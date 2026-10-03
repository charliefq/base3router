import {
  type EvaluationDatasetFilterV0,
  type EvaluationDatasetManifestV0,
  type EvaluationMetricV0,
  type PolicyEvaluationRecordV0,
  type TurnOutcomeObservationV0,
  EXPLICIT_NEGATIVE_FEEDBACK,
  EXPLICIT_POSITIVE_FEEDBACK,
  HYBRID_MIN_SAMPLE_MEDIAN,
  HYBRID_MIN_SAMPLE_P90,
  HYBRID_MIN_SAMPLE_P95,
  HYBRID_MIN_SAMPLE_RATE,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_SHRINKAGE_K,
  MODEL_ROUTER_POLICY_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  ROUTER_EVALUATION_DATASET_VERSION,
  TURN_OUTCOME_OBSERVATION_VERSION,
} from "@t3tools/contracts";

import { emptyLocalEvidence, type LocalModelEvidence } from "./hybridRouter.ts";
import { modelRouterTargetKey } from "./modelRouter.ts";

export {
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
};
export type { TurnOutcomeObservationV0 };

const QUALITY_EXCLUDED = new Set(["cancelled", "timeout", "infrastructure_failure"]);

const observationTargetKey = (observation: TurnOutcomeObservationV0): string =>
  observation.instanceId === undefined
    ? observation.model
    : `${observation.instanceId}\u0000${observation.model}`;

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const matchFilter = (
  observation: TurnOutcomeObservationV0,
  filters: EvaluationDatasetFilterV0,
): boolean => {
  if (
    filters.macroCategory !== undefined &&
    observation.taskProfile.macroCategory !== filters.macroCategory
  ) {
    return false;
  }
  if (
    filters.rawTaskTag !== undefined &&
    observation.taskProfile.rawExternalTag !== filters.rawTaskTag
  ) {
    return false;
  }
  if (filters.routingMode !== undefined && observation.routingMode !== filters.routingMode) {
    return false;
  }
  if (filters.model !== undefined && observation.model !== filters.model) return false;
  if (filters.provider !== undefined && observation.providerIdentity !== filters.provider) {
    return false;
  }
  if (filters.policyVersion !== undefined && observation.policyVersion !== filters.policyVersion) {
    return false;
  }
  if (filters.since !== undefined && observation.recordedAt < filters.since) return false;
  if (filters.until !== undefined && observation.recordedAt > filters.until) return false;
  return true;
};

const sortObservations = (
  records: ReadonlyArray<TurnOutcomeObservationV0>,
): ReadonlyArray<TurnOutcomeObservationV0> =>
  [...records].sort((left, right) => {
    const time = left.recordedAt.localeCompare(right.recordedAt);
    return time !== 0 ? time : left.observationId.localeCompare(right.observationId);
  });

const dedupeObservations = (
  records: ReadonlyArray<TurnOutcomeObservationV0>,
): ReadonlyArray<TurnOutcomeObservationV0> => {
  const seen = new Set<string>();
  const result: Array<TurnOutcomeObservationV0> = [];
  for (const record of sortObservations(records)) {
    if (seen.has(record.observationId)) continue;
    seen.add(record.observationId);
    result.push(record);
  }
  return result;
};

export const buildEvaluationDataset = (input: {
  readonly records: ReadonlyArray<TurnOutcomeObservationV0>;
  readonly filters?: EvaluationDatasetFilterV0;
  readonly synthetic?: boolean;
  readonly asOf?: string;
}): {
  readonly manifest: EvaluationDatasetManifestV0;
  readonly train: ReadonlyArray<TurnOutcomeObservationV0>;
  readonly evaluation: ReadonlyArray<TurnOutcomeObservationV0>;
  readonly excluded: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
} => {
  const filters = input.filters ?? {};
  const excluded: Array<{ readonly id: string; readonly reason: string }> = [];
  const filtered: Array<TurnOutcomeObservationV0> = [];
  for (const record of dedupeObservations(input.records)) {
    if (input.asOf !== undefined && record.recordedAt > input.asOf) {
      excluded.push({ id: record.observationId, reason: "future_leakage" });
      continue;
    }
    if (!matchFilter(record, filters)) {
      excluded.push({ id: record.observationId, reason: "filter_mismatch" });
      continue;
    }
    filtered.push(record);
  }
  const splitAt = Math.max(0, Math.floor(filtered.length * 0.8));
  const train = filtered.slice(0, splitAt);
  const evaluation = filtered.slice(splitAt);
  const since = filtered[0]?.recordedAt;
  const until = filtered[filtered.length - 1]?.recordedAt;
  const datasetHash = fnv1a(
    `${TURN_OUTCOME_OBSERVATION_VERSION}:${filtered.map((entry) => entry.observationId).join(",")}`,
  );
  return {
    manifest: {
      version: ROUTER_EVALUATION_DATASET_VERSION,
      synthetic: input.synthetic === true,
      recordCount: filtered.length,
      trainCount: train.length,
      evaluationCount: evaluation.length,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      schemaVersion: TURN_OUTCOME_OBSERVATION_VERSION,
      filters,
      datasetHash,
      holdout: "temporal_last_20_percent",
    },
    train,
    evaluation,
    excluded,
  };
};

const metric = (input: {
  readonly id: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly sampleCount: number;
  readonly minSample: number;
  readonly unit: EvaluationMetricV0["unit"];
  readonly provenance: EvaluationMetricV0["provenance"];
}): EvaluationMetricV0 => ({
  id: input.id,
  numerator: input.numerator,
  denominator: input.denominator,
  sampleCount: input.sampleCount,
  status:
    input.sampleCount === 0
      ? "unknown"
      : input.sampleCount >= input.minSample
        ? "reliable"
        : "insufficient",
  provenance: input.provenance,
  unit: input.unit,
});

const percentile = (values: ReadonlyArray<number>, p: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const median = (values: ReadonlyArray<number>): number | undefined => percentile(values, 50);

export const calculateEvaluationMetrics = (
  records: ReadonlyArray<TurnOutcomeObservationV0>,
): ReadonlyArray<EvaluationMetricV0> => {
  const quality = records.filter((record) => !QUALITY_EXCLUDED.has(record.terminalCategory));
  const success = quality.filter((record) => record.terminalCategory === "success");
  const providerFailure = records.filter(
    (record) => record.terminalCategory === "provider_failure",
  );
  const cancelled = records.filter((record) => record.cancelled);
  const fallbacks = records.filter((record) => record.fallbackCount > 0);
  const latency = success
    .map((record) => record.timing.totalDurationMs)
    .filter((value) => value.status === "known")
    .map((value) => value.value);
  const ttft = success
    .map((record) => record.timing.timeToFirstTokenMs)
    .filter((value) => value.status === "known")
    .map((value) => value.value);
  const reportedCost = success
    .map((record) => record.cost.reportedUsd)
    .filter((value) => value.status === "known")
    .map((value) => value.value);
  const estimatedCost = success
    .map((record) => record.cost.estimatedUsd)
    .filter((value) => value.status === "known")
    .map((value) => value.value);
  const withFeedback = records.filter((record) => record.evidence.explicitFeedback.length > 0);
  const positive = withFeedback.filter((record) =>
    record.evidence.explicitFeedback.some((entry) => EXPLICIT_POSITIVE_FEEDBACK.has(entry.kind)),
  );
  const negative = withFeedback.filter((record) =>
    record.evidence.explicitFeedback.some((entry) => EXPLICIT_NEGATIVE_FEEDBACK.has(entry.kind)),
  );
  const rework = records.filter((record) => record.evidence.reworkProxies.length > 0);
  const withVerification = records.filter((record) => record.evidence.verification.length > 0);
  const verificationPassed = withVerification.filter((record) =>
    record.evidence.verification.every((entry) => entry.result === "passed"),
  );
  const autoToManual = records.filter((record) =>
    record.evidence.reworkProxies.some((entry) => entry.kind === "auto_to_manual_switch"),
  );
  const agreementKnown = records.filter(
    (record) =>
      record.openRouterAgreement === "agreement" || record.openRouterAgreement === "disagreement",
  );
  const agreed = agreementKnown.filter((record) => record.openRouterAgreement === "agreement");
  const latencyMedian = median(latency);
  const latencyP90 = percentile(latency, 90);
  const latencyP95 = percentile(latency, 95);
  const ttftMedian = median(ttft);
  const reportedCostMedian = median(reportedCost);
  const estimatedCostMedian = median(estimatedCost);

  return [
    metric({
      id: "execution_success_rate",
      numerator: success.length,
      denominator: quality.length,
      sampleCount: quality.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "provider_failure_rate",
      numerator: providerFailure.length,
      denominator: records.length,
      sampleCount: records.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "fallback_rate",
      numerator: fallbacks.length,
      denominator: records.length,
      sampleCount: records.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "cancellation_rate",
      numerator: cancelled.length,
      denominator: records.length,
      sampleCount: records.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "median_latency_ms",
      numerator: latencyMedian ?? 0,
      denominator: 1,
      sampleCount: latency.length,
      minSample: HYBRID_MIN_SAMPLE_MEDIAN,
      unit: "ms",
      provenance: "observed",
    }),
    metric({
      id: "p90_latency_ms",
      numerator: latencyP90 ?? 0,
      denominator: 1,
      sampleCount: latency.length,
      minSample: HYBRID_MIN_SAMPLE_P90,
      unit: "ms",
      provenance: "observed",
    }),
    metric({
      id: "p95_latency_ms",
      numerator: latencyP95 ?? 0,
      denominator: 1,
      sampleCount: latency.length,
      minSample: HYBRID_MIN_SAMPLE_P95,
      unit: "ms",
      provenance: "observed",
    }),
    metric({
      id: "median_ttft_ms",
      numerator: ttftMedian ?? 0,
      denominator: 1,
      sampleCount: ttft.length,
      minSample: HYBRID_MIN_SAMPLE_MEDIAN,
      unit: "ms",
      provenance: "observed",
    }),
    metric({
      id: "reported_cost_per_success_usd",
      numerator: reportedCostMedian ?? 0,
      denominator: 1,
      sampleCount: reportedCost.length,
      minSample: HYBRID_MIN_SAMPLE_MEDIAN,
      unit: "usd",
      provenance: "observed",
    }),
    metric({
      id: "estimated_cost_per_success_usd",
      numerator: estimatedCostMedian ?? 0,
      denominator: 1,
      sampleCount: estimatedCost.length,
      minSample: HYBRID_MIN_SAMPLE_MEDIAN,
      unit: "usd",
      provenance: "estimated",
    }),
    metric({
      id: "explicit_positive_feedback_rate",
      numerator: positive.length,
      denominator: withFeedback.length,
      sampleCount: withFeedback.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "explicit_negative_feedback_rate",
      numerator: negative.length,
      denominator: withFeedback.length,
      sampleCount: withFeedback.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "rework_proxy_rate",
      numerator: rework.length,
      denominator: records.length,
      sampleCount: records.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "verification_pass_rate",
      numerator: verificationPassed.length,
      denominator: withVerification.length,
      sampleCount: withVerification.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "auto_manual_switch_rate",
      numerator: autoToManual.length,
      denominator: records.length,
      sampleCount: records.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
    metric({
      id: "base3_openrouter_agreement_rate",
      numerator: agreed.length,
      denominator: agreementKnown.length,
      sampleCount: agreementKnown.length,
      minSample: HYBRID_MIN_SAMPLE_RATE,
      unit: "rate",
      provenance: "observed",
    }),
  ];
};

export const evidenceFromObservations = (
  records: ReadonlyArray<TurnOutcomeObservationV0>,
): Map<string, LocalModelEvidence> => {
  const grouped = new Map<string, TurnOutcomeObservationV0[]>();
  for (const record of records) {
    const key = observationTargetKey(record);
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  const result = new Map<string, LocalModelEvidence>();
  for (const [key, group] of grouped) {
    const quality = group.filter((record) => !QUALITY_EXCLUDED.has(record.terminalCategory));
    const knownQuantity = (
      quantity: TurnOutcomeObservationV0["timing"]["totalDurationMs"],
    ): number[] => (quantity.status === "known" ? [quantity.value] : []);
    const latency = quality.flatMap((record) => knownQuantity(record.timing.totalDurationMs));
    const reported = quality.flatMap((record) => knownQuantity(record.cost.reportedUsd));
    const estimated = quality.flatMap((record) => knownQuantity(record.cost.estimatedUsd));
    const useReported = reported.length >= estimated.length;
    const withFeedback = group.filter((record) => record.evidence.explicitFeedback.length > 0);
    result.set(key, {
      ...emptyLocalEvidence(),
      successTrials: quality.length,
      successCount: quality.filter((record) => record.terminalCategory === "success").length,
      latencySamples: latency,
      costSamples: useReported ? reported : estimated,
      costProvenance: useReported
        ? reported.length > 0
          ? "observed"
          : "unknown"
        : estimated.length > 0
          ? "estimated"
          : "unknown",
      costSource: useReported
        ? quality.find((record) => record.cost.reportedUsd.status === "known")?.cost
            .reportedSource === "openrouter_accounting"
          ? "openrouter_accounting"
          : "provider_reported"
        : "catalog_estimate",
      explicitPositive: withFeedback.filter((record) =>
        record.evidence.explicitFeedback.some((entry) =>
          EXPLICIT_POSITIVE_FEEDBACK.has(entry.kind),
        ),
      ).length,
      explicitNegative: withFeedback.filter((record) =>
        record.evidence.explicitFeedback.some((entry) =>
          EXPLICIT_NEGATIVE_FEEDBACK.has(entry.kind),
        ),
      ).length,
      explicitTotal: withFeedback.length,
      reworkProxies: group.filter((record) => record.evidence.reworkProxies.length > 0).length,
      reworkTrials: group.length,
      verificationPassed: group.filter(
        (record) =>
          record.evidence.verification.length > 0 &&
          record.evidence.verification.every((entry) => entry.result === "passed"),
      ).length,
      verificationTrials: group.filter((record) => record.evidence.verification.length > 0).length,
    });
  }
  return result;
};

export const evaluatePolicies = (input: {
  readonly records: ReadonlyArray<TurnOutcomeObservationV0>;
  readonly v0Selected: ReadonlyMap<string, string>;
  readonly hybridSelected: ReadonlyMap<string, string>;
  readonly policyVersion: string;
  readonly synthetic?: boolean;
}): PolicyEvaluationRecordV0 => {
  const dataset = buildEvaluationDataset({
    records: input.records,
    ...(input.synthetic !== undefined ? { synthetic: input.synthetic } : {}),
  });
  let changed = 0;
  let regressions = 0;
  let improvements = 0;
  let unknowns = 0;
  for (const record of dataset.evaluation) {
    const v0 = input.v0Selected.get(record.observationId);
    const hybrid = input.hybridSelected.get(record.observationId);
    if (v0 === undefined || hybrid === undefined) {
      unknowns += 1;
      continue;
    }
    if (v0 === hybrid) continue;
    changed += 1;
    const v0Success = record.model === v0 && record.terminalCategory === "success";
    const hybridWouldMatchActual = record.model === hybrid;
    if (hybridWouldMatchActual && record.terminalCategory === "success") improvements += 1;
    else if (v0Success && !hybridWouldMatchActual) regressions += 1;
  }
  const metrics = calculateEvaluationMetrics(dataset.evaluation);
  const coverage = metric({
    id: "coverage",
    numerator: dataset.evaluation.length,
    denominator: dataset.manifest.recordCount,
    sampleCount: dataset.manifest.recordCount,
    minSample: HYBRID_MIN_SAMPLE_RATE,
    unit: "rate",
    provenance: "observed",
  });
  return {
    evaluationId: `eval-${dataset.manifest.datasetHash}`,
    evaluatedAt: dataset.manifest.until ?? "1970-01-01T00:00:00.000Z",
    policyVersion: input.policyVersion,
    dataset: dataset.manifest,
    coverage,
    excludedCount: dataset.excluded.length,
    exclusionReasons: [...new Set(dataset.excluded.map((entry) => entry.reason))],
    metrics,
    changedDecisions: changed,
    regressions,
    improvements,
    unknowns,
    reproducibility: {
      seed: "temporal-holdout",
      shrinkageK: HYBRID_SHRINKAGE_K,
      minSampleRate: HYBRID_MIN_SAMPLE_RATE,
    },
  };
};
