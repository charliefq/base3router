import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
// Argument hashes are canonical JSON. A schema codec would change the bytes
// a grant is compared against after a queue delay.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import {
  type AuthEnvironmentScope,
  type ChatAttachment,
  type OrchestrationMessageContext,
  MODEL_ROUTER_POLICY_VERSION,
  AuthOrchestrationOperateScope,
  defaultConcurrencyBudgetPolicy,
  EnvironmentId,
  MessageId,
  ModelSelection,
  type ModelRouterConstraints,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  contractGrantFields,
  type TaskContractFields,
  TaskContract,
  TaskContractReviewState,
  TaskContractReviewReference,
  TaskAutoPreviewInput,
  type TaskAutoPreviewState,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ActionGateService } from "../actionGate/ActionGateService.ts";
import {
  calculateDispatcherModelRoute,
  readDispatcherProjectedState,
  readDispatcherTaskRoute,
  bindDispatcherTurnStartCommand,
  bindingForExplicitTarget,
  deleteDispatcherTaskRoutesByThread,
  persistDispatcherTaskRoute,
  type DispatcherTurnStartCommand,
} from "../dispatcher/Dispatcher.ts";
import { deleteTaskHandoffsByThread } from "../dispatcher/Handoff.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RouterEvaluation from "../routerEvaluation/RouterEvaluationService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readTaskReview } from "../collaboration/store.ts";
import type { ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import { Base3PolicyDeniedError } from "./Base3PolicyDeniedError.ts";
import { classifyCommand, commandNeedsCapacity, type OperationClass } from "./operationPolicy.ts";
import {
  loadTaskState,
  requestTaskCancellation,
  reserveGovernedStart,
  reserveProviderHandoff,
  taskBlocksStart,
} from "./TaskContract.ts";

const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
] as const;

export { Base3PolicyDeniedError } from "./Base3PolicyDeniedError.ts";

export interface DispatchPolicyCommand {
  readonly type: string;
  readonly commandId: string;
  readonly threadId?: string;
  readonly parentThreadId?: string;
  readonly runId?: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly modelSelection?: ModelSelection;
  readonly routingMode?: "auto" | "manual";
  readonly modelRouteConstraints?: ModelRouterConstraints;
  readonly scheduledTaskId?: string;
  readonly usageLimitContinuationOfRunId?: string;
  readonly manualContinuationOfRunId?: string;
  readonly restartContinuationOfRunId?: string;
  readonly delegatedCompletion?: unknown;
  readonly dispatchMode?: {
    readonly type: string;
    readonly targetRunId?: string;
    readonly targetAttemptId?: string | undefined;
  };
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly task?: string;
  readonly taskContract?: TaskContractFields;
}

const deny = (commandType: string, reason: string, detail?: string) =>
  Effect.fail(new Base3PolicyDeniedError({ reason, commandType, ...(detail ? { detail } : {}) }));

export function argumentHash(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const decodeModelSelection = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const decodeGrantScopes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const isPolicyDenied = Schema.is(Base3PolicyDeniedError);

const messageArguments = (command: DispatchPolicyCommand) => ({
  text: command.text ?? "",
  model: command.modelSelection?.model ?? null,
  instanceId: command.modelSelection?.instanceId ?? null,
  attachmentIds: (command.attachments ?? []).map((attachment) => attachment.id ?? ""),
  ...(command.modelSelection?.options === undefined
    ? {}
    : { options: command.modelSelection.options }),
  ...(command.modelRouteConstraints === undefined
    ? {}
    : { modelRouteConstraints: command.modelRouteConstraints }),
});

const isContinuation = (command: DispatchPolicyCommand): boolean =>
  command.usageLimitContinuationOfRunId !== undefined ||
  command.scheduledTaskId !== undefined ||
  command.manualContinuationOfRunId !== undefined ||
  command.restartContinuationOfRunId !== undefined ||
  command.delegatedCompletion !== undefined;

const hasOperate = (scopes: ReadonlyArray<AuthEnvironmentScope>): boolean =>
  scopes.includes(AuthOrchestrationOperateScope);

const environmentId = Effect.gen(function* () {
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  if (Option.isNone(environment)) return EnvironmentId.make("local");
  return yield* environment.value.getEnvironmentId.pipe(
    Effect.orElseSucceed(() => EnvironmentId.make("local")),
  );
});

const unavailableRoutingPolicy = () => ({
  activePolicyVersion: MODEL_ROUTER_POLICY_VERSION,
  challengerEnabled: false,
  evidenceByTarget: new Map(),
  policyLoadFailure: "Policy snapshot unavailable; Router V0 was used.",
});

const providersForBind = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  if (Option.isNone(registry)) return [] as ReadonlyArray<ServerProvider>;
  return yield* registry.value.getProviders.pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
  );
});

export const countOccupied = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly environmentId: EnvironmentId;
  readonly threadId?: string;
  readonly workloadClass?: string;
}) => {
  const query =
    input.threadId !== undefined
      ? input.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM base3_capacity_leases
          WHERE environment_id = ${input.environmentId}
            AND thread_id = ${input.threadId}
            AND released_at IS NULL
            AND status = 'active'
        `
      : input.workloadClass !== undefined
        ? input.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM base3_capacity_leases
            WHERE environment_id = ${input.environmentId}
              AND workload_class = ${input.workloadClass}
              AND released_at IS NULL
              AND status = 'active'
          `
        : input.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM base3_capacity_leases
            WHERE environment_id = ${input.environmentId}
              AND released_at IS NULL
              AND status = 'active'
          `;
  return query.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
};

/** Active controls keep the occupied run's slot; they never admit a second turn. */
export const verifyActiveRunLease = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId?: string;
  readonly commandType: string;
}) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind === "kernel-test") return;
    if (context.kind !== "session" || !hasOperate(context.scopes))
      return yield* deny(input.commandType, "unauthenticated");
    const env = yield* environmentId;
    const now = DateTime.formatIso(yield* DateTime.now);
    if (context.expiresAt !== undefined && context.expiresAt <= now)
      return yield* deny(input.commandType, "grant-expired");
    const rows = yield* input.sql<{ attempt_id: string; message_id: string }>`
    SELECT attempt.attempt_id, json_extract(run.payload_json,'$.userMessageId') AS message_id
    FROM orchestration_v2_projection_runs AS run
    JOIN orchestration_v2_projection_run_attempts AS attempt
      ON attempt.attempt_id=json_extract(run.payload_json,'$.activeAttemptId')
      AND attempt.run_id=run.run_id AND attempt.thread_id=run.thread_id
    JOIN base3_capacity_leases AS lease
      ON lease.run_id=run.run_id AND lease.thread_id=run.thread_id
    WHERE run.run_id=${input.runId} AND run.thread_id=${input.threadId}
      AND run.status='running' AND attempt.status='running'
      AND lease.environment_id=${env} AND lease.workload_class='foreground-turn'
      AND lease.status='active' AND lease.released_at IS NULL
      AND lease.interrupt_requested=0 AND lease.disconnect_unconfirmed=0
  `;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      (input.attemptId !== undefined && input.attemptId !== row.attempt_id)
    )
      return yield* deny(
        input.commandType,
        "active-run-ownership",
        "The exact active run, attempt and occupied slot are required.",
      );
    const grant = (yield* loadGrant(
      input.sql,
      `grant:message:${input.threadId}:${row.message_id}`,
    ))[0];
    if (grant === undefined || grant.revoked_at !== null)
      return yield* deny(input.commandType, "grant-missing");
    if (grant.actor_id !== context.actorId)
      return yield* deny(input.commandType, "active-run-ownership");
    if (grant.expires_at !== null && grant.expires_at <= now)
      return yield* deny(input.commandType, "grant-expired");
    const scopes = yield* decodeGrantScopes(grant.scopes_json);
    if (!scopes.includes(AuthOrchestrationOperateScope))
      return yield* deny(input.commandType, "missing-operate-scope");
  }).pipe(
    Effect.mapError((cause) =>
      isPolicyDenied(cause)
        ? cause
        : new Base3PolicyDeniedError({
            commandType: input.commandType,
            reason: "policy-store-unavailable",
          }),
    ),
  );

export const isActiveRunControl = (command: {
  readonly type: string;
  readonly dispatchMode?: { readonly type: string } | undefined;
}): boolean =>
  command.type === "message.dispatch" &&
  (command.dispatchMode?.type === "restart_active" ||
    command.dispatchMode?.type === "steer_active");

/** A receipt is not authority for a different authenticated principal. */
export const verifyActiveControlReplay = (command: {
  readonly type: string;
  readonly threadId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly dispatchMode?: { readonly type: string } | undefined;
}) =>
  Effect.gen(function* () {
    if (!isActiveRunControl(command)) return;
    const context = yield* PolicyExecutionContext;
    if (context.kind === "kernel-test") return;
    if (context.kind !== "session" || !hasOperate(context.scopes))
      return yield* deny(command.type, "unauthenticated");
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return yield* deny(command.type, "policy-store-unavailable");
    const sql = sqlOption.value;
    const grant = (yield* loadGrant(
      sql,
      `grant:message:${command.threadId}:${command.messageId}`,
    ))[0];
    if (grant === undefined || grant.revoked_at !== null)
      return yield* deny(command.type, "grant-missing");
    if (grant.actor_id !== context.actorId)
      return yield* deny(command.type, "active-run-ownership");
    const now = DateTime.formatIso(yield* DateTime.now);
    if (
      (grant.expires_at !== null && grant.expires_at <= now) ||
      (context.expiresAt !== undefined && context.expiresAt <= now)
    )
      return yield* deny(command.type, "grant-expired");
  }).pipe(
    Effect.mapError((cause) =>
      isPolicyDenied(cause)
        ? cause
        : new Base3PolicyDeniedError({
            commandType: command.type,
            reason: "policy-store-unavailable",
          }),
    ),
  );

const admitLease = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly messageId: string | null;
  readonly parentLeaseId: string | null;
  readonly workloadClass: string;
  readonly nonBlocking: boolean;
}) =>
  Effect.gen(function* () {
    const policy = defaultConcurrencyBudgetPolicy();
    const classLimit = policy.classes[input.workloadClass as keyof typeof policy.classes];
    const maxClass = classLimit?.maxConcurrent ?? 1;
    const [environmentCount, threadCount, classCount] = yield* Effect.all([
      countOccupied({ sql: input.sql, environmentId: input.environmentId }),
      countOccupied({
        sql: input.sql,
        environmentId: input.environmentId,
        threadId: input.threadId,
      }),
      countOccupied({
        sql: input.sql,
        environmentId: input.environmentId,
        workloadClass: input.workloadClass,
      }),
    ]);
    const threadLimit =
      input.workloadClass === "foreground-turn" ? policy.threadForegroundConcurrent : maxClass;
    const projectLimit = policy.projectForegroundConcurrent;
    if (
      threadCount >= threadLimit ||
      classCount >= maxClass ||
      environmentCount >= projectLimit + maxClass
    ) {
      if (input.nonBlocking) {
        return yield* deny(
          "delegated_task.request",
          "capacity",
          "Child admission rejected without waiting.",
        );
      }
      return yield* deny(input.workloadClass, "capacity", "No execution capacity is available.");
    }
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const leaseId = `lease:${input.threadId}:${input.messageId ?? now}`;
    yield* input.sql`
      INSERT OR IGNORE INTO base3_capacity_leases (
        lease_id, environment_id, thread_id, message_id, run_id, parent_lease_id,
        workload_class, status, interrupt_requested, disconnect_unconfirmed, created_at
      ) VALUES (
        ${leaseId}, ${input.environmentId}, ${input.threadId}, ${input.messageId},
        ${null}, ${input.parentLeaseId}, ${input.workloadClass}, 'active', 0, 0, ${now}
      )
    `;
    return leaseId;
  });

export const noteInterrupt = (input: {
  readonly threadId: string;
  readonly runId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return;
    if (input.runId === undefined) {
      yield* sql.value`
        UPDATE base3_capacity_leases
        SET interrupt_requested = 1
        WHERE released_at IS NULL AND thread_id = ${input.threadId}
      `;
      return;
    }
    yield* sql.value`
      UPDATE base3_capacity_leases
      SET interrupt_requested = 1
      WHERE released_at IS NULL
        AND thread_id = ${input.threadId}
        AND (run_id = ${input.runId} OR run_id IS NULL)
    `;
  });

export const noteUnconfirmedDisconnect = (input: {
  readonly threadId: string;
  readonly runId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return;
    if (input.runId === undefined) {
      yield* sql.value`
        UPDATE base3_capacity_leases
        SET disconnect_unconfirmed = 1
        WHERE released_at IS NULL AND thread_id = ${input.threadId}
      `;
      return;
    }
    yield* sql.value`
      UPDATE base3_capacity_leases
      SET disconnect_unconfirmed = 1
      WHERE released_at IS NULL
        AND thread_id = ${input.threadId}
        AND (run_id = ${input.runId} OR run_id IS NULL)
    `;
  });

/**
 * Release a slot only after the matching provider turn is confirmed terminal.
 * Interrupt requests, stream close, and local projection status do not call this.
 */
export const confirmProviderTermination = (input: {
  readonly threadId: string;
  readonly runId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly attemptId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return;
    if (input.runId === undefined && input.messageId === undefined) return;
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (input.runId !== undefined) {
      yield* sql.value`
        UPDATE base3_capacity_leases
        SET released_at = ${now}, status = 'released'
        WHERE released_at IS NULL
          AND thread_id = ${input.threadId}
          AND run_id = ${input.runId}
          AND (${input.attemptId ?? null} IS NULL OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs AS run
            JOIN orchestration_v2_projection_run_attempts AS current
              ON current.attempt_id=json_extract(run.payload_json,'$.activeAttemptId')
            JOIN orchestration_v2_projection_run_attempts AS stopped
              ON stopped.attempt_id=${input.attemptId ?? null} AND stopped.run_id=run.run_id
            WHERE run.run_id=${input.runId} AND run.thread_id=${input.threadId}
              AND (current.attempt_id=stopped.attempt_id OR (
                run.status IN ('completed','failed','cancelled','interrupted','rolled_back')
                AND current.provider_turn_id IS NULL
                AND json_extract(current.payload_json,'$.startedAt') IS NULL
                AND current.attempt_ordinal=stopped.attempt_ordinal+1
              ))
          ))
      `;
      return;
    }
    yield* sql.value`
      UPDATE base3_capacity_leases
      SET released_at = ${now}, status = 'released'
      WHERE released_at IS NULL
        AND thread_id = ${input.threadId}
        AND message_id = ${input.messageId ?? null}
    `;
  });

const insertGrant = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly grantId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly runId: string | null;
  readonly operation: string;
  readonly actorId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: string | null;
  readonly hash: string;
  readonly approvalId: string | null;
}) =>
  Effect.gen(function* () {
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* input.sql`
      INSERT OR REPLACE INTO base3_execution_grants (
        grant_id, thread_id, message_id, run_id, operation, actor_id, scopes_json,
        expires_at, argument_hash, approval_id, revoked_at, created_at
      ) VALUES (
        ${input.grantId}, ${input.threadId}, ${input.messageId}, ${input.runId},
        ${input.operation}, ${input.actorId}, ${JSON.stringify(input.scopes)},
        ${input.expiresAt}, ${input.hash}, ${input.approvalId}, ${null}, ${now}
      )
    `;
  });

const loadGrant = (sql: SqlClient.SqlClient, grantId: string) =>
  sql<{
    readonly grant_id: string;
    readonly scopes_json: string;
    readonly expires_at: string | null;
    readonly argument_hash: string;
    readonly revoked_at: string | null;
    readonly actor_id: string;
  }>`
    SELECT grant_id, scopes_json, expires_at, argument_hash, revoked_at, actor_id
    FROM base3_execution_grants
    WHERE grant_id = ${grantId}
    LIMIT 1
  `;

const assertGrant = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly command: DispatchPolicyCommand;
  readonly grantId: string;
  readonly hash: string;
}) =>
  Effect.gen(function* () {
    const rows = yield* loadGrant(input.sql, input.grantId);
    const grant = rows[0];
    if (grant === undefined) {
      return yield* deny(
        input.command.type,
        "grant-missing",
        "Continuation has no execution grant.",
      );
    }
    if (grant.revoked_at !== null) {
      return yield* deny(input.command.type, "grant-revoked");
    }
    if (grant.expires_at !== null) {
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      if (grant.expires_at <= now) return yield* deny(input.command.type, "grant-expired");
    }
    if (grant.argument_hash !== input.hash) {
      return yield* deny(
        input.command.type,
        "argument-mismatch",
        "Queued arguments no longer match the grant.",
      );
    }
    return grant;
  });

const recordAttempt = (
  sql: SqlClient.SqlClient,
  command: DispatchPolicyCommand,
  operation: string,
) =>
  Effect.gen(function* () {
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* sql`
      INSERT INTO base3_execution_attempts (attempt_id, operation, thread_id, message_id, started_at)
      VALUES (
        ${`${command.commandId}:${operation}`},
        ${operation},
        ${command.threadId ?? command.parentThreadId ?? null},
        ${command.messageId ?? null},
        ${now}
      )
    `;
  });

const requireAsk = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly commandType: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) =>
  Effect.gen(function* () {
    const gate = yield* Effect.serviceOption(ActionGateService);
    if (Option.isNone(gate)) {
      return yield* deny(input.commandType, "action-gate-unavailable");
    }
    const decision = yield* gate.value
      .authorizeTool({
        toolName: input.toolName,
        args: input.args,
        environmentId: input.environmentId,
        threadId: ThreadId.make(input.threadId),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new Base3PolicyDeniedError({
              reason: "action-gate",
              commandType: input.commandType,
              detail: cause instanceof Error ? cause.message : "ActionGate denied the operation.",
            }),
        ),
      );
    if (decision.decision === "DENY") {
      return yield* deny(input.commandType, "action-denied");
    }
    if (decision.decision === "ALLOW") return decision.approvalId ?? null;
    if (decision.approvalId === undefined)
      return yield* deny(input.commandType, "approval-required");
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const consumed = yield* gate.value.consume(decision.approvalId, decision.fingerprint, now).pipe(
      Effect.mapError(
        () =>
          new Base3PolicyDeniedError({
            reason: "approval-required",
            commandType: input.commandType,
            detail: "ASK was not granted. Execution did not start.",
          }),
      ),
    );
    if (consumed.status !== "consumed") {
      return yield* deny(input.commandType, "approval-required");
    }
    return consumed.approvalId;
  });

const bindRoute = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly command: DispatchPolicyCommand;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly environmentId: EnvironmentId;
}) =>
  Effect.gen(function* () {
    if (input.command.threadId === undefined || input.command.messageId === undefined) {
      return yield* deny(
        input.command.type,
        "binding",
        "Execution is missing thread or message identity.",
      );
    }
    const routingMode = input.command.routingMode ?? "manual";
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const environmentDefaultModelSelection = Option.isNone(settings)
      ? null
      : yield* settings.value.getSettings.pipe(
          Effect.map((current) => current.defaultModelSelection),
          Effect.orElseSucceed(() => null),
        );
    const threadRows = yield* input.sql<{ readonly selection: string | null }>`
      SELECT json_extract(payload_json, '$.modelSelection') AS selection
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${input.command.threadId}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as { readonly selection: string | null }[]));
    const storedSelection = threadRows[0]?.selection;
    const threadModel =
      storedSelection == null
        ? null
        : yield* decodeModelSelection(storedSelection).pipe(
            Effect.mapError(
              () =>
                new Base3PolicyDeniedError({
                  reason: "binding",
                  commandType: input.command.type,
                  detail: "Stored model selection is invalid.",
                }),
            ),
          );
    const preferred = input.command.modelSelection ?? threadModel ?? undefined;
    const turn: DispatcherTurnStartCommand = {
      type: "thread.turn.start",
      threadId: ThreadId.make(input.command.threadId),
      message: {
        messageId: MessageId.make(input.command.messageId),
        text: input.command.text ?? "",
        ...(input.command.attachments === undefined
          ? {}
          : { attachments: input.command.attachments }),
        ...(input.command.context === undefined ? {} : { context: input.command.context }),
      },
      routingMode,
      ...(input.command.modelRouteConstraints === undefined
        ? {}
        : { modelRouteConstraints: input.command.modelRouteConstraints }),
      ...(preferred === undefined ? {} : { modelSelection: preferred }),
    };
    const localTaskProfile = classifyLocalTask(input.command.text ?? "");
    const evaluation = yield* Effect.serviceOption(RouterEvaluation.RouterEvaluationService);
    const fallback = unavailableRoutingPolicy();
    const hybrid = Option.isNone(evaluation)
      ? fallback
      : yield* evaluation.value.routingSnapshot(input.environmentId, localTaskProfile).pipe(
          Effect.map(RouterEvaluation.routingPolicyInput),
          Effect.orElseSucceed(() => fallback),
        );
    const bound = yield* bindDispatcherTurnStartCommand(turn, {
      enabled: true,
      environmentId: Effect.succeed(input.environmentId),
      providers: Effect.succeed(input.providers),
      environmentDefaultModelSelection: Effect.succeed(environmentDefaultModelSelection),
      sql: input.sql,
      hybrid,
      localTaskProfile,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, input.sql),
      Effect.mapError(
        (cause) =>
          new Base3PolicyDeniedError({
            reason: "binding",
            commandType: input.command.type,
            detail: cause.message,
          }),
      ),
    );
    // Dispatcher may preserve a legacy explicit Manual binding without a
    // selected router decision. Such a binding cannot prove a hard limit passed.
    const constraints = input.command.modelRouteConstraints;
    if (
      (constraints?.maxCostUsd !== undefined || constraints?.maxLatencyMs !== undefined) &&
      bound.routeBinding?.modelRoute?.selected == null
    ) {
      return yield* deny(
        input.command.type,
        "binding",
        "Manual Route could not satisfy the supplied estimated cost or latency limits.",
      );
    }
    let binding = bound.routeBinding;
    if (binding === undefined && routingMode === "manual" && preferred !== undefined) {
      const provider = input.providers.find(
        (candidate) => candidate.instanceId === preferred.instanceId,
      );
      if (provider !== undefined) {
        binding = bindingForExplicitTarget({
          instanceId: ProviderInstanceId.make(preferred.instanceId),
          model: preferred.model,
          driver: provider.driver,
        });
      }
    }
    if (binding === undefined) {
      return yield* deny(input.command.type, "binding", "No immutable route binding was produced.");
    }
    binding = { ...binding, localTaskProfile };
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* persistDispatcherTaskRoute({
      threadId: ThreadId.make(input.command.threadId),
      messageId: turn.message.messageId,
      binding,
      createdAt: now,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, input.sql),
      Effect.mapError(
        (cause) =>
          new Base3PolicyDeniedError({
            reason: "binding-immutable",
            commandType: input.command.type,
            detail: cause instanceof Error ? cause.message : "Route binding conflict.",
          }),
      ),
    );
    return (
      bound.modelSelection ?? { instanceId: binding.target.instanceId, model: binding.target.model }
    );
  });

const continuationGrantId = (command: DispatchPolicyCommand): string | null => {
  if (command.scheduledTaskId !== undefined) return `grant:schedule:${command.scheduledTaskId}`;
  if (command.usageLimitContinuationOfRunId !== undefined) {
    return `grant:usage-limit:${command.usageLimitContinuationOfRunId}`;
  }
  if (command.manualContinuationOfRunId !== undefined) {
    return `grant:manual:${command.manualContinuationOfRunId}`;
  }
  if (command.restartContinuationOfRunId !== undefined) {
    return `grant:restart:${command.restartContinuationOfRunId}`;
  }
  if (command.delegatedCompletion !== undefined && command.threadId !== undefined) {
    return `grant:delegated:${command.threadId}`;
  }
  return null;
};

export const authorizeDispatch = <
  Command extends DispatchPolicyCommand | { readonly type: string; readonly commandId: string },
>(
  input: Command,
) => {
  const command = input as DispatchPolicyCommand;
  return Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    const operation = classifyCommand(command.type);
    if (operation.kind === "task-decision") {
      if (context.kind !== "session" || !hasOperate(context.scopes)) {
        return yield* deny(
          command.type,
          context.kind === "session" ? "missing-operate-scope" : "unauthenticated",
          "Accept, redirect, and contract completion require an authenticated session with orchestration:operate. Provider completion is not acceptance.",
        );
      }
      return;
    }
    if (context.kind === "kernel-test") {
      if (command.type === "run.interrupt") {
        yield* noteInterrupt({ threadId: command.threadId ?? "", runId: command.runId });
      }
      return;
    }
    if (operation.kind === "read") return;
    if (context.kind === "absent") {
      if (operation.kind === "auth-only") return;
      return yield* deny(command.type, "unauthenticated");
    }
    if (context.kind === "server-continuation") {
      if (operation.kind === "auth-only") return;
      return yield* authorizeContinuation(command, operation);
    }
    if (!hasOperate(context.scopes)) return yield* deny(command.type, "missing-operate-scope");
    if (operation.kind === "ungoverned") {
      return yield* deny(
        command.type,
        "ungoverned",
        "This command has no Base3 policy and cannot run.",
      );
    }
    if (operation.kind === "provider-switch") {
      return yield* deny(
        command.type,
        "provider-switch-requires-explicit-handoff",
        "Authenticated sessions change providers through explicit handoff.",
      );
    }
    if (operation.kind === "auth-only") {
      if (command.type === "thread.delete" && command.threadId !== undefined) {
        const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
        if (Option.isSome(sqlOption)) {
          const threadId = ThreadId.make(command.threadId);
          const policyStore = Effect.provideService(SqlClient.SqlClient, sqlOption.value);
          const unavailable = new Base3PolicyDeniedError({
            reason: "policy-store-unavailable",
            commandType: command.type,
            detail: "Thread policy rows could not be removed.",
          });
          yield* sqlOption.value`DELETE FROM base3_image_delivery_denials WHERE thread_id=${threadId}`.pipe(
            Effect.mapError(() => unavailable),
          );
          yield* deleteDispatcherTaskRoutesByThread({ threadId }).pipe(
            policyStore,
            Effect.mapError(() => unavailable),
          );
          yield* deleteTaskHandoffsByThread(threadId).pipe(
            policyStore,
            Effect.mapError(() => unavailable),
          );
        }
      }
      return;
    }
    if (operation.kind === "interrupt") {
      yield* noteInterrupt({ threadId: command.threadId ?? "", runId: command.runId });
      return;
    }
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return yield* deny(command.type, "policy-store-unavailable");
    const sql = sqlOption.value;
    const env = yield* environmentId;
    if (operation.kind === "delegation") {
      const threadId = command.parentThreadId ?? command.threadId;
      if (threadId === undefined) return yield* deny(command.type, "binding");
      const parentState = yield* loadTaskState(sql, threadId);
      yield* reserveGovernedStart({
        sql,
        state: parentState,
        commandType: command.type,
        commandId: command.commandId,
        threadId,
        messageId: command.messageId ?? command.commandId,
        proposed: command.taskContract ?? null,
      });
      const approvalId = yield* requireAsk({
        sql,
        commandType: command.type,
        toolName: "delegate_task",
        args: {
          task: command.task ?? "",
          model: command.modelSelection ?? null,
          ...contractGrantFields(
            parentState.governance === "required" ? parentState.contract : null,
          ),
        },
        environmentId: env,
        threadId,
      });
      yield* admitLease({
        sql,
        environmentId: env,
        threadId,
        messageId: command.commandId,
        parentLeaseId: null,
        workloadClass: "child-agent",
        nonBlocking: true,
      });
      yield* insertGrant({
        sql,
        grantId: `grant:delegated:${threadId}`,
        threadId,
        messageId: command.messageId ?? command.commandId,
        runId: null,
        operation: "delegation",
        actorId: context.actorId,
        scopes: context.scopes,
        expiresAt: null,
        hash: argumentHash({
          task: command.task ?? "",
          model: command.modelSelection ?? null,
          ...contractGrantFields(
            parentState.governance === "required" ? parentState.contract : null,
          ),
        }),
        approvalId,
      });
      yield* recordAttempt(sql, command, "delegation");
      return;
    }
    if (
      command.type !== "message.dispatch" &&
      operation.kind !== "queue-resume" &&
      operation.kind !== "queue-edit" &&
      operation.kind !== "steer" &&
      operation.kind !== "release" &&
      operation.kind !== "rollback"
    ) {
      return yield* deny(command.type, "ungoverned");
    }
    if (isContinuation(command)) {
      return yield* authorizeContinuation(command, {
        kind: "message",
        continuation: true,
        ask: false,
      });
    }
    if (command.type === "message.dispatch") {
      const catalog = yield* providersForBind;
      const modelSelection = yield* bindRoute({
        sql,
        command,
        providers: catalog,
        environmentId: env,
      });
      // Stable receipt replay is handled before authorization. A new session
      // command must not replace the grant of a persisted message, including
      // while an active control is waiting for native interruption.
      const existing = yield* sql`SELECT message.message_id
          FROM orchestration_v2_projection_messages AS message
          JOIN base3_execution_grants AS authority
            ON authority.grant_id='grant:message:' || message.thread_id || ':' || message.message_id
          WHERE message.message_id=${command.messageId ?? null} LIMIT 1`;
      if (existing.length > 0)
        return yield* deny(
          command.type,
          "message-identity",
          "This message already has an execution grant. Replay its original command receipt.",
        );
      const effectiveCommand = {
        ...input,
        modelSelection,
      };
      const taskState = yield* loadTaskState(sql, command.threadId ?? "");
      const activeControl = isActiveRunControl(command);
      if (activeControl) {
        yield* verifyActiveRunLease({
          sql,
          threadId: command.threadId ?? "",
          runId: command.dispatchMode?.targetRunId ?? "",
          ...(command.dispatchMode?.targetAttemptId === undefined
            ? {}
            : { attemptId: command.dispatchMode.targetAttemptId }),
          commandType: command.type,
        });
        const blocked = taskBlocksStart(taskState);
        if (blocked !== null) return yield* deny(command.type, "task-contract", blocked);
      } else {
        yield* reserveGovernedStart({
          sql,
          state: taskState,
          commandType: command.type,
          commandId: command.commandId,
          threadId: command.threadId ?? "",
          messageId: command.messageId ?? null,
        });
      }
      if (
        !activeControl &&
        command.dispatchMode?.type !== "queue_after_active" &&
        commandNeedsCapacity(operation)
      ) {
        yield* admitLease({
          sql,
          environmentId: env,
          threadId: command.threadId ?? "",
          messageId: command.messageId ?? command.commandId,
          parentLeaseId: null,
          workloadClass: "foreground-turn",
          nonBlocking: false,
        });
      }
      const hash = argumentHash({
        ...messageArguments({ ...command, modelSelection: effectiveCommand.modelSelection }),
        ...contractGrantFields(taskState.governance === "required" ? taskState.contract : null),
      });
      yield* insertGrant({
        sql,
        grantId: `grant:message:${command.threadId}:${command.messageId}`,
        threadId: command.threadId ?? "",
        messageId: command.messageId ?? command.commandId,
        runId: command.usageLimitContinuationOfRunId ?? null,
        operation: "message",
        actorId: context.actorId,
        scopes: context.scopes,
        expiresAt: context.expiresAt ?? null,
        hash,
        approvalId: null,
      });
      if (command.usageLimitContinuationOfRunId === undefined && command.runId !== undefined) {
        yield* insertGrant({
          sql,
          grantId: `grant:usage-limit:${command.runId}`,
          threadId: command.threadId ?? "",
          messageId: command.messageId ?? command.commandId,
          runId: command.runId,
          operation: "usage-limit",
          actorId: context.actorId,
          scopes: context.scopes,
          expiresAt: null,
          hash,
          approvalId: null,
        });
      }
      yield* recordAttempt(sql, command, "message");
      return effectiveCommand;
    }
    if (
      operation.kind === "queue-resume" ||
      operation.kind === "queue-edit" ||
      operation.kind === "steer"
    ) {
      return yield* authorizeContinuation(command, operation);
    }
    yield* recordAttempt(sql, command, operation.kind);
  });
};

const authorizeContinuation = (command: DispatchPolicyCommand, operation: OperationClass) =>
  Effect.gen(function* () {
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return yield* deny(command.type, "policy-store-unavailable");
    const sql = sqlOption.value;
    const grantId =
      continuationGrantId(command) ??
      (command.threadId !== undefined && command.messageId !== undefined
        ? `grant:message:${command.threadId}:${command.messageId}`
        : null);
    if (grantId === null) return yield* deny(command.type, "grant-missing");
    const taskState = yield* loadTaskState(sql, command.threadId ?? "");
    const grantFields = contractGrantFields(
      taskState.governance === "required" ? taskState.contract : null,
    );
    const hash = argumentHash(
      command.type === "queued-run.edit" || command.type === "message.dispatch"
        ? { ...messageArguments(command), ...grantFields }
        : { commandId: command.commandId, type: command.type, ...grantFields },
    );
    const stored = yield* loadGrant(sql, grantId);
    const comparable = command.type === "message.dispatch" || command.type === "queued-run.edit";
    if (stored[0] !== undefined && comparable) {
      yield* assertGrant({ sql, command, grantId, hash });
    } else if (stored[0] === undefined) {
      return yield* deny(command.type, "grant-missing");
    } else if (stored[0].revoked_at !== null) {
      return yield* deny(command.type, "grant-revoked");
    }
    const blocked = taskBlocksStart(taskState);
    if (blocked !== null) {
      yield* requestTaskCancellation(sql, taskState.rootThreadId, command.threadId ?? "");
      return yield* deny(command.type, "task-contract", blocked);
    }
    if (command.type === "message.dispatch") {
      yield* reserveGovernedStart({
        sql,
        state: taskState,
        commandType: command.type,
        commandId: command.commandId,
        threadId: command.threadId ?? "",
        messageId: command.messageId ?? null,
      });
    }
    if (operation.kind === "message" && command.dispatchMode?.type !== "queue_after_active") {
      const env = yield* environmentId;
      yield* admitLease({
        sql,
        environmentId: env,
        threadId: command.threadId ?? "",
        messageId: command.messageId ?? command.commandId,
        parentLeaseId: null,
        workloadClass: "foreground-turn",
        nonBlocking: false,
      });
    }
    yield* recordAttempt(sql, command, "continuation");
  });

const IMAGE_DELIVERY_DENIED =
  "Image delivery denied: the bound model no longer has available declared image-input support. Send again with an eligible model or remove the image.";

export const imageDeliveryDenialStatus = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return null;
    const rows = yield* sql.value<{
      settled_at: string | null;
    }>`SELECT settled_at FROM base3_image_delivery_denials WHERE thread_id=${threadId} AND message_id=${messageId}`;
    return rows[0] === undefined
      ? null
      : rows[0].settled_at === null
        ? ("pending" as const)
        : ("settled" as const);
  });

/** A denial permanently removes delivery authority; only its event settlement may be retried. */
export const settleImageDeliveryDenial = <A extends { readonly committed: boolean }, E>(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly settle: Effect.Effect<A, E>;
}) =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql))
      return yield* new Base3PolicyDeniedError({
        reason: "policy-store-unavailable",
        commandType: "image-denial.settle",
      });
    return yield* sql.value.withTransaction(
      Effect.gen(function* () {
        const status = yield* imageDeliveryDenialStatus(input.threadId, input.messageId);
        if (status === "settled") return undefined;
        if (status !== "pending")
          return yield* new Base3PolicyDeniedError({
            reason: "denial-missing",
            commandType: "image-denial.settle",
          });
        const result = yield* input.settle;
        if (!result.committed)
          return yield* new Base3PolicyDeniedError({
            reason: "denial-settlement-stale",
            commandType: "image-denial.settle",
          });
        yield* sql.value`UPDATE base3_image_delivery_denials SET settled_at=${DateTime.formatIso(yield* DateTime.now)} WHERE thread_id=${input.threadId} AND message_id=${input.messageId}`;
        return result;
      }),
    );
  });

export const revalidateImageRoute = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadId: string;
  readonly messageId: string;
  readonly commandType: string;
  readonly target?: { readonly instanceId: ProviderInstanceId; readonly model: string };
}) =>
  Effect.gen(function* () {
    const denied = yield* imageDeliveryDenialStatus(input.threadId, input.messageId).pipe(
      Effect.provideService(SqlClient.SqlClient, input.sql),
    );
    if (denied !== null)
      return yield* deny(input.commandType, "image-eligibility", IMAGE_DELIVERY_DENIED);
    // Queue admission cannot promise that the cached declaration is still current at handoff.
    const route = yield* readDispatcherTaskRoute({
      threadId: ThreadId.make(input.threadId),
      messageId: MessageId.make(input.messageId),
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, input.sql),
      Effect.mapError(
        () =>
          new Base3PolicyDeniedError({
            reason: "binding",
            commandType: input.commandType,
            detail: "Execution route could not be verified.",
          }),
      ),
    );
    if (
      Option.isSome(route) &&
      route.value.modelRoute?.task.requiredCapabilities.includes("vision")
    ) {
      const target = input.target ?? route.value.target;
      const current = calculateDispatcherModelRoute({
        mode: "auto",
        providers: yield* providersForBind,
        preferredTargets: [],
        constraints: {
          requiredCapabilities: ["vision"],
          allowedInstanceIds: [target.instanceId],
          allowedModels: [target.model],
        },
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        localTaskProfile: classifyLocalTask(""),
      });
      if (current.decision.selected === null) {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* input.sql.withTransaction(
          Effect.gen(function* () {
            yield* input.sql`INSERT INTO base3_image_delivery_denials (thread_id,message_id,denied_at) VALUES (${input.threadId},${input.messageId},${now}) ON CONFLICT DO NOTHING`;
            yield* input.sql`UPDATE base3_execution_grants SET revoked_at=COALESCE(revoked_at,${now}) WHERE grant_id=${`grant:message:${input.threadId}:${input.messageId}`}`;
          }),
        );
        return yield* deny(input.commandType, "image-eligibility", IMAGE_DELIVERY_DENIED);
      }
    }
  });

export const revalidateOutboxEffect = (effect: {
  readonly threadId: string;
  readonly commandId?: string | undefined;
  readonly attemptCount?: number | undefined;
  readonly afterInterrupt?: boolean;
  readonly request: {
    readonly type: string;
    readonly runId?: string | undefined;
    readonly messageId?: string | undefined;
    readonly replacementAttemptId?: string | undefined;
  };
}) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind === "kernel-test") return;
    if (effect.request.type === "provider-turn.interrupt") {
      yield* noteInterrupt({ threadId: effect.threadId, runId: effect.request.runId });
      return;
    }
    if (
      effect.request.type !== "provider-turn.start" &&
      effect.request.type !== "provider-turn.steer" &&
      effect.request.type !== "provider-turn.restart" &&
      effect.request.type !== "provider-runtime.continue"
    ) {
      return;
    }
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption))
      return yield* deny(effect.request.type, "policy-store-unavailable");
    const sql = sqlOption.value;
    const env = yield* environmentId;
    const runId = effect.request.runId;
    let messageId = effect.request.messageId;
    let runStatus: string | undefined;
    if (runId !== undefined) {
      const runs = yield* sql<{ readonly status: string; readonly payload_json: string }>`
        SELECT status, payload_json FROM orchestration_v2_projection_runs WHERE run_id = ${runId} LIMIT 1
      `;
      const run = runs[0];
      if (run === undefined)
        return yield* deny(effect.request.type, "unconfirmed", "Run is not visible.");
      runStatus = run.status;
      if (messageId === undefined) {
        const parsed = yield* Effect.try({
          try: () => JSON.parse(run.payload_json) as { userMessageId?: string },
          catch: () => undefined,
        }).pipe(Effect.option);
        messageId = Option.isSome(parsed) ? parsed.value.userMessageId : undefined;
      }
    } else if (messageId === undefined) {
      return yield* deny(effect.request.type, "binding", "Effect is missing a run.");
    }
    if (
      (effect.request.type === "provider-turn.start" ||
        effect.request.type === "provider-turn.restart" ||
        effect.request.type === "provider-turn.steer") &&
      (yield* imageDeliveryDenialStatus(effect.threadId, messageId ?? "").pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      )) !== null
    ) {
      return "image-denied" as const;
    }
    if (runStatus !== undefined && (TERMINAL_RUN_STATUSES as readonly string[]).includes(runStatus))
      return yield* deny(
        effect.request.type,
        "terminal",
        "Terminal runs are not restarted by the outbox.",
      );
    if (
      effect.request.type === "provider-turn.restart" &&
      (effect.request.replacementAttemptId === undefined || effect.request.messageId === undefined)
    )
      return yield* deny(
        effect.request.type,
        "binding",
        "Legacy restart ownership is unconfirmed; no replacement was started.",
      );
    const grantId = `grant:message:${effect.threadId}:${messageId ?? ""}`;
    const grant = (yield* loadGrant(sql, grantId))[0];
    if (grant === undefined || grant.revoked_at !== null) {
      return yield* deny(effect.request.type, "grant-missing");
    }
    if (
      effect.request.type === "provider-turn.restart" ||
      effect.request.type === "provider-turn.steer"
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      if (grant.expires_at !== null && grant.expires_at <= now)
        return yield* deny(effect.request.type, "grant-expired");
      if (effect.request.type === "provider-turn.restart") {
        const owned = yield* sql`
          SELECT lease.lease_id FROM base3_capacity_leases AS lease
          JOIN orchestration_v2_projection_runs AS run ON run.run_id=lease.run_id AND run.thread_id=lease.thread_id
          WHERE lease.thread_id=${effect.threadId} AND lease.run_id=${runId ?? null}
            AND lease.environment_id=${env} AND lease.status='active' AND lease.released_at IS NULL
            AND lease.interrupt_requested=0 AND lease.disconnect_unconfirmed=0
            AND run.status='starting'
            AND json_extract(run.payload_json,'$.userMessageId')=${messageId ?? null}
            AND (${effect.request.replacementAttemptId ?? null} IS NULL OR json_extract(run.payload_json,'$.activeAttemptId')=${effect.request.replacementAttemptId ?? null})
        `;
        if (owned.length !== 1) return yield* deny(effect.request.type, "active-run-ownership");
      }
    }
    const taskState = yield* loadTaskState(sql, effect.threadId, effect.request.type);
    if (
      (effect.request.type === "provider-turn.restart"
        ? effect.afterInterrupt === true
        : !effect.afterInterrupt) &&
      (effect.request.type === "provider-turn.start" ||
        effect.request.type === "provider-turn.restart" ||
        effect.request.type === "provider-runtime.continue")
    ) {
      yield* reserveProviderHandoff({
        sql,
        state: taskState,
        commandId: effect.commandId ?? grantId,
        threadId: effect.threadId,
        messageId: messageId ?? null,
        effectType: effect.request.type,
        attemptCount:
          effect.request.type === "provider-turn.restart" ? 1 : (effect.attemptCount ?? 1),
      });
    } else {
      const blocked = taskBlocksStart(taskState);
      if (blocked !== null) {
        yield* requestTaskCancellation(sql, taskState.rootThreadId, effect.threadId);
        return yield* deny(effect.request.type, "task-contract", blocked);
      }
    }
    if (effect.request.type === "provider-turn.start") {
      const existing = yield* sql`SELECT lease_id FROM base3_capacity_leases
        WHERE environment_id=${env} AND thread_id=${effect.threadId} AND released_at IS NULL AND status='active'
          AND (run_id=${runId ?? null} OR (run_id IS NULL AND message_id=${messageId ?? null}))`;
      if (existing.length === 0)
        yield* sql.withTransaction(
          admitLease({
            sql,
            environmentId: env,
            threadId: effect.threadId,
            messageId: messageId ?? null,
            parentLeaseId: null,
            workloadClass: "foreground-turn",
            nonBlocking: false,
          }),
        );
    }
    if (runId !== undefined) {
      yield* sql`
        UPDATE base3_capacity_leases
        SET run_id = ${runId}
        WHERE environment_id = ${env} AND thread_id = ${effect.threadId}
          AND message_id = ${messageId ?? null}
          AND released_at IS NULL
          AND run_id IS NULL
      `;
    }
  });

export const issueContinuationGrant = (input: {
  readonly grantId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly runId: string | null;
  readonly operation: string;
  readonly hash: string;
}) =>
  Effect.gen(function* () {
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return yield* deny(input.operation, "policy-store-unavailable");
    const rows = yield* sqlOption.value<{
      readonly actor_id: string;
      readonly scopes_json: string;
    }>`
      SELECT actor_id, scopes_json FROM base3_execution_grants
      WHERE thread_id = ${input.threadId} AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const prior = rows[0];
    if (prior === undefined) return yield* deny(input.operation, "grant-missing");
    const scopes = JSON.parse(prior.scopes_json) as ReadonlyArray<string>;
    yield* insertGrant({
      sql: sqlOption.value,
      grantId: input.grantId,
      threadId: input.threadId,
      messageId: input.messageId,
      runId: input.runId,
      operation: input.operation,
      actorId: prior.actor_id,
      scopes,
      expiresAt: null,
      hash: input.hash,
      approvalId: null,
    });
  });

export const authorizeScheduleUpsert = (input: {
  readonly taskId: string;
  readonly threadId: string | null;
  readonly prompt: string;
  readonly modelSelection?: ModelSelection;
  readonly createdBy: string;
  readonly creationSource: string;
}) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    const unattended = input.createdBy === "agent" || input.creationSource === "mcp";
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return yield* deny("schedule_task", "policy-store-unavailable");
    const sql = sqlOption.value;
    const env = yield* environmentId;
    let approvalId: string | null = null;
    if (unattended) {
      // Kernel tests are not a session and cannot satisfy ASK. Agent and MCP
      // schedules stay fail-closed until a real operate session is approved.
      if (context.kind !== "session" || !hasOperate(context.scopes)) {
        return yield* deny("schedule_task", "unauthenticated");
      }
      approvalId = yield* requireAsk({
        sql,
        commandType: "schedule_task",
        toolName: "schedule_task",
        args: { prompt: input.prompt, taskId: input.taskId },
        environmentId: env,
        threadId: input.threadId ?? input.taskId,
      });
    } else if (context.kind === "absent") {
      return yield* deny("schedule_task", "unauthenticated");
    } else if (context.kind === "session" && !hasOperate(context.scopes)) {
      return yield* deny("schedule_task", "missing-operate-scope");
    }
    // User schedules from the Vitest operate subject must leave a grant.
    // Firing replaces that subject with server-continuation, which revalidates
    // the stored grant instead of trusting the caller.
    const actorId =
      context.kind === "session" || context.kind === "kernel-test" ? context.actorId : "server";
    const scopes =
      context.kind === "session" || context.kind === "kernel-test" ? context.scopes : [];
    yield* insertGrant({
      sql,
      grantId: `grant:schedule:${input.taskId}`,
      threadId: input.threadId ?? input.taskId,
      messageId: input.taskId,
      runId: null,
      operation: "schedule",
      actorId,
      scopes,
      expiresAt: null,
      // Bind the same message arguments that firing revalidates, including option presence.
      // Old grants that omit saved options need an authorized re-save; never repair at fire time.
      // Governed threads additionally bind contractGrantFields at continuation admission;
      // this schedule grant does not authorize a contract and must still fail closed there.
      hash: argumentHash(
        messageArguments({
          type: "message.dispatch",
          commandId: `schedule:${input.taskId}`,
          text: input.prompt,
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        }),
      ),
      approvalId,
    });
  });

export const actorForThread = (threadId: string) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind === "session") {
      return {
        actorId: context.actorId,
        sessionId: context.sessionId,
        scopes: context.scopes,
      };
    }
    if (context.kind === "kernel-test") {
      return { actorId: "kernel-test", sessionId: "kernel-test", scopes: context.scopes };
    }
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return null;
    const rows = yield* sqlOption.value<{
      readonly actor_id: string;
      readonly scopes_json: string;
    }>`
      SELECT actor_id, scopes_json FROM base3_execution_grants
      WHERE thread_id = ${threadId} AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const scopes = JSON.parse(row.scopes_json) as ReadonlyArray<AuthEnvironmentScope>;
    return { actorId: row.actor_id, sessionId: "grant", scopes };
  });

const isPreviewInput = Schema.is(TaskAutoPreviewInput);
const samePreviewContract = Schema.toEquivalence(TaskContract);
const samePreviewReview = Schema.toEquivalence(TaskContractReviewState);
const samePreviewReference = Schema.toEquivalence(TaskContractReviewReference);

/** Read-only service implementation: identity failure never becomes a routing fallback. */
export const readTaskAutoPreview = Effect.fn("Base3.readTaskAutoPreview")(
  function* (
    sql: SqlClient.SqlClient,
    input: TaskAutoPreviewInput,
    readProjection: (
      id: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>,
  ) {
    const unavailable: TaskAutoPreviewState = {
      status: "unavailable",
      reason: "task-preview-unavailable",
    };
    if (!isPreviewInput(input)) return unavailable;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const before = yield* readTaskReview(sql, input);
        if (
          before.status !== "available" ||
          before.phase !== "active" ||
          before.acceptedRevision !== null ||
          !before.actions.includes("accept") ||
          !samePreviewReference(before.reference, input.reference)
        )
          return unavailable;
        const projection = yield* readProjection(ThreadId.make(input.threadId));
        const after = yield* readTaskReview(sql, input);
        const t = projection.thread;
        if (
          after.status !== "available" ||
          !samePreviewReview(before, after) ||
          t.id !== input.threadId ||
          t.projectId !== input.projectId ||
          t.title !== after.title ||
          t.taskGovernance !== "required" ||
          !t.taskContract ||
          !samePreviewContract(after.contract, t.taskContract) ||
          t.taskContractPhase !== "active" ||
          t.taskAcceptedRevision !== null ||
          t.archivedAt !== null ||
          t.deletedAt !== null ||
          t.forkedFrom !== null ||
          t.lineage.rootThreadId !== t.id ||
          t.lineage.parentThreadId !== null ||
          t.lineage.relationshipToParent !== null ||
          t.activeProviderThreadId !== null ||
          DateTime.formatIso(t.updatedAt) !== after.reference.threadUpdatedAt ||
          projection.messages.length !== 0 ||
          projection.runs.length !== 0 ||
          projection.attempts.length !== 0 ||
          projection.nodes.length !== 0 ||
          projection.providerThreads.length !== 0 ||
          projection.providerTurns.length !== 0 ||
          projection.providerSessions.length !== 0 ||
          projection.runtimeRequests.length !== 0
        )
          return unavailable;
        const env = EnvironmentId.make(input.environmentId);
        const profile = classifyLocalTask(input.text);
        const providers = yield* providersForBind;
        const settings = yield* Effect.serviceOption(ServerSettingsService);
        const defaultSelection = Option.isNone(settings)
          ? null
          : yield* settings.value.getSettings.pipe(
              Effect.map((s) => s.defaultModelSelection),
              Effect.orElseSucceed(() => null),
            );
        const projected = yield* readDispatcherProjectedState({ threadId: t.id }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const project = projected.projects.find((p) => p.id === input.projectId);
        if (
          !project ||
          !projected.threads.some((p) => p.id === t.id && p.projectId === input.projectId)
        )
          return unavailable;
        const evaluation = yield* Effect.serviceOption(RouterEvaluation.RouterEvaluationService);
        const existing = Option.isNone(evaluation)
          ? { snapshot: Option.none(), unavailable: true }
          : yield* evaluation.value.existingRoutingSnapshot(env, profile).pipe(
              Effect.match({
                onFailure: () => ({ snapshot: Option.none(), unavailable: true }),
                onSuccess: (snapshot) => ({ snapshot, unavailable: false }),
              }),
            );
        const snapshot = existing.snapshot;
        const policyFallbackReason = Option.isSome(snapshot)
          ? null
          : existing.unavailable
            ? "Policy snapshot unavailable; ephemeral Router V0 used without initialization."
            : "Policy snapshot uninitialized; ephemeral Router V0 used without initialization.";
        const hybrid = Option.isSome(snapshot)
          ? RouterEvaluation.routingPolicyInput(snapshot.value)
          : existing.unavailable
            ? unavailableRoutingPolicy()
            : {
                activePolicyVersion: MODEL_ROUTER_POLICY_VERSION,
                challengerEnabled: false,
                evidenceByTarget: new Map(),
              };
        const calculation = calculateDispatcherModelRoute({
          mode: "auto",
          providers,
          preferredTargets: [
            ...(project.defaultModelSelection ? [project.defaultModelSelection] : []),
            ...(defaultSelection ? [defaultSelection] : []),
          ],
          nowMs: DateTime.toEpochMillis(yield* DateTime.now),
          localTaskProfile: profile,
          hybrid,
          executionStatus: "not-started",
          ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
        });
        return {
          status: "available" as const,
          request: input,
          reference: after.reference,
          profile,
          activePolicyVersion: hybrid.activePolicyVersion,
          policyFallbackReason,
          decision: calculation.decision,
          ...(calculation.hybrid === undefined ? {} : { hybrid: calculation.hybrid }),
        };
      }),
    );
  },
  Effect.catch(() =>
    Effect.succeed({ status: "unavailable" as const, reason: "task-preview-unavailable" as const }),
  ),
);
