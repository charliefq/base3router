/**
 * Phase 11 evaluation and Hybrid Router contracts.
 *
 * These types are observational and policy-facing. They never carry API keys,
 * Authorization headers, raw prompts, raw completions, source code, or tool
 * arguments. Missing metrics stay unknown. Numeric zero is never used to mean
 * unavailable.
 *
 * @module routerEvaluation
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelRouterMetricValue, ModelRouterMode, ModelRouterTarget } from "./modelRouter.ts";
import { TaskMacroCategory, TaskProfileV0 } from "./openRouter.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const TURN_OUTCOME_OBSERVATION_VERSION = "turn-outcome-observation.v0" as const;
export const HYBRID_ROUTER_POLICY_VERSION = "hybrid-router.v1.0.0" as const;
export const ROUTER_EVALUATION_DATASET_VERSION = "router-evaluation-dataset.v0" as const;
export const ROUTER_POLICY_SNAPSHOT_VERSION = "router-policy-snapshot.v0" as const;
export const DEFAULT_OBSERVATION_RETENTION_DAYS = 90;
export const HYBRID_SHRINKAGE_K = 10;
export const HYBRID_MIN_SAMPLE_RATE = 8;
export const HYBRID_MIN_SAMPLE_MEDIAN = 8;
export const HYBRID_MIN_SAMPLE_P90 = 20;
export const HYBRID_MIN_SAMPLE_P95 = 40;
export const REWORK_ABANDONMENT_WINDOW_MS = 120_000;

export const TurnOutcomeObservationVersion = Schema.Literal(TURN_OUTCOME_OBSERVATION_VERSION);
export type TurnOutcomeObservationVersion = typeof TurnOutcomeObservationVersion.Type;

export const HybridRouterPolicyVersion = Schema.Literal(HYBRID_ROUTER_POLICY_VERSION);
export type HybridRouterPolicyVersion = typeof HybridRouterPolicyVersion.Type;

export const RouterEvaluationDatasetVersion = Schema.Literal(ROUTER_EVALUATION_DATASET_VERSION);
export type RouterEvaluationDatasetVersion = typeof RouterEvaluationDatasetVersion.Type;

export const RouterPolicySnapshotVersion = Schema.Literal(ROUTER_POLICY_SNAPSHOT_VERSION);
export type RouterPolicySnapshotVersion = typeof RouterPolicySnapshotVersion.Type;

export const ObservationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ObservationId"),
);
export type ObservationId = typeof ObservationId.Type;

export const RouterPolicyId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("RouterPolicyId"),
);
export type RouterPolicyId = typeof RouterPolicyId.Type;

const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedUnit = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
const BoundedHash = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedPolicyVersion = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

const MEASUREMENT_UNITS = ["ms", "token", "usd", "count", "rate", "share"] as const;
export const MeasurementUnit = Schema.Literals(MEASUREMENT_UNITS);
export type MeasurementUnit = typeof MeasurementUnit.Type;

const MEASUREMENT_PROVENANCE = ["observed", "estimated", "unknown"] as const;
export const MeasurementProvenance = Schema.Literals(MEASUREMENT_PROVENANCE);
export type MeasurementProvenance = typeof MeasurementProvenance.Type;

const MEASUREMENT_SOURCES = [
  "monotonic_clock",
  "wall_clock",
  "provider_reported",
  "openrouter_accounting",
  "openrouter_upstream_byok",
  "catalog_estimate",
  "user_explicit",
  "rework_proxy",
  "verification_command",
  "not_reported",
  "unknown",
] as const;
export const MeasurementSource = Schema.Literals(MEASUREMENT_SOURCES);
export type MeasurementSource = typeof MeasurementSource.Type;

const COST_SOURCES = [
  "provider_reported",
  "openrouter_accounting",
  "openrouter_upstream_byok",
  "catalog_estimate",
  "unknown",
] as const;
export const CostSource = Schema.Literals(COST_SOURCES);
export type CostSource = typeof CostSource.Type;

/**
 * A single measured quantity. Absent/null provider values decode as
 * `{ status: "unknown" }`. A known zero is a real zero, never a stand-in
 * for missing data.
 */
export const MeasuredQuantityV0 = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unknown"),
    unit: MeasurementUnit,
    source: MeasurementSource,
  }),
  Schema.Struct({
    status: Schema.Literal("known"),
    value: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    unit: MeasurementUnit,
    source: MeasurementSource,
    provenance: MeasurementProvenance,
    observedAt: BoundedIso,
  }),
]);
export type MeasuredQuantityV0 = typeof MeasuredQuantityV0.Type;

export const unknownQuantity = (
  unit: MeasurementUnit,
  source: MeasurementSource = "not_reported",
): MeasuredQuantityV0 => ({ status: "unknown", unit, source });

export const ExecutionTimingV0 = Schema.Struct({
  routeStartAt: Schema.optional(BoundedIso),
  providerRequestStartAt: Schema.optional(BoundedIso),
  firstOutputAt: Schema.optional(BoundedIso),
  terminalAt: Schema.optional(BoundedIso),
  timeToFirstTokenMs: MeasuredQuantityV0,
  totalDurationMs: MeasuredQuantityV0,
  /** Wall timestamps use Effect millis. Durations use a monotonic source. */
  clock: Schema.Literals(["effect_clock_millis", "monotonic_nanos"]),
});
export type ExecutionTimingV0 = typeof ExecutionTimingV0.Type;

export const UsageMeasurementV0 = Schema.Struct({
  promptTokens: MeasuredQuantityV0,
  completionTokens: MeasuredQuantityV0,
  totalTokens: MeasuredQuantityV0,
  reasoningTokens: MeasuredQuantityV0,
  cacheReadTokens: MeasuredQuantityV0,
  cacheWriteTokens: MeasuredQuantityV0,
  generationId: Schema.optional(BoundedSlug),
  isByok: Schema.optional(Schema.Boolean),
});
export type UsageMeasurementV0 = typeof UsageMeasurementV0.Type;

export const CostMeasurementV0 = Schema.Struct({
  reportedUsd: MeasuredQuantityV0,
  reportedSource: CostSource,
  estimatedUsd: MeasuredQuantityV0,
  estimatedSource: CostSource,
  pricingSnapshotAt: Schema.optional(BoundedIso),
  pricingSnapshotVersion: Schema.optional(BoundedSlug),
  mixedProvenance: Schema.Boolean,
});
export type CostMeasurementV0 = typeof CostMeasurementV0.Type;

const TERMINAL_CATEGORIES = [
  "success",
  "provider_failure",
  "cancelled",
  "timeout",
  "infrastructure_failure",
  "unknown",
] as const;
export const TerminalOutcomeCategory = Schema.Literals(TERMINAL_CATEGORIES);
export type TerminalOutcomeCategory = typeof TerminalOutcomeCategory.Type;

const FINISH_REASONS = [
  "stop",
  "length",
  "cancelled",
  "timeout",
  "error",
  "content_filter",
  "unknown",
] as const;
export const NormalizedFinishReason = Schema.Literals(FINISH_REASONS);
export type NormalizedFinishReason = typeof NormalizedFinishReason.Type;

const EXPLICIT_FEEDBACK_KINDS = [
  "helpful",
  "not_helpful",
  "accepted",
  "incorrect",
  "incomplete",
  "too_slow",
  "too_expensive",
  "wrong_model_choice",
] as const;
export const ExplicitFeedbackKind = Schema.Literals(EXPLICIT_FEEDBACK_KINDS);
export type ExplicitFeedbackKind = typeof ExplicitFeedbackKind.Type;

export const EXPLICIT_POSITIVE_FEEDBACK: ReadonlySet<ExplicitFeedbackKind> = new Set([
  "helpful",
  "accepted",
]);
export const EXPLICIT_NEGATIVE_FEEDBACK: ReadonlySet<ExplicitFeedbackKind> = new Set([
  "not_helpful",
  "incorrect",
  "incomplete",
  "too_slow",
  "too_expensive",
  "wrong_model_choice",
]);

export const ExplicitUserFeedbackV0 = Schema.Struct({
  kind: ExplicitFeedbackKind,
  reasonCategory: Schema.optional(ExplicitFeedbackKind),
  recordedAt: BoundedIso,
  /** Free text is not persisted in Phase 11. Always false. */
  freeTextIncluded: Schema.Literal(false),
});
export type ExplicitUserFeedbackV0 = typeof ExplicitUserFeedbackV0.Type;

const REWORK_PROXY_KINDS = [
  "regenerate",
  "retry_after_failure",
  "edit_and_resubmit",
  "manual_model_switch",
  "auto_to_manual_switch",
  "immediate_abandonment",
  "undo_revert",
  "follow_up_correction",
] as const;
export const ReworkProxyKind = Schema.Literals(REWORK_PROXY_KINDS);
export type ReworkProxyKind = typeof ReworkProxyKind.Type;

export const ReworkSignalV0 = Schema.Struct({
  kind: ReworkProxyKind,
  labeledAs: Schema.Literal("proxy"),
  rawEventType: ReworkProxyKind,
  detectionWindowMs: NonNegativeInt,
  recordedAt: BoundedIso,
  deduped: Schema.Boolean,
});
export type ReworkSignalV0 = typeof ReworkSignalV0.Type;

const VERIFICATION_KINDS = ["tests", "typecheck", "lint", "build", "command"] as const;
export const VerificationKind = Schema.Literals(VERIFICATION_KINDS);
export type VerificationKind = typeof VerificationKind.Type;

const VERIFICATION_RESULTS = ["passed", "failed", "unknown"] as const;
export const VerificationResult = Schema.Literals(VERIFICATION_RESULTS);
export type VerificationResult = typeof VerificationResult.Type;

export const VerificationEvidenceV0 = Schema.Struct({
  kind: VerificationKind,
  result: VerificationResult,
  exitStatus: Schema.optional(Schema.Int),
  retryCount: NonNegativeInt,
  recordedAt: BoundedIso,
  /** Must be true: an LLM must never fabricate this record. */
  fromRealCommand: Schema.Literal(true),
});
export type VerificationEvidenceV0 = typeof VerificationEvidenceV0.Type;

export const OutcomeEvidenceV0 = Schema.Struct({
  explicitFeedback: Schema.Array(ExplicitUserFeedbackV0).check(Schema.isMaxLength(8)),
  reworkProxies: Schema.Array(ReworkSignalV0).check(Schema.isMaxLength(16)),
  verification: Schema.Array(VerificationEvidenceV0).check(Schema.isMaxLength(16)),
});
export type OutcomeEvidenceV0 = typeof OutcomeEvidenceV0.Type;

export const ROUTER_POLICY_STATES = [
  "baseline",
  "candidate",
  "shadow",
  "active",
  "retired",
] as const;
export const RouterPolicyState = Schema.Literals(ROUTER_POLICY_STATES);
export type RouterPolicyState = typeof RouterPolicyState.Type;

export const HybridScoreComponentV0 = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  label: BoundedExplanation,
  source: MeasurementSource,
  provenance: MeasurementProvenance,
  sampleSize: NonNegativeInt,
  windowDays: Schema.optional(NonNegativeInt),
  weight: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  value: ModelRouterMetricValue,
  status: Schema.Literals(["used", "insufficient", "unknown", "incompatible_provenance"]),
});
export type HybridScoreComponentV0 = typeof HybridScoreComponentV0.Type;

export const HybridRouteDecisionV1 = Schema.Struct({
  policyVersion: HybridRouterPolicyVersion,
  usedHybridRanking: Schema.Boolean,
  fallbackToV0: Schema.Boolean,
  fallbackReason: Schema.optional(BoundedExplanation),
  selected: Schema.NullOr(ModelRouterTarget),
  eligibleCount: NonNegativeInt,
  components: Schema.Array(HybridScoreComponentV0).check(Schema.isMaxLength(16)),
  explanation: BoundedExplanation,
  challenger: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("policy_shadow"),
      selected: Schema.NullOr(ModelRouterTarget),
      agreement: Schema.Literals(["agreement", "disagreement", "inapplicable", "unknown"]),
    }),
  ),
});
export type HybridRouteDecisionV1 = typeof HybridRouteDecisionV1.Type;

export const TurnOutcomeObservationV0 = Schema.Struct({
  version: TurnOutcomeObservationVersion,
  observationId: ObservationId,
  environmentId: EnvironmentId,
  recordedAt: BoundedIso,
  policyVersion: BoundedPolicyVersion,
  routingMode: ModelRouterMode,
  model: BoundedSlug,
  instanceId: Schema.optional(ProviderInstanceId),
  driver: Schema.optional(ProviderDriverKind),
  providerIdentity: Schema.optional(BoundedSlug),
  actualExecutionModel: Schema.optional(BoundedSlug),
  taskProfile: TaskProfileV0,
  timing: ExecutionTimingV0,
  usage: UsageMeasurementV0,
  cost: CostMeasurementV0,
  providerAttempts: NonNegativeInt,
  fallbackCount: NonNegativeInt,
  cancelled: Schema.Boolean,
  timedOut: Schema.Boolean,
  finishReason: NormalizedFinishReason,
  terminalCategory: TerminalOutcomeCategory,
  evidence: OutcomeEvidenceV0,
  hybrid: Schema.optional(HybridRouteDecisionV1),
  openRouterAgreement: Schema.optional(
    Schema.Literals(["agreement", "disagreement", "inapplicable", "unknown"]),
  ),
  eligibleCandidateCount: Schema.optional(NonNegativeInt),
});
export type TurnOutcomeObservationV0 = typeof TurnOutcomeObservationV0.Type;

export const RouterPolicyWeightsV1 = Schema.Struct({
  preference: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  marketPrior: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  success: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  latency: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  cost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  explicitPositive: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  explicitNegative: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  reworkProxy: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  verification: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export type RouterPolicyWeightsV1 = typeof RouterPolicyWeightsV1.Type;

export const DEFAULT_HYBRID_ROUTER_WEIGHTS: RouterPolicyWeightsV1 = {
  preference: 1,
  marketPrior: 0.5,
  success: 2,
  latency: 1,
  cost: 1,
  explicitPositive: 1,
  explicitNegative: 1.5,
  reworkProxy: 0.5,
  verification: 2,
};

export const RouterPolicySnapshotV0 = Schema.Struct({
  version: RouterPolicySnapshotVersion,
  policyId: RouterPolicyId,
  policyVersion: BoundedPolicyVersion,
  state: RouterPolicyState,
  environmentId: EnvironmentId,
  createdAt: BoundedIso,
  sourceDatasetHash: Schema.optional(BoundedHash),
  evaluationRecordId: Schema.optional(BoundedSlug),
  weights: RouterPolicyWeightsV1,
  shrinkageK: Schema.Literal(HYBRID_SHRINKAGE_K),
  minSampleRate: Schema.Literal(HYBRID_MIN_SAMPLE_RATE),
  recencyDecayImplemented: Schema.Literal(false),
  priorActivePolicyId: Schema.optional(RouterPolicyId),
  activatedAt: Schema.optional(BoundedIso),
  retiredAt: Schema.optional(BoundedIso),
  activationConfirmed: Schema.optional(Schema.Boolean),
  /** Pairing subject or session id. Never a credential. */
  activatedBy: Schema.optional(BoundedSlug),
});
export type RouterPolicySnapshotV0 = typeof RouterPolicySnapshotV0.Type;

export const RouterPolicyCandidateV0 = Schema.Struct({
  snapshot: RouterPolicySnapshotV0,
  immutable: Schema.Literal(true),
});
export type RouterPolicyCandidateV0 = typeof RouterPolicyCandidateV0.Type;

const METRIC_STATUSES = ["reliable", "insufficient", "unknown"] as const;
export const EvaluationMetricStatus = Schema.Literals(METRIC_STATUSES);
export type EvaluationMetricStatus = typeof EvaluationMetricStatus.Type;

export const EvaluationMetricV0 = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  numerator: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  denominator: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  sampleCount: NonNegativeInt,
  status: EvaluationMetricStatus,
  provenance: MeasurementProvenance,
  unit: MeasurementUnit,
});
export type EvaluationMetricV0 = typeof EvaluationMetricV0.Type;

export const EvaluationDatasetFilterV0 = Schema.Struct({
  macroCategory: Schema.optional(TaskMacroCategory),
  rawTaskTag: Schema.optional(BoundedSlug),
  routingMode: Schema.optional(ModelRouterMode),
  model: Schema.optional(BoundedSlug),
  provider: Schema.optional(BoundedSlug),
  policyVersion: Schema.optional(BoundedPolicyVersion),
  since: Schema.optional(BoundedIso),
  until: Schema.optional(BoundedIso),
});
export type EvaluationDatasetFilterV0 = typeof EvaluationDatasetFilterV0.Type;

export const EvaluationDatasetManifestV0 = Schema.Struct({
  version: RouterEvaluationDatasetVersion,
  synthetic: Schema.Boolean,
  recordCount: NonNegativeInt,
  trainCount: NonNegativeInt,
  evaluationCount: NonNegativeInt,
  since: Schema.optional(BoundedIso),
  until: Schema.optional(BoundedIso),
  schemaVersion: TurnOutcomeObservationVersion,
  filters: EvaluationDatasetFilterV0,
  datasetHash: BoundedHash,
  holdout: Schema.Literal("temporal_last_20_percent"),
});
export type EvaluationDatasetManifestV0 = typeof EvaluationDatasetManifestV0.Type;

export const PolicyEvaluationRecordV0 = Schema.Struct({
  evaluationId: BoundedSlug,
  evaluatedAt: BoundedIso,
  policyVersion: BoundedPolicyVersion,
  dataset: EvaluationDatasetManifestV0,
  coverage: EvaluationMetricV0,
  excludedCount: NonNegativeInt,
  exclusionReasons: Schema.Array(BoundedExplanation).check(Schema.isMaxLength(32)),
  metrics: Schema.Array(EvaluationMetricV0).check(Schema.isMaxLength(32)),
  changedDecisions: NonNegativeInt,
  regressions: NonNegativeInt,
  improvements: NonNegativeInt,
  unknowns: NonNegativeInt,
  reproducibility: Schema.Struct({
    seed: Schema.Literal("temporal-holdout"),
    shrinkageK: Schema.Literal(HYBRID_SHRINKAGE_K),
    minSampleRate: Schema.Literal(HYBRID_MIN_SAMPLE_RATE),
  }),
});
export type PolicyEvaluationRecordV0 = typeof PolicyEvaluationRecordV0.Type;

export const RouterEvaluationSettings = Schema.Struct({
  measurementEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  retentionDays: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_OBSERVATION_RETENTION_DAYS)),
  ),
  challengerShadowEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type RouterEvaluationSettings = typeof RouterEvaluationSettings.Type;

export const DEFAULT_ROUTER_EVALUATION_SETTINGS: RouterEvaluationSettings = {
  measurementEnabled: true,
  retentionDays: DEFAULT_OBSERVATION_RETENTION_DAYS,
  challengerShadowEnabled: false,
};

export const RouterInsightsSnapshotV0 = Schema.Struct({
  observationCount: NonNegativeInt,
  coverage: EvaluationMetricV0,
  activePolicyVersion: BoundedPolicyVersion,
  candidatePolicyVersion: Schema.optional(BoundedPolicyVersion),
  candidatePolicyId: Schema.optional(RouterPolicyId),
  candidatePolicyState: Schema.optional(RouterPolicyState),
  challengerEnabled: Schema.Boolean,
  measurementEnabled: Schema.Boolean,
  retentionDays: NonNegativeInt,
  freshness: Schema.Literals(["fresh", "stale", "empty", "unknown"]),
  metrics: Schema.Array(EvaluationMetricV0).check(Schema.isMaxLength(32)),
  mixedProvenanceWarning: Schema.Boolean,
  insufficientData: Schema.Boolean,
  latestObservationId: Schema.optional(ObservationId),
});
export type RouterInsightsSnapshotV0 = typeof RouterInsightsSnapshotV0.Type;

export const emptyUsageMeasurement = (): UsageMeasurementV0 => ({
  promptTokens: unknownQuantity("token"),
  completionTokens: unknownQuantity("token"),
  totalTokens: unknownQuantity("token"),
  reasoningTokens: unknownQuantity("token"),
  cacheReadTokens: unknownQuantity("token"),
  cacheWriteTokens: unknownQuantity("token"),
});

export const emptyCostMeasurement = (): CostMeasurementV0 => ({
  reportedUsd: unknownQuantity("usd"),
  reportedSource: "unknown",
  estimatedUsd: unknownQuantity("usd", "catalog_estimate"),
  estimatedSource: "unknown",
  mixedProvenance: false,
});

export const emptyTiming = (): ExecutionTimingV0 => ({
  timeToFirstTokenMs: unknownQuantity("ms", "monotonic_clock"),
  totalDurationMs: unknownQuantity("ms", "monotonic_clock"),
  clock: "monotonic_nanos",
});

export const emptyOutcomeEvidence = (): OutcomeEvidenceV0 => ({
  explicitFeedback: [],
  reworkProxies: [],
  verification: [],
});

export const FORBIDDEN_OBSERVATION_FIELD_NAMES = [
  "prompt",
  "completion",
  "messages",
  "content",
  "apiKey",
  "authorization",
  "rawPrompt",
  "rawCompletion",
  "toolArguments",
  "sourceCode",
] as const;

export const observationContainsForbiddenFields = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of FORBIDDEN_OBSERVATION_FIELD_NAMES) {
    if (key in record) return true;
  }
  return false;
};

export class RouterEvaluationError extends Schema.TaggedError<RouterEvaluationError>()(
  "RouterEvaluationError",
  {
    reason: Schema.Literals([
      "not_found",
      "unauthorized_activation",
      "confirmation_required",
      "malformed_policy",
      "illegal_transition",
      "empty",
    ]),
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Router evaluation failed (${this.reason}): ${this.detail}`;
  }
}

export const RouterInsightsRequest = Schema.Struct({});
export type RouterInsightsRequest = typeof RouterInsightsRequest.Type;

export const RouterExportObservationsRequest = Schema.Struct({});
export type RouterExportObservationsRequest = typeof RouterExportObservationsRequest.Type;

export const RouterExportObservationsResult = Schema.Struct({
  manifest: EvaluationDatasetManifestV0,
  records: Schema.Array(TurnOutcomeObservationV0).check(Schema.isMaxLength(10_000)),
});
export type RouterExportObservationsResult = typeof RouterExportObservationsResult.Type;

export const RouterDeleteObservationsRequest = Schema.Struct({
  confirmDelete: Schema.Boolean,
  scope: Schema.Literal("environment"),
});
export type RouterDeleteObservationsRequest = typeof RouterDeleteObservationsRequest.Type;

export const RouterDeleteObservationsResult = Schema.Struct({
  deleted: NonNegativeInt,
});
export type RouterDeleteObservationsResult = typeof RouterDeleteObservationsResult.Type;

export const RouterSubmitFeedbackRequest = Schema.Struct({
  observationId: ObservationId,
  kind: ExplicitFeedbackKind,
  reasonCategory: Schema.optional(ExplicitFeedbackKind),
});
export type RouterSubmitFeedbackRequest = typeof RouterSubmitFeedbackRequest.Type;

export const RouterSubmitFeedbackResult = Schema.Struct({
  observationId: ObservationId,
  recorded: Schema.Boolean,
});
export type RouterSubmitFeedbackResult = typeof RouterSubmitFeedbackResult.Type;

export const RouterListPoliciesResult = Schema.Struct({
  policies: Schema.Array(RouterPolicySnapshotV0).check(Schema.isMaxLength(32)),
});
export type RouterListPoliciesResult = typeof RouterListPoliciesResult.Type;

export const RouterInspectPolicyRequest = Schema.Struct({
  policyId: RouterPolicyId,
});
export type RouterInspectPolicyRequest = typeof RouterInspectPolicyRequest.Type;

export const RouterActivatePolicyRequest = Schema.Struct({
  policyId: RouterPolicyId,
  confirmActivation: Schema.Boolean,
});
export type RouterActivatePolicyRequest = typeof RouterActivatePolicyRequest.Type;

export const RouterShadowPolicyRequest = Schema.Struct({
  policyId: RouterPolicyId,
  confirmShadow: Schema.Boolean,
});
export type RouterShadowPolicyRequest = typeof RouterShadowPolicyRequest.Type;

export const RouterRollbackPolicyRequest = Schema.Struct({
  confirmRollback: Schema.Boolean,
});
export type RouterRollbackPolicyRequest = typeof RouterRollbackPolicyRequest.Type;

export const RouterPolicyMutationResult = Schema.Struct({
  active: RouterPolicySnapshotV0,
  previous: Schema.optional(RouterPolicySnapshotV0),
});
export type RouterPolicyMutationResult = typeof RouterPolicyMutationResult.Type;

export const ROUTER_OBSERVATION_EVENT_VERSION = "router-observation-event.v0" as const;
export const ObservationEventId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ObservationEventId"),
);
export type ObservationEventId = typeof ObservationEventId.Type;

const OBSERVATION_EVENT_TYPES = [
  "terminal_recorded",
  "usage_enriched",
  "explicit_feedback",
  "rework_proxy",
  "verification",
  "conflict_rejected",
  "retention_pruned",
  "observations_deleted",
  "policy_activated",
  "policy_shadowed",
  "policy_rolled_back",
] as const;
export const RouterObservationEventType = Schema.Literals(OBSERVATION_EVENT_TYPES);
export type RouterObservationEventType = typeof RouterObservationEventType.Type;

export const RouterObservationEventV0 = Schema.Struct({
  version: Schema.Literal(ROUTER_OBSERVATION_EVENT_VERSION),
  eventId: ObservationEventId,
  environmentId: EnvironmentId,
  observationId: Schema.optional(ObservationId),
  eventType: RouterObservationEventType,
  recordedAt: BoundedIso,
  idempotencyKey: BoundedSlug,
  sequence: NonNegativeInt,
  schemaVersion: BoundedSlug,
  actor: Schema.optional(BoundedSlug),
  terminalCategory: Schema.optional(TerminalOutcomeCategory),
  detail: Schema.optional(BoundedExplanation),
});
export type RouterObservationEventV0 = typeof RouterObservationEventV0.Type;

/** Higher rank cannot be overwritten by a lower rank. Success is lowest. */
export const TERMINAL_CATEGORY_RANK: Readonly<Record<TerminalOutcomeCategory, number>> = {
  success: 1,
  unknown: 2,
  provider_failure: 3,
  infrastructure_failure: 4,
  timeout: 5,
  cancelled: 6,
};
