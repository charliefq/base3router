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
