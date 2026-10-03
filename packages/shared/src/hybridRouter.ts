import {
  type HybridRouteDecisionV1,
  type HybridScoreComponentV0,
  type MeasurementProvenance,
  type MeasurementSource,
  type ModelRouterCandidate,
  type ModelRouterDecision,
  type ModelRouterMetricValue,
  type ModelRouterReasonCode,
  type ModelRouterTarget,
  type RouterPolicyWeightsV1,
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  HYBRID_MIN_SAMPLE_RATE,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_SHRINKAGE_K,
  MODEL_ROUTER_UNKNOWN_METRIC,
} from "@t3tools/contracts";

import {
  compareModelRouterTieBreak,
  modelRouterTargetKey,
  routeModel,
  type ModelRouterInput,
} from "./modelRouter.ts";

export type LocalModelEvidence = {
  readonly successTrials: number;
  readonly successCount: number;
  readonly latencySamples: ReadonlyArray<number>;
  readonly costSamples: ReadonlyArray<number>;
  readonly costProvenance: MeasurementProvenance | "unknown";
  readonly costSource: MeasurementSource | "unknown";
  readonly explicitPositive: number;
  readonly explicitNegative: number;
  readonly explicitTotal: number;
  readonly reworkProxies: number;
  readonly reworkTrials: number;
  readonly verificationPassed: number;
  readonly verificationTrials: number;
  readonly marketPriorShare?: number;
};

export type HybridRouterInput = ModelRouterInput & {
  readonly evidenceByTarget?: ReadonlyMap<string, LocalModelEvidence>;
  readonly weights?: RouterPolicyWeightsV1;
  readonly activePolicyVersion?: string;
  readonly challengerEnabled?: boolean;
};

export type HybridRouterOutput = {
  readonly decision: ModelRouterDecision;
  readonly hybrid: HybridRouteDecisionV1;
};

const uniqueReasons = (
  codes: ReadonlyArray<ModelRouterReasonCode>,
): ReadonlyArray<ModelRouterReasonCode> => [...new Set(codes)].slice(0, 16);

const unknownMetric: ModelRouterMetricValue = MODEL_ROUTER_UNKNOWN_METRIC;

const knownMetric = (value: number): ModelRouterMetricValue =>
  Number.isFinite(value) ? { status: "known", value } : unknownMetric;

const shrink = (observed: number, n: number, prior: number, k = HYBRID_SHRINKAGE_K): number =>
  (n / (n + k)) * observed + (k / (n + k)) * prior;

const median = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid];
};

const invertNormalize = (value: number, min: number, max: number): number => {
  if (max <= min) return 0.5;
  const clamped = Math.min(max, Math.max(min, value));
  return 1 - (clamped - min) / (max - min);
};

const rate = (count: number, trials: number): number | undefined =>
  trials > 0 ? count / trials : undefined;

type Ranked = {
  readonly candidate: ModelRouterCandidate;
  readonly score: number;
  readonly components: ReadonlyArray<HybridScoreComponentV0>;
};

const component = (input: {
  readonly id: string;
  readonly label: string;
  readonly source: MeasurementSource;
  readonly provenance: MeasurementProvenance;
  readonly sampleSize: number;
  readonly weight: number;
  readonly value: ModelRouterMetricValue;
  readonly status: HybridScoreComponentV0["status"];
  readonly windowDays?: number;
}): HybridScoreComponentV0 => ({
  id: input.id,
  label: input.label,
  source: input.source,
  provenance: input.provenance,
  sampleSize: input.sampleSize,
  weight: input.weight,
  value: input.value,
  status: input.status,
  ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
});

const scoreCandidate = (
  candidate: ModelRouterCandidate,
  evidence: LocalModelEvidence | undefined,
  weights: RouterPolicyWeightsV1,
  costBounds: {
    readonly min: number;
    readonly max: number;
    readonly provenance: MeasurementProvenance;
  },
  latencyBounds: { readonly min: number; readonly max: number },
): Ranked => {
  const components: Array<HybridScoreComponentV0> = [];
  let score = 0;

  const marketPrior = evidence?.marketPriorShare;
  const marketUsable = marketPrior !== undefined;
  components.push(
    component({
      id: "market_prior",
      label: "OpenRouter 7-day sampled spend share (prior, not quality)",
      source: "openrouter_accounting",
      provenance: "estimated",
      sampleSize: marketUsable ? 1 : 0,
      weight: weights.marketPrior,
      value: marketUsable ? knownMetric(marketPrior) : unknownMetric,
      status: marketUsable ? "used" : "unknown",
      windowDays: 7,
    }),
  );
  if (marketUsable) score += weights.marketPrior * marketPrior;

  const successTrials = evidence?.successTrials ?? 0;
  const successRate = evidence ? rate(evidence.successCount, evidence.successTrials) : undefined;
  if (successTrials >= HYBRID_MIN_SAMPLE_RATE && successRate !== undefined) {
    const prior = marketPrior ?? 0.5;
    const shrunk = shrink(successRate, successTrials, prior);
    score += weights.success * shrunk;
    components.push(
      component({
        id: "success",
        label: "Local execution success (shrunk toward prior)",
        source: "provider_reported",
        provenance: "observed",
        sampleSize: successTrials,
        weight: weights.success,
        value: knownMetric(shrunk),
        status: "used",
      }),
    );
  } else {
    components.push(
      component({
        id: "success",
        label: "Local execution success",
        source: "provider_reported",
        provenance: "unknown",
        sampleSize: successTrials,
        weight: weights.success,
        value: unknownMetric,
        status: successTrials === 0 ? "unknown" : "insufficient",
      }),
    );
  }

  const latencyN = evidence?.latencySamples.length ?? 0;
  const latencyMedian = evidence ? median(evidence.latencySamples) : undefined;
  if (latencyN >= HYBRID_MIN_SAMPLE_RATE && latencyMedian !== undefined) {
    const inverted = invertNormalize(latencyMedian, latencyBounds.min, latencyBounds.max);
    score += weights.latency * inverted;
    components.push(
      component({
        id: "latency",
        label: "Median latency (measured)",
        source: "monotonic_clock",
        provenance: "observed",
        sampleSize: latencyN,
        weight: weights.latency,
        value: knownMetric(latencyMedian),
        status: "used",
      }),
    );
  } else {
    components.push(
      component({
        id: "latency",
        label: "Median latency",
        source: "monotonic_clock",
        provenance: "unknown",
        sampleSize: latencyN,
        weight: weights.latency,
        value: unknownMetric,
        status: latencyN === 0 ? "unknown" : "insufficient",
      }),
    );
  }

  const costN = evidence?.costSamples.length ?? 0;
  const costMedian = evidence ? median(evidence.costSamples) : undefined;
  const costProvenance = evidence?.costProvenance ?? "unknown";
  if (
    costN >= HYBRID_MIN_SAMPLE_RATE &&
    costMedian !== undefined &&
    costProvenance !== "unknown" &&
    costProvenance === costBounds.provenance
  ) {
    const inverted = invertNormalize(costMedian, costBounds.min, costBounds.max);
    score += weights.cost * inverted;
    components.push(
      component({
        id: "cost",
        label: `Median cost (${evidence?.costSource ?? "unknown"})`,
        source:
          evidence?.costSource === "unknown" ? "unknown" : (evidence?.costSource ?? "unknown"),
        provenance: costProvenance,
        sampleSize: costN,
        weight: weights.cost,
        value: knownMetric(costMedian),
        status: "used",
      }),
    );
  } else {
    const incompatible =
      costN >= HYBRID_MIN_SAMPLE_RATE &&
      costProvenance !== "unknown" &&
      costProvenance !== costBounds.provenance;
    components.push(
      component({
        id: "cost",
        label: "Median cost",
        source:
          evidence?.costSource === "unknown" || evidence?.costSource === undefined
            ? "unknown"
            : evidence.costSource,
        provenance: costProvenance === "unknown" ? "unknown" : costProvenance,
        sampleSize: costN,
        weight: weights.cost,
        value: unknownMetric,
        status: incompatible ? "incompatible_provenance" : costN === 0 ? "unknown" : "insufficient",
      }),
    );
  }

  const explicitTotal = evidence?.explicitTotal ?? 0;
  const positiveRate = evidence
    ? rate(evidence.explicitPositive, evidence.explicitTotal)
    : undefined;
  const negativeRate = evidence
    ? rate(evidence.explicitNegative, evidence.explicitTotal)
    : undefined;
  if (explicitTotal >= HYBRID_MIN_SAMPLE_RATE && positiveRate !== undefined) {
    const shrunk = shrink(positiveRate, explicitTotal, 0.5);
    score += weights.explicitPositive * shrunk;
    components.push(
      component({
        id: "explicit_positive",
        label: "Explicit positive feedback",
        source: "user_explicit",
        provenance: "observed",
        sampleSize: explicitTotal,
        weight: weights.explicitPositive,
        value: knownMetric(shrunk),
        status: "used",
      }),
    );
  } else {
    components.push(
      component({
        id: "explicit_positive",
        label: "Explicit positive feedback (absence is not positive)",
        source: "user_explicit",
        provenance: "unknown",
        sampleSize: explicitTotal,
        weight: weights.explicitPositive,
        value: unknownMetric,
        status: explicitTotal === 0 ? "unknown" : "insufficient",
      }),
    );
  }
  if (explicitTotal >= HYBRID_MIN_SAMPLE_RATE && negativeRate !== undefined) {
    const shrunk = shrink(negativeRate, explicitTotal, 0.5);
    score -= weights.explicitNegative * shrunk;
    components.push(
      component({
        id: "explicit_negative",
        label: "Explicit negative feedback",
        source: "user_explicit",
        provenance: "observed",
        sampleSize: explicitTotal,
        weight: weights.explicitNegative,
        value: knownMetric(shrunk),
        status: "used",
      }),
    );
  } else {
    components.push(
      component({
        id: "explicit_negative",
        label: "Explicit negative feedback",
        source: "user_explicit",
        provenance: "unknown",
        sampleSize: explicitTotal,
        weight: weights.explicitNegative,
        value: unknownMetric,
        status: explicitTotal === 0 ? "unknown" : "insufficient",
      }),
    );
  }

  const reworkTrials = evidence?.reworkTrials ?? 0;
  const reworkRate = evidence ? rate(evidence.reworkProxies, evidence.reworkTrials) : undefined;
  if (reworkTrials >= HYBRID_MIN_SAMPLE_RATE && reworkRate !== undefined) {
    const shrunk = shrink(reworkRate, reworkTrials, 0.5);
    score -= weights.reworkProxy * shrunk;
    components.push(
      component({
        id: "rework_proxy",
        label: "Rework proxy rate (proxy, not quality)",
        source: "rework_proxy",
        provenance: "observed",
        sampleSize: reworkTrials,
        weight: weights.reworkProxy,
        value: knownMetric(shrunk),
        status: "used",
      }),
    );
  } else {
    components.push(
      component({
        id: "rework_proxy",
        label: "Rework proxy rate (proxy, not quality)",
        source: "rework_proxy",
        provenance: "unknown",
        sampleSize: reworkTrials,
        weight: weights.reworkProxy,
        value: unknownMetric,
        status: reworkTrials === 0 ? "unknown" : "insufficient",
      }),
    );
  }

  const verifyTrials = evidence?.verificationTrials ?? 0;
  const verifyRate = evidence
    ? rate(evidence.verificationPassed, evidence.verificationTrials)
    : undefined;
  if (verifyTrials >= HYBRID_MIN_SAMPLE_RATE && verifyRate !== undefined) {
    const shrunk = shrink(verifyRate, verifyTrials, 0.5);
    score += weights.verification * shrunk;
    components.push(
      component({
        id: "verification",
        label: "Coding verification pass rate",
        source: "verification_command",
        provenance: "observed",
        sampleSize: verifyTrials,
        weight: weights.verification,
        value: knownMetric(shrunk),
        status: "used",
      }),
    );
  } else {
    components.push(
      component({
        id: "verification",
        label: "Coding verification pass rate",
        source: "verification_command",
        provenance: "unknown",
        sampleSize: verifyTrials,
        weight: weights.verification,
        value: unknownMetric,
        status: verifyTrials === 0 ? "unknown" : "insufficient",
      }),
    );
  }

  return { candidate, score, components };
};

const rankingUsable = (ranked: Ranked): boolean =>
  ranked.components.some((entry) => entry.status === "used" && entry.id !== "market_prior");

const agreement = (
  left: ModelRouterTarget | null,
  right: ModelRouterTarget | null,
): "agreement" | "disagreement" | "inapplicable" | "unknown" => {
  if (left === null || right === null) return "inapplicable";
  return modelRouterTargetKey(left) === modelRouterTargetKey(right) ? "agreement" : "disagreement";
};

const explain = (input: {
  readonly selected: ModelRouterCandidate | null;
  readonly usedHybrid: boolean;
  readonly fallbackToV0: boolean;
  readonly components: ReadonlyArray<HybridScoreComponentV0>;
  readonly fallbackReason?: string;
}): string => {
  if (input.selected === null) {
    return "No eligible model after hard constraints.";
  }
  const target = `${input.selected.target.instanceId} · ${input.selected.target.model}`;
  if (!input.usedHybrid) {
    const reason =
      input.fallbackReason ??
      (input.fallbackToV0
        ? "Hybrid evidence is insufficient; Router V0 was used."
        : "Manual bypassed Hybrid ranking.");
    return `Selected ${target}. ${reason} Policy: ${HYBRID_ROUTER_POLICY_VERSION}.`;
  }
  const used = input.components
    .filter((entry) => entry.status === "used")
    .map((entry) => {
      const sample = entry.sampleSize > 0 ? `, n=${entry.sampleSize}` : "";
      const value = entry.value.status === "known" ? ` ${entry.value.value}` : "";
      return `${entry.label}:${value}${sample}`;
    })
    .slice(0, 6);
  return `Selected ${target}. Passed all hard constraints. ${used.join("; ")}. Policy: ${HYBRID_ROUTER_POLICY_VERSION}.`;
};

/**
 * Pure Hybrid Router V1. Hard filters come from `routeModel`. Insufficient
 * local evidence falls back to Router V0. Policy shadow never changes the
 * live decision.
 */
export function routeHybridModel(input: HybridRouterInput): HybridRouterOutput {
  const v0 = routeModel(input);
  const weights = input.weights ?? DEFAULT_HYBRID_ROUTER_WEIGHTS;
  const evidenceByTarget = input.evidenceByTarget ?? new Map();
  const activeIsHybrid = input.activePolicyVersion === HYBRID_ROUTER_POLICY_VERSION;

  if (input.mode === "manual") {
    const hybrid: HybridRouteDecisionV1 = {
      policyVersion: HYBRID_ROUTER_POLICY_VERSION,
      usedHybridRanking: false,
      fallbackToV0: false,
      fallbackReason: "Manual bypasses Hybrid ranking.",
      selected: v0.selected?.target ?? null,
      eligibleCount: v0.candidates.filter((candidate) => candidate.eligible).length,
      components: [],
      explanation: explain({
        selected: v0.selected,
        usedHybrid: false,
        fallbackToV0: false,
        components: [],
      }),
    };
    return { decision: v0, hybrid };
  }

  const eligible = v0.candidates.filter((candidate) => candidate.eligible);
  const latencyValues = eligible.flatMap(
    (candidate) =>
      evidenceByTarget.get(modelRouterTargetKey(candidate.target))?.latencySamples ?? [],
  );
  const costGroups = new Map<MeasurementProvenance, number[]>();
  for (const candidate of eligible) {
    const evidence = evidenceByTarget.get(modelRouterTargetKey(candidate.target));
    if (evidence === undefined || evidence.costProvenance === "unknown") continue;
    const group = costGroups.get(evidence.costProvenance) ?? [];
    group.push(...evidence.costSamples);
    costGroups.set(evidence.costProvenance, group);
  }
  let costProvenance: MeasurementProvenance = "observed";
  let costValues: number[] = [];
  for (const [provenance, values] of costGroups) {
    if (values.length > costValues.length) {
      costProvenance = provenance;
      costValues = values;
    }
  }
  const latencyBounds = {
    min: latencyValues.length > 0 ? Math.min(...latencyValues) : 0,
    max: latencyValues.length > 0 ? Math.max(...latencyValues) : 1,
  };
  const costBounds = {
    min: costValues.length > 0 ? Math.min(...costValues) : 0,
    max: costValues.length > 0 ? Math.max(...costValues) : 1,
    provenance: costProvenance,
  };

  const ranked = eligible.map((candidate) =>
    scoreCandidate(
      candidate,
      evidenceByTarget.get(modelRouterTargetKey(candidate.target)),
      weights,
      costBounds,
      latencyBounds,
    ),
  );
  const sufficient = ranked.some(rankingUsable);
  ranked.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return compareModelRouterTieBreak(left.candidate, right.candidate);
  });
  const hybridSelected = sufficient ? (ranked[0]?.candidate ?? null) : null;
  const selectedComponents = ranked[0]?.components ?? [];

  const applyHybrid = activeIsHybrid && sufficient && hybridSelected !== null;
  const fallbackToV0 = activeIsHybrid && !applyHybrid;
  const extraReasons: ReadonlyArray<ModelRouterReasonCode> = applyHybrid
    ? ["HYBRID_RANKED"]
    : fallbackToV0
      ? ["HYBRID_INSUFFICIENT_EVIDENCE", "HYBRID_FALLBACK_V0"]
      : input.challengerEnabled === true && sufficient
        ? ["POLICY_SHADOW_RECORDED"]
        : [];
  const fallbackReason = applyHybrid
    ? undefined
    : fallbackToV0
      ? "Insufficient local evidence; Router V0 was used."
      : "Hybrid is not the active policy; Router V0 executed.";
  const decision: ModelRouterDecision = applyHybrid
    ? {
        ...v0,
        policyVersion: applyHybrid ? HYBRID_ROUTER_POLICY_VERSION : v0.policyVersion,
        selected: {
          ...hybridSelected,
          reasonCodes: uniqueReasons([...hybridSelected.reasonCodes, "HYBRID_RANKED", "SELECTED"]),
        },
        reasonCodes: uniqueReasons([...v0.reasonCodes, ...extraReasons]),
        executed: hybridSelected,
        explanation: explain({
          selected: hybridSelected,
          usedHybrid: true,
          fallbackToV0: false,
          components: selectedComponents,
        }),
      }
    : {
        ...v0,
        reasonCodes: uniqueReasons([...v0.reasonCodes, ...extraReasons]),
      };

  const liveTarget = decision.selected?.target ?? null;
  const hybridTarget = hybridSelected?.target ?? null;
  const hybrid: HybridRouteDecisionV1 = {
    policyVersion: HYBRID_ROUTER_POLICY_VERSION,
    usedHybridRanking: applyHybrid,
    fallbackToV0,
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    selected: liveTarget,
    eligibleCount: eligible.length,
    components: selectedComponents,
    explanation: explain({
      selected: applyHybrid ? hybridSelected : v0.selected,
      usedHybrid: applyHybrid,
      fallbackToV0,
      components: selectedComponents,
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    }),
    ...(input.challengerEnabled === true
      ? {
          challenger: {
            kind: "policy_shadow" as const,
            selected: hybridTarget,
            agreement: sufficient ? agreement(liveTarget, hybridTarget) : ("inapplicable" as const),
          },
        }
      : {}),
  };

  return { decision, hybrid };
}

export const emptyLocalEvidence = (): LocalModelEvidence => ({
  successTrials: 0,
  successCount: 0,
  latencySamples: [],
  costSamples: [],
  costProvenance: "unknown",
  costSource: "unknown",
  explicitPositive: 0,
  explicitNegative: 0,
  explicitTotal: 0,
  reworkProxies: 0,
  reworkTrials: 0,
  verificationPassed: 0,
  verificationTrials: 0,
});
