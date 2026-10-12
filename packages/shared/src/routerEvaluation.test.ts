import { describe, expect, it } from "vite-plus/test";
import {
  UNKNOWN_TASK_PROFILE,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  emptyTiming,
  emptyUsageMeasurement,
  TURN_OUTCOME_OBSERVATION_VERSION,
  type TurnOutcomeObservationV0,
} from "@t3tools/contracts";

import { buildEvaluationDataset, calculateEvaluationMetrics } from "./routerEvaluation.ts";
import { knownQuantity } from "./turnOutcome.ts";

const observation = (input: {
  readonly id: string;
  readonly at: string;
  readonly model?: string;
  readonly terminal?: TurnOutcomeObservationV0["terminalCategory"];
  readonly cancelled?: boolean;
}): TurnOutcomeObservationV0 => ({
  version: TURN_OUTCOME_OBSERVATION_VERSION,
  observationId: input.id as TurnOutcomeObservationV0["observationId"],
  environmentId: "lab-environment" as TurnOutcomeObservationV0["environmentId"],
  recordedAt: input.at,
  policyVersion: "model-router.v0",
  routingMode: "auto",
  model: input.model ?? "gpt-5.5",
  instanceId: "codex" as TurnOutcomeObservationV0["instanceId"],
  taskProfile: UNKNOWN_TASK_PROFILE,
  timing: emptyTiming(),
  usage: emptyUsageMeasurement(),
  cost: emptyCostMeasurement(),
  providerAttempts: 1,
  fallbackCount: 0,
  cancelled: input.cancelled === true,
  timedOut: false,
  finishReason: input.cancelled === true ? "cancelled" : "stop",
  terminalCategory: input.terminal ?? (input.cancelled === true ? "cancelled" : "success"),
  evidence: emptyOutcomeEvidence(),
});

describe("router evaluation datasets", () => {
  const costRecords = (costs: ReadonlyArray<number | null>) =>
    costs.map((cost, index) => {
      const record = observation({
        id: `syn-cost-${index}`,
        at: "2026-10-12T00:00:00.000Z",
        terminal: index === 0 ? "provider_failure" : "success",
      });
      return {
        ...record,
        cost: {
          ...record.cost,
          reportedUsd:
            cost === null
              ? record.cost.reportedUsd
              : knownQuantity({
                  value: cost,
                  unit: "usd",
                  source: "openrouter_accounting",
                  provenance: "observed",
                  observedAt: record.recordedAt,
                }),
        },
      };
    });

  it("includes failed execution spend in the reported cost per terminal turn", () => {
    const metrics = calculateEvaluationMetrics(costRecords([9, 1, 1, 1, 1, 1, 1, 1]));
    const cost = metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd");
    expect(cost?.status).toBe("reliable");
    expect(cost?.numerator).toBe(16);
    expect(cost?.denominator).toBe(8);
    expect(cost?.sampleCount).toBe(8);
    expect(metrics.find((entry) => entry.id === "reported_cost_per_success_usd")?.numerator).toBe(
      1,
    );
  });

  it("reports incomplete cost coverage without imputing unknown spend as zero", () => {
    const metrics = calculateEvaluationMetrics(costRecords([null, 1, 1, 1, 1, 1, 1, 1]));
    const cost = metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd");
    expect(cost?.status).toBe("unknown");
    expect(cost?.denominator).toBe(0);
    expect(cost?.sampleCount).toBe(7);
    const coverage = metrics.find((entry) => entry.id === "reported_cost_coverage_rate");
    expect(coverage?.numerator).toBe(7);
    expect(coverage?.denominator).toBe(8);
  });

  it("preserves an explicitly reported zero cost", () => {
    const metrics = calculateEvaluationMetrics(costRecords(Array.from({ length: 8 }, () => 0)));
    const cost = metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd");
    expect(cost?.status).toBe("reliable");
    expect(cost?.numerator).toBe(0);
    expect(cost?.denominator).toBe(8);
  });

  it("keeps a complete but small cost sample insufficient", () => {
    const metrics = calculateEvaluationMetrics(costRecords([3]));
    const cost = metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd");
    expect(cost?.status).toBe("insufficient");
    expect(cost?.numerator).toBe(3);
    expect(cost?.denominator).toBe(1);
  });

  it.each(["cancelled", "timeout", "infrastructure_failure"] as const)(
    "includes reported spend for %s without changing quality exclusions",
    (terminalCategory) => {
      const records = costRecords([9, 1, 1, 1, 1, 1, 1, 1]);
      records[0] = { ...records[0]!, terminalCategory };
      const metrics = calculateEvaluationMetrics(records);
      expect(
        metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd")?.numerator,
      ).toBe(16);
      expect(metrics.find((entry) => entry.id === "execution_success_rate")?.denominator).toBe(7);
    },
  );

  it("does not substitute an estimated price for an unreported charge", () => {
    const records = costRecords([null]);
    const record = records[0]!;
    const metrics = calculateEvaluationMetrics([
      {
        ...record,
        cost: {
          ...record.cost,
          estimatedUsd: knownQuantity({
            value: 4,
            unit: "usd",
            source: "catalog_estimate",
            provenance: "estimated",
            observedAt: record.recordedAt,
          }),
        },
      },
    ]);
    expect(
      metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd")?.status,
    ).toBe("unknown");
    expect(metrics.find((entry) => entry.id === "reported_cost_coverage_rate")?.numerator).toBe(0);
  });

  it("keeps an empty reported-cost sample unknown", () => {
    const metrics = calculateEvaluationMetrics([]);
    expect(
      metrics.find((entry) => entry.id === "reported_cost_per_terminal_turn_usd")?.status,
    ).toBe("unknown");
    expect(metrics.find((entry) => entry.id === "reported_cost_coverage_rate")?.status).toBe(
      "unknown",
    );
  });

  it("uses a temporal holdout and rejects future rows", () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      observation({
        id: `syn-obs-${String(index + 1).padStart(2, "0")}`,
        at: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`,
      }),
    );
    const dataset = buildEvaluationDataset({
      records: [...records, observation({ id: "syn-obs-future", at: "2026-11-01T00:00:00.000Z" })],
      synthetic: true,
      asOf: "2026-10-09T00:00:00.000Z",
    });
    expect(dataset.excluded.some((entry) => entry.reason === "future_leakage")).toBe(true);
    expect(dataset.train.length + dataset.evaluation.length).toBe(dataset.manifest.recordCount);
    expect(dataset.evaluation.length).toBe(
      Math.ceil(dataset.manifest.recordCount * 0.2) || dataset.manifest.evaluationCount,
    );
    expect(dataset.manifest.synthetic).toBe(true);
    expect(dataset.manifest.holdout).toBe("temporal_last_20_percent");
  });

  it("does not treat cancellation as a quality failure", () => {
    const metrics = calculateEvaluationMetrics([
      observation({ id: "syn-ok", at: "2026-10-01T00:00:00.000Z" }),
      observation({
        id: "syn-cancel",
        at: "2026-10-02T00:00:00.000Z",
        cancelled: true,
      }),
    ]);
    const success = metrics.find((entry) => entry.id === "execution_success_rate");
    expect(success?.numerator).toBe(1);
    expect(success?.denominator).toBe(1);
    const cancel = metrics.find((entry) => entry.id === "cancellation_rate");
    expect(cancel?.numerator).toBe(1);
    expect(success?.status).toBe("insufficient");
  });

  it("marks metrics below the sample threshold as insufficient, not zero-reliable", () => {
    const metrics = calculateEvaluationMetrics([
      observation({ id: "syn-one", at: "2026-10-01T00:00:00.000Z" }),
    ]);
    for (const entry of metrics) {
      if (entry.sampleCount > 0 && entry.sampleCount < 8) {
        expect(entry.status).toBe("insufficient");
      }
    }
  });
});
