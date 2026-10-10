/**
 * Task-level usage accounting.
 *
 * A provider turn's `turnTokenUsage` is one turn's normalized snapshot:
 * input includes cache reads and writes, and output includes reasoning.
 * Cache and reasoning stay visible and are not added again. The live context
 * meter (`usedTokens`) is a cumulative window snapshot and is not usage.
 *
 * Missing tokens or cost stay unknown. A reported zero is a real report.
 * Cost is whatever the provider reported. Nothing here prices a model.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const TaskUsageCoverage = Schema.Literals(["complete", "partial"]);
export type TaskUsageCoverage = typeof TaskUsageCoverage.Type;

export const TaskUsageAcceptance = Schema.Literals(["accepted", "rejected", "unfinished"]);
export type TaskUsageAcceptance = typeof TaskUsageAcceptance.Type;

export const TaskUsageBasis = Schema.Literals(["snapshot", "incremental"]);
export type TaskUsageBasis = typeof TaskUsageBasis.Type;

const NullableCount = Schema.NullOr(NonNegativeInt);
const NullableCost = Schema.NullOr(Schema.Number.check(Schema.isFinite()));
const NullableRatio = Schema.NullOr(Schema.Number.check(Schema.isFinite()));

export const TaskUsageNumbers = Schema.Struct({
  inputTokens: NullableCount,
  cachedInputTokens: NullableCount,
  cacheCreationTokens: NullableCount,
  outputTokens: NullableCount,
  reasoningTokens: NullableCount,
  reportedCostUsd: NullableCost,
});
export type TaskUsageNumbers = typeof TaskUsageNumbers.Type;

export const TaskUsageAttempt = Schema.Struct({
  ...TaskUsageNumbers.fields,
  providerTurnId: Schema.String,
  threadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  contractRevision: Schema.NullOr(NonNegativeInt),
  status: Schema.String,
  role: Schema.Literals(["primary", "retry", "failover"]),
  usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
  basis: TaskUsageBasis,
});
export type TaskUsageAttempt = typeof TaskUsageAttempt.Type;

export const TaskUsageSummary = Schema.Struct({
  rootThreadId: ThreadId,
  acceptance: TaskUsageAcceptance,
  /** Human acceptance of this revision. Provider completion does not set it. */
  providerCompletionIsAcceptance: Schema.Literal(false),
  contractRevision: Schema.NullOr(NonNegativeInt),
  acceptedRevision: Schema.NullOr(NonNegativeInt),
  phase: Schema.String,
  attempts: NonNegativeInt,
  childCount: NonNegativeInt,
  primaryAttempts: NonNegativeInt,
  retryAttempts: NonNegativeInt,
  failoverAttempts: NonNegativeInt,
  failedAttempts: NonNegativeInt,
  cancelledAttempts: NonNegativeInt,
  missingUsageAttempts: NonNegativeInt,
  missingCostAttempts: NonNegativeInt,
  /** Input and output were reported for every attempt. */
  usageCoverage: TaskUsageCoverage,
  /** Cache and reasoning splits were reported for every attempt. */
  categoryCoverage: TaskUsageCoverage,
  costCoverage: TaskUsageCoverage,
  totalsComplete: Schema.Boolean,
  /** Null wherever the cohort of attempts is missing a report. Never a fill-in zero. */
  totals: TaskUsageNumbers,
  /** Sum of reports that exist. Null when no attempt reported that category. */
  reported: TaskUsageNumbers,
  /** Input plus output for attempts that reported both. Cache and reasoning are not added. */
  reportedBillableTokens: NullableCount,
});
export type TaskUsageSummary = typeof TaskUsageSummary.Type;

export const TaskUsagePerAccepted = Schema.Struct({
  /** False when the cohort accepted nothing. Ratios are then null, not zero. */
  defined: Schema.Boolean,
  coverage: TaskUsageCoverage,
  inputTokens: NullableRatio,
  outputTokens: NullableRatio,
  cachedInputTokens: NullableRatio,
  cacheCreationTokens: NullableRatio,
  reasoningTokens: NullableRatio,
  reportedCostUsd: NullableRatio,
  reportedInputTokens: NullableRatio,
  reportedOutputTokens: NullableRatio,
  reportedCachedInputTokens: NullableRatio,
  reportedCacheCreationTokens: NullableRatio,
  reportedReasoningTokens: NullableRatio,
  reportedCostUsdKnown: NullableRatio,
  reportedBillableTokens: NullableRatio,
});
export type TaskUsagePerAccepted = typeof TaskUsagePerAccepted.Type;

export const TaskUsageCohort = Schema.Struct({
  attempted: NonNegativeInt,
  accepted: NonNegativeInt,
  rejected: NonNegativeInt,
  unfinished: NonNegativeInt,
  coverage: TaskUsageCoverage,
  totals: TaskUsageNumbers,
  reported: TaskUsageNumbers,
  reportedBillableTokens: NullableCount,
  perAccepted: TaskUsagePerAccepted,
});
export type TaskUsageCohort = typeof TaskUsageCohort.Type;

export class TaskUsageReadError extends Schema.TaggedError<TaskUsageReadError>()(
  "TaskUsageReadError",
  {
    message: Schema.String,
  },
) {}

export interface TaskUsageContribution {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly reportedCostUsd: number | null;
  readonly usageStatus: "complete" | "partial" | "unavailable";
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return null;
  return left + right;
}

/** Latest snapshot replaces. An incremental report adds. Unavailable does not erase a known report. */
export function mergeTaskUsage(
  previous: TaskUsageContribution | null,
  next: TaskUsageContribution,
  basis: TaskUsageBasis,
): TaskUsageContribution {
  if (next.usageStatus === "unavailable") return previous ?? next;
  if (basis === "snapshot" || previous === null || previous.usageStatus === "unavailable") {
    return next;
  }
  const usageStatus =
    previous.usageStatus === "complete" && next.usageStatus === "complete" ? "complete" : "partial";
  return {
    inputTokens: addNullable(previous.inputTokens, next.inputTokens),
    cachedInputTokens: addNullable(previous.cachedInputTokens, next.cachedInputTokens),
    cacheCreationTokens: addNullable(previous.cacheCreationTokens, next.cacheCreationTokens),
    outputTokens: addNullable(previous.outputTokens, next.outputTokens),
    reasoningTokens: addNullable(previous.reasoningTokens, next.reasoningTokens),
    reportedCostUsd: addNullable(previous.reportedCostUsd, next.reportedCostUsd),
    usageStatus,
  };
}

function sumKnown(values: ReadonlyArray<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const value of values) {
    if (value === null) continue;
    any = true;
    sum += value;
  }
  return any ? sum : null;
}

function sumComplete(values: ReadonlyArray<number | null>, complete: boolean): number | null {
  if (!complete) return null;
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function usageComplete(attempt: TaskUsageAttempt): boolean {
  return (
    attempt.usageStatus === "complete" &&
    attempt.inputTokens !== null &&
    attempt.outputTokens !== null
  );
}

function categoriesComplete(attempt: TaskUsageAttempt): boolean {
  return (
    usageComplete(attempt) &&
    attempt.cachedInputTokens !== null &&
    attempt.cacheCreationTokens !== null &&
    attempt.reasoningTokens !== null
  );
}

function costComplete(attempt: TaskUsageAttempt): boolean {
  return attempt.reportedCostUsd !== null;
}

function billableOf(attempt: TaskUsageAttempt): number | null {
  if (!usageComplete(attempt)) return null;
  return attempt.inputTokens! + attempt.outputTokens!;
}

function coverageOf(complete: boolean): TaskUsageCoverage {
  return complete ? "complete" : "partial";
}

export function acceptanceOf(input: {
  readonly contractRevision: number | null;
  readonly acceptedRevision: number | null;
  readonly phase: string;
}): TaskUsageAcceptance {
  if (
    input.contractRevision !== null &&
    input.acceptedRevision !== null &&
    input.acceptedRevision === input.contractRevision
  ) {
    return "accepted";
  }
  if (input.phase === "redirected") return "rejected";
  return "unfinished";
}

export function summarizeTaskUsage(input: {
  readonly rootThreadId: ThreadId;
  readonly contractRevision: number | null;
  readonly acceptedRevision: number | null;
  readonly phase: string;
  readonly attempts: ReadonlyArray<TaskUsageAttempt>;
}): TaskUsageSummary {
  const attempts = input.attempts;
  const usageCoverage = coverageOf(attempts.length > 0 && attempts.every(usageComplete));
  const categoryCoverage = coverageOf(attempts.length > 0 && attempts.every(categoriesComplete));
  const costCoverage = coverageOf(attempts.length > 0 && attempts.every(costComplete));
  const totalsComplete =
    usageCoverage === "complete" && categoryCoverage === "complete" && costCoverage === "complete";
  const children = new Set(
    attempts
      .filter((attempt) => attempt.threadId !== input.rootThreadId)
      .map((attempt) => attempt.threadId),
  );
  return {
    rootThreadId: input.rootThreadId,
    acceptance: acceptanceOf(input),
    providerCompletionIsAcceptance: false,
    contractRevision: input.contractRevision,
    acceptedRevision: input.acceptedRevision,
    phase: input.phase,
    attempts: attempts.length,
    childCount: children.size,
    primaryAttempts: attempts.filter((attempt) => attempt.role === "primary").length,
    retryAttempts: attempts.filter((attempt) => attempt.role === "retry").length,
    failoverAttempts: attempts.filter((attempt) => attempt.role === "failover").length,
    failedAttempts: attempts.filter((attempt) => attempt.status === "failed").length,
    cancelledAttempts: attempts.filter((attempt) => attempt.status === "cancelled").length,
    missingUsageAttempts: attempts.filter((attempt) => !usageComplete(attempt)).length,
    missingCostAttempts: attempts.filter((attempt) => !costComplete(attempt)).length,
    usageCoverage,
    categoryCoverage,
    costCoverage,
    totalsComplete,
    totals: {
      inputTokens: sumComplete(
        attempts.map((attempt) => attempt.inputTokens),
        usageCoverage === "complete",
      ),
      outputTokens: sumComplete(
        attempts.map((attempt) => attempt.outputTokens),
        usageCoverage === "complete",
      ),
      cachedInputTokens: sumComplete(
        attempts.map((attempt) => attempt.cachedInputTokens),
        categoryCoverage === "complete",
      ),
      cacheCreationTokens: sumComplete(
        attempts.map((attempt) => attempt.cacheCreationTokens),
        categoryCoverage === "complete",
      ),
      reasoningTokens: sumComplete(
        attempts.map((attempt) => attempt.reasoningTokens),
        categoryCoverage === "complete",
      ),
      reportedCostUsd: sumComplete(
        attempts.map((attempt) => attempt.reportedCostUsd),
        costCoverage === "complete",
      ),
    },
    reported: {
      inputTokens: sumKnown(attempts.map((attempt) => attempt.inputTokens)),
      outputTokens: sumKnown(attempts.map((attempt) => attempt.outputTokens)),
      cachedInputTokens: sumKnown(attempts.map((attempt) => attempt.cachedInputTokens)),
      cacheCreationTokens: sumKnown(attempts.map((attempt) => attempt.cacheCreationTokens)),
      reasoningTokens: sumKnown(attempts.map((attempt) => attempt.reasoningTokens)),
      reportedCostUsd: sumKnown(attempts.map((attempt) => attempt.reportedCostUsd)),
    },
    reportedBillableTokens: sumKnown(attempts.map(billableOf)),
  };
}

function ratio(total: number | null, accepted: number, defined: boolean): number | null {
  if (!defined || total === null) return null;
  return total / accepted;
}

/**
 * Consumption per accepted task includes failed and rejected work in the
 * numerator. With no accepted task the ratio is undefined, not zero.
 * Incomplete categories stay null and the cohort is partial.
 */
export function measureTaskCohort(tasks: ReadonlyArray<TaskUsageSummary>): TaskUsageCohort {
  const accepted = tasks.filter((task) => task.acceptance === "accepted").length;
  const rejected = tasks.filter((task) => task.acceptance === "rejected").length;
  const unfinished = tasks.filter((task) => task.acceptance === "unfinished").length;
  const coverage = coverageOf(tasks.length > 0 && tasks.every((task) => task.totalsComplete));
  const reported = {
    inputTokens: sumKnown(tasks.map((task) => task.reported.inputTokens)),
    outputTokens: sumKnown(tasks.map((task) => task.reported.outputTokens)),
    cachedInputTokens: sumKnown(tasks.map((task) => task.reported.cachedInputTokens)),
    cacheCreationTokens: sumKnown(tasks.map((task) => task.reported.cacheCreationTokens)),
    reasoningTokens: sumKnown(tasks.map((task) => task.reported.reasoningTokens)),
    reportedCostUsd: sumKnown(tasks.map((task) => task.reported.reportedCostUsd)),
  };
  const totals = {
    inputTokens: sumComplete(
      tasks.map((task) => task.totals.inputTokens),
      coverage === "complete",
    ),
    outputTokens: sumComplete(
      tasks.map((task) => task.totals.outputTokens),
      coverage === "complete",
    ),
    cachedInputTokens: sumComplete(
      tasks.map((task) => task.totals.cachedInputTokens),
      coverage === "complete",
    ),
    cacheCreationTokens: sumComplete(
      tasks.map((task) => task.totals.cacheCreationTokens),
      coverage === "complete",
    ),
    reasoningTokens: sumComplete(
      tasks.map((task) => task.totals.reasoningTokens),
      coverage === "complete",
    ),
    reportedCostUsd: sumComplete(
      tasks.map((task) => task.totals.reportedCostUsd),
      coverage === "complete",
    ),
  };
  const reportedBillableTokens = sumKnown(tasks.map((task) => task.reportedBillableTokens));
  const defined = accepted > 0;
  return {
    attempted: tasks.length,
    accepted,
    rejected,
    unfinished,
    coverage,
    totals,
    reported,
    reportedBillableTokens,
    perAccepted: {
      defined,
      coverage,
      inputTokens: ratio(totals.inputTokens, accepted, defined && coverage === "complete"),
      outputTokens: ratio(totals.outputTokens, accepted, defined && coverage === "complete"),
      cachedInputTokens: ratio(
        totals.cachedInputTokens,
        accepted,
        defined && coverage === "complete",
      ),
      cacheCreationTokens: ratio(
        totals.cacheCreationTokens,
        accepted,
        defined && coverage === "complete",
      ),
      reasoningTokens: ratio(totals.reasoningTokens, accepted, defined && coverage === "complete"),
      reportedCostUsd: ratio(totals.reportedCostUsd, accepted, defined && coverage === "complete"),
      reportedInputTokens: ratio(reported.inputTokens, accepted, defined),
      reportedOutputTokens: ratio(reported.outputTokens, accepted, defined),
      reportedCachedInputTokens: ratio(reported.cachedInputTokens, accepted, defined),
      reportedCacheCreationTokens: ratio(reported.cacheCreationTokens, accepted, defined),
      reportedReasoningTokens: ratio(reported.reasoningTokens, accepted, defined),
      reportedCostUsdKnown: ratio(reported.reportedCostUsd, accepted, defined),
      reportedBillableTokens: ratio(reportedBillableTokens, accepted, defined),
    },
  };
}
