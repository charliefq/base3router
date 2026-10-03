/**
 * Synthetic Phase 11 evaluation fixture. Obviously synthetic: ids are `syn-*`.
 * Contains no prompts, completions, or credentials.
 */
import {
  EnvironmentId,
  ObservationId,
  ProviderDriverKind,
  ProviderInstanceId,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  emptyTiming,
  emptyUsageMeasurement,
  type TurnOutcomeObservationV0,
} from "@t3tools/contracts";

import { knownQuantity } from "./turnOutcome.ts";

const env = EnvironmentId.make("syn-environment");

const base = (id: string, at: string, model: string): TurnOutcomeObservationV0 => {
  const claude = model.startsWith("claude");
  return {
    version: TURN_OUTCOME_OBSERVATION_VERSION,
    observationId: ObservationId.make(id),
    environmentId: env,
    recordedAt: at,
    policyVersion: "model-router.v0",
    routingMode: "auto",
    model,
    instanceId: ProviderInstanceId.make(claude ? "claude" : "codex"),
    driver: ProviderDriverKind.make(claude ? "claudeAgent" : "codex"),
    taskProfile: { ...UNKNOWN_TASK_PROFILE, macroCategory: "coding" },
    timing: {
      ...emptyTiming(),
      totalDurationMs: knownQuantity({
        value: claude ? 140 : 400,
        unit: "ms",
        source: "monotonic_clock",
        provenance: "observed",
        observedAt: at,
      }),
      timeToFirstTokenMs: knownQuantity({
        value: 40,
        unit: "ms",
        source: "monotonic_clock",
        provenance: "observed",
        observedAt: at,
      }),
    },
    usage: emptyUsageMeasurement(),
    cost: {
      ...emptyCostMeasurement(),
      reportedUsd: knownQuantity({
        value: 0.02,
        unit: "usd",
        source: "openrouter_accounting",
        provenance: "observed",
        observedAt: at,
      }),
      reportedSource: "openrouter_accounting",
    },
    providerAttempts: 1,
    fallbackCount: 0,
    cancelled: false,
    timedOut: false,
    finishReason: "stop",
    terminalCategory: "success",
    evidence: emptyOutcomeEvidence(),
  };
};

export const SYNTHETIC_ROUTER_EVALUATION_OBSERVATIONS: ReadonlyArray<TurnOutcomeObservationV0> =
  Array.from({ length: 20 }, (_, index) => {
    const day = String((index % 9) + 1).padStart(2, "0");
    const model = index % 2 === 0 ? "gpt-5.5" : "claude-sonnet-4-6";
    return base(
      `syn-obs-${String(index + 1).padStart(2, "0")}`,
      `2026-10-${day}T00:00:00.000Z`,
      model,
    );
  });
