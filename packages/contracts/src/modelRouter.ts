import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const MODEL_ROUTER_POLICY_VERSION = "model-router.v0" as const;
export const MODEL_ROUTER_MAX_CANDIDATES = 32;
const MODEL_ROUTER_MAX_REASON_CODES = 16;

/**
 * Documented Auto Route tie-break after preferred defaults. Unknown drivers
 * (including future API runners such as qwen, deepseek, and kimi) sort after
 * this list by instance id. This is policy, not a quality claim.
 */
export const MODEL_ROUTER_TIE_BREAK_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
] as const;

/** Representable API-runner kinds. No live adapters or credentials ship in V0. */
export const MODEL_ROUTER_FUTURE_API_DRIVERS = ["qwen", "deepseek", "kimi"] as const;

export const ModelRouterPolicyVersion = Schema.Literal(MODEL_ROUTER_POLICY_VERSION);
export type ModelRouterPolicyVersion = typeof ModelRouterPolicyVersion.Type;

const MODEL_ROUTER_MODES = ["auto", "manual"] as const;
export const ModelRouterMode = Schema.Literals(MODEL_ROUTER_MODES);
export type ModelRouterMode = typeof ModelRouterMode.Type;

const MODEL_ROUTER_CAPABILITIES = ["code", "tools", "vision", "long-context"] as const;
export const ModelRouterCapability = Schema.Literals(MODEL_ROUTER_CAPABILITIES);
export type ModelRouterCapability = typeof ModelRouterCapability.Type;

export const MODEL_ROUTER_REASON_CODES = [
  "SELECTED",
  "MANUAL_OVERRIDE",
  "PREFERRED_DEFAULT",
  "POLICY_TIE_BREAK",
  "METRICS_UNKNOWN",
  "REQUIRED_CAPABILITY_MISSING",
  "CONSTRAINT_EXCLUDED",
  "PROVIDER_INSTANCE_NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_DISABLED",
  "PROVIDER_NOT_INSTALLED",
  "PROVIDER_UNAUTHENTICATED",
  "PROVIDER_ERROR",
  "MODEL_NOT_FOUND",
  "NO_ELIGIBLE_CANDIDATES",
] as const;
export const ModelRouterReasonCode = Schema.Literals(MODEL_ROUTER_REASON_CODES);
export type ModelRouterReasonCode = typeof ModelRouterReasonCode.Type;

const BoundedModel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedCapabilityList = Schema.Array(ModelRouterCapability).check(Schema.isMaxLength(8));
const BoundedReasonCodes = Schema.Array(ModelRouterReasonCode).check(
  Schema.isMaxLength(MODEL_ROUTER_MAX_REASON_CODES),
);
const BoundedInstanceIdList = Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(32));
const BoundedDriverList = Schema.Array(ProviderDriverKind).check(Schema.isMaxLength(32));
const BoundedModelList = Schema.Array(BoundedModel).check(Schema.isMaxLength(64));

export const ModelRouterMetricValue = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({
    status: Schema.Literal("known"),
    value: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
export type ModelRouterMetricValue = typeof ModelRouterMetricValue.Type;

export const MODEL_ROUTER_UNKNOWN_METRIC: ModelRouterMetricValue = { status: "unknown" };

export const ModelRouterMetrics = Schema.Struct({
  quality: ModelRouterMetricValue,
  costUsd: ModelRouterMetricValue,
  latencyMs: ModelRouterMetricValue,
});
export type ModelRouterMetrics = typeof ModelRouterMetrics.Type;

export const MODEL_ROUTER_UNKNOWN_METRICS: ModelRouterMetrics = {
  quality: MODEL_ROUTER_UNKNOWN_METRIC,
  costUsd: MODEL_ROUTER_UNKNOWN_METRIC,
  latencyMs: MODEL_ROUTER_UNKNOWN_METRIC,
};

export const ModelRouterPolicy = Schema.Struct({
  version: ModelRouterPolicyVersion,
  qualityWeight: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  costWeight: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  latencyWeight: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export type ModelRouterPolicy = typeof ModelRouterPolicy.Type;

export const MODEL_ROUTER_DEFAULT_POLICY: ModelRouterPolicy = {
  version: MODEL_ROUTER_POLICY_VERSION,
  qualityWeight: 1,
  costWeight: 1,
  latencyWeight: 1,
};

export const ModelRouterConstraints = Schema.Struct({
  requiredCapabilities: Schema.optional(BoundedCapabilityList),
  allowedInstanceIds: Schema.optional(BoundedInstanceIdList),
  excludedInstanceIds: Schema.optional(BoundedInstanceIdList),
  allowedDrivers: Schema.optional(BoundedDriverList),
  excludedDrivers: Schema.optional(BoundedDriverList),
  allowedModels: Schema.optional(BoundedModelList),
  excludedModels: Schema.optional(BoundedModelList),
});
export type ModelRouterConstraints = typeof ModelRouterConstraints.Type;

export const ModelRouterTaskCharacteristics = Schema.Struct({
  attachmentCount: NonNegativeInt,
  composerContextKinds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(200)),
  requiredCapabilities: BoundedCapabilityList,
});
export type ModelRouterTaskCharacteristics = typeof ModelRouterTaskCharacteristics.Type;

export const ModelRouterTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: BoundedModel,
});
export type ModelRouterTarget = typeof ModelRouterTarget.Type;

const MODEL_ROUTER_EXECUTION_STATUSES = [
  "not-started",
  "bound",
  "running",
  "completed",
  "failed",
] as const;
export const ModelRouterExecutionStatus = Schema.Literals(MODEL_ROUTER_EXECUTION_STATUSES);
export type ModelRouterExecutionStatus = typeof ModelRouterExecutionStatus.Type;

export const ModelRouterCandidate = Schema.Struct({
  fallbackIndex: NonNegativeInt,
  target: ModelRouterTarget,
  driver: Schema.NullOr(ProviderDriverKind),
  capabilities: BoundedCapabilityList,
  eligible: Schema.Boolean,
  reasonCodes: BoundedReasonCodes,
  preferredDefault: Schema.Boolean,
  metrics: ModelRouterMetrics,
});
export type ModelRouterCandidate = typeof ModelRouterCandidate.Type;

export const ModelRouterDecision = Schema.Struct({
  policyVersion: ModelRouterPolicyVersion,
  mode: ModelRouterMode,
  task: ModelRouterTaskCharacteristics,
  policy: ModelRouterPolicy,
  selected: Schema.NullOr(ModelRouterCandidate),
  fallbacks: Schema.Array(ModelRouterCandidate).check(
    Schema.isMaxLength(MODEL_ROUTER_MAX_CANDIDATES),
  ),
  candidates: Schema.Array(ModelRouterCandidate).check(
    Schema.isMaxLength(MODEL_ROUTER_MAX_CANDIDATES),
  ),
  reasonCodes: BoundedReasonCodes,
  explanation: BoundedExplanation,
  estimatedCostUsd: ModelRouterMetricValue,
  estimatedLatencyMs: ModelRouterMetricValue,
  estimatedQuality: ModelRouterMetricValue,
  executionStatus: ModelRouterExecutionStatus,
});
export type ModelRouterDecision = typeof ModelRouterDecision.Type;
