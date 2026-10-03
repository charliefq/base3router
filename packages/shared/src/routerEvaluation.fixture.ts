/**
 * Synthetic Phase 11 evaluation fixture. Obviously synthetic: ids are `syn-*`.
 * Contains no prompts, completions, or credentials. Outcomes are mixed on
 * purpose so Hybrid is not tuned to look better than Router V0.
 */
import {
  EnvironmentId,
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
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

const base = (
  id: string,
  at: string,
  model: string,
  extras: Partial<TurnOutcomeObservationV0> = {},
): TurnOutcomeObservationV0 => {
  const claude = model.startsWith("claude");
  return {
    version: TURN_OUTCOME_OBSERVATION_VERSION,
    observationId: ObservationId.make(id),
    environmentId: env,
    recordedAt: at,
    policyVersion: MODEL_ROUTER_POLICY_VERSION,
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
    ...extras,
  };
};

export const SYNTHETIC_ROUTER_EVALUATION_OBSERVATIONS: ReadonlyArray<TurnOutcomeObservationV0> = [
  ...Array.from({ length: 12 }, (_, index) => {
    const day = String((index % 9) + 1).padStart(2, "0");
    const model = index % 2 === 0 ? "gpt-5.5" : "claude-sonnet-4-6";
    return base(
      `syn-obs-${String(index + 1).padStart(2, "0")}`,
      `2026-10-${day}T00:00:00.000Z`,
      model,
      index < 4
        ? {
            policyVersion: HYBRID_ROUTER_POLICY_VERSION,
            hybrid: {
              policyVersion: HYBRID_ROUTER_POLICY_VERSION,
              usedHybridRanking: true,
              fallbackToV0: false,
              selected: {
                instanceId: ProviderInstanceId.make(
                  model.startsWith("claude") ? "claude" : "codex",
                ),
                model,
              },
              eligibleCount: 2,
              components: [],
              explanation: "Hybrid ranked from local evidence.",
            },
          }
        : index === 4
          ? {
              hybrid: {
                policyVersion: HYBRID_ROUTER_POLICY_VERSION,
                usedHybridRanking: false,
                fallbackToV0: true,
                selected: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
                eligibleCount: 2,
                components: [],
                explanation: "Insufficient local evidence; Router V0 was used.",
              },
            }
          : {},
    );
  }),
  base("syn-obs-13", "2026-10-04T00:00:00.000Z", "gpt-5.5", {
    terminalCategory: "provider_failure",
    finishReason: "error",
  }),
  base("syn-obs-14", "2026-10-04T01:00:00.000Z", "gpt-5.5", {
    terminalCategory: "provider_failure",
    finishReason: "content_filter",
  }),
  base("syn-obs-15", "2026-10-04T02:00:00.000Z", "gpt-5.5", {
    terminalCategory: "timeout",
    timedOut: true,
    finishReason: "timeout",
    timing: emptyTiming(),
  }),
  base("syn-obs-16", "2026-10-04T03:00:00.000Z", "gpt-5.5", {
    terminalCategory: "cancelled",
    cancelled: true,
    finishReason: "cancelled",
  }),
  base("syn-obs-17", "2026-10-05T00:00:00.000Z", "claude-sonnet-4-6", {
    evidence: {
      explicitFeedback: [
        { kind: "helpful", recordedAt: "2026-10-05T00:01:00.000Z", freeTextIncluded: false },
      ],
      reworkProxies: [],
      verification: [],
    },
  }),
  base("syn-obs-18", "2026-10-05T01:00:00.000Z", "gpt-5.5", {
    evidence: {
      explicitFeedback: [],
      reworkProxies: [
        {
          kind: "retry_after_failure",
          labeledAs: "proxy",
          rawEventType: "retry_after_failure",
          detectionWindowMs: 8_000,
          recordedAt: "2026-10-05T01:00:08.000Z",
          deduped: false,
        },
      ],
      verification: [],
    },
  }),
  base("syn-obs-19", "2026-10-05T02:00:00.000Z", "claude-sonnet-4-6", {
    evidence: {
      explicitFeedback: [],
      reworkProxies: [],
      verification: [
        {
          kind: "tests",
          result: "passed",
          retryCount: 0,
          recordedAt: "2026-10-05T02:00:10.000Z",
          fromRealCommand: true,
        },
      ],
    },
  }),
  base("syn-obs-20", "2026-10-05T03:00:00.000Z", "gpt-5.5", {
    cost: {
      ...emptyCostMeasurement(),
      reportedUsd: knownQuantity({
        value: 0.01,
        unit: "usd",
        source: "openrouter_accounting",
        provenance: "observed",
        observedAt: "2026-10-05T03:00:00.000Z",
      }),
      reportedSource: "openrouter_accounting",
      estimatedUsd: knownQuantity({
        value: 0.03,
        unit: "usd",
        source: "catalog_estimate",
        provenance: "estimated",
        observedAt: "2026-10-05T03:00:00.000Z",
      }),
      estimatedSource: "catalog_estimate",
      pricingSnapshotAt: "2026-10-05T00:00:00.000Z",
      pricingSnapshotVersion: "catalog.v0",
      mixedProvenance: true,
    },
  }),
];
