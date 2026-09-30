import {
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_MAX_CANDIDATES,
  MODEL_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_TIE_BREAK_DRIVERS,
  MODEL_ROUTER_UNKNOWN_METRIC,
  type ModelRouterCandidate,
  type ModelRouterCapability,
  type ModelRouterConstraints,
  type ModelRouterDecision,
  type ModelRouterExecutionStatus,
  type ModelRouterMetricValue,
  type ModelRouterMetrics,
  type ModelRouterMode,
  type ModelRouterPolicy,
  type ModelRouterReasonCode,
  type ModelRouterTarget,
  type ModelRouterTaskCharacteristics,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

const SECRET_SHAPED =
  /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|CURSOR_API_KEY\s*=|api[_-]?key\s*[=:]|Authorization\s*:/i;

export const MODEL_ROUTER_SECRET_REDACTION = "[redacted]";

export type ModelRouterCatalogEntry = {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | null;
  readonly model: string;
  readonly isDefault: boolean;
  readonly capabilities: ReadonlyArray<ModelRouterCapability>;
  readonly availabilityReasons: ReadonlyArray<ModelRouterReasonCode>;
  readonly metrics?: ModelRouterMetrics;
};

export type ModelRouterInput = {
  readonly mode: ModelRouterMode;
  readonly task?: Partial<ModelRouterTaskCharacteristics>;
  readonly constraints?: ModelRouterConstraints;
  readonly policy?: ModelRouterPolicy;
  readonly catalog: ReadonlyArray<ModelRouterCatalogEntry>;
  readonly preferredTargets?: ReadonlyArray<ModelRouterTarget>;
  readonly manualOverride?: ModelRouterTarget | null;
  readonly executionStatus?: ModelRouterExecutionStatus;
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const targetKey = (target: ModelRouterTarget): string =>
  `${target.instanceId}\u0000${target.model}`;

const uniqueReasons = (
  codes: ReadonlyArray<ModelRouterReasonCode>,
): ReadonlyArray<ModelRouterReasonCode> => [...new Set(codes)].slice(0, 16);

const hasId = (list: ReadonlyArray<string> | undefined, value: string): boolean =>
  list !== undefined && list.includes(value);

const driverTieBreakIndex = (driver: ProviderDriverKind | null): number => {
  if (driver === null) return MODEL_ROUTER_TIE_BREAK_DRIVERS.length + 1;
  const index = (MODEL_ROUTER_TIE_BREAK_DRIVERS as readonly string[]).indexOf(driver);
  return index === -1 ? MODEL_ROUTER_TIE_BREAK_DRIVERS.length : index;
};

const metricOrUnknown = (value: ModelRouterMetricValue | undefined): ModelRouterMetricValue =>
  value ?? MODEL_ROUTER_UNKNOWN_METRIC;

const cloneMetrics = (metrics: ModelRouterMetrics | undefined): ModelRouterMetrics => ({
  quality: metricOrUnknown(metrics?.quality),
  costUsd: metricOrUnknown(metrics?.costUsd),
  latencyMs: metricOrUnknown(metrics?.latencyMs),
});

export function modelRouterAvailabilityReasons(
  provider: ServerProvider | undefined,
  model: string,
): ReadonlyArray<ModelRouterReasonCode> {
  if (provider === undefined) return ["PROVIDER_INSTANCE_NOT_FOUND"];
  if (provider.availability === "unavailable") return ["PROVIDER_UNAVAILABLE"];
  if (!provider.enabled || provider.status === "disabled") return ["PROVIDER_DISABLED"];
  if (!provider.installed) return ["PROVIDER_NOT_INSTALLED"];
  if (provider.auth.status === "unauthenticated") return ["PROVIDER_UNAUTHENTICATED"];
  if (provider.status === "error") return ["PROVIDER_ERROR"];
  if (!provider.models.some((entry) => entry.slug === model)) return ["MODEL_NOT_FOUND"];
  return [];
}

/**
 * Coding-agent CLIs expose tools and code. Vision and long-context stay
 * unknown unless a catalog entry declares them — never inferred from names.
 */
export function structuralModelRouterCapabilities(
  declared?: ReadonlyArray<ModelRouterCapability> | null,
): ReadonlyArray<ModelRouterCapability> {
  if (declared) {
    return uniqueCapabilities(declared);
  }
  return ["code", "tools"];
}

function uniqueCapabilities(
  capabilities: ReadonlyArray<ModelRouterCapability>,
): ReadonlyArray<ModelRouterCapability> {
  return [...new Set(capabilities)];
}

export function modelRouterCatalogFromProviders(
  providers: ReadonlyArray<ServerProvider>,
  declaredCapabilities?: ReadonlyMap<string, ReadonlyArray<ModelRouterCapability>>,
  declaredMetrics?: ReadonlyMap<string, ModelRouterMetrics>,
): ReadonlyArray<ModelRouterCatalogEntry> {
  const catalog: Array<ModelRouterCatalogEntry> = [];
  for (const provider of [...providers].sort((left, right) =>
    compareStrings(left.instanceId, right.instanceId),
  )) {
    const models = [...provider.models].sort((left, right) =>
      compareStrings(left.slug, right.slug),
    );
    for (const model of models) {
      const key = `${provider.instanceId}\u0000${model.slug}`;
      catalog.push({
        instanceId: provider.instanceId,
        driver: provider.driver,
        model: model.slug,
        isDefault: model.isDefault === true,
        capabilities: structuralModelRouterCapabilities(declaredCapabilities?.get(key)),
        availabilityReasons: modelRouterAvailabilityReasons(provider, model.slug),
        ...(declaredMetrics?.has(key) ? { metrics: declaredMetrics.get(key) } : {}),
      });
    }
  }
  return catalog;
}

function constraintReasons(
  entry: ModelRouterCatalogEntry,
  constraints: ModelRouterConstraints | undefined,
  requiredCapabilities: ReadonlyArray<ModelRouterCapability>,
): ReadonlyArray<ModelRouterReasonCode> {
  const reasons: Array<ModelRouterReasonCode> = [];
  if (requiredCapabilities.some((capability) => !entry.capabilities.includes(capability))) {
    reasons.push("REQUIRED_CAPABILITY_MISSING");
  }
  if (
    hasId(constraints?.allowedInstanceIds, entry.instanceId) === false &&
    constraints?.allowedInstanceIds !== undefined
  ) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  if (hasId(constraints?.excludedInstanceIds, entry.instanceId)) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  if (entry.driver !== null) {
    if (
      hasId(constraints?.allowedDrivers, entry.driver) === false &&
      constraints?.allowedDrivers !== undefined
    ) {
      reasons.push("CONSTRAINT_EXCLUDED");
    }
    if (hasId(constraints?.excludedDrivers, entry.driver)) {
      reasons.push("CONSTRAINT_EXCLUDED");
    }
  }
  if (
    hasId(constraints?.allowedModels, entry.model) === false &&
    constraints?.allowedModels !== undefined
  ) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  if (hasId(constraints?.excludedModels, entry.model)) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  return uniqueReasons(reasons);
}

function scoreDimensionActive(
  candidates: ReadonlyArray<{ readonly eligible: boolean; readonly metrics: ModelRouterMetrics }>,
  read: (metrics: ModelRouterMetrics) => ModelRouterMetricValue,
): boolean {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  return (
    eligible.length > 0 && eligible.every((candidate) => read(candidate.metrics).status === "known")
  );
}

function metricValue(metric: ModelRouterMetricValue): number {
  return metric.status === "known" ? metric.value : 0;
}

function policyScore(
  candidate: ModelRouterCandidate,
  policy: ModelRouterPolicy,
  qualityActive: boolean,
  costActive: boolean,
  latencyActive: boolean,
): number {
  let score = 0;
  if (qualityActive) score += policy.qualityWeight * metricValue(candidate.metrics.quality);
  if (costActive) score -= policy.costWeight * metricValue(candidate.metrics.costUsd);
  if (latencyActive) score -= policy.latencyWeight * metricValue(candidate.metrics.latencyMs);
  return score;
}

function compareForSelection(
  left: ModelRouterCandidate,
  right: ModelRouterCandidate,
  policy: ModelRouterPolicy,
  qualityActive: boolean,
  costActive: boolean,
  latencyActive: boolean,
): number {
  const leftScore = policyScore(left, policy, qualityActive, costActive, latencyActive);
  const rightScore = policyScore(right, policy, qualityActive, costActive, latencyActive);
  if (leftScore !== rightScore) return rightScore - leftScore;
  if (left.preferredDefault !== right.preferredDefault) {
    return left.preferredDefault ? -1 : 1;
  }
  const driverDelta = driverTieBreakIndex(left.driver) - driverTieBreakIndex(right.driver);
  if (driverDelta !== 0) return driverDelta;
  const instanceDelta = compareStrings(left.target.instanceId, right.target.instanceId);
  if (instanceDelta !== 0) return instanceDelta;
  return compareStrings(left.target.model, right.target.model);
}

function explanationFor(input: {
  readonly mode: ModelRouterMode;
  readonly selected: ModelRouterCandidate | null;
  readonly qualityActive: boolean;
  readonly costActive: boolean;
  readonly latencyActive: boolean;
}): string {
  if (input.selected === null) {
    return input.mode === "manual"
      ? "Manual model selection could not be recorded against the catalog."
      : "Auto Route found no available, authorized model that meets the required capabilities and constraints.";
  }
  const target = `${input.selected.target.instanceId} · ${input.selected.target.model}`;
  if (input.mode === "manual") {
    return `Manual selection of ${target}. Automatic ranking was not applied.`;
  }
  if (input.selected.reasonCodes.includes("PREFERRED_DEFAULT")) {
    return `Auto Route selected ${target} because it is the configured default and is available.`;
  }
  if (input.qualityActive || input.costActive || input.latencyActive) {
    return `Auto Route selected ${target} using policy ${MODEL_ROUTER_POLICY_VERSION} weights on known metrics.`;
  }
  return `Auto Route selected ${target} by policy ${MODEL_ROUTER_POLICY_VERSION} tie-break. Quality, cost, and latency are unknown.`;
}

function sanitizeText(value: string): string {
  return SECRET_SHAPED.test(value) ? MODEL_ROUTER_SECRET_REDACTION : value;
}

export function modelRouterDecisionOmitsSecrets(value: unknown): boolean {
  if (typeof value === "string") return !SECRET_SHAPED.test(value);
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every(modelRouterDecisionOmitsSecrets);
  return Object.entries(value as Record<string, unknown>).every(([key, nested]) => {
    if (/secret|token|password|credential|apiKey|authorization/i.test(key)) return false;
    return modelRouterDecisionOmitsSecrets(nested);
  });
}

function sanitizeDecision(decision: ModelRouterDecision): ModelRouterDecision {
  return {
    ...decision,
    explanation: sanitizeText(decision.explanation),
    reasonCodes: decision.reasonCodes,
    candidates: decision.candidates,
    fallbacks: decision.fallbacks,
    selected: decision.selected,
  };
}

function toCandidate(
  entry: ModelRouterCatalogEntry,
  input: {
    readonly constraints: ModelRouterConstraints | undefined;
    readonly requiredCapabilities: ReadonlyArray<ModelRouterCapability>;
    readonly preferredKeys: ReadonlySet<string>;
  },
): Omit<ModelRouterCandidate, "fallbackIndex"> {
  const filterReasons = uniqueReasons([
    ...entry.availabilityReasons,
    ...constraintReasons(entry, input.constraints, input.requiredCapabilities),
  ]);
  const preferredDefault = input.preferredKeys.has(
    targetKey({ instanceId: entry.instanceId, model: entry.model }),
  );
  return {
    target: { instanceId: entry.instanceId, model: entry.model },
    driver: entry.driver,
    capabilities: [...entry.capabilities],
    eligible: filterReasons.length === 0,
    reasonCodes: preferredDefault
      ? uniqueReasons([...filterReasons, "PREFERRED_DEFAULT"])
      : filterReasons,
    preferredDefault,
    metrics: cloneMetrics(entry.metrics),
  };
}

export function routeModel(input: ModelRouterInput): ModelRouterDecision {
  const policy = input.policy ?? MODEL_ROUTER_DEFAULT_POLICY;
  const requiredCapabilities = uniqueCapabilities([
    ...(input.task?.requiredCapabilities ?? []),
    ...(input.constraints?.requiredCapabilities ?? []),
  ]);
  const task: ModelRouterTaskCharacteristics = {
    attachmentCount: input.task?.attachmentCount ?? 0,
    composerContextKinds: [...(input.task?.composerContextKinds ?? [])],
    requiredCapabilities,
  };
  const preferredKeys = new Set((input.preferredTargets ?? []).map(targetKey));
  const seen = new Set<string>();
  const built: Array<Omit<ModelRouterCandidate, "fallbackIndex">> = [];
  for (const entry of input.catalog) {
    const key = `${entry.instanceId}\u0000${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    built.push(
      toCandidate(entry, {
        constraints: input.constraints,
        requiredCapabilities,
        preferredKeys,
      }),
    );
  }

  if (input.mode === "manual" && input.manualOverride) {
    const key = targetKey(input.manualOverride);
    if (!seen.has(key)) {
      const overrideEntry: ModelRouterCatalogEntry = {
        instanceId: input.manualOverride.instanceId,
        driver: null,
        model: input.manualOverride.model,
        isDefault: false,
        capabilities: [],
        availabilityReasons: ["MODEL_NOT_FOUND"],
      };
      built.push(
        toCandidate(overrideEntry, {
          constraints: input.constraints,
          requiredCapabilities,
          preferredKeys,
        }),
      );
      seen.add(key);
    }
  }

  const qualityActive = scoreDimensionActive(built, (metrics) => metrics.quality);
  const costActive = scoreDimensionActive(built, (metrics) => metrics.costUsd);
  const latencyActive = scoreDimensionActive(built, (metrics) => metrics.latencyMs);

  const ranked = [...built].sort((left, right) =>
    compareForSelection(
      { ...left, fallbackIndex: 0 },
      { ...right, fallbackIndex: 0 },
      policy,
      qualityActive,
      costActive,
      latencyActive,
    ),
  );

  const withIndex: Array<ModelRouterCandidate> = ranked
    .slice(0, MODEL_ROUTER_MAX_CANDIDATES)
    .map((candidate, fallbackIndex) => ({ ...candidate, fallbackIndex }));

  const eligible = withIndex.filter((candidate) => candidate.eligible);
  let selected: ModelRouterCandidate | null = null;
  let selectionReasons: Array<ModelRouterReasonCode> = [];

  if (input.mode === "manual") {
    const override = input.manualOverride;
    if (override) {
      const match =
        withIndex.find((candidate) => targetKey(candidate.target) === targetKey(override)) ?? null;
      selected = match;
      selectionReasons = ["MANUAL_OVERRIDE"];
      if (match) {
        selected = {
          ...match,
          reasonCodes: uniqueReasons([...match.reasonCodes, "MANUAL_OVERRIDE", "SELECTED"]),
        };
      }
    }
  } else {
    selected = eligible[0] ?? null;
    if (selected) {
      const extras: Array<ModelRouterReasonCode> = ["SELECTED"];
      if (selected.preferredDefault) extras.push("PREFERRED_DEFAULT");
      if (!qualityActive && !costActive && !latencyActive)
        extras.push("METRICS_UNKNOWN", "POLICY_TIE_BREAK");
      else extras.push("POLICY_TIE_BREAK");
      selected = {
        ...selected,
        reasonCodes: uniqueReasons([...selected.reasonCodes, ...extras]),
      };
      selectionReasons = extras;
    } else {
      selectionReasons = ["NO_ELIGIBLE_CANDIDATES"];
    }
  }

  const fallbacks = eligible.filter(
    (candidate) => selected === null || targetKey(candidate.target) !== targetKey(selected.target),
  );
  const decisionReasons = uniqueReasons([
    ...selectionReasons,
    ...(selected === null
      ? withIndex.flatMap((candidate) => candidate.reasonCodes)
      : selected.reasonCodes),
  ]);

  const decision: ModelRouterDecision = {
    policyVersion: MODEL_ROUTER_POLICY_VERSION,
    mode: input.mode,
    task,
    policy,
    selected,
    fallbacks,
    candidates: withIndex,
    reasonCodes:
      decisionReasons.length > 0
        ? decisionReasons
        : selected === null
          ? ["NO_ELIGIBLE_CANDIDATES"]
          : ["SELECTED"],
    explanation: explanationFor({
      mode: input.mode,
      selected,
      qualityActive,
      costActive,
      latencyActive,
    }),
    estimatedCostUsd: selected?.metrics.costUsd ?? MODEL_ROUTER_UNKNOWN_METRIC,
    estimatedLatencyMs: selected?.metrics.latencyMs ?? MODEL_ROUTER_UNKNOWN_METRIC,
    estimatedQuality: selected?.metrics.quality ?? MODEL_ROUTER_UNKNOWN_METRIC,
    executionStatus: input.executionStatus ?? (selected ? "not-started" : "not-started"),
  };

  return sanitizeDecision(decision);
}

export function modelSelectionFromRoute(
  decision: ModelRouterDecision,
): { instanceId: ProviderInstanceId; model: string } | null {
  return decision.selected === null ? null : decision.selected.target;
}
