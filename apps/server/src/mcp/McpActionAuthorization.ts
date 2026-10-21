import {
  ActionGateError,
  McpActionGateBlockedError,
  MODEL_ROUTER_UNKNOWN_METRIC,
  type ActionGateDecision,
} from "@t3tools/contracts";
import { defaultDecisionForRisk } from "@t3tools/shared/actionGate";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ActionGateService } from "../actionGate/ActionGateService.ts";
import { planMcpToolAction } from "../actionGate/mcpToolPlan.ts";
import { ConcurrencyBudgetService } from "../concurrencyBudget/ConcurrencyBudgetService.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

type ActionScope = Pick<McpInvocationContext.McpInvocationScope, "environmentId" | "threadId">;

const isActionGateError = Schema.is(ActionGateError);

const blocked = (
  toolName: string,
  detail: string,
  reasonCodes: ReadonlyArray<"ACTION_DENIED" | "REPLAY_REJECTED" | "APPROVAL_CONSUMED"> = [
    "ACTION_DENIED",
  ],
) =>
  new McpActionGateBlockedError({
    toolName,
    decision: "DENY",
    reasonCodes: [...reasonCodes],
    detail,
  });

const revalidateAfterQueue = (
  gate: ActionGateService["Service"],
  toolName: string,
  args: unknown,
  prior: ActionGateDecision,
  invocation: ActionScope,
): Effect.Effect<void, McpActionGateBlockedError> =>
  Effect.gen(function* () {
    const { spec, action } = planMcpToolAction({
      toolName,
      args,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
    });
    if (action === undefined || action.fingerprint !== prior.fingerprint) {
      return yield* blocked(
        toolName,
        "Queued MCP arguments no longer match the authorized fingerprint.",
        ["REPLAY_REJECTED"],
      );
    }
    const defaults = defaultDecisionForRisk({
      riskClass: action.riskClass,
      sideEffectClass: action.sideEffectClass,
      mayExposeSecrets: spec?.name === "preview_snapshot" || spec?.name === "device_screenshot",
    });
    if (defaults.decision === "DENY") {
      return yield* blocked(toolName, "ActionGate denied this action after queue delay.");
    }
    if (prior.approvalId === undefined) return;
    const stored = yield* gate
      .getApproval(prior.approvalId)
      .pipe(
        Effect.mapError(() => blocked(toolName, "ActionGate could not revalidate the approval.")),
      );
    if (Option.isNone(stored)) {
      return yield* blocked(toolName, "Queued approval is no longer present.");
    }
    if (stored.value.fingerprint !== prior.fingerprint) {
      return yield* blocked(
        toolName,
        "Queued approval is bound to a different action fingerprint.",
        ["REPLAY_REJECTED"],
      );
    }
    if (stored.value.expiresAt <= DateTime.formatIso(yield* DateTime.now))
      return yield* blocked(toolName, "Queued approval expired.");
    if (stored.value.status !== "consumed" && stored.value.status !== "granted") {
      return yield* blocked(toolName, `Queued approval is ${stored.value.status} and cannot run.`, [
        "ACTION_DENIED",
      ]);
    }
  });

const withMcpAdmission = <A, E, R>(
  invocation: ActionScope,
  toolName: string,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpActionGateBlockedError, R> =>
  Effect.gen(function* () {
    const budget = yield* Effect.serviceOption(ConcurrencyBudgetService);
    if (Option.isNone(budget)) return yield* run;
    const requestedAt = DateTime.formatIso(yield* DateTime.now);
    const admitted = yield* budget.value
      .admit({
        workloadClass: "mcp-action",
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        requestedAt,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new McpActionGateBlockedError({
              toolName,
              decision: "DENY",
              reasonCodes: ["ACTION_DENIED"],
              detail: error.detail,
            }),
        ),
      );
    const leaseId = admitted.lease?.leaseId;
    if (leaseId === undefined) {
      return yield* new McpActionGateBlockedError({
        toolName,
        decision: "DENY",
        reasonCodes: ["ACTION_DENIED"],
        detail: admitted.explanation,
      });
    }
    return yield* run.pipe(
      Effect.ensuring(budget.value.release(invocation.environmentId, leaseId)),
    );
  });

const requireAllowedScoped = (
  invocation: ActionScope,
  toolName: string,
  args: unknown,
): Effect.Effect<ActionGateDecision, McpActionGateBlockedError, ActionGateService> =>
  Effect.gen(function* () {
    const actionGate = yield* ActionGateService;
    const decision = yield* actionGate
      .authorizeTool({
        toolName,
        args,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
      })
      .pipe(
        Effect.mapError(
          () =>
            new McpActionGateBlockedError({
              toolName,
              decision: "DENY",
              reasonCodes: ["ACTION_DENIED"],
              detail: "ActionGate could not authorize this tool call.",
            }),
        ),
      );
    if (decision.decision === "ALLOW") {
      return decision;
    }
    if (decision.decision === "DENY") {
      return yield* new McpActionGateBlockedError({
        toolName,
        decision: "DENY",
        reasonCodes: [...decision.reasonCodes],
        detail: decision.explanation,
        ...(decision.approvalId !== undefined ? { approvalId: decision.approvalId } : {}),
      });
    }
    if (decision.approvalId === undefined) {
      return yield* new McpActionGateBlockedError({
        toolName,
        decision: "ASK",
        reasonCodes: [...decision.reasonCodes],
        detail: decision.explanation,
      });
    }
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const consumed = yield* actionGate
      .waitForAuthorized(decision.approvalId, decision.fingerprint, nowIso)
      .pipe(
        Effect.mapError((error) => {
          const reason = isActionGateError(error) ? error.reason : "invalid";
          const detail = isActionGateError(error) ? error.detail : decision.explanation;
          const codes =
            reason === "expired"
              ? (["APPROVAL_EXPIRED"] as const)
              : reason === "replay"
                ? (["REPLAY_REJECTED", "APPROVAL_CONSUMED"] as const)
                : /denied/i.test(detail)
                  ? (["APPROVAL_DENIED"] as const)
                  : /cancel/i.test(detail)
                    ? (["APPROVAL_CANCELLED"] as const)
                    : (["ACTION_DENIED"] as const);
          return new McpActionGateBlockedError({
            toolName,
            decision: "DENY",
            reasonCodes: [...codes],
            detail,
            approvalId: decision.approvalId,
          });
        }),
      );
    yield* actionGate
      .appendAudit({
        eventId: consumed.approvalId,
        kind: "action.started",
        at: nowIso,
        environmentId: invocation.environmentId,
        planId: consumed.planId,
        actionId: consumed.actionId,
        decision: "ALLOW",
        reasonCodes: ["ACTION_ALLOWED"],
        fingerprint: consumed.fingerprint,
        policyVersion: consumed.policyVersion,
        cost: MODEL_ROUTER_UNKNOWN_METRIC,
      })
      .pipe(Effect.ignore);
    return {
      ...decision,
      decision: "ALLOW" as const,
      requiresApproval: false,
      reasonCodes: ["ACTION_ALLOWED"],
      explanation: "ActionGate allowed this action after a one-time approval.",
    } satisfies ActionGateDecision;
  });

export const requireAllowedMcpTool = (toolName: string, args: unknown) =>
  Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
    requireAllowedScoped(scope, toolName, args),
  );

/** Only the two explicit server-owned reads use this path; no MCP session is fabricated. */
export const withAllowedSavedPrRead = <A, E, R>(
  scope: ActionScope,
  run: Effect.Effect<A, E, R>,
  toolName: "list_thread_pull_requests" | "t3_worktree_status" = "list_thread_pull_requests",
  onAuthorized: (decision: ActionGateDecision) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const available = yield* Effect.serviceOption(ActionGateService);
    if (Option.isNone(available)) return yield* blocked(toolName, "ActionGate unavailable.");
    const gate = available.value;
    const decision = yield* requireAllowedScoped(scope, toolName, {}).pipe(
      Effect.provideService(ActionGateService, gate),
    );
    return yield* withMcpAdmission(
      scope,
      toolName,
      revalidateAfterQueue(gate, toolName, {}, decision, scope).pipe(
        Effect.andThen(onAuthorized(decision)),
        Effect.andThen(run),
      ),
    );
  });

export const withAllowedMcpTool = <A, E, R>(
  toolName: string,
  args: unknown,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpActionGateBlockedError, R | McpInvocationContext.McpInvocationContext> =>
  Effect.gen(function* () {
    // VITEST defaults to kernel-test so upstream tool tests keep their fakes.
    // A production session never sets that context and cannot take this path.
    const policy = yield* PolicyExecutionContext;
    if (policy.kind === "kernel-test") return yield* run;
    const gate = yield* Effect.serviceOption(ActionGateService);
    if (Option.isNone(gate)) {
      return yield* blocked(toolName, "ActionGate is not available for this execution.");
    }
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const decision = yield* requireAllowedMcpTool(toolName, args).pipe(
      Effect.provideService(ActionGateService, gate.value),
    );
    return yield* withMcpAdmission(
      invocation,
      toolName,
      revalidateAfterQueue(gate.value, toolName, args, decision, invocation).pipe(
        Effect.andThen(run),
      ),
    );
  });
