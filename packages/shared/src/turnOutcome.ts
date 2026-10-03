import {
  type CostMeasurementV0,
  type CostSource,
  type ExecutionTimingV0,
  type MeasuredQuantityV0,
  type MeasurementProvenance,
  type MeasurementSource,
  type MeasurementUnit,
  type ModelRouterFailureCategory,
  type NormalizedFinishReason,
  type TerminalOutcomeCategory,
  type TurnOutcomeObservationV0,
  type TurnTokenUsage,
  type UsageMeasurementV0,
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  REWORK_ABANDONMENT_WINDOW_MS,
  TERMINAL_CATEGORY_RANK,
  emptyCostMeasurement,
  emptyUsageMeasurement,
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

export const nanosToDurationMs = (
  startNanos: bigint | undefined,
  endNanos: bigint | undefined,
): number | undefined => {
  if (startNanos === undefined || endNanos === undefined) return undefined;
  if (endNanos < startNanos) return undefined;
  const millis = Number(endNanos - startNanos) / 1_000_000;
  return Number.isFinite(millis) && millis >= 0 ? millis : undefined;
};

export const timingFromClock = (input: {
  readonly routeStartMs?: number;
  readonly providerRequestStartMs?: number;
  readonly firstOutputMs?: number;
  readonly terminalMs?: number;
  readonly timeToFirstTokenMs?: number;
  readonly totalDurationMs?: number;
  readonly clock?: ExecutionTimingV0["clock"];
  readonly iso: (ms: number) => string;
}): ExecutionTimingV0 => {
  const total =
    input.totalDurationMs ??
    durationMs(input.routeStartMs ?? input.providerRequestStartMs, input.terminalMs);
  const ttft =
    input.timeToFirstTokenMs ??
    durationMs(input.providerRequestStartMs ?? input.routeStartMs, input.firstOutputMs);
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
    clock:
      input.clock ??
      (input.totalDurationMs !== undefined ? "monotonic_nanos" : "effect_clock_millis"),
  };
};

export const effectivePolicyVersion = (input: {
  readonly usedHybridRanking?: boolean;
  readonly modelRoutePolicyVersion?: string;
}): string =>
  input.usedHybridRanking === true
    ? HYBRID_ROUTER_POLICY_VERSION
    : (input.modelRoutePolicyVersion ?? MODEL_ROUTER_POLICY_VERSION);

export type ClassifyTurnTerminalInput = {
  readonly eventType: "turn.completed" | "turn.aborted";
  readonly state?: "completed" | "failed" | "interrupted" | "cancelled";
  readonly failureCategory?: ModelRouterFailureCategory;
  readonly stopReason?: string | null;
  readonly abortReason?: string;
  readonly errorMessage?: string;
  readonly openRouterErrorCategory?: string;
  readonly openRouterStatus?: string;
};

export type TerminalClassification = {
  readonly terminalCategory: TerminalOutcomeCategory;
  readonly finishReason: NormalizedFinishReason;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
};

const TIMEOUT_PATTERN = /timeout|timed out|stalled/i;
const CANCEL_PATTERN = /cancel|interrupt|aborted by user|interrupted by user/i;

const textLooksLike = (
  pattern: RegExp,
  ...values: ReadonlyArray<string | null | undefined>
): boolean => values.some((value) => value !== undefined && value !== null && pattern.test(value));

const finishFromStopReason = (stopReason: string | null | undefined): NormalizedFinishReason => {
  if (stopReason === undefined || stopReason === null || stopReason.length === 0) return "unknown";
  const normalized = stopReason.toLowerCase();
  if (normalized === "end_turn" || normalized === "stop" || normalized === "tool_use")
    return "stop";
  if (
    normalized === "max_tokens" ||
    normalized === "length" ||
    normalized === "max_turn_requests"
  ) {
    return "length";
  }
  if (normalized === "cancelled") return "cancelled";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized === "refusal" || normalized === "content_filter") return "content_filter";
  return "unknown";
};

export const classifyTurnTerminal = (input: ClassifyTurnTerminalInput): TerminalClassification => {
  const policyViolation =
    input.openRouterErrorCategory === "policy_violation" ||
    input.openRouterStatus === "policy_violation";
  const timeoutHint = textLooksLike(
    TIMEOUT_PATTERN,
    input.stopReason,
    input.abortReason,
    input.errorMessage,
  );
  const cancelHint = textLooksLike(
    CANCEL_PATTERN,
    input.stopReason,
    input.abortReason,
    input.errorMessage,
  );

  if (input.eventType === "turn.aborted") {
    if (timeoutHint) {
      return {
        terminalCategory: "timeout",
        finishReason: "timeout",
        cancelled: false,
        timedOut: true,
      };
    }
    return {
      terminalCategory: "cancelled",
      finishReason: "cancelled",
      cancelled: true,
      timedOut: false,
    };
  }

  if (policyViolation) {
    return {
      terminalCategory: "provider_failure",
      finishReason: "content_filter",
      cancelled: false,
      timedOut: false,
    };
  }

  const finishReason = finishFromStopReason(input.stopReason);
  if (timeoutHint || finishReason === "timeout") {
    return {
      terminalCategory: "timeout",
      finishReason: "timeout",
      cancelled: false,
      timedOut: true,
    };
  }

  if (input.state === "cancelled" || finishReason === "cancelled") {
    return {
      terminalCategory: "cancelled",
      finishReason: "cancelled",
      cancelled: true,
      timedOut: false,
    };
  }

  if (input.state === "interrupted") {
    if (timeoutHint) {
      return {
        terminalCategory: "timeout",
        finishReason: "timeout",
        cancelled: false,
        timedOut: true,
      };
    }
    if (cancelHint) {
      return {
        terminalCategory: "cancelled",
        finishReason: "cancelled",
        cancelled: true,
        timedOut: false,
      };
    }
    return {
      terminalCategory: "infrastructure_failure",
      finishReason: "unknown",
      cancelled: false,
      timedOut: false,
    };
  }

  if (input.state === "failed" || input.failureCategory !== undefined) {
    if (timeoutHint) {
      return {
        terminalCategory: "timeout",
        finishReason: "timeout",
        cancelled: false,
        timedOut: true,
      };
    }
    return {
      terminalCategory: "provider_failure",
      finishReason: "error",
      cancelled: false,
      timedOut: false,
    };
  }

  if (input.state === "completed") {
    const finishReason = finishFromStopReason(input.stopReason);
    return {
      terminalCategory: "success",
      finishReason: finishReason === "unknown" ? "stop" : finishReason,
      cancelled: false,
      timedOut: false,
    };
  }

  return {
    terminalCategory: "unknown",
    finishReason: finishFromStopReason(input.stopReason),
    cancelled: false,
    timedOut: false,
  };
};

const LOCKED_TERMINALS = new Set<TerminalOutcomeCategory>([
  "cancelled",
  "timeout",
  "provider_failure",
  "infrastructure_failure",
]);

export type TerminalWriteKind = "inserted" | "idempotent" | "enriched" | "replaced" | "rejected";

export type TerminalWriteResult = {
  readonly kind: TerminalWriteKind;
  readonly observation: TurnOutcomeObservationV0;
  readonly reason?: "success_after_failure" | "conflicting_terminal";
};

const preferKnown = <T extends { readonly status: "known" | "unknown" }>(
  current: T,
  incoming: T,
): T => (current.status === "known" ? current : incoming);

const enrichTiming = (
  current: TurnOutcomeObservationV0["timing"],
  incoming: TurnOutcomeObservationV0["timing"],
): TurnOutcomeObservationV0["timing"] => ({
  ...current,
  ...incoming,
  routeStartAt: current.routeStartAt ?? incoming.routeStartAt,
  providerRequestStartAt: current.providerRequestStartAt ?? incoming.providerRequestStartAt,
  firstOutputAt: current.firstOutputAt ?? incoming.firstOutputAt,
  terminalAt: current.terminalAt ?? incoming.terminalAt,
  timeToFirstTokenMs: preferKnown(current.timeToFirstTokenMs, incoming.timeToFirstTokenMs),
  totalDurationMs: preferKnown(current.totalDurationMs, incoming.totalDurationMs),
});

const enrichUsage = (
  current: TurnOutcomeObservationV0["usage"],
  incoming: TurnOutcomeObservationV0["usage"],
): TurnOutcomeObservationV0["usage"] => ({
  promptTokens: preferKnown(current.promptTokens, incoming.promptTokens),
  completionTokens: preferKnown(current.completionTokens, incoming.completionTokens),
  totalTokens: preferKnown(current.totalTokens, incoming.totalTokens),
  reasoningTokens: preferKnown(current.reasoningTokens, incoming.reasoningTokens),
  cacheReadTokens: preferKnown(current.cacheReadTokens, incoming.cacheReadTokens),
  cacheWriteTokens: preferKnown(current.cacheWriteTokens, incoming.cacheWriteTokens),
  generationId: current.generationId ?? incoming.generationId,
  isByok: current.isByok ?? incoming.isByok,
});

const enrichCost = (
  current: TurnOutcomeObservationV0["cost"],
  incoming: TurnOutcomeObservationV0["cost"],
): TurnOutcomeObservationV0["cost"] => ({
  ...current,
  reportedUsd: preferKnown(current.reportedUsd, incoming.reportedUsd),
  estimatedUsd:
    current.estimatedUsd.status === "known" ? current.estimatedUsd : incoming.estimatedUsd,
  reportedSource:
    current.reportedUsd.status === "known" ? current.reportedSource : incoming.reportedSource,
  estimatedSource:
    current.estimatedUsd.status === "known" ? current.estimatedSource : incoming.estimatedSource,
  pricingSnapshotAt: current.pricingSnapshotAt ?? incoming.pricingSnapshotAt,
  pricingSnapshotVersion: current.pricingSnapshotVersion ?? incoming.pricingSnapshotVersion,
  mixedProvenance: current.mixedProvenance || incoming.mixedProvenance,
});

const withEnrichedFacts = (
  current: TurnOutcomeObservationV0,
  incoming: TurnOutcomeObservationV0,
): TurnOutcomeObservationV0 => ({
  ...current,
  timing: enrichTiming(current.timing, incoming.timing),
  usage: enrichUsage(current.usage, incoming.usage),
  cost: enrichCost(current.cost, incoming.cost),
  evidence: current.evidence,
  hybrid: current.hybrid ?? incoming.hybrid,
  openRouterAgreement: current.openRouterAgreement ?? incoming.openRouterAgreement,
  actualExecutionModel: current.actualExecutionModel ?? incoming.actualExecutionModel,
  eligibleCandidateCount: current.eligibleCandidateCount ?? incoming.eligibleCandidateCount,
});

export const mergeTerminalWrite = (
  existing: TurnOutcomeObservationV0 | undefined,
  incoming: TurnOutcomeObservationV0,
): TerminalWriteResult => {
  if (existing === undefined) {
    return { kind: "inserted", observation: incoming };
  }
  if (existing.terminalCategory === incoming.terminalCategory) {
    const observation = withEnrichedFacts(existing, incoming);
    const unchanged =
      observation.usage === existing.usage &&
      observation.timing === existing.timing &&
      observation.cost === existing.cost;
    return { kind: unchanged ? "idempotent" : "enriched", observation };
  }
  if (LOCKED_TERMINALS.has(existing.terminalCategory) && incoming.terminalCategory === "success") {
    return {
      kind: "rejected",
      observation: existing,
      reason: "success_after_failure",
    };
  }
  if (
    LOCKED_TERMINALS.has(existing.terminalCategory) &&
    LOCKED_TERMINALS.has(incoming.terminalCategory)
  ) {
    return {
      kind: "rejected",
      observation: existing,
      reason: "conflicting_terminal",
    };
  }
  if (
    TERMINAL_CATEGORY_RANK[incoming.terminalCategory] >
    TERMINAL_CATEGORY_RANK[existing.terminalCategory]
  ) {
    return {
      kind: "replaced",
      observation: {
        ...incoming,
        recordedAt: existing.recordedAt,
        policyVersion: existing.policyVersion,
        evidence: existing.evidence,
        timing: enrichTiming(existing.timing, incoming.timing),
        usage: enrichUsage(existing.usage, incoming.usage),
        cost: enrichCost(existing.cost, incoming.cost),
      },
    };
  }
  return {
    kind: "rejected",
    observation: existing,
    reason: "conflicting_terminal",
  };
};

export const usageFromTurnTokenUsage = (input: {
  readonly tokenUsage?: TurnTokenUsage;
  readonly completeAccounting: boolean;
  readonly observedAt: string;
}): UsageMeasurementV0 => {
  const tokenUsage = input.tokenUsage;
  if (
    tokenUsage === undefined ||
    !input.completeAccounting ||
    tokenUsage.usageStatus !== "complete"
  ) {
    return emptyUsageMeasurement();
  }
  return {
    promptTokens: knownQuantity({
      value: tokenUsage.inputTokens,
      unit: "token",
      source: "provider_reported",
      provenance: "observed",
      observedAt: input.observedAt,
    }),
    completionTokens: knownQuantity({
      value: tokenUsage.outputTokens,
      unit: "token",
      source: "provider_reported",
      provenance: "observed",
      observedAt: input.observedAt,
    }),
    totalTokens: knownQuantity({
      value: tokenUsage.inputTokens + tokenUsage.outputTokens,
      unit: "token",
      source: "provider_reported",
      provenance: "observed",
      observedAt: input.observedAt,
    }),
    reasoningTokens: quantityFromOptionalNumber({
      value: tokenUsage.reasoningTokens,
      unit: "token",
      source: "provider_reported",
      provenance: "observed",
      observedAt: input.observedAt,
    }),
    cacheReadTokens: quantityFromOptionalNumber({
      value: tokenUsage.cachedInputTokens,
      unit: "token",
      source: "provider_reported",
      provenance: "observed",
      observedAt: input.observedAt,
    }),
    cacheWriteTokens: quantityFromOptionalNumber({
      value: tokenUsage.cacheCreationTokens,
      unit: "token",
      source: "provider_reported",
      provenance: "observed",
      observedAt: input.observedAt,
    }),
  };
};

export const costFromProviderTotal = (input: {
  readonly totalCostUsd?: number;
  readonly observedAt: string;
}): CostMeasurementV0 => {
  if (input.totalCostUsd === undefined) return emptyCostMeasurement();
  return costFromReportedAndEstimate({
    reportedUsd: input.totalCostUsd,
    reportedSource: "provider_reported",
    observedAt: input.observedAt,
  });
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
