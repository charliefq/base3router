/**
 * Admission gate for a persisted task contract.
 * A brake reserves a start and requests cancellation. It does not release a lease.
 * Token, dollar, and deadline checks share that reservation. Production usage
 * rows stay unverified; only a synthetic fixture price can satisfy a dollar cap.
 * Frozen tree bounds stay in force when a later payload omits them. A usage
 * update or database startup asks active work to stop once those bounds are
 * spent. This process does not send the provider a remaining-token ceiling, so
 * one turn can report more than the budget that remained when it started.
 */
// Persisted thread payloads are already JSON text in SQLite.
// @effect-diagnostics preferSchemaOverJson:off
import {
  childConstraintConflict,
  incompleteTaskContractMessage,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  SYNTHETIC_FIXTURE_PRICE_LABEL,
  TASK_CONTRACT_HUMAN_DECISION,
  type OrchestrationV2AppThread,
  TaskContract,
  type TaskContractDecision,
  type TaskContractReviewReference,
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
      parentThreadId: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const decodeStoredTaskPayload = Schema.decodeUnknownOption(StoredTaskPayload);
const decodeTaskContract = Schema.decodeUnknownOption(TaskContract);

export interface PersistedTaskState {
  readonly governance: "chat" | "required";
  readonly contract: TaskContract | null;
  readonly phase: "active" | "redirected";
  readonly acceptedRevision: number | null;
  readonly rootThreadId: string;
  readonly parentThreadId?: string | null;
}

export function taskStateFromUnknown(threadId: string, payload: unknown): PersistedTaskState {
  const parsed = decodeStoredTaskPayload(payload);
  if (parsed._tag === "None") {
    return {
      // A corrupt persisted task must not silently become an ungoverned chat.
      // Historical chats still decode successfully with absent optional fields.
      governance: "required",
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
      : decodeTaskContract(value.taskContract);
  const contract =
    contractOption !== null && contractOption._tag === "Some" ? contractOption.value : null;
  return {
    governance,
    contract,
    phase: value.taskContractPhase ?? "active",
    acceptedRevision:
      typeof value.taskAcceptedRevision === "number" ? value.taskAcceptedRevision : null,
    rootThreadId: value.lineage?.rootThreadId ?? threadId,
    parentThreadId: value.lineage?.parentThreadId ?? null,
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
    | {
        readonly type: "thread.task-contract.accept";
        readonly revision: number;
        readonly reviewTask?: TaskContractReviewReference;
      }
    | {
        readonly type: "thread.task-contract.redirect";
        readonly revision: number;
        readonly reviewTask?: TaskContractReviewReference;
      }
    | {
        readonly type: "thread.task-contract.resume";
        readonly revision: number;
        readonly reviewTask?: TaskContractReviewReference;
      };
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
    ...(input.command.type !== "thread.task-contract.set" && input.command.reviewTask !== undefined
      ? { reviewTask: input.command.reviewTask }
      : {}),
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

/**
 * Interrupt occupied leases whose frozen deadline has passed or whose tree
 * usage has reached a frozen cap. Idempotent. Does not release a lease and
 * does not admit a start. Database startup runs this for every root.
 */
export const evaluatePersistedBrakes = (sql: SqlClient.SqlClient, rootThreadId?: string | null) =>
  Effect.gen(function* () {
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const scope = rootThreadId ?? null;
    const rows = yield* sql<{ readonly root_thread_id: string }>`
      SELECT bounds.root_thread_id
      FROM task_contract_deadlines AS bounds
      WHERE (${scope} IS NULL OR bounds.root_thread_id = ${scope})
        AND EXISTS (
          SELECT 1 FROM base3_capacity_leases AS lease
          WHERE lease.released_at IS NULL
            AND (
              lease.thread_id = bounds.root_thread_id
              OR lease.thread_id IN (
                SELECT thread_id FROM task_contract_members
                WHERE root_thread_id = bounds.root_thread_id
              )
            )
        )
        AND (
          bounds.deadline_at <= ${now}
          OR (
            bounds.max_tokens IS NOT NULL
            AND COALESCE((
              SELECT SUM(input_tokens + output_tokens) FROM task_usage_attempts
              WHERE root_thread_id = bounds.root_thread_id
            ), 0) >= bounds.max_tokens
          )
          OR (
            bounds.max_cost_usd IS NOT NULL
            AND COALESCE((
              SELECT SUM(reported_cost_usd) FROM task_usage_attempts
              WHERE root_thread_id = bounds.root_thread_id
            ), 0) >= bounds.max_cost_usd
          )
        )
    `;
    for (const row of rows) {
      yield* requestTaskCancellation(sql, row.root_thread_id, row.root_thread_id);
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

const PINNED_LEASE =
  "Active work was asked to cancel and stays leased until the provider turn is confirmed terminal.";

function canonicalDeadline(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(parsed));
}

function pilotActive(brake: TaskContract["brake"]): boolean {
  return (
    brake.maxTokens !== undefined ||
    brake.maxCostUsd !== undefined ||
    brake.deadlineAt !== undefined
  );
}

const countRows = (rows: ReadonlyArray<{ readonly count: number | null }>) =>
  Number(rows[0]?.count ?? 0);

/**
 * Freeze the absolute deadline once, then insert one admission.
 * The deadline row commits even when the admission is refused, so a restart
 * cannot move it later. Failure of this effect is a policy denial after commit.
 */
const commitTaskAdmission = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly state: PersistedTaskState;
  readonly contract: TaskContract;
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId: string | null;
}) =>
  input.sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const brake = input.contract.brake;
      const active = pilotActive(brake);
      const deadline = canonicalDeadline(brake.deadlineAt);
      const maxTokens =
        brake.maxTokens === undefined
          ? null
          : Number.isInteger(brake.maxTokens) && brake.maxTokens >= 1
            ? brake.maxTokens
            : "invalid";
      const maxCostUsd =
        brake.maxCostUsd === undefined
          ? null
          : Number.isFinite(brake.maxCostUsd) && brake.maxCostUsd > 0
            ? brake.maxCostUsd
            : "invalid";
      yield* input.sql`
        INSERT OR IGNORE INTO task_contract_members (
          thread_id, root_thread_id, revision, parent_thread_id
        ) VALUES (
          ${input.threadId},
          ${input.state.rootThreadId},
          ${input.contract.revision},
          ${input.state.parentThreadId ?? null}
        )
      `;
      const refuse = (detail: string) =>
        Effect.gen(function* () {
          yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
          return { _tag: "denied" as const, detail };
        });
      if (maxTokens === "invalid" || maxCostUsd === "invalid") {
        return yield* refuse(
          "A budgeted start needs an explicit positive token cap, dollar cap, and absolute deadline when those brakes are set. No default was applied. No provider was started.",
        );
      }
      const tokenCap = maxTokens;
      const dollarCap = maxCostUsd;
      // The first deadline stays put. A later payload may only lower a cap.
      // Omitting a cap does not clear one that was already frozen.
      if (deadline !== null) {
        yield* input.sql`
          INSERT INTO task_contract_deadlines (
            root_thread_id, deadline_at, frozen_at, max_tokens, max_cost_usd
          ) VALUES (
            ${input.state.rootThreadId}, ${deadline}, ${now}, ${tokenCap}, ${dollarCap}
          )
          ON CONFLICT(root_thread_id) DO UPDATE SET
            max_tokens = CASE
              WHEN excluded.max_tokens IS NULL THEN task_contract_deadlines.max_tokens
              WHEN task_contract_deadlines.max_tokens IS NULL THEN excluded.max_tokens
              WHEN excluded.max_tokens < task_contract_deadlines.max_tokens
                THEN excluded.max_tokens
              ELSE task_contract_deadlines.max_tokens
            END,
            max_cost_usd = CASE
              WHEN excluded.max_cost_usd IS NULL THEN task_contract_deadlines.max_cost_usd
              WHEN task_contract_deadlines.max_cost_usd IS NULL THEN excluded.max_cost_usd
              WHEN excluded.max_cost_usd < task_contract_deadlines.max_cost_usd
                THEN excluded.max_cost_usd
              ELSE task_contract_deadlines.max_cost_usd
            END
        `;
      } else if (tokenCap !== null || dollarCap !== null) {
        yield* input.sql`
          UPDATE task_contract_deadlines SET
            max_tokens = CASE
              WHEN ${tokenCap} IS NULL THEN max_tokens
              WHEN max_tokens IS NULL THEN ${tokenCap}
              WHEN ${tokenCap} < max_tokens THEN ${tokenCap}
              ELSE max_tokens
            END,
            max_cost_usd = CASE
              WHEN ${dollarCap} IS NULL THEN max_cost_usd
              WHEN max_cost_usd IS NULL THEN ${dollarCap}
              WHEN ${dollarCap} < max_cost_usd THEN ${dollarCap}
              ELSE max_cost_usd
            END
          WHERE root_thread_id = ${input.state.rootThreadId}
        `;
      }
      const bounds = yield* input.sql<{ readonly root_thread_id: string }>`
        SELECT root_thread_id FROM task_contract_deadlines
        WHERE root_thread_id = ${input.state.rootThreadId}
        LIMIT 1
      `;
      if (active && deadline === null && bounds.length === 0) {
        return yield* refuse(
          "A budgeted start needs an explicit positive token cap, dollar cap, and absolute deadline when those brakes are set. No default was applied. No provider was started.",
        );
      }
      const enforced = bounds.length > 0;
      const pilotAllows = enforced
        ? input.sql`
            (
              (SELECT deadline_at FROM task_contract_deadlines
                WHERE root_thread_id = ${input.state.rootThreadId}) > ${now}
              AND NOT EXISTS (
                SELECT 1 FROM task_usage_attempts
                WHERE root_thread_id = ${input.state.rootThreadId}
                  AND (
                    input_tokens IS NULL
                    OR output_tokens IS NULL
                    OR usage_status <> 'complete'
                    OR reported_cost_usd IS NULL
                    OR price_verified <> 1
                    OR price_label <> ${SYNTHETIC_FIXTURE_PRICE_LABEL}
                  )
              )
              AND (
                (SELECT max_tokens FROM task_contract_deadlines
                  WHERE root_thread_id = ${input.state.rootThreadId}) IS NULL
                OR COALESCE((
                  SELECT SUM(input_tokens + output_tokens) FROM task_usage_attempts
                  WHERE root_thread_id = ${input.state.rootThreadId}
                ), 0) < (
                  SELECT max_tokens FROM task_contract_deadlines
                  WHERE root_thread_id = ${input.state.rootThreadId}
                )
              )
              AND (
                (SELECT max_cost_usd FROM task_contract_deadlines
                  WHERE root_thread_id = ${input.state.rootThreadId}) IS NULL
                OR COALESCE((
                  SELECT SUM(reported_cost_usd) FROM task_usage_attempts
                  WHERE root_thread_id = ${input.state.rootThreadId}
                ), 0) < (
                  SELECT max_cost_usd FROM task_contract_deadlines
                  WHERE root_thread_id = ${input.state.rootThreadId}
                )
              )
              AND (
                SELECT COUNT(*) FROM task_contract_admissions
                WHERE root_thread_id = ${input.state.rootThreadId}
              ) = (
                SELECT COUNT(*) FROM task_usage_attempts
                WHERE root_thread_id = ${input.state.rootThreadId}
                  AND usage_status = 'complete'
                  AND input_tokens IS NOT NULL
                  AND output_tokens IS NOT NULL
                  AND reported_cost_usd IS NOT NULL
                  AND price_verified = 1
                  AND price_label = ${SYNTHETIC_FIXTURE_PRICE_LABEL}
              )
            )
          `
        : input.sql`1`;
      yield* input.sql`
        INSERT INTO task_contract_admissions (
          root_thread_id, command_id, thread_id, contract_revision, message_id, created_at
        )
        SELECT
          ${input.state.rootThreadId},
          ${input.commandId},
          ${input.threadId},
          ${input.contract.revision},
          ${input.messageId},
          ${now}
        WHERE NOT EXISTS (
          SELECT 1 FROM task_contract_admissions
          WHERE root_thread_id = ${input.state.rootThreadId}
            AND command_id = ${input.commandId}
        )
        AND (
          SELECT COUNT(*) FROM task_contract_admissions
          WHERE root_thread_id = ${input.state.rootThreadId}
        ) < ${brake.maxProviderStarts}
        AND (${pilotAllows})
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
        return { _tag: "denied" as const, detail: null };
      }
      if (reserved.contract_revision !== input.contract.revision) {
        return {
          _tag: "revision" as const,
          reservedRevision: reserved.contract_revision,
        };
      }
      return { _tag: "reserved" as const };
    }),
  );

const classifyPilotDenial = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly rootThreadId: string;
  readonly contract: TaskContract;
}) =>
  Effect.gen(function* () {
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const deadlineRows = yield* input.sql<{
      readonly deadline_at: string;
      readonly max_tokens: number | null;
      readonly max_cost_usd: number | null;
    }>`
      SELECT deadline_at, max_tokens, max_cost_usd FROM task_contract_deadlines
      WHERE root_thread_id = ${input.rootThreadId}
      LIMIT 1
    `;
    const bound = deadlineRows[0];
    if (bound === undefined && !pilotActive(input.contract.brake)) return null;
    const deadline = bound?.deadline_at;
    if (deadline === undefined) {
      return `An absolute deadline must be persisted before a budgeted start. No default deadline was applied. No provider was started.`;
    }
    if (deadline <= now) {
      return `Absolute deadline ${deadline} is already past. Restart does not extend it. ${PINNED_LEASE}`;
    }
    const unknownRows = yield* input.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM task_usage_attempts
      WHERE root_thread_id = ${input.rootThreadId}
        AND (
          input_tokens IS NULL
          OR output_tokens IS NULL
          OR usage_status <> 'complete'
        )
    `;
    if (countRows(unknownRows) > 0) {
      return `Unknown usage denies a new start on this task tree. ${PINNED_LEASE}`;
    }
    const unverifiedRows = yield* input.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM task_usage_attempts
      WHERE root_thread_id = ${input.rootThreadId}
        AND (
          reported_cost_usd IS NULL
          OR price_verified <> 1
          OR price_label IS NULL
          OR price_label <> ${SYNTHETIC_FIXTURE_PRICE_LABEL}
        )
    `;
    const unverified = countRows(unverifiedRows);
    if (unverified > 0) {
      return `Unknown or unverified pricing denies a new start. A reported cost is not a verified price, and a synthetic price is not a production default. ${PINNED_LEASE}`;
    }
    const sums = yield* input.sql<{
      readonly tokens: number | null;
      readonly cost: number | null;
    }>`
      SELECT
        COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
        COALESCE(SUM(reported_cost_usd), 0) AS cost
      FROM task_usage_attempts
      WHERE root_thread_id = ${input.rootThreadId}
    `;
    const tokens = Number(sums[0]?.tokens ?? 0);
    const cost = Number(sums[0]?.cost ?? 0);
    const maxTokens = bound?.max_tokens ?? input.contract.brake.maxTokens ?? null;
    if (maxTokens !== null && tokens >= Number(maxTokens)) {
      return `Token budget exhausted: ${tokens} tokens are already accounted on this task tree, and the cap is ${maxTokens}. A child, retry, or handoff does not reset that total. ${PINNED_LEASE}`;
    }
    const maxCostUsd = bound?.max_cost_usd ?? input.contract.brake.maxCostUsd ?? null;
    if (maxCostUsd !== null && cost >= Number(maxCostUsd)) {
      return `Dollar budget exhausted: ${cost} USD is already accounted on this task tree, and the cap is ${maxCostUsd}. A child, retry, or handoff does not reset that total. ${PINNED_LEASE}`;
    }
    const admissionRows = yield* input.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM task_contract_admissions
      WHERE root_thread_id = ${input.rootThreadId}
    `;
    const settledRows = yield* input.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM task_usage_attempts
      WHERE root_thread_id = ${input.rootThreadId}
        AND usage_status = 'complete'
        AND input_tokens IS NOT NULL
        AND output_tokens IS NOT NULL
        AND reported_cost_usd IS NOT NULL
        AND price_verified = 1
        AND price_label = ${SYNTHETIC_FIXTURE_PRICE_LABEL}
    `;
    const admissions = countRows(admissionRows);
    const settled = countRows(settledRows);
    if (admissions !== settled) {
      return `An unsettled reservation already holds this task tree. A concurrent start was not given another reservation. ${PINNED_LEASE}`;
    }
    return null;
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
    const reserved = yield* commitTaskAdmission({
      sql: input.sql,
      state: input.state,
      contract,
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId ?? null,
    });
    if (reserved._tag === "revision") {
      return yield* deny(
        input.commandType,
        `This dispatch was reserved for contract revision ${reserved.reservedRevision} and cannot reuse that grant for revision ${contract.revision}.`,
      );
    }
    if (reserved._tag === "denied") {
      return yield* deny(
        input.commandType,
        reserved.detail ??
          (yield* classifyPilotDenial({
            sql: input.sql,
            rootThreadId: input.state.rootThreadId,
            contract,
          })) ??
          `Brake exhausted: ${contract.brake.maxProviderStarts} provider starts are already reserved on this task. ${PINNED_LEASE}`,
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
      // Reusing a slot must not let queued work outlive its frozen deadline.
      const bounds = yield* input.sql<{ readonly deadline_at: string }>`
        SELECT deadline_at FROM task_contract_deadlines
        WHERE root_thread_id = ${input.state.rootThreadId}
        LIMIT 1
      `;
      const deadline = bounds[0]?.deadline_at;
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      if (deadline !== undefined && deadline <= now) {
        yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
        return yield* deny(
          input.effectType,
          `Absolute deadline ${deadline} is already past. Restart does not extend it. ${PINNED_LEASE}`,
        );
      }
      return;
    }
    const key = `handoff:${input.effectType}:${input.messageId ?? input.commandId}:${input.attemptCount}`;
    const reserved = yield* commitTaskAdmission({
      sql: input.sql,
      state: input.state,
      contract,
      commandId: key,
      threadId: input.threadId,
      messageId: input.messageId ?? null,
    });
    if (reserved._tag === "revision") {
      yield* requestTaskCancellation(input.sql, input.state.rootThreadId, input.threadId);
      return yield* deny(
        input.effectType,
        `This queued start was reserved for contract revision ${reserved.reservedRevision} and was not reused for revision ${contract.revision}.`,
      );
    }
    if (reserved._tag === "denied") {
      return yield* deny(
        input.effectType,
        reserved.detail ??
          (yield* classifyPilotDenial({
            sql: input.sql,
            rootThreadId: input.state.rootThreadId,
            contract,
          })) ??
          `Brake exhausted: ${contract.brake.maxProviderStarts} provider starts are already reserved on this task. A retry or failover was not given another start. ${PINNED_LEASE}`,
      );
    }
  }).pipe(asPolicyDenial(input.effectType));
