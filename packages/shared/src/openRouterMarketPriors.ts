import {
  MODEL_ROUTER_UNKNOWN_METRIC,
  type ModelRouterMetricValue,
  type OpenRouterCatalogModelV0,
  type OpenRouterFreshnessStatus,
  type OpenRouterMarketPriorClassificationV0,
  type OpenRouterMarketPriorV0,
  OPENROUTER_MARKET_PRIOR_VERSION,
} from "@t3tools/contracts";

const asFiniteNonNegative = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
};

export const knownOrUnknown = (value: unknown): ModelRouterMetricValue => {
  const parsed = asFiniteNonNegative(value);
  return parsed === undefined ? MODEL_ROUTER_UNKNOWN_METRIC : { status: "known", value: parsed };
};

const stringList = (value: unknown, max = 64): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, max);
};

export const normalizeOpenRouterCatalogModel = (raw: unknown): OpenRouterCatalogModelV0 | null => {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
  const architecture =
    record.architecture !== null && typeof record.architecture === "object"
      ? (record.architecture as Record<string, unknown>)
      : {};
  const pricing =
    record.pricing !== null && typeof record.pricing === "object"
      ? (record.pricing as Record<string, unknown>)
      : {};
  return {
    id: record.id.trim(),
    ...(typeof record.canonical_slug === "string" && record.canonical_slug.trim().length > 0
      ? { canonicalSlug: record.canonical_slug.trim() }
      : {}),
    ...(typeof record.name === "string" && record.name.trim().length > 0
      ? { displayName: record.name.trim() }
      : {}),
    contextLength: knownOrUnknown(record.context_length),
    inputModalities: [...stringList(architecture.input_modalities, 16)],
    outputModalities: [...stringList(architecture.output_modalities, 16)],
    supportedParameters: [...stringList(record.supported_parameters)],
    promptPrice: knownOrUnknown(pricing.prompt),
    completionPrice: knownOrUnknown(pricing.completion),
    ...(typeof record.zdr === "boolean" ? { zdrEligible: record.zdr } : {}),
    latencyMs: knownOrUnknown(record.latency),
    throughput: knownOrUnknown(record.throughput),
    intelligence: knownOrUnknown(record.intelligence_index ?? record.intelligence),
    coding: knownOrUnknown(record.coding_index ?? record.coding),
    agentic: knownOrUnknown(record.agentic_index ?? record.agentic),
    designArenaElo: knownOrUnknown(record.design_arena_elo),
  };
};

export const normalizeOpenRouterClassification = (
  raw: unknown,
): OpenRouterMarketPriorClassificationV0 | null => {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.tag !== "string" || record.tag.trim().length === 0) return null;
  const models = Array.isArray(record.models)
    ? record.models.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const model = entry as Record<string, unknown>;
        if (typeof model.id !== "string" || model.id.trim().length === 0) return [];
        return [
          {
            id: model.id.trim(),
            tagUsageShare: knownOrUnknown(model.tag_usage_share),
            tagTokenShare: knownOrUnknown(model.tag_token_share),
          },
        ];
      })
    : [];
  return {
    tag: record.tag.trim(),
    ...(typeof record.display_name === "string" ? { displayName: record.display_name.trim() } : {}),
    ...(typeof record.macro_category === "string"
      ? { macroCategory: record.macro_category.trim() }
      : {}),
    usageShare: knownOrUnknown(record.usage_share),
    tokenShare: knownOrUnknown(record.token_share),
    models: models.slice(0, 32),
  };
};

export const buildOpenRouterMarketPrior = (input: {
  readonly asOf?: string;
  readonly observedAt: string;
  readonly windowDays?: number;
  readonly freshness: OpenRouterFreshnessStatus;
  readonly classifications: unknown;
  readonly catalog: unknown;
}): OpenRouterMarketPriorV0 => {
  const classifications = Array.isArray(input.classifications)
    ? input.classifications.flatMap((entry) => {
        const normalized = normalizeOpenRouterClassification(entry);
        return normalized === null ? [] : [normalized];
      })
    : [];
  const catalog = Array.isArray(input.catalog)
    ? input.catalog.flatMap((entry) => {
        const normalized = normalizeOpenRouterCatalogModel(entry);
        return normalized === null ? [] : [normalized];
      })
    : [];
  const asOf = input.asOf?.trim();
  return {
    version: OPENROUTER_MARKET_PRIOR_VERSION,
    source: "openrouter_classifications",
    sampled: true,
    observedAt: input.observedAt,
    freshness: input.freshness,
    classifications: classifications.slice(0, 128),
    catalog: catalog.slice(0, 1024),
    ...(asOf !== undefined && asOf.length > 0 ? { asOf } : {}),
    ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
    ...(asOf !== undefined && asOf.length > 0
      ? { citation: `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}.` }
      : {}),
  };
};

export const nextModelsPageOffset = (input: {
  readonly offset: number;
  readonly limit: number;
  readonly pageLength: number;
}): number | null => {
  if (input.pageLength < input.limit || input.pageLength === 0) return null;
  return input.offset + input.pageLength;
};
