import {
  type CostMeasurementV0,
  type CostSource,
  type ExecutionTimingV0,
  type MeasuredQuantityV0,
  type MeasurementProvenance,
  type MeasurementSource,
  type MeasurementUnit,
  type UsageMeasurementV0,
  REWORK_ABANDONMENT_WINDOW_MS,
  unknownQuantity,
} from "@t3tools/contracts";

export const knownQuantity = (input: {
  readonly value: number;
  readonly unit: MeasurementUnit;
  readonly source: MeasurementSource;
  readonly provenance: MeasurementProvenance;
  readonly observedAt: string;
}): MeasuredQuantityV0 => {
  if (!Number.isFinite(input.value) || input.value < 0) {
    return unknownQuantity(input.unit, input.source);
  }
  return {
    status: "known",
    value: input.value,
    unit: input.unit,
    source: input.source,
    provenance: input.provenance,
    observedAt: input.observedAt,
  };
};

export const quantityFromOptionalNumber = (input: {
  readonly value: number | undefined | null;
  readonly unit: MeasurementUnit;
  readonly source: MeasurementSource;
  readonly provenance: MeasurementProvenance;
  readonly observedAt: string;
}): MeasuredQuantityV0 => {
  if (input.value === undefined || input.value === null || !Number.isFinite(input.value)) {
    return unknownQuantity(input.unit, input.source);
  }
  return knownQuantity({
    value: input.value,
    unit: input.unit,
    source: input.source,
    provenance: input.provenance,
    observedAt: input.observedAt,
  });
};

export const durationMs = (
  startMs: number | undefined,
  endMs: number | undefined,
): number | undefined => {
  if (startMs === undefined || endMs === undefined) return undefined;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  if (endMs < startMs) return undefined;
  return endMs - startMs;
};

export const isImmediateAbandonmentProxy = (deltaMs: number): boolean =>
  Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= REWORK_ABANDONMENT_WINDOW_MS;

export const timingFromClock = (input: {
  readonly routeStartMs?: number;
  readonly providerRequestStartMs?: number;
  readonly firstOutputMs?: number;
  readonly terminalMs?: number;
  readonly iso: (ms: number) => string;
}): ExecutionTimingV0 => {
  const total = durationMs(input.routeStartMs ?? input.providerRequestStartMs, input.terminalMs);
  const ttft = durationMs(input.providerRequestStartMs ?? input.routeStartMs, input.firstOutputMs);
  const observedAt = input.iso(input.terminalMs ?? input.routeStartMs ?? 0);
  return {
    ...(input.routeStartMs !== undefined ? { routeStartAt: input.iso(input.routeStartMs) } : {}),
    ...(input.providerRequestStartMs !== undefined
      ? { providerRequestStartAt: input.iso(input.providerRequestStartMs) }
      : {}),
    ...(input.firstOutputMs !== undefined ? { firstOutputAt: input.iso(input.firstOutputMs) } : {}),
    ...(input.terminalMs !== undefined ? { terminalAt: input.iso(input.terminalMs) } : {}),
    timeToFirstTokenMs: quantityFromOptionalNumber({
      value: ttft,
      unit: "ms",
      source: "monotonic_clock",
      provenance: "observed",
      observedAt,
    }),
    totalDurationMs: quantityFromOptionalNumber({
      value: total,
      unit: "ms",
      source: "monotonic_clock",
      provenance: "observed",
      observedAt,
    }),
    clock: "effect_clock_millis",
  };
};

export const usageFromOpenRouter = (input: {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly generationId?: string;
  readonly isByok?: boolean;
  readonly estimated?: boolean;
  readonly observedAt: string;
}): UsageMeasurementV0 => {
  const provenance: MeasurementProvenance = input.estimated === true ? "estimated" : "observed";
  const source: MeasurementSource = "openrouter_accounting";
  return {
    promptTokens: quantityFromOptionalNumber({
      value: input.promptTokens,
      unit: "token",
      source,
      provenance,
      observedAt: input.observedAt,
    }),
    completionTokens: quantityFromOptionalNumber({
      value: input.completionTokens,
      unit: "token",
      source,
      provenance,
      observedAt: input.observedAt,
    }),
    totalTokens: quantityFromOptionalNumber({
      value: input.totalTokens,
      unit: "token",
      source,
      provenance,
      observedAt: input.observedAt,
    }),
    reasoningTokens: quantityFromOptionalNumber({
      value: input.reasoningTokens,
      unit: "token",
      source,
      provenance,
      observedAt: input.observedAt,
    }),
    cacheReadTokens: quantityFromOptionalNumber({
      value: input.cacheReadTokens,
      unit: "token",
      source,
      provenance,
      observedAt: input.observedAt,
    }),
    cacheWriteTokens: quantityFromOptionalNumber({
      value: input.cacheWriteTokens,
      unit: "token",
      source,
      provenance,
      observedAt: input.observedAt,
    }),
    ...(input.generationId !== undefined ? { generationId: input.generationId } : {}),
    ...(input.isByok !== undefined ? { isByok: input.isByok } : {}),
  };
};

export const costFromReportedAndEstimate = (input: {
  readonly reportedUsd?: number;
  readonly reportedSource?: CostSource;
  readonly estimatedUsd?: number;
  readonly pricingSnapshotAt?: string;
  readonly pricingSnapshotVersion?: string;
  readonly observedAt: string;
  readonly isByok?: boolean;
}): CostMeasurementV0 => {
  const reportedSource: CostSource =
    input.reportedSource ??
    (input.reportedUsd === undefined
      ? "unknown"
      : input.isByok === true
        ? "openrouter_upstream_byok"
        : "openrouter_accounting");
  const reported =
    input.reportedUsd === undefined
      ? unknownQuantity("usd", reportedSource === "unknown" ? "not_reported" : reportedSource)
      : knownQuantity({
          value: input.reportedUsd,
          unit: "usd",
          source: reportedSource,
          provenance: "observed",
          observedAt: input.observedAt,
        });
  const estimated =
    input.estimatedUsd === undefined
      ? unknownQuantity("usd", "catalog_estimate")
      : knownQuantity({
          value: input.estimatedUsd,
          unit: "usd",
          source: "catalog_estimate",
          provenance: "estimated",
          observedAt: input.observedAt,
        });
  const mixedProvenance =
    reported.status === "known" &&
    estimated.status === "known" &&
    reportedSource !== "catalog_estimate";
  return {
    reportedUsd: reported,
    reportedSource,
    estimatedUsd: estimated,
    estimatedSource: estimated.status === "known" ? "catalog_estimate" : "unknown",
    ...(input.pricingSnapshotAt !== undefined
      ? { pricingSnapshotAt: input.pricingSnapshotAt }
      : {}),
    ...(input.pricingSnapshotVersion !== undefined
      ? { pricingSnapshotVersion: input.pricingSnapshotVersion }
      : {}),
    mixedProvenance,
  };
};

export const estimateCatalogCostUsd = (input: {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly promptPricePerToken?: number;
  readonly completionPricePerToken?: number;
}): number | undefined => {
  if (
    input.promptTokens === undefined ||
    input.completionTokens === undefined ||
    input.promptPricePerToken === undefined ||
    input.completionPricePerToken === undefined
  ) {
    return undefined;
  }
  const value =
    input.promptTokens * input.promptPricePerToken +
    input.completionTokens * input.completionPricePerToken;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};
