import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import { UNKNOWN_TASK_PROFILE } from "./openRouter.ts";
import {
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  DEFAULT_OBSERVATION_RETENTION_DAYS,
  FORBIDDEN_OBSERVATION_FIELD_NAMES,
  HYBRID_ROUTER_POLICY_VERSION,
  TURN_OUTCOME_OBSERVATION_VERSION,
  TurnOutcomeObservationV0,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  emptyTiming,
  emptyUsageMeasurement,
  observationContainsForbiddenFields,
  unknownQuantity,
} from "./routerEvaluation.ts";

const decodeObservation = (input: unknown) =>
  Schema.decodeUnknownExit(TurnOutcomeObservationV0)(input, { onExcessProperty: "error" });
const encodeObservation = Schema.encodeUnknownSync(TurnOutcomeObservationV0);

const sampleObservation = {
  version: TURN_OUTCOME_OBSERVATION_VERSION,
  observationId: "syn-obs-1",
  environmentId: "lab-environment",
  recordedAt: "2026-10-03T00:00:00.000Z",
  policyVersion: "model-router.v0",
  routingMode: "auto",
  model: "gpt-5.5",
  instanceId: "codex",
  driver: "codex",
  taskProfile: UNKNOWN_TASK_PROFILE,
  timing: emptyTiming(),
  usage: emptyUsageMeasurement(),
  cost: emptyCostMeasurement(),
  providerAttempts: 1,
  fallbackCount: 0,
  cancelled: false,
  timedOut: false,
  finishReason: "stop",
  terminalCategory: "success",
  evidence: emptyOutcomeEvidence(),
} as const;

describe("router evaluation contracts", () => {
  it("decodes a sanitized observation without prompt or completion fields", () => {
    const decoded = decodeObservation(sampleObservation);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      const encoded = encodeObservation(decoded.value);
      expect(observationContainsForbiddenFields(encoded)).toBe(false);
      for (const field of FORBIDDEN_OBSERVATION_FIELD_NAMES) {
        expect(encoded).not.toHaveProperty(field);
      }
    }
  });

  it("rejects raw prompt fields on the observation schema", () => {
    const decoded = decodeObservation({
      ...sampleObservation,
      prompt: "write the dispatcher note",
    });
    expect(Exit.isSuccess(decoded)).toBe(false);
  });

  it("keeps missing cost and tokens unknown instead of zero", () => {
    expect(unknownQuantity("usd").status).toBe("unknown");
    expect(emptyCostMeasurement().reportedUsd).toEqual({
      status: "unknown",
      unit: "usd",
      source: "not_reported",
    });
    expect(emptyUsageMeasurement().promptTokens.status).toBe("unknown");
    expect(DEFAULT_HYBRID_ROUTER_WEIGHTS.reworkProxy).toBe(0.5);
    expect(DEFAULT_OBSERVATION_RETENTION_DAYS).toBe(90);
    expect(HYBRID_ROUTER_POLICY_VERSION).toBe("hybrid-router.v1.0.0");
    expect(EnvironmentId.make("lab-environment")).toBe("lab-environment");
  });

  it("labels rework signals as proxies", () => {
    const decoded = decodeObservation({
      ...sampleObservation,
      evidence: {
        explicitFeedback: [],
        reworkProxies: [
          {
            kind: "regenerate",
            labeledAs: "proxy",
            rawEventType: "regenerate",
            detectionWindowMs: 0,
            recordedAt: "2026-10-03T00:01:00.000Z",
            deduped: false,
          },
        ],
        verification: [],
      },
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.evidence.reworkProxies[0]?.labeledAs).toBe("proxy");
    }
  });
});
