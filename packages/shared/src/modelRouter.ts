import {
  MODEL_ROUTER_ATTEMPT_BUDGET,
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_MAX_CANDIDATES,
  MODEL_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_TIE_BREAK_DRIVERS,
  MODEL_ROUTER_UNKNOWN_METRIC,
  type ModelRouterAvailabilityCooldown,
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
  type ModelRouterSelectionBasis,
  type ModelRouterRouteAttempt,
  type ModelRouterTarget,
  type ModelRouterTaskCharacteristics,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

const SECRET_SHAPED =
  /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|OPENROUTER_API_KEY\s*=|CURSOR_API_KEY\s*=|api[_-]?key\s*[=:]|Authorization\s*:/i;

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

export const modelRouterTargetKey = targetKey;

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

function modelRouterAvailabilityReasons(
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
function structuralModelRouterCapabilities(
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
      const metrics = declaredMetrics?.get(key);
      catalog.push({
        instanceId: provider.instanceId,
        driver: provider.driver,
        model: model.slug,
        isDefault: model.isDefault === true,
        capabilities: structuralModelRouterCapabilities(declaredCapabilities?.get(key)),
        availabilityReasons: modelRouterAvailabilityReasons(provider, model.slug),
        ...(metrics === undefined ? {} : { metrics }),
      });
    }
  }
  return catalog;
}

/**
 * OpenRouter is a Teacher/Shadow execution vehicle, not an Auto Route peer.
 * Including it in Auto ranking would change Phase 8 selections.
 */
export const modelRouterCatalogForMode = (
  catalog: ReadonlyArray<ModelRouterCatalogEntry>,
  mode: ModelRouterMode,
): ReadonlyArray<ModelRouterCatalogEntry> =>
  mode === "auto" ? catalog.filter((entry) => entry.driver !== "openrouter") : catalog;

function cooldownReason(cooldown: ModelRouterAvailabilityCooldown): ModelRouterReasonCode {
  if (
    cooldown.reasonCode === "PROVIDER_USAGE_LIMIT" ||
    cooldown.reasonCode === "PROVIDER_RATE_LIMITED"
  ) {
    return cooldown.reasonCode;
  }
  if (cooldown.category === "usage_quota_exhausted") return "PROVIDER_USAGE_LIMIT";
  if (cooldown.category === "rate_limited") return "PROVIDER_RATE_LIMITED";
  return "PROVIDER_COOLDOWN";
}

function cooldownApplies(
  cooldown: ModelRouterAvailabilityCooldown,
  entry: ModelRouterCatalogEntry,
  nowMs: number,
): boolean {
  if (Date.parse(cooldown.until) <= nowMs) return false;
  if (cooldown.instanceId !== entry.instanceId) return false;
  if (cooldown.scope === "model") return cooldown.model === entry.model;
  return true;
}

export function applyModelRouterCooldowns(
  catalog: ReadonlyArray<ModelRouterCatalogEntry>,
  cooldowns: ReadonlyArray<ModelRouterAvailabilityCooldown>,
  nowMs: number,
): ReadonlyArray<ModelRouterCatalogEntry> {
  if (cooldowns.length === 0) return catalog;
  return catalog.map((entry) => {
    const matching = cooldowns.filter((cooldown) => cooldownApplies(cooldown, entry, nowMs));
    if (matching.length === 0) return entry;
    return {
      ...entry,
      availabilityReasons: uniqueReasons([
        ...entry.availabilityReasons,
        ...matching.map(cooldownReason),
      ]),
    };
  });
}

function distinctInstanceFallbacks(
  eligible: ReadonlyArray<ModelRouterCandidate>,
  selected: ModelRouterCandidate | null,
): ReadonlyArray<ModelRouterCandidate> {
  const seen = new Set<string>(selected === null ? [] : [selected.target.instanceId]);
  const fallbacks: Array<ModelRouterCandidate> = [];
  for (const candidate of eligible) {
    if (seen.has(candidate.target.instanceId)) continue;
    seen.add(candidate.target.instanceId);
    fallbacks.push(candidate);
  }
  return fallbacks;
}

export function executableAlternateInstanceCount(decision: ModelRouterDecision): number {
  return new Set(decision.fallbacks.map((candidate) => candidate.target.instanceId)).size;
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
  if (entry.driver === null) {
    if (constraints?.allowedDrivers !== undefined && constraints.allowedDrivers.length === 0) {
      reasons.push("CONSTRAINT_EXCLUDED");
    } else if (
      constraints?.allowedDrivers !== undefined ||
      (constraints?.excludedDrivers?.length ?? 0) > 0
    ) {
      reasons.push("CONSTRAINT_METADATA_UNKNOWN");
    }
  } else {
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
  candidate: Pick<ModelRouterCandidate, "metrics">,
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
  return compareModelRouterTieBreak(left, right);
}

export function compareModelRouterTieBreak(
  left: ModelRouterCandidate,
  right: ModelRouterCandidate,
): number {
  if (left.preferredDefault !== right.preferredDefault) {
    return left.preferredDefault ? -1 : 1;
  }
  const driverDelta = driverTieBreakIndex(left.driver) - driverTieBreakIndex(right.driver);
  if (driverDelta !== 0) return driverDelta;
  const instanceDelta = compareStrings(left.target.instanceId, right.target.instanceId);
  if (instanceDelta !== 0) return instanceDelta;
  return compareStrings(left.target.model, right.target.model);
}

function selectionBasisFor(input: {
  readonly mode: ModelRouterMode;
  readonly selected: ModelRouterCandidate | null;
  readonly manualRejected: boolean;
  readonly eligible: ReadonlyArray<ModelRouterCandidate>;
  readonly built: ReadonlyArray<Omit<ModelRouterCandidate, "fallbackIndex">>;
  readonly policy: ModelRouterPolicy;
  readonly qualityActive: boolean;
  readonly costActive: boolean;
  readonly latencyActive: boolean;
}): ModelRouterSelectionBasis {
  const dimension = (weight: number, complete: boolean) => ({
    weight,
    complete,
    participation:
      weight === 0
        ? ("zero-weight" as const)
        : complete
          ? ("weighted" as const)
          : ("incomplete" as const),
  });
  const score = (candidate: Pick<ModelRouterCandidate, "metrics">) =>
    policyScore(
      candidate,
      input.policy,
      input.qualityActive,
      input.costActive,
      input.latencyActive,
    );
  const selected = input.selected;
  let outcome: ModelRouterSelectionBasis["outcome"] =
    input.mode === "manual"
      ? selected !== null
        ? "manual-accepted"
        : input.manualRejected
          ? "manual-rejected"
          : "manual-missing"
      : selected === null
        ? "none"
        : input.eligible.length === 1
          ? "single"
          : "score";
  const tieBreak: Array<ModelRouterSelectionBasis["tieBreak"][number]> = [];
  let selectedScore: number | null = null;
  let runnerUpScore: number | null = null;
  if (outcome === "score" && selected !== null) {
    selectedScore = score(selected);
    runnerUpScore = input.eligible[1] === undefined ? null : score(input.eligible[1]);
    let tied = input.eligible.filter((candidate) => score(candidate) === selectedScore);
    // The existing sort includes excluded rows before its display/selection cap.
    if (input.built.some((candidate) => Number.isNaN(score(candidate)))) {
      outcome = "unknown";
    } else if (tied.length > 1) {
      outcome = "tie";
      // Record only stages that actually remove equal-score contenders.
      const narrow = (
        stage: ModelRouterSelectionBasis["tieBreak"][number],
        matches: (candidate: ModelRouterCandidate) => boolean,
      ) => {
        const remaining = tied.filter(matches);
        if (remaining.length < tied.length) tieBreak.push(stage);
        tied = remaining;
      };
      narrow("preferred", (candidate) => candidate.preferredDefault === selected.preferredDefault);
      narrow(
        "driver",
        (candidate) =>
          driverTieBreakIndex(candidate.driver) === driverTieBreakIndex(selected.driver),
      );
      narrow("instance", (candidate) => candidate.target.instanceId === selected.target.instanceId);
      narrow("model", (candidate) => candidate.target.model === selected.target.model);
    }
  }
  return {
    version: "model-router.v0.selection-basis.v1",
    selectedTarget: selected?.target ?? null,
    outcome,
    eligibleCount: input.built.filter((candidate) => candidate.eligible).length,
    consideredEligibleCount: input.eligible.length,
    excludedCount: input.built.filter((candidate) => !candidate.eligible).length,
    dimensions: {
      quality: dimension(input.policy.qualityWeight, input.qualityActive),
      costUsd: dimension(input.policy.costWeight, input.costActive),
      latencyMs: dimension(input.policy.latencyWeight, input.latencyActive),
    },
    // Preserve the existing arithmetic even if extreme finite inputs overflow.
    selectedScore: selectedScore !== null && Number.isFinite(selectedScore) ? selectedScore : null,
    runnerUpScore: runnerUpScore !== null && Number.isFinite(runnerUpScore) ? runnerUpScore : null,
    tieBreak,
  };
}

function explanationFor(
  mode: ModelRouterMode,
  selected: ModelRouterCandidate | null,
  basis: ModelRouterSelectionBasis,
): string {
  if (selected === null) {
    return mode === "manual"
      ? "Manual model selection could not be recorded against the catalog."
      : basis.eligibleCount > 0
        ? "Auto Route found no eligible candidate within the policy candidate limit."
        : "Auto Route found no available, authorized model that meets the required capabilities and constraints.";
  }
  const target = `${selected.target.instanceId} · ${selected.target.model}`;
  if (mode === "manual") return `Manual selection of ${target}. Automatic ranking was not applied.`;
  if (basis.outcome === "unknown")
    return `Auto Route selected ${target}; ranking arithmetic was not representable, so the detailed selection cause is unknown.`;
  if (basis.outcome === "single")
    return `Auto Route selected ${target}: the only eligible candidate in the selectable ranking.`;
  if (basis.outcome === "score")
    return `Auto Route selected ${target} by higher weighted catalog-estimate score under policy ${MODEL_ROUTER_POLICY_VERSION}.`;
  return `Auto Route selected ${target} by equal-score tie-break (${basis.tieBreak.join(" → ")}) under policy ${MODEL_ROUTER_POLICY_VERSION}.`;
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

function sanitizeAttempt(attempt: ModelRouterRouteAttempt): ModelRouterRouteAttempt {
  return attempt.detail === undefined
    ? attempt
    : { ...attempt, detail: sanitizeText(attempt.detail) };
}

function sanitizeDecision(decision: ModelRouterDecision): ModelRouterDecision {
  return {
    ...decision,
    explanation: sanitizeText(decision.explanation).slice(0, 512),
    reasonCodes: decision.reasonCodes,
    candidates: decision.candidates,
    fallbacks: decision.fallbacks,
    selected: decision.selected,
    attempts: decision.attempts?.map(sanitizeAttempt),
    executed: decision.executed,
  };
}

function estimatedLimitReasons(
  metrics: ModelRouterMetrics | undefined,
  constraints: ModelRouterConstraints | undefined,
): ReadonlyArray<ModelRouterReasonCode> {
  const reasons: Array<ModelRouterReasonCode> = [];
  if (constraints?.maxCostUsd !== undefined) {
    const cost = metricOrUnknown(metrics?.costUsd);
    if (cost.status === "unknown") reasons.push("ESTIMATED_COST_UNKNOWN");
    else if (cost.value > constraints.maxCostUsd) reasons.push("ESTIMATED_COST_LIMIT_EXCEEDED");
  }
  if (constraints?.maxLatencyMs !== undefined) {
    const latency = metricOrUnknown(metrics?.latencyMs);
    if (latency.status === "unknown") reasons.push("ESTIMATED_LATENCY_UNKNOWN");
    else if (latency.value > constraints.maxLatencyMs)
      reasons.push("ESTIMATED_LATENCY_LIMIT_EXCEEDED");
  }
  return reasons;
}

function manualCatalogEntry(
  catalog: ReadonlyArray<ModelRouterCatalogEntry>,
  target: ModelRouterTarget,
): ModelRouterCatalogEntry {
  return (
    catalog.find(
      (entry) => entry.instanceId === target.instanceId && entry.model === target.model,
    ) ?? {
      instanceId: target.instanceId,
      driver: null,
      model: target.model,
      isDefault: false,
      capabilities: [],
      availabilityReasons: ["MODEL_NOT_FOUND"],
    }
  );
}

/** Check the explicit Manual target, independently of ranking, availability and display truncation. */
export function manualModelRouterConstraintReasons(
  input: Pick<ModelRouterInput, "catalog" | "manualOverride" | "constraints" | "task">,
): ReadonlyArray<ModelRouterReasonCode> {
  if (!input.manualOverride) return [];
  const entry = manualCatalogEntry(input.catalog, input.manualOverride);
  const required = uniqueCapabilities([
    ...(input.task?.requiredCapabilities ?? []),
    ...(input.constraints?.requiredCapabilities ?? []),
  ]);
  return uniqueReasons([
    ...estimatedLimitReasons(entry.metrics, input.constraints),
    ...constraintReasons(entry, input.constraints, required),
  ]);
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
    ...estimatedLimitReasons(entry.metrics, input.constraints),
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
      const overrideEntry = manualCatalogEntry(input.catalog, input.manualOverride);
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
  let manualRejectionReasons: ReadonlyArray<ModelRouterReasonCode> = [];

  if (input.mode === "manual") {
    const override = input.manualOverride;
    if (override) {
      const match =
        withIndex.find((candidate) => targetKey(candidate.target) === targetKey(override)) ?? null;
      manualRejectionReasons = manualModelRouterConstraintReasons(input);
      selected = manualRejectionReasons.length > 0 ? null : match;
      selectionReasons = ["MANUAL_OVERRIDE", ...manualRejectionReasons];
      if (selected) {
        selected = {
          ...selected,
          reasonCodes: uniqueReasons([
            ...selected.reasonCodes.filter((code) => code !== "PREFERRED_DEFAULT"),
            "MANUAL_OVERRIDE",
            "SELECTED",
          ]),
        };
      }
    }
  } else {
    selected = eligible[0] ?? null;
    if (selected) {
      const extras: Array<ModelRouterReasonCode> = ["SELECTED"];
      selected = {
        ...selected,
        reasonCodes: uniqueReasons([
          ...selected.reasonCodes.filter((code) => code !== "PREFERRED_DEFAULT"),
          ...extras,
        ]),
      };
      selectionReasons = extras;
    } else {
      selectionReasons = ["NO_ELIGIBLE_CANDIDATES"];
    }
  }

  const selectionBasis = selectionBasisFor({
    mode: input.mode,
    selected,
    manualRejected: manualRejectionReasons.length > 0,
    eligible,
    built,
    policy,
    qualityActive,
    costActive,
    latencyActive,
  });
  if (input.mode === "auto" && selected !== null) {
    if (selectionBasis.tieBreak.includes("preferred")) selectionReasons.push("PREFERRED_DEFAULT");
    if (!qualityActive && !costActive && !latencyActive) selectionReasons.push("METRICS_UNKNOWN");
    if (selectionBasis.outcome === "tie") selectionReasons.push("POLICY_TIE_BREAK");
    selected = {
      ...selected,
      reasonCodes: uniqueReasons([...selected.reasonCodes, ...selectionReasons]),
    };
  }
  const fallbacks = [...distinctInstanceFallbacks(eligible, selected)];
  const decisionReasons = uniqueReasons(
    [
      ...selectionReasons,
      ...(manualRejectionReasons.some((reason) => !reason.startsWith("ESTIMATED_"))
        ? []
        : selected === null
          ? withIndex.flatMap((candidate) => candidate.reasonCodes)
          : selected.reasonCodes),
    ].filter(
      (code) =>
        code !== "PREFERRED_DEFAULT" ||
        (input.mode === "auto" && selectionBasis.tieBreak.includes("preferred")),
    ),
  );

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
    explanation:
      manualRejectionReasons.length > 0
        ? manualRejectionReasons.every((reason) => reason.startsWith("ESTIMATED_"))
          ? "Manual override could not satisfy the supplied estimated cost or latency limits. No model was selected."
          : "Manual selection could not satisfy the supplied capabilities or allow/exclude constraints. No model was selected."
        : explanationFor(input.mode, selected, selectionBasis),
    selectionBasis,
    estimatedCostUsd: selected?.metrics.costUsd ?? MODEL_ROUTER_UNKNOWN_METRIC,
    estimatedLatencyMs: selected?.metrics.latencyMs ?? MODEL_ROUTER_UNKNOWN_METRIC,
    estimatedQuality: selected?.metrics.quality ?? MODEL_ROUTER_UNKNOWN_METRIC,
    executionStatus: input.executionStatus ?? (selected ? "not-started" : "not-started"),
    attemptBudget: MODEL_ROUTER_ATTEMPT_BUDGET,
    attempts: [],
    executed: selected,
  };

  return sanitizeDecision(decision);
}

export function modelSelectionFromRoute(
  decision: ModelRouterDecision,
): { instanceId: ProviderInstanceId; model: string } | null {
  return decision.selected === null ? null : decision.selected.target;
}
