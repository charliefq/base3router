import {
  ActionGateError,
  McpActionGateBlockedError,
  MODEL_ROUTER_UNKNOWN_METRIC,
  type ActionGateDecision,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ActionGateService } from "../actionGate/ActionGateService.ts";
import { ConcurrencyBudgetService } from "../concurrencyBudget/ConcurrencyBudgetService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as Option from "effect/Option";

const isActionGateError = Schema.is(ActionGateError);

const admitMcpAction = (invocation: McpInvocationContext.McpInvocationScope, toolName: string) =>
  Effect.gen(function* () {
    const budget = yield* Effect.serviceOption(ConcurrencyBudgetService);
    if (Option.isNone(budget)) return;
    const result = yield* budget.value
      .admit({
        workloadClass: "mcp-action",
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        requestedAt: new Date().toISOString(),
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
    if (result.lease === undefined) {
      return yield* new McpActionGateBlockedError({
        toolName,
        decision: "DENY",
        reasonCodes: ["ACTION_DENIED"],
        detail: result.explanation,
      });
    }
    yield* Effect.acquireRelease(Effect.succeed(result.lease.leaseId), (leaseId) =>
      budget.value.release(invocation.environmentId, leaseId),
    );
  });

export const requireAllowedMcpTool = (
  toolName: string,
  args: unknown,
): Effect.Effect<
  ActionGateDecision,
  McpActionGateBlockedError,
  McpInvocationContext.McpInvocationContext | ActionGateService
> =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
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
      yield* admitMcpAction(invocation, toolName);
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
    yield* admitMcpAction(invocation);
    return {
      ...decision,
      decision: "ALLOW" as const,
      requiresApproval: false,
      reasonCodes: ["ACTION_ALLOWED"],
      explanation: "ActionGate allowed this action after a one-time approval.",
    } satisfies ActionGateDecision;
  });
