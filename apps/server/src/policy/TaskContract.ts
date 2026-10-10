/**
 * Admission gate for a persisted task contract.
 * A brake reserves a start and requests cancellation. It does not release a lease.
 */
// Persisted thread payloads are already JSON text in SQLite.
// @effect-diagnostics preferSchemaOverJson:off
import {
  childConstraintConflict,
  incompleteTaskContractMessage,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  TASK_CONTRACT_HUMAN_DECISION,
  type OrchestrationV2AppThread,
  type TaskContract,
  type TaskContractDecision,
  type TaskContractFields,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import { Base3PolicyDeniedError } from "./Base3PolicyDeniedError.ts";

const StoredTaskPayload = Schema.Struct({
  taskGovernance: Schema.optional(Schema.Literals(["chat", "required"])),
  taskContract: Schema.optional(Schema.NullOr(Schema.Unknown)),
  taskContractPhase: Schema.optional(Schema.Literals(["active", "redirected"])),
  taskAcceptedRevision: Schema.optional(Schema.NullOr(Schema.Number)),
  lineage: Schema.optional(
    Schema.Struct({
      rootThreadId: Schema.optional(Schema.String),
    }),
  ),
});

export interface PersistedTaskState {
  readonly governance: "chat" | "required";
  readonly contract: TaskContract | null;
  readonly phase: "active" | "redirected";
  readonly acceptedRevision: number | null;
  readonly rootThreadId: string;
}

export function taskStateFromUnknown(threadId: string, payload: unknown): PersistedTaskState {
  const parsed = Schema.decodeUnknownOption(StoredTaskPayload)(payload);
  if (parsed._tag === "None") {
    return {
      governance: "chat",
      contract: null,
      phase: "active",
      acceptedRevision: null,
      rootThreadId: threadId,
    };
  }
  const value = parsed.value;
  const governance = value.taskGovernance ?? "chat";
  const contractOption =
    value.taskContract === undefined || value.taskContract === null
      ? null
      : Schema.decodeUnknownOption(
          Schema.Struct({
            revision: Schema.Number,
            goal: Schema.String,
            redirect: Schema.String,
            acceptance: Schema.String,
            brake: Schema.Struct({
              maxProviderStarts: Schema.Number,
              stopConditions: Schema.String,
            }),
          }),
        )(value.taskContract);
  const contract =
    contractOption !== null && contractOption._tag === "Some"
      ? (contractOption.value as TaskContract)
      : null;
  return {
    governance,
    contract,
    phase: value.taskContractPhase ?? "active",
    acceptedRevision:
      typeof value.taskAcceptedRevision === "number" ? value.taskAcceptedRevision : null,
    rootThreadId: value.lineage?.rootThreadId ?? threadId,
  };
}

export const loadTaskState = (
  sql: SqlClient.SqlClient,
  threadId: string,
  commandType = "message.dispatch",
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return taskStateFromUnknown(threadId, {});
    }
    const payload = yield* Effect.try({
      try: () => JSON.parse(row.payload_json) as unknown,
      catch: () => row.payload_json,
    });
    if (typeof payload === "string") {
      return yield* new Base3PolicyDeniedError({
        reason: "task-contract",
        commandType,
        detail: "The persisted thread could not be read. No provider was started.",
      });
    }
    return taskStateFromUnknown(threadId, payload);
  }).pipe(asPolicyDenial(commandType));

export function nextTaskContractThread(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly actorId: string;
  readonly now: DateTime.Utc;
  readonly command:
    | {
        readonly type: "thread.task-contract.set";
        readonly goal: string;
        readonly redirect: string;
        readonly acceptance: string;
        readonly brake: TaskContractFields["brake"];
      }
    | { readonly type: "thread.task-contract.accept"; readonly revision: number }
    | { readonly type: "thread.task-contract.redirect"; readonly revision: number }
    | { readonly type: "thread.task-contract.resume"; readonly revision: number };
}):
  | { readonly error: string }
  | { readonly thread: OrchestrationV2AppThread; readonly rootThreadId: string } {
  const current = input.thread.taskContract ?? null;
  const decision = (
    kind: TaskContractDecision["kind"],
    revision: number,
  ): TaskContractDecision => ({
    kind,
    revision,
    actorId: input.actorId,
    at: input.now,
  });
  const withDecision = (
    thread: OrchestrationV2AppThread,
    next: TaskContractDecision,
  ): OrchestrationV2AppThread => ({
    ...thread,
    taskDecisions: [...(thread.taskDecisions ?? []), next],
    updatedAt: input.now,
  });
  if (input.command.type === "thread.task-contract.set") {
    const revision = (current?.revision ?? 0) + 1;
    const contract: TaskContract = {
      revision,
      goal: input.command.goal,
      redirect: input.command.redirect,
      acceptance: input.command.acceptance,
      brake: input.command.brake,
    };
    return {
      rootThreadId: input.thread.lineage.rootThreadId,
      thread: withDecision(
        {
          ...input.thread,
          taskGovernance: "required",
          taskContract: contract,
          taskContractPhase: "active",
          taskAcceptedRevision: null,
        },
        decision("set", revision),
      ),
    };
  }
  if (current === null || input.thread.taskGovernance !== "required") {
    return { error: incompleteTaskContractMessage() };
  }
  if (input.command.revision !== current.revision) {
    return {
      error: `Contract revision ${input.command.revision} does not match persisted revision ${current.revision}. The previous approval was not reused.`,
    };
  }
  if (input.command.type === "thread.task-contract.accept") {
    return {
      rootThreadId: input.thread.lineage.rootThreadId,
      thread: withDecision(
        { ...input.thread, taskAcceptedRevision: current.revision },
        decision("accept", current.revision),
      ),
    };
  }
  if (input.command.type === "thread.task-contract.resume") {
    if (input.thread.taskContractPhase !== "redirected") {
      return {
        error: `Contract revision ${current.revision} is not paused for redirect. Resume does not start a provider by itself.`,
      };
    }
    return {
      rootThreadId: input.thread.lineage.rootThreadId,
      thread: withDecision(
        { ...input.thread, taskContractPhase: "active" },
        decision("resume", current.revision),
      ),
    };
  }
  return {
    rootThreadId: input.thread.lineage.rootThreadId,
    thread: withDecision(
      { ...input.thread, taskContractPhase: "redirected" },
      decision("redirect", current.revision),
    ),
  };
}

/**
 * A governed thread stays governed. Updates that omit the contract cannot turn
 * it back into ordinary chat. An explicit required revision still replaces it.
 */
export function retainGovernedTask<T extends Record<string, unknown>>(
  previous: unknown,
  next: T,
): T {
  if (previous === null || previous === undefined || typeof previous !== "object") return next;
  const stored = previous as {
    readonly id?: unknown;
    readonly taskGovernance?: unknown;
    readonly taskContract?: unknown;
    readonly taskContractPhase?: unknown;
    readonly taskAcceptedRevision?: unknown;
    readonly taskDecisions?: unknown;
  };
  if (stored.taskGovernance !== "required") return next;
  if (stored.id !== undefined && next.id !== undefined && stored.id !== next.id) return next;
  if (next.taskGovernance === "required") return next;
  return {
    ...next,
    taskGovernance: "required",
    taskContract: stored.taskContract,
    taskContractPhase: stored.taskContractPhase,
    taskAcceptedRevision: stored.taskAcceptedRevision,
    taskDecisions: stored.taskDecisions,
  };
}

export function retainGovernedJson<T extends Record<string, unknown>>(
  previousJson: string | null,
  next: T,
): T {
  if (previousJson === null) return next;
  try {
    return retainGovernedTask(JSON.parse(previousJson) as unknown, next);
  } catch {
    return next;
  }
}

export function taskBlocksStart(state: PersistedTaskState): string | null {
  if (state.governance !== "required") return null;
  if (state.contract === null) return incompleteTaskContractMessage();
  if (state.phase === "redirected") {
    return `Execution is paused for revised instructions at contract revision ${state.contract.revision}. Resume that revision with thread.task-contract.resume before more work starts. ${TASK_CONTRACT_HUMAN_DECISION}`;
  }
  if (state.acceptedRevision === state.contract.revision) {
    return `Contract revision ${state.contract.revision} is already accepted. Provider completion is not acceptance, and a new revision is required before more work starts.`;
  }
  return null;
}

const deny = (commandType: string, detail: string) =>
  new Base3PolicyDeniedError({
    reason: "task-contract",
    commandType,
    detail,
  });

const storeFailure = (commandType: string) =>
  new Base3PolicyDeniedError({
    reason: "policy-store-unavailable",
    commandType,
    detail: "Task contract enforcement could not use the policy store. No provider was started.",
  });

const asPolicyDenial =
  (commandType: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.is(Base3PolicyDeniedError)(cause) ? cause : storeFailure(commandType),
      ),
    );

const encodeInterrupt = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

/**
 * Ask the V2 outbox to interrupt running provider turns on this task tree.
 * The lease flag is the same signal `noteInterrupt` records. The outbox row
 * is what EffectWorker delivers to the provider. Neither releases a lease.
 */
export const requestTaskCancellation = (
  sql: SqlClient.SqlClient,
  rootThreadId: string,
  threadId: string,
) =>
  Effect.gen(function* () {
    yield* sql`
      UPDATE base3_capacity_leases
      SET interrupt_requested = 1
      WHERE released_at IS NULL
        AND (
          thread_id = ${rootThreadId}
          OR thread_id = ${threadId}
          OR thread_id IN (
            SELECT thread_id FROM task_contract_members WHERE root_thread_id = ${rootThreadId}
          )
        )
    `;
    const turns = yield* sql<{
      readonly provider_turn_id: string;
      readonly provider_thread_id: string;
      readonly thread_id: string;
      readonly provider_session_id: string;
    }>`
      SELECT
        turn.provider_turn_id,
        turn.provider_thread_id,
        turn.thread_id,
        thread.provider_session_id
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_provider_threads AS thread
        ON thread.provider_thread_id = turn.provider_thread_id
      WHERE turn.status = 'running'
        AND thread.provider_session_id IS NOT NULL
        AND (
          turn.thread_id = ${rootThreadId}
          OR turn.thread_id = ${threadId}
          OR turn.thread_id IN (
            SELECT thread_id FROM task_contract_members WHERE root_thread_id = ${rootThreadId}
          )
        )
    `;
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    for (const turn of turns) {
      const request = {
        type: "provider-turn.interrupt" as const,
        providerSessionId: ProviderSessionId.make(turn.provider_session_id),
        providerThreadId: ProviderThreadId.make(turn.provider_thread_id),
        providerTurnId: ProviderTurnId.make(turn.provider_turn_id),
      };
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:task-contract-cancel:${turn.provider_turn_id}`},
          ${`task-contract-cancel:${turn.provider_turn_id}`},
          ${turn.thread_id},
          'provider-turn.interrupt',
          ${encodeInterrupt(request)},
          'pending',
          0,
          ${now},
          ${now},
          ${now}
        )
        ON CONFLICT(effect_id) DO NOTHING
      `;
    }
  });

export const countTaskAdmissions = (sql: SqlClient.SqlClient, rootThreadId: string) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM task_contract_admissions
    WHERE root_thread_id = ${rootThreadId}
  `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

export const revokeTaskContractGrants = (sql: SqlClient.SqlClient, rootThreadId: string) =>
  Effect.gen(function* () {
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* sql`
      UPDATE base3_execution_grants
      SET revoked_at = ${now}
      WHERE revoked_at IS NULL
        AND (
          thread_id = ${rootThreadId}
          OR thread_id IN (
            SELECT thread_id FROM task_contract_members WHERE root_thread_id = ${rootThreadId}
          )
        )
    `;
  });

/**
 * Block a provider start that the persisted contract does not allow.
 * Chat returns without touching grants or leases. A successful governed start
 * inserts one admission row for this command id.
 */
export const reserveGovernedStart = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly state: PersistedTaskState;
  readonly commandType: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId?: string | null;
  readonly proposed?: TaskContractFields | null;
}) =>
  Effect.gen(function* () {
    if (input.state.governance !== "required") {
      if (input.proposed !== undefined && input.proposed !== null) {
        return yield* deny(
          input.commandType,
          "Ordinary chat cannot delegate a governed contract. No provider was started.",
        );
      }
      return;
    }
    const contract = input.state.contract;
    if (contract === null) {
      return yield* deny(input.commandType, incompleteTaskContractMessage());
    }
    if (input.proposed !== undefined && input.proposed !== null) {
      const conflict = childConstraintConflict(contract, input.proposed);
      if (conflict !== null) {
        return yield* deny(input.commandType, `${conflict} No provider was started.`);
      }
    }
    const blocked = taskBlocksStart(input.state);
    if (blocked !== null) {
      if (input.state.phase === "redirected") {
        yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
      }
      return yield* deny(input.commandType, blocked);
    }
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* input.sql`
      INSERT OR IGNORE INTO task_contract_members (thread_id, root_thread_id, revision)
      VALUES (${input.threadId}, ${input.state.rootThreadId}, ${contract.revision})
    `;
    yield* input.sql`
      INSERT INTO task_contract_admissions (
        root_thread_id, command_id, thread_id, contract_revision, message_id, created_at
      )
      SELECT
        ${input.state.rootThreadId},
        ${input.commandId},
        ${input.threadId},
        ${contract.revision},
        ${input.messageId ?? null},
        ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM task_contract_admissions
        WHERE root_thread_id = ${input.state.rootThreadId}
          AND command_id = ${input.commandId}
      )
      AND (
        SELECT COUNT(*) FROM task_contract_admissions
        WHERE root_thread_id = ${input.state.rootThreadId}
      ) < ${contract.brake.maxProviderStarts}
    `;
    const rows = yield* input.sql<{ readonly contract_revision: number }>`
      SELECT contract_revision FROM task_contract_admissions
      WHERE root_thread_id = ${input.state.rootThreadId}
        AND command_id = ${input.commandId}
      LIMIT 1
    `;
    const reserved = rows[0];
    if (reserved === undefined) {
      yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
      return yield* deny(
        input.commandType,
        `Brake exhausted: ${contract.brake.maxProviderStarts} provider starts are already reserved on this task. Active work was asked to cancel and stays leased until the provider turn is confirmed terminal.`,
      );
    }
    if (reserved.contract_revision !== contract.revision) {
      return yield* deny(
        input.commandType,
        `This dispatch was reserved for contract revision ${reserved.contract_revision} and cannot reuse that grant for revision ${contract.revision}.`,
      );
    }
  }).pipe(asPolicyDenial(input.commandType));

/**
 * Count a provider handoff against the same tree budget.
 * The first `provider-turn.start` for an admitted command or message reuses
 * that reservation. A later claim of the same effect is a retry. Restart and
 * runtime continuation are failover handoffs and each take another slot.
 * Editing the contract does not delete earlier rows.
 */
export const reserveProviderHandoff = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly state: PersistedTaskState;
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId?: string | null;
  readonly effectType: string;
  readonly attemptCount: number;
}) =>
  Effect.gen(function* () {
    if (input.state.governance !== "required") return;
    const blocked = taskBlocksStart(input.state);
    if (blocked !== null) {
      yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
      return yield* deny(input.effectType, blocked);
    }
    const contract = input.state.contract;
    if (contract === null) return yield* deny(input.effectType, incompleteTaskContractMessage());
    const covered =
      input.effectType === "provider-turn.start" && input.attemptCount <= 1
        ? yield* input.sql<{ readonly contract_revision: number }>`
            SELECT contract_revision FROM task_contract_admissions
            WHERE root_thread_id = ${input.state.rootThreadId}
              AND command_id NOT LIKE 'handoff:%'
              AND (
                command_id = ${input.commandId}
                OR message_id = ${input.messageId ?? null}
              )
            LIMIT 1
          `
        : [];
    const reservation = covered[0];
    if (reservation !== undefined) {
      if (reservation.contract_revision !== contract.revision) {
        yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
        return yield* deny(
          input.effectType,
          `This queued start was reserved for contract revision ${reservation.contract_revision} and was not reused for revision ${contract.revision}.`,
        );
      }
      return;
    }
    const key = `handoff:${input.effectType}:${input.messageId ?? input.commandId}:${input.attemptCount}`;
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* input.sql`
      INSERT INTO task_contract_admissions (
        root_thread_id, command_id, thread_id, contract_revision, message_id, created_at
      )
      SELECT
        ${input.state.rootThreadId},
        ${key},
        ${input.threadId},
        ${contract.revision},
        ${input.messageId ?? null},
        ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM task_contract_admissions
        WHERE root_thread_id = ${input.state.rootThreadId}
          AND command_id = ${key}
      )
      AND (
        SELECT COUNT(*) FROM task_contract_admissions
        WHERE root_thread_id = ${input.state.rootThreadId}
      ) < ${contract.brake.maxProviderStarts}
    `;
    const rows = yield* input.sql<{ readonly command_id: string }>`
      SELECT command_id FROM task_contract_admissions
      WHERE root_thread_id = ${input.state.rootThreadId}
        AND command_id = ${key}
      LIMIT 1
    `;
    if (rows[0] === undefined) {
      yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
      return yield* deny(
        input.effectType,
        `Brake exhausted: ${contract.brake.maxProviderStarts} provider starts are already reserved on this task. A retry or failover was not given another start. Active work was asked to cancel and stays leased until the provider turn is confirmed terminal.`,
      );
    }
  }).pipe(asPolicyDenial(input.effectType));
