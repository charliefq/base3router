import { describe, expect, it } from "vite-plus/test";
import { unknownQuantity, type MeasuredQuantityV0 } from "@t3tools/contracts";
import { FIXED_TASK_CORPUS, fixedTaskCorpusHash } from "./FixedTaskCorpus.ts";
import {
  PAIRED_FIXTURE_EXAMPLE,
  pairedReplayReport,
  type PairedReplayRecord,
} from "./PairedReplayReport.ts";

const corpus = PAIRED_FIXTURE_EXAMPLE.corpus;
const record = (
  taskIndex: number,
  arm: "router" | "baseline",
  outcome: PairedReplayRecord["outcome"] = "success",
): PairedReplayRecord => ({
  taskId: corpus.tasks[taskIndex]!.id,
  arm,
  executedTarget:
    arm === "router" ? corpus.tasks[taskIndex]!.expected! : corpus.tasks[taskIndex]!.baselineTarget,
  outcome,
  evidenceClass: "OBSERVED",
  cost: { completeness: "complete", quantity: quantity(1, "usd") },
  latency: quantity(10 * (taskIndex + 1), "ms"),
});
const quantity = (value: number, unit: "usd" | "ms"): MeasuredQuantityV0 => ({
  status: "known",
  value,
  unit,
  source: "provider_reported",
  provenance: "observed",
  observedAt: "2026-10-13T00:00:00Z",
});

describe("paired replay reports", () => {
  it("aligns both explicit targets without turning target conformance into task success", () => {
    const report = pairedReplayReport(corpus, [
      record(0, "router", "failure"),
      record(0, "baseline"),
    ]);
    const observed = report.evidence.OBSERVED.overall;
    expect(report.tasks.find((item) => item.id === corpus.tasks[0]!.id)).toMatchObject({
      selectionCorrect: true,
      records: { router: { targetMatches: true }, baseline: { targetMatches: true } },
      missingArms: [],
    });
    expect(observed.arms.router.success).toMatchObject({
      numerator: 0,
      denominator: 1,
      rate: { status: "known", value: 0 },
    });
    expect(observed.arms.baseline.success).toMatchObject({ numerator: 1, denominator: 1 });
    expect(observed.paired).toMatchObject({
      recordedPairs: 1,
      comparablePairs: 1,
      eligibleTasks: 60,
    });
    expect(observed.differences.successRate).toEqual({ status: "known", value: -1 });
  });

  it("discloses missing arms and unknown empty evidence without invented passes or zero cost", () => {
    const report = pairedReplayReport(corpus, [record(0, "router")]);
    expect(report.tasks.find((item) => item.id === corpus.tasks[0]!.id)!.missingArms).toEqual([
      "baseline",
    ]);
    expect(report.tasks.find((item) => item.id === corpus.tasks[1]!.id)!.missingArms).toEqual([
      "router",
      "baseline",
    ]);
    expect(report.evidence.OBSERVED.overall.arms.baseline.success.rate.status).toBe("unknown");
    expect(report.evidence.OBSERVED.overall.paired.comparablePairs).toBe(0);
    expect(report.evidence.OBSERVED.overall.differences.successRate.status).toBe("unknown");
    const empty = pairedReplayReport(corpus, []);
    expect(empty.evidence.OBSERVED.overall.arms.router).toMatchObject({
      terminalTasks: 0,
      eligibleTasks: 60,
      terminalCoverage: { status: "known", value: 0 },
      taskCost: { measuredTasks: 0, total: { status: "unknown" }, mean: { status: "unknown" } },
      latency: { sampleCount: 0, quantity: { status: "unknown" } },
    });
  });

  it("exposes execution mismatches and excludes them from comparable arm differences", () => {
    const wrong = { ...record(0, "router"), executedTarget: corpus.tasks[0]!.baselineTarget };
    const report = pairedReplayReport(corpus, [wrong, record(0, "baseline")]);
    expect(
      report.tasks.find((item) => item.id === wrong.taskId)!.records.router?.targetMatches,
    ).toBe(false);
    expect(report.evidence.OBSERVED.overall.paired).toMatchObject({
      recordedPairs: 1,
      comparablePairs: 0,
    });
    expect(report.evidence.OBSERVED.overall.differences.successRate.status).toBe("unknown");
  });

  it("rejects duplicate task definitions, duplicate task-arm records and unknown task IDs", () => {
    expect(() =>
      pairedReplayReport({ ...corpus, tasks: [...corpus.tasks, corpus.tasks[0]!] }, []),
    ).toThrow(/Duplicate/);
    expect(() => pairedReplayReport(corpus, [record(0, "router"), record(0, "router")])).toThrow(
      /Duplicate/,
    );
    expect(() =>
      pairedReplayReport(corpus, [{ ...record(0, "router"), taskId: "unknown" }]),
    ).toThrow(/Unknown/);
  });

  it("includes complete costs of every terminal outcome and keeps partial or missing costs incomplete", () => {
    const records = [
      record(0, "router"),
      record(1, "router", "failure"),
      record(2, "router", "cancelled"),
      record(3, "router", "timeout"),
      {
        ...record(4, "router"),
        cost: { completeness: "partial" as const, quantity: quantity(50, "usd") },
      },
      {
        ...record(5, "router"),
        cost: { completeness: "unknown" as const, quantity: unknownQuantity("usd") },
      },
    ];
    const summary = pairedReplayReport(corpus, records).evidence.OBSERVED.overall.arms.router;
    expect(summary.success).toMatchObject({ numerator: 3, denominator: 6 });
    expect(summary.taskCost).toMatchObject({
      measuredTasks: 4,
      partialTasks: 1,
      missingTasks: 1,
      total: { status: "known", value: 4 },
      mean: { status: "known", value: 1 },
    });
    expect(summary.taskCost.coverage).toEqual({ status: "known", value: 4 / 60 });
  });

  it("isolates fixtures and rejects estimated quantities from observed cost and p90", () => {
    const estimated = { ...quantity(20, "usd"), provenance: "estimated" } as MeasuredQuantityV0;
    const report = pairedReplayReport(corpus, [
      { ...record(0, "router"), evidenceClass: "FIXTURE" },
      {
        ...record(1, "router"),
        cost: { completeness: "complete", quantity: estimated },
        latency: { ...quantity(20, "ms"), provenance: "estimated" } as MeasuredQuantityV0,
      },
    ]);
    expect(report.evidence.FIXTURE.overall.arms.router.taskCost.total.status).toBe("known");
    expect(report.evidence.OBSERVED.overall.arms.router.taskCost.total.status).toBe("unknown");
    expect(report.evidence.OBSERVED.overall.arms.router.latency.quantity.status).toBe("unknown");
    const zero = pairedReplayReport(corpus, [
      { ...record(0, "router"), cost: { completeness: "complete", quantity: quantity(0, "usd") } },
    ]);
    expect(zero.evidence.OBSERVED.overall.arms.router.taskCost.total).toMatchObject({
      status: "known",
      value: 0,
    });
  });

  it("preserves qualified source composition and requires twenty latency samples", () => {
    const records = Array.from({ length: 20 }, (_, index) => ({
      ...record(index, "router"),
      latency: {
        ...quantity((index + 1) * 10, "ms"),
        source: index % 2 === 0 ? ("monotonic_clock" as const) : ("provider_reported" as const),
      },
    }));
    const enough = pairedReplayReport(corpus, records).evidence.OBSERVED.overall.arms.router
      .latency;
    expect(enough).toMatchObject({
      status: "reliable",
      sampleCount: 20,
      quantity: { status: "known", value: 180, source: "unknown" },
      sources: ["monotonic_clock", "provider_reported"],
      sourceComposition: "mixed",
    });
    expect(
      pairedReplayReport(corpus, records.slice(0, 19)).evidence.OBSERVED.overall.arms.router
        .latency,
    ).toMatchObject({ status: "insufficient", sampleCount: 19, quantity: { status: "unknown" } });
  });

  it("is deterministic under task, catalog and record reordering", () => {
    const records = [record(0, "router"), record(0, "baseline"), record(1, "router", "failure")];
    const reordered = {
      ...corpus,
      tasks: corpus.tasks.toReversed().map((task) => ({
        ...task,
        input: { ...task.input, catalog: task.input.catalog.toReversed() },
      })),
    };
    expect(pairedReplayReport(reordered, records.toReversed())).toEqual(
      pairedReplayReport(corpus, records),
    );
  });

  it("demonstrates sixty distinct fixture tasks in three categories with both arms and no observed claims", () => {
    const report = pairedReplayReport(corpus, PAIRED_FIXTURE_EXAMPLE.records);
    expect(corpus.tasks).toHaveLength(60);
    expect(new Set(corpus.tasks.map((task) => JSON.stringify(task.input))).size).toBe(60);
    for (const category of ["code-tools", "image-vision", "long-context"] as const) {
      const categoryReport = report.evidence.FIXTURE.categories[category];
      expect(categoryReport).toMatchObject({
        eligibleTasks: 20,
        paired: { recordedPairs: 20, comparablePairs: 20 },
      });
      expect(categoryReport.arms.router.terminalTasks).toBe(20);
      expect(categoryReport.arms.baseline.terminalTasks).toBe(20);
    }
    expect(report.evidence.FIXTURE.overall.paired.comparablePairs).toBe(60);
    expect(report.evidence.OBSERVED.overall.arms.router.success.rate.status).toBe("unknown");
    expect(report.evidence.OBSERVED.overall.arms.router.taskCost.total.status).toBe("unknown");
    expect(fixedTaskCorpusHash(FIXED_TASK_CORPUS)).toBe(
      "799b40b9e62363b8ac95c854e22cca13b172d9cd17a7d4b24c9b535ec54b6798",
    );
  });
});
