/**
 * Phase 10 OpenRouter contracts.
 *
 * These types are observational and policy-facing. They never carry API keys,
 * Authorization headers, raw prompts, or raw completions. Missing metrics stay
 * unknown. Unknown future OpenRouter task tags remain representable.
 *
 * @module openRouter
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelRouterMetricValue, ModelRouterTarget } from "./modelRouter.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const OPENROUTER_GUIDANCE_POLICY_VERSION = "openrouter-guidance.v0" as const;
export const OPENROUTER_OBSERVATION_VERSION = "openrouter-observation.v0" as const;
export const OPENROUTER_MARKET_PRIOR_VERSION = "openrouter-market-prior.v0" as const;
export const OPENROUTER_TASK_PROFILE_VERSION = "openrouter-task-profile.v0" as const;
export const OPENROUTER_AUTO_SLUG = "openrouter/auto" as const;
export const OPENROUTER_AUTO_ROUTER_PLUGIN_ID = "auto-router" as const;
export const OPENROUTER_CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions" as const;
export const OPENROUTER_MODELS_PATH = "/api/v1/models" as const;
export const OPENROUTER_CLASSIFICATIONS_PATH = "/api/v1/classifications/task" as const;
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai" as const;
export const OPENROUTER_SHADOW_MAX_TOKENS = 16;
export const OPENROUTER_REQUEST_TIMEOUT_MS = 15_000;
export const OPENROUTER_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const OPENROUTER_CATALOG_PAGE_SIZE = 500;
export const OPENROUTER_CATALOG_PAGE_SIZE_MAX = 1000;
export const OPENROUTER_CLASSIFICATION_WINDOW = "7d" as const;
export const OPENROUTER_METADATA_HEADER = "X-OpenRouter-Metadata" as const;
export const OPENROUTER_METADATA_HEADER_VALUE = "enabled" as const;
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY" as const;
export const OPENROUTER_DRIVER_KIND = "openrouter" as const;

export const OpenRouterGuidancePolicyVersion = Schema.Literal(OPENROUTER_GUIDANCE_POLICY_VERSION);
export type OpenRouterGuidancePolicyVersion = typeof OpenRouterGuidancePolicyVersion.Type;

export const OpenRouterObservationVersion = Schema.Literal(OPENROUTER_OBSERVATION_VERSION);
export type OpenRouterObservationVersion = typeof OpenRouterObservationVersion.Type;

export const OpenRouterMarketPriorVersion = Schema.Literal(OPENROUTER_MARKET_PRIOR_VERSION);
export type OpenRouterMarketPriorVersion = typeof OpenRouterMarketPriorVersion.Type;

export const OpenRouterTaskProfileVersion = Schema.Literal(OPENROUTER_TASK_PROFILE_VERSION);
export type OpenRouterTaskProfileVersion = typeof OpenRouterTaskProfileVersion.Type;

const OPENROUTER_GUIDANCE_MODES = ["off", "shadow", "teacher"] as const;
export const OpenRouterGuidanceMode = Schema.Literals(OPENROUTER_GUIDANCE_MODES);
export type OpenRouterGuidanceMode = typeof OpenRouterGuidanceMode.Type;

export const OPENROUTER_DEFAULT_GUIDANCE_MODE: OpenRouterGuidanceMode = "off";

const TASK_MACRO_CATEGORIES = [
  "coding",
  "debugging",
  "multi_step_agent",
  "research",
  "reasoning",
  "mathematics",
  "summarization",
  "simple_qa",
  "writing",
  "data_analysis",
  "other",
  "unknown",
] as const;
export const TaskMacroCategory = Schema.Literals(TASK_MACRO_CATEGORIES);
export type TaskMacroCategory = typeof TaskMacroCategory.Type;

const TASK_CLASSIFICATION_SOURCES = [
  "openrouter_auto",
  "openrouter_classifications",
  "local_heuristic",
  "unknown",
] as const;
export const TaskClassificationSource = Schema.Literals(TASK_CLASSIFICATION_SOURCES);
export type TaskClassificationSource = typeof TaskClassificationSource.Type;

const BoundedExternalTag = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * Raw OpenRouter task tag. Unknown future tags remain strings; they are never
 * collapsed into a closed enum at the wire boundary.
 */
export const OpenRouterTaskTag = BoundedExternalTag;
export type OpenRouterTaskTag = typeof OpenRouterTaskTag.Type;

export const TaskProfileV0 = Schema.Struct({
  version: OpenRouterTaskProfileVersion,
  macroCategory: TaskMacroCategory,
  rawExternalTag: Schema.optional(OpenRouterTaskTag),
  source: TaskClassificationSource,
  /**
   * Present only when OpenRouter returned a numeric confidence. Omitted means
   * unknown — never a fabricated 0.
   */
  confidence: Schema.optional(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(1),
    ),
  ),
  heuristic: Schema.optional(Schema.Boolean),
});
export type TaskProfileV0 = typeof TaskProfileV0.Type;

export const UNKNOWN_TASK_PROFILE: TaskProfileV0 = {
  version: OPENROUTER_TASK_PROFILE_VERSION,
  macroCategory: "unknown",
  source: "unknown",
};

const OPENROUTER_COST_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
export const OpenRouterCostTier = Schema.Literals(OPENROUTER_COST_TIERS);
export type OpenRouterCostTier = typeof OpenRouterCostTier.Type;

export const OPENROUTER_DEFAULT_COST_TIER: OpenRouterCostTier = "medium";

const OPENROUTER_PRIVACY_POLICIES = ["zdr_deny_collection"] as const;
export const OpenRouterPrivacyPolicy = Schema.Literals(OPENROUTER_PRIVACY_POLICIES);
export type OpenRouterPrivacyPolicy = typeof OpenRouterPrivacyPolicy.Type;

export const OPENROUTER_PHASE10_PRIVACY_POLICY: OpenRouterPrivacyPolicy = "zdr_deny_collection";

const OPENROUTER_CREDENTIAL_STATUSES = ["missing", "configured", "invalid", "unavailable"] as const;
export const OpenRouterCredentialStatus = Schema.Literals(OPENROUTER_CREDENTIAL_STATUSES);
export type OpenRouterCredentialStatus = typeof OpenRouterCredentialStatus.Type;

const OPENROUTER_CONNECTION_STATUSES = ["not_configured", "connected", "unavailable"] as const;
export const OpenRouterConnectionStatus = Schema.Literals(OPENROUTER_CONNECTION_STATUSES);
export type OpenRouterConnectionStatus = typeof OpenRouterConnectionStatus.Type;

const OBSERVATION_STATUSES = [
  "not_requested",
  "pending",
  "observed",
  "skipped",
  "failed",
  "policy_violation",
] as const;
export const OpenRouterObservationStatus = Schema.Literals(OBSERVATION_STATUSES);
export type OpenRouterObservationStatus = typeof OpenRouterObservationStatus.Type;

export const OPENROUTER_SKIP_REASONS = [
  "guidance_off",
  "not_configured",
  "missing_api_key",
  "consent_required",
  "likely_credentials",
  "manual_selection",
  "timeout",
  "cancelled",
  "provider_error",
  "unresolved_mapping",
  "empty_allowlist",
] as const;
export const OpenRouterSkipReason = Schema.Literals(OPENROUTER_SKIP_REASONS);
export type OpenRouterSkipReason = typeof OpenRouterSkipReason.Type;

const SANITIZED_ERROR_CATEGORIES = [
  "missing_api_key",
  "authentication_failed",
  "payment_required",
  "forbidden",
  "not_found",
  "rate_limited",
  "transient_transport",
  "timeout",
  "cancelled",
  "policy_violation",
  "invalid_response",
  "unknown",
] as const;
export const OpenRouterSanitizedErrorCategory = Schema.Literals(SANITIZED_ERROR_CATEGORIES);
export type OpenRouterSanitizedErrorCategory = typeof OpenRouterSanitizedErrorCategory.Type;

const FRESHNESS_STATUSES = ["fresh", "stale", "unknown"] as const;
export const OpenRouterFreshnessStatus = Schema.Literals(FRESHNESS_STATUSES);
export type OpenRouterFreshnessStatus = typeof OpenRouterFreshnessStatus.Type;

const AGREEMENT_STATUSES = ["agreement", "disagreement", "inapplicable", "unknown"] as const;
export const OpenRouterAgreementStatus = Schema.Literals(AGREEMENT_STATUSES);
export type OpenRouterAgreementStatus = typeof OpenRouterAgreementStatus.Type;

const FALLBACK_ORIGINS = ["base3router", "openrouter_internal"] as const;
export const OpenRouterFallbackOrigin = Schema.Literals(FALLBACK_ORIGINS);
export type OpenRouterFallbackOrigin = typeof OpenRouterFallbackOrigin.Type;

export const OpenRouterModelIdentity = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  driver: Schema.optional(ProviderDriverKind),
  base3Model: Schema.optional(BoundedSlug),
  openRouterSlug: Schema.optional(BoundedSlug),
  canonicalSlug: Schema.optional(BoundedSlug),
  actualOpenRouterModel: Schema.optional(BoundedSlug),
  resolved: Schema.Boolean,
});
export type OpenRouterModelIdentity = typeof OpenRouterModelIdentity.Type;

export const OpenRouterInternalAttempt = Schema.Struct({
  origin: OpenRouterFallbackOrigin,
  provider: Schema.optional(BoundedLabel),
  model: Schema.optional(BoundedSlug),
  status: Schema.optional(NonNegativeInt),
  selected: Schema.optional(Schema.Boolean),
});
export type OpenRouterInternalAttempt = typeof OpenRouterInternalAttempt.Type;

export const OpenRouterRoutingMetadataSummary = Schema.Struct({
  requested: Schema.optional(BoundedSlug),
  strategy: Schema.optional(BoundedLabel),
  region: Schema.optional(BoundedLabel),
  summary: Schema.optional(BoundedExplanation),
  attempt: Schema.optional(NonNegativeInt),
  isByok: Schema.optional(Schema.Boolean),
  nestedAttempts: Schema.Array(OpenRouterInternalAttempt).check(Schema.isMaxLength(16)),
});
export type OpenRouterRoutingMetadataSummary = typeof OpenRouterRoutingMetadataSummary.Type;

export const OpenRouterTeacherObservationV0 = Schema.Struct({
  version: OpenRouterObservationVersion,
  policyVersion: OpenRouterGuidancePolicyVersion,
  marketPriorVersion: Schema.optional(OpenRouterMarketPriorVersion),
  guidanceMode: OpenRouterGuidanceMode,
  status: OpenRouterObservationStatus,
  observedAt: Schema.optional(BoundedIso),
  taskProfile: TaskProfileV0,
  base3Selected: Schema.optional(ModelRouterTarget),
  openRouterSuggested: Schema.optional(BoundedSlug),
  actualExecutionModel: Schema.optional(BoundedSlug),
  requestedRouterTarget: Schema.optional(BoundedSlug),
  allowedModels: Schema.Array(BoundedSlug).check(Schema.isMaxLength(64)),
  costTier: OpenRouterCostTier,
  privacyPolicy: OpenRouterPrivacyPolicy,
  agreement: OpenRouterAgreementStatus,
  routingMetadata: Schema.optional(OpenRouterRoutingMetadataSummary),
  nestedFallbacks: Schema.Array(OpenRouterInternalAttempt).check(Schema.isMaxLength(16)),
  promptTokens: Schema.optional(ModelRouterMetricValue),
  completionTokens: Schema.optional(ModelRouterMetricValue),
  totalTokens: Schema.optional(ModelRouterMetricValue),
  reportedCostUsd: Schema.optional(ModelRouterMetricValue),
  latencyMs: Schema.optional(ModelRouterMetricValue),
  skipReason: Schema.optional(OpenRouterSkipReason),
  errorCategory: Schema.optional(OpenRouterSanitizedErrorCategory),
  detail: Schema.optional(BoundedExplanation),
});
export type OpenRouterTeacherObservationV0 = typeof OpenRouterTeacherObservationV0.Type;

export const OpenRouterMarketPriorModelShareV0 = Schema.Struct({
  id: BoundedSlug,
  tagUsageShare: Schema.optional(ModelRouterMetricValue),
  tagTokenShare: Schema.optional(ModelRouterMetricValue),
});
export type OpenRouterMarketPriorModelShareV0 = typeof OpenRouterMarketPriorModelShareV0.Type;

export const OpenRouterMarketPriorClassificationV0 = Schema.Struct({
  tag: OpenRouterTaskTag,
  displayName: Schema.optional(BoundedLabel),
  macroCategory: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  usageShare: Schema.optional(ModelRouterMetricValue),
  tokenShare: Schema.optional(ModelRouterMetricValue),
  models: Schema.Array(OpenRouterMarketPriorModelShareV0).check(Schema.isMaxLength(32)),
});
export type OpenRouterMarketPriorClassificationV0 =
  typeof OpenRouterMarketPriorClassificationV0.Type;

export const OpenRouterCatalogModelV0 = Schema.Struct({
  id: BoundedSlug,
  canonicalSlug: Schema.optional(BoundedSlug),
  displayName: Schema.optional(BoundedLabel),
  contextLength: Schema.optional(ModelRouterMetricValue),
  inputModalities: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(32))).check(
    Schema.isMaxLength(16),
  ),
  outputModalities: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(32))).check(
    Schema.isMaxLength(16),
  ),
  supportedParameters: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).check(
    Schema.isMaxLength(64),
  ),
  promptPrice: Schema.optional(ModelRouterMetricValue),
  completionPrice: Schema.optional(ModelRouterMetricValue),
  zdrEligible: Schema.optional(Schema.Boolean),
  latencyMs: Schema.optional(ModelRouterMetricValue),
  throughput: Schema.optional(ModelRouterMetricValue),
  intelligence: Schema.optional(ModelRouterMetricValue),
  coding: Schema.optional(ModelRouterMetricValue),
  agentic: Schema.optional(ModelRouterMetricValue),
  designArenaElo: Schema.optional(ModelRouterMetricValue),
});
export type OpenRouterCatalogModelV0 = typeof OpenRouterCatalogModelV0.Type;

export const OpenRouterMarketPriorV0 = Schema.Struct({
  version: OpenRouterMarketPriorVersion,
  source: Schema.Literal("openrouter_classifications"),
  sampled: Schema.Literal(true),
  asOf: Schema.optional(BoundedIso),
  observedAt: BoundedIso,
  windowDays: Schema.optional(NonNegativeInt),
  freshness: OpenRouterFreshnessStatus,
  classifications: Schema.Array(OpenRouterMarketPriorClassificationV0).check(
    Schema.isMaxLength(128),
  ),
  catalog: Schema.Array(OpenRouterCatalogModelV0).check(Schema.isMaxLength(1024)),
  citation: Schema.optional(BoundedExplanation),
});
export type OpenRouterMarketPriorV0 = typeof OpenRouterMarketPriorV0.Type;

export const OpenRouterCapabilitySnapshot = Schema.Struct({
  available: Schema.Boolean,
  guidanceModes: Schema.Array(OpenRouterGuidanceMode).check(Schema.isMaxLength(3)),
  credentialStatus: OpenRouterCredentialStatus,
  connectionStatus: OpenRouterConnectionStatus,
  configuredGuidanceMode: OpenRouterGuidanceMode,
  privacyPolicy: OpenRouterPrivacyPolicy,
  shadowConsent: Schema.Boolean,
  teacherFallbackToBase3: Schema.Boolean,
  costTier: OpenRouterCostTier,
  marketPriorFreshness: OpenRouterFreshnessStatus,
  marketPriorAsOf: Schema.optional(BoundedIso),
});
export type OpenRouterCapabilitySnapshot = typeof OpenRouterCapabilitySnapshot.Type;

export const OpenRouterGuidanceSettings = Schema.Struct({
  guidanceMode: OpenRouterGuidanceMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(OPENROUTER_DEFAULT_GUIDANCE_MODE)),
  ),
  shadowConsent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  teacherEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  teacherFallbackToBase3: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  costTier: OpenRouterCostTier.pipe(
    Schema.withDecodingDefault(Effect.succeed(OPENROUTER_DEFAULT_COST_TIER)),
  ),
  catalogTtlMs: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(OPENROUTER_CATALOG_TTL_MS)),
  ),
});
export type OpenRouterGuidanceSettings = typeof OpenRouterGuidanceSettings.Type;

export const DEFAULT_OPENROUTER_GUIDANCE_SETTINGS: OpenRouterGuidanceSettings = {
  guidanceMode: OPENROUTER_DEFAULT_GUIDANCE_MODE,
  shadowConsent: false,
  teacherEnabled: false,
  teacherFallbackToBase3: true,
  costTier: OPENROUTER_DEFAULT_COST_TIER,
  catalogTtlMs: OPENROUTER_CATALOG_TTL_MS,
};

export const emptyOpenRouterObservation = (input: {
  readonly guidanceMode: OpenRouterGuidanceMode;
  readonly status: OpenRouterObservationStatus;
  readonly allowedModels?: ReadonlyArray<string>;
  readonly costTier?: OpenRouterCostTier;
  readonly skipReason?: OpenRouterSkipReason;
  readonly errorCategory?: OpenRouterSanitizedErrorCategory;
  readonly detail?: string;
  readonly taskProfile?: TaskProfileV0;
}): OpenRouterTeacherObservationV0 => ({
  version: OPENROUTER_OBSERVATION_VERSION,
  policyVersion: OPENROUTER_GUIDANCE_POLICY_VERSION,
  guidanceMode: input.guidanceMode,
  status: input.status,
  taskProfile: input.taskProfile ?? UNKNOWN_TASK_PROFILE,
  allowedModels: [...(input.allowedModels ?? [])],
  costTier: input.costTier ?? OPENROUTER_DEFAULT_COST_TIER,
  privacyPolicy: OPENROUTER_PHASE10_PRIVACY_POLICY,
  agreement: "inapplicable",
  nestedFallbacks: [],
  ...(input.skipReason !== undefined ? { skipReason: input.skipReason } : {}),
  ...(input.errorCategory !== undefined ? { errorCategory: input.errorCategory } : {}),
  ...(input.detail !== undefined ? { detail: input.detail } : {}),
});
