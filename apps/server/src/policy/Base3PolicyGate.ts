// Argument hashes are canonical JSON. A schema codec would change the bytes
// a grant is compared against after a queue delay.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  defaultConcurrencyBudgetPolicy,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ActionGateService } from "../actionGate/ActionGateService.ts";
import {
  bindDispatcherTurnStartCommand,
  bindingForExplicitTarget,
  deleteDispatcherTaskRoutesByThread,
  persistDispatcherTaskRoute,
  type DispatcherTurnStartCommand,
} from "../dispatcher/Dispatcher.ts";
import { deleteTaskHandoffsByThread } from "../dispatcher/Handoff.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  PolicyExecutionContext,
  type PolicyExecutionContext as PolicyContext,
} from "./executionContext.ts";
import { classifyCommand, commandNeedsCapacity, type OperationClass } from "./operationPolicy.ts";

const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
] as const;

export class Base3PolicyDeniedError extends Schema.TaggedError<Base3PolicyDeniedError>()(
  "Base3PolicyDeniedError",
  {
    reason: Schema.String,
    commandType: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ?? `Base3 policy denied ${this.commandType} (${this.reason}).`;
  }
}

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
  readonly scheduledTaskId?: string;
  readonly usageLimitContinuationOfRunId?: string;
  readonly manualContinuationOfRunId?: string;
  readonly restartContinuationOfRunId?: string;
  readonly delegatedCompletion?: unknown;
  readonly dispatchMode?: { readonly type: string };
  readonly attachments?: ReadonlyArray<{ readonly id?: string }>;
  readonly task?: string;
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

const messageArguments = (command: DispatchPolicyCommand) => ({
  text: command.text ?? "",
  model: command.modelSelection?.model ?? null,
  instanceId: command.modelSelection?.instanceId ?? null,
  attachmentIds: (command.attachments ?? []).map((attachment) => attachment.id ?? ""),
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
          FROM base3_capacity_leases l
          LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = l.run_id
          WHERE l.environment_id = ${input.environmentId}
            AND l.thread_id = ${input.threadId}
            AND l.released_at IS NULL
            AND l.status = 'active'
            AND (
              l.run_id IS NULL
              OR r.run_id IS NULL
              OR r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
            )
        `
      : input.workloadClass !== undefined
        ? input.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM base3_capacity_leases l
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = l.run_id
            WHERE l.environment_id = ${input.environmentId}
              AND l.workload_class = ${input.workloadClass}
              AND l.released_at IS NULL
              AND l.status = 'active'
              AND (
                l.run_id IS NULL
                OR r.run_id IS NULL
                OR r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
              )
          `
        : input.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM base3_capacity_leases l
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = l.run_id
            WHERE l.environment_id = ${input.environmentId}
              AND l.released_at IS NULL
              AND l.status = 'active'
              AND (
                l.run_id IS NULL
                OR r.run_id IS NULL
                OR r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
              )
          `;
  return query.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
};

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
    const threadRows = yield* input.sql<{ readonly model_selection_json: string | null }>`
      SELECT model_selection_json AS "model_selection_json"
      FROM projection_threads
      WHERE thread_id = ${input.command.threadId}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as { readonly model_selection_json: string | null }[]));
    const threadModel = decodeModel(threadRows[0]?.model_selection_json);
    const preferred = input.command.modelSelection ?? threadModel ?? undefined;
    const turn: DispatcherTurnStartCommand = {
      type: "thread.turn.start",
      threadId: ThreadId.make(input.command.threadId),
      message: {
        messageId: MessageId.make(input.command.messageId),
        text: input.command.text ?? "",
      },
      routingMode,
      ...(preferred === undefined ? {} : { modelSelection: preferred }),
    };
    const bound = yield* bindDispatcherTurnStartCommand(turn, {
      enabled: true,
      environmentId: Effect.succeed(input.environmentId),
      providers: Effect.succeed(input.providers),
      environmentDefaultModelSelection: Effect.succeed(null),
      sql: input.sql,
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
    return binding;
  });

function decodeModel(json: string | null | undefined): ModelSelection | null {
  if (json === null || json === undefined || json.length === 0) return null;
  try {
    const parsed = JSON.parse(json) as { instanceId?: string; model?: string };
    if (parsed.instanceId === undefined || parsed.model === undefined) return null;
    return {
      instanceId: ProviderInstanceId.make(parsed.instanceId),
      model: parsed.model,
    };
  } catch {
    return null;
  }
}

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

export const authorizeDispatch = (
  input: DispatchPolicyCommand | { readonly type: string; readonly commandId: string },
) => {
  const command = input as DispatchPolicyCommand;
  return Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    const operation = classifyCommand(command.type);
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
      const approvalId = yield* requireAsk({
        sql,
        commandType: command.type,
        toolName: "delegate_task",
        args: { task: command.task ?? "", model: command.modelSelection ?? null },
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
        hash: argumentHash({ task: command.task ?? "", model: command.modelSelection ?? null }),
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
      yield* bindRoute({ sql, command, providers: catalog, environmentId: env });
      if (command.dispatchMode?.type !== "queue_after_active" && commandNeedsCapacity(operation)) {
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
      const hash = argumentHash(messageArguments(command));
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
      return;
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
    const hash = argumentHash(
      command.type === "queued-run.edit" || command.type === "message.dispatch"
        ? messageArguments(command)
        : { commandId: command.commandId, type: command.type },
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

export const revalidateOutboxEffect = (effect: {
  readonly threadId: string;
  readonly request: {
    readonly type: string;
    readonly runId?: string | undefined;
    readonly messageId?: string | undefined;
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
    const runId = effect.request.runId;
    let messageId = effect.request.messageId;
    if (runId !== undefined) {
      const runs = yield* sql<{ readonly status: string; readonly payload_json: string }>`
        SELECT status, payload_json FROM orchestration_v2_projection_runs WHERE run_id = ${runId} LIMIT 1
      `;
      const run = runs[0];
      if (run === undefined)
        return yield* deny(effect.request.type, "unconfirmed", "Run is not visible.");
      if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
        return yield* deny(
          effect.request.type,
          "terminal",
          "Terminal runs are not restarted by the outbox.",
        );
      }
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
    const grantId = `grant:message:${effect.threadId}:${messageId ?? ""}`;
    const grant = (yield* loadGrant(sql, grantId))[0];
    if (grant === undefined || grant.revoked_at !== null) {
      return yield* deny(effect.request.type, "grant-missing");
    }
    if (runId !== undefined) {
      yield* sql`
        UPDATE base3_capacity_leases
        SET run_id = ${runId}
        WHERE thread_id = ${effect.threadId}
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
  readonly model: string | null;
  readonly instanceId: string | null;
  readonly createdBy: string;
  readonly creationSource: string;
}) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind === "kernel-test") return;
    const unattended = input.createdBy === "agent" || input.creationSource === "mcp";
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) return yield* deny("schedule_task", "policy-store-unavailable");
    const sql = sqlOption.value;
    const env = yield* environmentId;
    let approvalId: string | null = null;
    if (unattended) {
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
    const actorId = context.kind === "session" ? context.actorId : "server";
    const scopes = context.kind === "session" ? context.scopes : [];
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
      hash: argumentHash({
        text: input.prompt,
        model: input.model,
        instanceId: input.instanceId,
        attachmentIds: [],
      }),
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
