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
  mergeTaskUsage,
  summarizeTaskUsage,
  type OrchestrationV2DomainEvent,
  type TaskUsageAttempt,
  type TaskUsageBasis,
  type TaskUsageCohort,
  type TaskUsageContribution,
  type TaskUsageNumbers,
  type TaskUsageSummary,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { taskStateFromUnknown } from "./TaskContract.ts";

const UNSCOPED_ENVIRONMENT = "unscoped";

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

function numbersFrom(merged: TaskUsageContribution): TaskUsageNumbers {
  return {
    inputTokens: merged.inputTokens,
    cachedInputTokens: merged.cachedInputTokens,
    cacheCreationTokens: merged.cacheCreationTokens,
    outputTokens: merged.outputTokens,
    reasoningTokens: merged.reasoningTokens,
    reportedCostUsd: merged.reportedCostUsd,
  };
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
  const seen = yield* sql<{ readonly event_id: string }>`
    SELECT event_id FROM task_usage_events
    WHERE environment_id = ${environmentId} AND event_id = ${event.id}
    LIMIT 1
  `;
  if (seen.length > 0) return;

  const threadRows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_threads
    WHERE thread_id = ${event.threadId}
    LIMIT 1
  `;
  const threadRow = threadRows[0];
  if (threadRow === undefined) return;
  const payload = yield* Effect.try({
    try: () => JSON.parse(threadRow.payload_json) as unknown,
    catch: () => threadRow.payload_json,
  });
  if (typeof payload === "string") return;
  const state = taskStateFromUnknown(event.threadId, payload);
  if (state.governance !== "required" || state.contract === null) return;

  const runId = event.runId ?? null;
  const messageRows =
    runId === null
      ? []
      : yield* sql<{ readonly message_id: string }>`
          SELECT message_id FROM orchestration_v2_projection_messages
          WHERE thread_id = ${event.threadId} AND run_id = ${runId} AND role = 'user'
          LIMIT 1
        `;
  const messageId = messageRows[0]?.message_id ?? null;
  const providerInstanceId = event.providerInstanceId ?? null;
  const existing = yield* sql<AttemptRow>`
    SELECT * FROM task_usage_attempts
    WHERE environment_id = ${environmentId} AND provider_turn_id = ${event.payload.id}
    LIMIT 1
  `;
  const current = existing[0];
  const siblings = yield* sql<{ readonly provider_instance_id: string | null }>`
    SELECT provider_instance_id FROM task_usage_attempts
    WHERE environment_id = ${environmentId}
      AND root_thread_id = ${state.rootThreadId}
      AND provider_turn_id <> ${event.payload.id}
      AND (
        (${messageId} IS NOT NULL AND message_id = ${messageId})
        OR (
          ${messageId} IS NULL
          AND thread_id = ${event.threadId}
          AND run_id IS NOT DISTINCT FROM ${runId}
        )
      )
  `;
  const role =
    current?.attempt_role ??
    (siblings.length === 0
      ? "primary"
      : siblings.some(
            (row) =>
              row.provider_instance_id !== null && row.provider_instance_id !== providerInstanceId,
          )
        ? "failover"
        : "retry");
  const previous =
    current === undefined
      ? null
      : {
          inputTokens: current.input_tokens,
          cachedInputTokens: current.cached_input_tokens,
          cacheCreationTokens: current.cache_creation_tokens,
          outputTokens: current.output_tokens,
          reasoningTokens: current.reasoning_tokens,
          reportedCostUsd: current.reported_cost_usd,
          usageStatus: current.usage_status,
        };
  const basis = event.payload.usageAccounting ?? "snapshot";
  const updatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const merged = mergeTaskUsage(previous, contributionFromTurn(event.payload), basis);
  const stored = numbersFrom(merged);
  yield* sql`
    INSERT INTO task_usage_attempts (
      environment_id, provider_turn_id, root_thread_id, thread_id, run_id, message_id,
      contract_revision, provider_instance_id, status, attempt_role, usage_status, basis,
      input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens,
      reported_cost_usd, updated_at
    ) VALUES (
      ${environmentId},
      ${event.payload.id},
      ${state.rootThreadId},
      ${event.threadId},
      ${runId},
      ${messageId},
      ${state.contract.revision},
      ${providerInstanceId},
      ${event.payload.status},
      ${role},
      ${merged.usageStatus},
      ${basis},
      ${stored.inputTokens},
      ${stored.cachedInputTokens},
      ${stored.cacheCreationTokens},
      ${stored.outputTokens},
      ${stored.reasoningTokens},
      ${stored.reportedCostUsd},
      ${updatedAt}
    )
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
      message_id = COALESCE(task_usage_attempts.message_id, excluded.message_id),
      run_id = COALESCE(task_usage_attempts.run_id, excluded.run_id),
      updated_at = excluded.updated_at
  `;
  yield* sql`
    INSERT INTO task_usage_events (environment_id, event_id, provider_turn_id)
    VALUES (${environmentId}, ${event.id}, ${event.payload.id})
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

export const taskUsageEnvironmentId = UNSCOPED_ENVIRONMENT;

export type { TaskUsageCohort, TaskUsageSummary };
