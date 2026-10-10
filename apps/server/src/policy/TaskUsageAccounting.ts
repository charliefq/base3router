/**
 * Durable task usage projection.
 *
 * Rows keep provider-turn totals for a governed root. They do not keep
 * prompts, credentials, or transcripts. Replayed event ids are ignored.
 * A later snapshot for the same turn replaces that turn. An incremental
 * report adds. The context-window meter is not written here.
 */
// @effect-diagnostics preferSchemaOverJson:off
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  TaskUsageReadError,
  ThreadId,
  measureTaskCohort,
  summarizeTaskUsage,
  type OrchestrationV2DomainEvent,
  type TaskUsageAttempt,
  type TaskUsageBasis,
  type TaskUsageCohort,
  type TaskUsageContribution,
  type TaskUsageSummary,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { taskStateFromUnknown } from "./TaskContract.ts";

const isTaskUsageReadError = Schema.is(TaskUsageReadError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export function asTaskUsageReadError(
  cause: unknown,
): TaskUsageReadError | EnvironmentAuthorizationError {
  if (isTaskUsageReadError(cause) || isEnvironmentAuthorizationError(cause)) return cause;
  return new TaskUsageReadError({ message: "Task usage could not be read." });
}

export function assertCanReadTaskUsage(
  scopes: readonly string[] | undefined,
): Effect.Effect<void, EnvironmentAuthorizationError> {
  if (scopes?.includes(AuthOrchestrationReadScope)) return Effect.void;
  return Effect.fail(
    new EnvironmentAuthorizationError({
      message: `The authenticated token is missing required scope: ${AuthOrchestrationReadScope}.`,
      requiredScope: AuthOrchestrationReadScope,
    }),
  );
}

function finiteCost(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function clampSubset(total: number | null, part: number | undefined): number | null {
  if (part === undefined) return null;
  if (total === null) return part;
  return Math.min(total, part);
}

/** Normalized turn totals. Cache and reasoning stay subsets. Context `usedTokens` is ignored. */
export function contributionFromTurn(turn: {
  readonly turnTokenUsage?: TurnTokenUsage | undefined;
  readonly reportedCostUsd?: number | undefined;
}): TaskUsageContribution {
  const usage = turn.turnTokenUsage;
  if (usage === undefined || usage.usageStatus === "unavailable") {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      reportedCostUsd: finiteCost(turn.reportedCostUsd),
      usageStatus: "unavailable",
    };
  }
  const inputTokens = usage.inputTokens ?? null;
  const outputTokens = usage.outputTokens ?? null;
  const cachedInputTokens = clampSubset(inputTokens, usage.cachedInputTokens);
  let cacheCreationTokens = clampSubset(inputTokens, usage.cacheCreationTokens);
  if (
    inputTokens !== null &&
    cachedInputTokens !== null &&
    cacheCreationTokens !== null &&
    cachedInputTokens + cacheCreationTokens > inputTokens
  ) {
    cacheCreationTokens = inputTokens - cachedInputTokens;
  }
  const reasoningTokens = clampSubset(outputTokens, usage.reasoningTokens);
  const usageStatus =
    usage.usageStatus === "complete" && inputTokens !== null && outputTokens !== null
      ? "complete"
      : "partial";
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    reportedCostUsd: finiteCost(turn.reportedCostUsd),
    usageStatus,
  };
}

interface AttemptRow {
  readonly provider_turn_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly message_id: string | null;
  readonly contract_revision: number | null;
  readonly status: string;
  readonly attempt_role: "primary" | "retry" | "failover";
  readonly usage_status: "complete" | "partial" | "unavailable";
  readonly basis: TaskUsageBasis;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_creation_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly reported_cost_usd: number | null;
}

function attemptFromRow(row: AttemptRow): TaskUsageAttempt {
  return {
    providerTurnId: row.provider_turn_id,
    threadId: ThreadId.make(row.thread_id),
    runId: row.run_id,
    messageId: row.message_id,
    contractRevision: row.contract_revision,
    status: row.status,
    role: row.attempt_role,
    usageStatus: row.usage_status,
    basis: row.basis,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    reportedCostUsd: row.reported_cost_usd,
  };
}

type ProviderTurnEvent = Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }>;

export const recordTaskUsage = Effect.fn("TaskUsageAccounting.recordTaskUsage")(function* (
  environmentId: string,
  event: ProviderTurnEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  const next = contributionFromTurn(event.payload);
  const basis = event.payload.usageAccounting ?? "snapshot";
  const runId = event.runId ?? null;
  const providerInstanceId = event.providerInstanceId ?? null;
  const updatedAt = DateTime.formatIso(event.occurredAt);
  // One statement. A second yield inside the projection transaction lets a
  // concurrent approval response store the request before its turn item exists.
  const messageId = sql`
    (
      SELECT message_id FROM orchestration_v2_projection_messages
      WHERE thread_id = ${event.threadId}
        AND run_id = ${runId}
        AND role = 'user'
        AND ${runId} IS NOT NULL
      LIMIT 1
    )
  `;
  yield* sql`
    INSERT INTO task_usage_attempts (
        environment_id, provider_turn_id, root_thread_id, thread_id, run_id, message_id,
        contract_revision, provider_instance_id, status, attempt_role, usage_status, basis,
        input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens,
        reported_cost_usd, source_event_id, updated_at
      )
      SELECT
        ${environmentId},
        ${event.payload.id},
        COALESCE(json_extract(thread.payload_json, '$.lineage.rootThreadId'), ${event.threadId}),
        ${event.threadId},
        ${runId},
        ${messageId},
        json_extract(thread.payload_json, '$.taskContract.revision'),
        ${providerInstanceId},
        ${event.payload.status},
        CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM task_usage_attempts AS sibling
            WHERE sibling.environment_id = ${environmentId}
              AND sibling.root_thread_id = COALESCE(
                json_extract(thread.payload_json, '$.lineage.rootThreadId'),
                ${event.threadId}
              )
              AND sibling.provider_turn_id <> ${event.payload.id}
              AND (
                (${messageId} IS NOT NULL AND sibling.message_id = ${messageId})
                OR (
                  ${messageId} IS NULL
                  AND sibling.thread_id = ${event.threadId}
                  AND sibling.run_id IS NOT DISTINCT FROM ${runId}
                )
              )
          ) THEN 'primary'
          WHEN EXISTS (
            SELECT 1 FROM task_usage_attempts AS sibling
            WHERE sibling.environment_id = ${environmentId}
              AND sibling.root_thread_id = COALESCE(
                json_extract(thread.payload_json, '$.lineage.rootThreadId'),
                ${event.threadId}
              )
              AND sibling.provider_turn_id <> ${event.payload.id}
              AND sibling.provider_instance_id IS NOT NULL
              AND (
                ${providerInstanceId} IS NULL
                OR sibling.provider_instance_id <> ${providerInstanceId}
              )
              AND (
                (${messageId} IS NOT NULL AND sibling.message_id = ${messageId})
                OR (
                  ${messageId} IS NULL
                  AND sibling.thread_id = ${event.threadId}
                  AND sibling.run_id IS NOT DISTINCT FROM ${runId}
                )
              )
          ) THEN 'failover'
          ELSE 'retry'
        END,
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.usage_status
          WHEN ${next.usageStatus} = 'unavailable' THEN 'unavailable'
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            THEN ${next.usageStatus}
          WHEN previous.usage_status = 'complete' AND ${next.usageStatus} = 'complete'
            THEN 'complete'
          ELSE 'partial'
        END,
        ${basis},
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.input_tokens
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            OR ${next.usageStatus} = 'unavailable'
            THEN ${next.inputTokens}
          WHEN previous.input_tokens IS NULL THEN ${next.inputTokens}
          WHEN ${next.inputTokens} IS NULL THEN NULL
          ELSE previous.input_tokens + ${next.inputTokens}
        END,
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.cached_input_tokens
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            OR ${next.usageStatus} = 'unavailable'
            THEN ${next.cachedInputTokens}
          WHEN previous.cached_input_tokens IS NULL THEN ${next.cachedInputTokens}
          WHEN ${next.cachedInputTokens} IS NULL THEN NULL
          ELSE previous.cached_input_tokens + ${next.cachedInputTokens}
        END,
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.cache_creation_tokens
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            OR ${next.usageStatus} = 'unavailable'
            THEN ${next.cacheCreationTokens}
          WHEN previous.cache_creation_tokens IS NULL THEN ${next.cacheCreationTokens}
          WHEN ${next.cacheCreationTokens} IS NULL THEN NULL
          ELSE previous.cache_creation_tokens + ${next.cacheCreationTokens}
        END,
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.output_tokens
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            OR ${next.usageStatus} = 'unavailable'
            THEN ${next.outputTokens}
          WHEN previous.output_tokens IS NULL THEN ${next.outputTokens}
          WHEN ${next.outputTokens} IS NULL THEN NULL
          ELSE previous.output_tokens + ${next.outputTokens}
        END,
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.reasoning_tokens
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            OR ${next.usageStatus} = 'unavailable'
            THEN ${next.reasoningTokens}
          WHEN previous.reasoning_tokens IS NULL THEN ${next.reasoningTokens}
          WHEN ${next.reasoningTokens} IS NULL THEN NULL
          ELSE previous.reasoning_tokens + ${next.reasoningTokens}
        END,
        CASE
          WHEN ${next.usageStatus} = 'unavailable' AND previous.provider_turn_id IS NOT NULL
            THEN previous.reported_cost_usd
          WHEN ${basis} = 'snapshot'
            OR previous.provider_turn_id IS NULL
            OR previous.usage_status = 'unavailable'
            OR ${next.usageStatus} = 'unavailable'
            THEN ${next.reportedCostUsd}
          WHEN previous.reported_cost_usd IS NULL THEN ${next.reportedCostUsd}
          WHEN ${next.reportedCostUsd} IS NULL THEN NULL
          ELSE previous.reported_cost_usd + ${next.reportedCostUsd}
        END,
        ${event.id},
        ${updatedAt}
      FROM (
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${event.threadId}
        LIMIT 1
      ) AS thread
      LEFT JOIN task_usage_attempts AS previous
        ON previous.environment_id = ${environmentId}
        AND previous.provider_turn_id = ${event.payload.id}
      WHERE NOT EXISTS (
          SELECT 1 FROM task_usage_events
          WHERE environment_id = ${environmentId} AND event_id = ${event.id}
        )
        AND json_extract(thread.payload_json, '$.taskGovernance') = 'required'
        AND json_type(thread.payload_json, '$.taskContract') = 'object'
        AND typeof(json_extract(thread.payload_json, '$.taskContract.revision')) = 'integer'
      ON CONFLICT(environment_id, provider_turn_id) DO UPDATE SET
        contract_revision = excluded.contract_revision,
        status = excluded.status,
        usage_status = excluded.usage_status,
        basis = excluded.basis,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        reported_cost_usd = excluded.reported_cost_usd,
        source_event_id = excluded.source_event_id,
        message_id = COALESCE(task_usage_attempts.message_id, excluded.message_id),
        run_id = COALESCE(task_usage_attempts.run_id, excluded.run_id),
        updated_at = excluded.updated_at
  `;
});

export const readTaskUsage = Effect.fn("TaskUsageAccounting.readTaskUsage")(function* (
  environmentId: string,
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const threadRows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_threads
    WHERE thread_id = ${threadId}
    LIMIT 1
  `;
  const threadRow = threadRows[0];
  if (threadRow === undefined) {
    return yield* new TaskUsageReadError({ message: `No thread ${threadId}.` });
  }
  const payload = yield* Effect.try({
    try: () => JSON.parse(threadRow.payload_json) as unknown,
    catch: () => threadRow.payload_json,
  }).pipe(
    Effect.mapError(
      () => new TaskUsageReadError({ message: `Task usage for ${threadId} could not be read.` }),
    ),
  );
  if (typeof payload === "string") {
    return yield* new TaskUsageReadError({
      message: `Task usage for ${threadId} could not be read.`,
    });
  }
  const state = taskStateFromUnknown(threadId, payload);
  let rootState = state;
  if (state.rootThreadId !== threadId) {
    const rootRows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads
      WHERE thread_id = ${state.rootThreadId}
      LIMIT 1
    `;
    const raw = rootRows[0]?.payload_json;
    if (raw !== undefined) {
      rootState = taskStateFromUnknown(state.rootThreadId, JSON.parse(raw) as unknown);
    }
  }
  const rows = yield* sql<AttemptRow>`
    SELECT * FROM task_usage_attempts
    WHERE environment_id = ${environmentId} AND root_thread_id = ${state.rootThreadId}
  `;
  return summarizeTaskUsage({
    rootThreadId: ThreadId.make(state.rootThreadId),
    contractRevision: rootState.contract?.revision ?? null,
    acceptedRevision: rootState.acceptedRevision,
    phase: rootState.phase,
    attempts: rows.map(attemptFromRow),
  });
});

export const readTaskUsageCohort = Effect.fn("TaskUsageAccounting.readTaskUsageCohort")(function* (
  environmentId: string,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const seen = new Set<string>();
  const tasks: TaskUsageSummary[] = [];
  for (const threadId of threadIds) {
    const summary = yield* readTaskUsage(environmentId, threadId);
    if (seen.has(summary.rootThreadId)) continue;
    seen.add(summary.rootThreadId);
    tasks.push(summary);
  }
  return measureTaskCohort(tasks);
});

export type { TaskUsageCohort, TaskUsageSummary };
