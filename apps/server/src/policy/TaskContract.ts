/**
 * Admission gate for a persisted task contract.
 * A brake reserves a start and requests cancellation. It does not release a lease.
 */
// Persisted thread payloads are already JSON text in SQLite.
// @effect-diagnostics preferSchemaOverJson:off
import {
  childConstraintConflict,
  incompleteTaskContractMessage,
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
    | { readonly type: "thread.task-contract.redirect"; readonly revision: number };
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
  return {
    rootThreadId: input.thread.lineage.rootThreadId,
    thread: withDecision(
      { ...input.thread, taskContractPhase: "redirected" },
      decision("redirect", current.revision),
    ),
  };
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

const requestTreeCancellation = (
  sql: SqlClient.SqlClient,
  rootThreadId: string,
  threadId: string,
) =>
  sql`
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
    if (input.state.phase === "redirected") {
      yield* requestTreeCancellation(input.sql, input.state.rootThreadId, input.threadId);
      return yield* deny(
        input.commandType,
        `Execution is paused for revised instructions at contract revision ${contract.revision}. ${TASK_CONTRACT_HUMAN_DECISION}`,
      );
    }
    if (input.state.acceptedRevision === contract.revision) {
      return yield* deny(
        input.commandType,
        `Contract revision ${contract.revision} is already accepted. Provider completion is not acceptance, and a new revision is required before more work starts.`,
      );
    }
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* input.sql`
      INSERT OR IGNORE INTO task_contract_members (thread_id, root_thread_id, revision)
      VALUES (${input.threadId}, ${input.state.rootThreadId}, ${contract.revision})
    `;
    yield* input.sql`
      INSERT INTO task_contract_admissions (
        root_thread_id, command_id, thread_id, contract_revision, created_at
      )
      SELECT
        ${input.state.rootThreadId},
        ${input.commandId},
        ${input.threadId},
        ${contract.revision},
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
      yield* requestTreeCancellation(input.sql, input.state.rootThreadId, input.threadId);
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
