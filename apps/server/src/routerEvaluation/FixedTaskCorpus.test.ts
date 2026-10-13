import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, unknownQuantity, type MeasuredQuantityV0 } from "@t3tools/contracts";
import { routeModel } from "@t3tools/shared/modelRouter";

import {
  FIXED_TASK_CORPUS,
  fixedTaskCorpusHash,
  runFixedTaskCorpus,
  type FixedTaskCorpus,
  type FixedTaskMeasurement,
} from "./FixedTaskCorpus.ts";

const target = (model: string) => ({
  instanceId: ProviderInstanceId.make(`fixture-${model}`),
  model,
});
const quantity = (value: number, unit: "usd" | "ms"): MeasuredQuantityV0 => ({
  status: "known",
  value,
  unit,
  source: "provider_reported",
  provenance: "observed",
  observedAt: "2026-10-13T00:00:00Z",
});
const measuredCorpus = (records: ReadonlyArray<FixedTaskMeasurement>): FixedTaskCorpus => ({
  ...FIXED_TASK_CORPUS,
  cases: FIXED_TASK_CORPUS.cases.map((item, index) =>
    index === 0 ? { ...item, recordedExecutedTarget: target("code"), measurements: records } : item,
  ),
});
const measurements = (count: number): ReadonlyArray<FixedTaskMeasurement> =>
  Array.from({ length: count }, (_, index) => ({
    id: `record-${index}`,
    evidenceClass: "OBSERVED",
    cost: quantity(0.01, "usd"),
    latency: quantity((index + 1) * 10, "ms"),
  }));

describe("fixed Model Router corpus", () => {
  it("covers seven frozen task dimensions using the existing router and honest unknown actuals", () => {
    const report = runFixedTaskCorpus(FIXED_TASK_CORPUS);
    expect(report.cases).toHaveLength(7);
    expect(report.selectionQuality).toMatchObject({
      meaning: "fixture_policy_conformance",
      evidenceClass: "FIXTURE",
      metric: { numerator: 7, denominator: 7 },
      rate: { status: "known", value: 1 },
    });
    expect(report.executionConsistency).toMatchObject({
      metric: { numerator: 0, denominator: 0 },
      rate: { status: "unknown" },
    });
    expect(report.actualCost.quantity.status).toBe("unknown");
    expect(report.p90Latency.quantity.status).toBe("unknown");
    for (const item of report.cases) {
      expect(item.decision).toEqual(routeModel(item.input));
      expect(item.explanation).toBe(item.decision.explanation);
      expect(item.selectionCorrect).toBe(true);
      expect(item.executionConsistency).toBe("unobserved");
      expect(item.catalogEvidenceClass).toBe("FIXTURE");
    }
    const byId = Object.fromEntries(report.cases.map((item) => [item.id, item]));
    expect(byId["image-attachment"]!.input.task).toMatchObject({
      attachmentCount: 1,
      requiredCapabilities: ["vision"],
    });
    expect(byId["code-tools"]!.input.task?.requiredCapabilities).toEqual(["code", "tools"]);
    expect(byId["long-context"]!.input.task?.requiredCapabilities).toEqual(["long-context"]);
    expect(byId["cost-preference"]!.decision.selected?.target).toEqual(target("code"));
    expect(byId["latency-preference"]!.decision.selected?.target).toEqual(target("context"));
    expect(byId["capability-unavailable"]!.decision.selected).toBeNull();
    expect(byId["capability-unavailable"]!.decision.reasonCodes).toContain(
      "REQUIRED_CAPABILITY_MISSING",
    );
    expect(byId["unknown-metrics"]!.decision.reasonCodes).toContain("METRICS_UNKNOWN");
  });

  it("keeps the identity and complete report stable under irrelevant input ordering", () => {
    const reordered: FixedTaskCorpus = {
      ...FIXED_TASK_CORPUS,
      cases: [...FIXED_TASK_CORPUS.cases].toReversed().map((item) => ({
        ...item,
        input: {
          ...item.input,
          task: {
            ...item.input.task,
            requiredCapabilities: [...(item.input.task?.requiredCapabilities ?? [])].toReversed(),
          },
          catalog: [...item.input.catalog]
            .toReversed()
            .map((entry) => ({ ...entry, capabilities: [...entry.capabilities].toReversed() })),
        },
      })),
    };
    expect(fixedTaskCorpusHash(reordered)).toBe(fixedTaskCorpusHash(FIXED_TASK_CORPUS));
    expect(fixedTaskCorpusHash(FIXED_TASK_CORPUS)).toMatch(/^[a-f0-9]{64}$/);
    expect(runFixedTaskCorpus(reordered)).toEqual(runFixedTaskCorpus(FIXED_TASK_CORPUS));
    expect(runFixedTaskCorpus(FIXED_TASK_CORPUS)).toEqual(runFixedTaskCorpus(FIXED_TASK_CORPUS));
    expect(fixedTaskCorpusHash({ ...FIXED_TASK_CORPUS, version: "2" })).not.toBe(
      fixedTaskCorpusHash(FIXED_TASK_CORPUS),
    );
  });

  it("detects expected-target and recorded-execution mismatches without counting missing executions", () => {
    const corpus: FixedTaskCorpus = {
      ...FIXED_TASK_CORPUS,
      cases: FIXED_TASK_CORPUS.cases.map((item) =>
        item.id === "code-tools"
          ? { ...item, expected: target("vision"), recordedExecutedTarget: target("vision") }
          : item.id === "cost-preference"
            ? { ...item, recordedExecutedTarget: target("code") }
            : item,
      ),
    };
    const report = runFixedTaskCorpus(corpus);
    expect(report.selectionQuality.metric).toMatchObject({ numerator: 6, denominator: 7 });
    expect(report.executionConsistency.metric).toMatchObject({ numerator: 1, denominator: 2 });
    expect(report.executionConsistency.rate).toEqual({ status: "known", value: 0.5 });
    expect(report.cases.find((item) => item.id === "code-tools")).toMatchObject({
      selectionCorrect: false,
      executionConsistency: "mismatch",
    });
  });

  it("rejects fixture, synthetic and estimated quantities from actual aggregates", () => {
    const records: ReadonlyArray<FixedTaskMeasurement> = [
      ...measurements(20).map((item) => ({ ...item, evidenceClass: "FIXTURE" as const })),
      { ...measurements(1)[0]!, id: "synthetic", evidenceClass: "SYNTHETIC" },
      {
        id: "estimated",
        evidenceClass: "OBSERVED",
        cost: { ...quantity(1, "usd"), provenance: "estimated" } as MeasuredQuantityV0,
        latency: unknownQuantity("ms"),
      },
    ];
    const report = runFixedTaskCorpus(measuredCorpus(records));
    expect(report.actualCost.quantity.status).toBe("unknown");
    expect(report.p90Latency.quantity.status).toBe("unknown");
    expect(report.actualCost.sampleCount).toBe(0);
    expect(
      report.cases
        .find((item) => item.measurements.length > 0)!
        .measurements.find((record) => record.id === "record-0")!.evidenceClass,
    ).toBe("FIXTURE");
  });

  it("computes only explicitly observed input costs and nearest-rank p90 with at least twenty samples", () => {
    // Simulated OBSERVED records test the rule; this test is FIXTURE evidence, not a live run.
    const report = runFixedTaskCorpus(measuredCorpus(measurements(20)));
    expect(report.actualCost.quantity).toMatchObject({
      status: "known",
      unit: "usd",
      provenance: "observed",
    });
    if (report.actualCost.quantity.status === "known")
      expect(report.actualCost.quantity.value).toBeCloseTo(0.2);
    expect(report.p90Latency.quantity).toMatchObject({ status: "known", value: 180, unit: "ms" });
    expect(report.p90Latency.sampleCount).toBe(20);
    expect(report.p90Latency.status).toBe("reliable");
    expect(report.selectionQuality.evidenceClass).toBe("FIXTURE");
    const reversed = measuredCorpus([...measurements(20)].toReversed());
    expect(runFixedTaskCorpus(reversed)).toEqual(report);
  });

  it("reports insufficient p90 and preserves observed zero rather than inventing missing metrics", () => {
    const report = runFixedTaskCorpus(measuredCorpus(measurements(19)));
    expect(report.p90Latency.status).toBe("insufficient");
    expect(report.p90Latency.quantity.status).toBe("unknown");
    const zero = runFixedTaskCorpus(
      measuredCorpus([
        {
          id: "zero",
          evidenceClass: "OBSERVED",
          cost: quantity(0, "usd"),
          latency: unknownQuantity("ms"),
        },
      ]),
    );
    expect(zero.actualCost.quantity).toMatchObject({ status: "known", value: 0 });
    expect(zero.p90Latency.quantity.status).toBe("unknown");
  });
});
