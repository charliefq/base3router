import type { TaskRunRecord } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
export const runIsTerminal = (record: TaskRunRecord) => terminal.has(record.run.status);
export function elapsedMs(record: TaskRunRecord, now: number) {
  const start = record.run.startedAt;
  if (!start) return null;
  const end = record.run.completedAt;
  if (!end && runIsTerminal(record)) return null;
  return Math.max(0, (end ? DateTime.toEpochMillis(end) : now) - DateTime.toEpochMillis(start));
}
export function executedModels(record: TaskRunRecord) {
  return [
    ...new Set(
      record.turns
        .filter(({ turn }) => turn.startedAt !== null)
        .map(
          ({ turn, provider }) =>
            `${provider ?? "Unknown provider"} · ${turn.modelIdentity?.resolved ?? "Model not reported"}`,
        ),
    ),
  ];
}
export function recordUsage(record: TaskRunRecord) {
  // Projection rows are latest per-turn snapshots. Never sum streaming reports,
  // context-window usage, cache subsets, or reasoning subsets a second time.
  const turns = [...new Map(record.turns.map((entry) => [entry.turn.id, entry])).values()];
  let total = 0;
  let known = 0;
  let complete = turns.length > 0;
  let subagents = false;
  for (const entry of turns) {
    const turn = entry.turn;
    const accounting = entry.accounting;
    if (accounting && accounting.status !== "unavailable") {
      if (accounting.inputTokens !== null || accounting.outputTokens !== null) {
        total += (accounting.inputTokens ?? 0) + (accounting.outputTokens ?? 0);
        known++;
      }
      complete &&= accounting.status === "complete";
      subagents ||= turn.turnTokenUsage?.hasSubagents ?? false;
      continue;
    }
    // Historical incremental projections may only retain the latest increment.
    // Without ledger coverage, do not mislabel that increment as a turn total.
    const usage =
      turn.usageAccounting === "incremental" || turn.turnTokenUsage?.usageStatus === "unavailable"
        ? undefined
        : turn.turnTokenUsage;
    subagents ||= usage?.hasSubagents ?? false;
    if (usage?.usageStatus === "complete") {
      total += usage.inputTokens + usage.outputTokens;
      known++;
    } else {
      complete = false;
      if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
        total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        known++;
      }
    }
  }
  return { total: known ? total : null, complete, subagents };
}
export function recordEta(record: TaskRunRecord, records: readonly TaskRunRecord[], now: number) {
  const fallback = "Cannot estimate yet; no calibrated duration for this workload.";
  if (runIsTerminal(record))
    return { remainingMs: null, basis: "Finished; see recorded duration." };
  if (record.run.status !== "running")
    return {
      remainingMs: null,
      basis: `${record.run.status}; completion depends on queue, setup, or user/provider input.`,
    };
  const identities = executedModels(record);
  if (identities.length !== 1 || identities[0]!.includes("not reported"))
    return { remainingMs: null, basis: fallback };
  const durations = records
    .filter(
      (r) =>
        r.run.status === "completed" &&
        executedModels(r).length === 1 &&
        executedModels(r)[0] === identities[0],
    )
    .map((r) => elapsedMs(r, now))
    .filter((v): v is number => v !== null && v > 0)
    .sort((a, b) => a - b);
  const elapsed = elapsedMs(record, now);
  if (durations.length < 5 || elapsed === null) return { remainingMs: null, basis: fallback };
  const median = durations[Math.floor(durations.length / 2)]!;
  const basis = `Rough estimate: median of ${durations.length} completed runs on this page with the same confirmed provider/model; workload sizes may differ.`;
  return elapsed >= median
    ? { remainingMs: null, basis: `Longer than the comparison median. ${basis}` }
    : { remainingMs: median - elapsed, basis };
}
export function duration(ms: number | null) {
  if (ms === null) return "Unavailable";
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
