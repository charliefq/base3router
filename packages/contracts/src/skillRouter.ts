/**
 * Typed skill manifests and Skill Router decisions (Phase 12).
 *
 * Discovery catalogs remain `ServerProviderSkill`. This module is the routing
 * contract. Skill prose is untrusted data and never becomes instructions
 * unless an explicit trusted-instruction adapter ref is present.
 *
 * @module skillRouter
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ActionRiskClass } from "./actionGate.ts";
import {
  ModelRouterCapability,
  ModelRouterMetricValue,
  MODEL_ROUTER_UNKNOWN_METRIC,
} from "./modelRouter.ts";
import { TaskMacroCategory } from "./openRouter.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const SKILL_MANIFEST_VERSION = "skill-manifest.v0" as const;
export const SKILL_ROUTER_POLICY_VERSION = "skill-router.v0" as const;
export const SKILL_ROUTER_MAX_CANDIDATES = 32;

export const SkillManifestVersion = Schema.Literal(SKILL_MANIFEST_VERSION);
export type SkillManifestVersion = typeof SkillManifestVersion.Type;

export const SkillRouterPolicyVersion = Schema.Literal(SKILL_ROUTER_POLICY_VERSION);
export type SkillRouterPolicyVersion = typeof SkillRouterPolicyVersion.Type;

export const SkillId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SkillId"),
);
export type SkillId = typeof SkillId.Type;

const SKILL_SOURCES = ["local-filesystem", "provider-catalog", "fake-lab"] as const;
export const SkillSourceKind = Schema.Literals(SKILL_SOURCES);
export type SkillSourceKind = typeof SkillSourceKind.Type;

const SKILL_TRUST_STATES = ["trusted", "untrusted", "unknown"] as const;
export const SkillTrustState = Schema.Literals(SKILL_TRUST_STATES);
export type SkillTrustState = typeof SkillTrustState.Type;

const SKILL_CAPABILITIES = [
  "instructions",
  "code",
  "tools",
  "review",
  "testing",
  "docs",
  "research",
  "mcp",
] as const;
export const SkillCapability = Schema.Literals(SKILL_CAPABILITIES);
export type SkillCapability = typeof SkillCapability.Type;

const SKILL_PERMISSIONS = [
  "none",
  "workspace-read",
  "workspace-write",
  "network",
  "mcp",
  "credentials",
] as const;
export const SkillRequiredPermission = Schema.Literals(SKILL_PERMISSIONS);
export type SkillRequiredPermission = typeof SkillRequiredPermission.Type;

const INSTRUCTION_TRUST = ["not-executable", "trusted-selected"] as const;
export const SkillInstructionTrust = Schema.Literals(INSTRUCTION_TRUST);
export type SkillInstructionTrust = typeof SkillInstructionTrust.Type;

export const SKILL_ROUTER_MODES = ["auto", "manual"] as const;
export const SkillRouterMode = Schema.Literals(SKILL_ROUTER_MODES);
export type SkillRouterMode = typeof SkillRouterMode.Type;

export const SKILL_ROUTER_REASON_CODES = [
  "SELECTED",
  "NO_SKILL_REQUIRED",
  "NO_SKILLS_CONFIGURED",
  "MANUAL_OVERRIDE",
  "POLICY_TIE_BREAK",
  "METRICS_UNKNOWN",
  "REQUIRED_CAPABILITY_MISSING",
  "DISABLED",
  "UNAVAILABLE",
  "FILTERED_UNTRUSTED",
  "FILTERED_TRUST_UNKNOWN",
  "PROVIDER_MODEL_INCOMPATIBLE",
  "TASK_CLASS_INCOMPATIBLE",
  "MCP_DEPENDENCY_MISSING",
  "CONSTRAINT_EXCLUDED",
  "CONSTRAINT_NOT_ALLOWED",
  "INSUFFICIENT_EVIDENCE",
  "NO_ELIGIBLE_CANDIDATES",
] as const;
export const SkillRouterReasonCode = Schema.Literals(SKILL_ROUTER_REASON_CODES);
export type SkillRouterReasonCode = typeof SkillRouterReasonCode.Type;

const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedVersion = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedPath = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedHash = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedToolId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedReasonCodes = Schema.Array(SkillRouterReasonCode).check(Schema.isMaxLength(16));
const BoundedCapabilities = Schema.Array(SkillCapability).check(Schema.isMaxLength(8));
const BoundedTaskClasses = Schema.Array(TaskMacroCategory).check(Schema.isMaxLength(16));
const BoundedModelCapabilities = Schema.Array(ModelRouterCapability).check(Schema.isMaxLength(8));
const BoundedPermissions = Schema.Array(SkillRequiredPermission).check(Schema.isMaxLength(8));
const BoundedToolIds = Schema.Array(BoundedToolId).check(Schema.isMaxLength(32));
const BoundedSkillIds = Schema.Array(SkillId).check(Schema.isMaxLength(32));

export const SkillSchemaRef = Schema.Struct({
  digest: BoundedHash,
  mediaType: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type SkillSchemaRef = typeof SkillSchemaRef.Type;

export const SkillManifestV0 = Schema.Struct({
  manifestVersion: SkillManifestVersion,
  skillId: SkillId,
  name: BoundedName,
  version: BoundedVersion,
  source: SkillSourceKind,
  provenance: BoundedPath,
  driver: Schema.NullOr(ProviderDriverKind),
  trustState: SkillTrustState,
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  capabilities: BoundedCapabilities,
  compatibleTaskClasses: BoundedTaskClasses,
  compatibleModelCapabilities: BoundedModelCapabilities,
  requiredMcpTools: BoundedToolIds,
  inputSchemaRef: Schema.optional(SkillSchemaRef),
  outputSchemaRef: Schema.optional(SkillSchemaRef),
  riskClass: ActionRiskClass,
  requiredPermissions: BoundedPermissions,
  costHint: ModelRouterMetricValue,
  resourceHint: ModelRouterMetricValue,
  instructionsTrust: SkillInstructionTrust,
});
export type SkillManifestV0 = typeof SkillManifestV0.Type;

export const SKILL_UNKNOWN_COST: ModelRouterMetricValue = MODEL_ROUTER_UNKNOWN_METRIC;

export const SkillRouterCandidate = Schema.Struct({
  skillId: SkillId,
  name: BoundedName,
  version: BoundedVersion,
  eligible: Schema.Boolean,
  reasonCodes: BoundedReasonCodes,
  trustState: SkillTrustState,
  capabilities: BoundedCapabilities,
  costHint: ModelRouterMetricValue,
  riskClass: ActionRiskClass,
});
export type SkillRouterCandidate = typeof SkillRouterCandidate.Type;

export const SkillRouterConstraints = Schema.Struct({
  requiredCapabilities: Schema.optional(BoundedCapabilities),
  allowedSkillIds: Schema.optional(BoundedSkillIds),
  excludedSkillIds: Schema.optional(BoundedSkillIds),
  allowUnknownLocalTrust: Schema.optional(Schema.Boolean),
  allowUntrusted: Schema.optional(Schema.Boolean),
});
export type SkillRouterConstraints = typeof SkillRouterConstraints.Type;

export const SkillRouterEvidence = Schema.Struct({
  skillId: SkillId,
  successTrials: NonNegativeInt,
  successCount: NonNegativeInt,
  valid: Schema.Boolean,
});
export type SkillRouterEvidence = typeof SkillRouterEvidence.Type;

export const SkillInstructionRef = Schema.Struct({
  skillId: SkillId,
  version: BoundedVersion,
  digest: BoundedHash,
});
export type SkillInstructionRef = typeof SkillInstructionRef.Type;

export const SkillRouterDecision = Schema.Struct({
  policyVersion: SkillRouterPolicyVersion,
  mode: SkillRouterMode,
  selected: Schema.NullOr(SkillRouterCandidate),
  instructionRef: Schema.NullOr(SkillInstructionRef),
  eligible: Schema.Array(SkillRouterCandidate).check(
    Schema.isMaxLength(SKILL_ROUTER_MAX_CANDIDATES),
  ),
  filtered: Schema.Array(SkillRouterCandidate).check(
    Schema.isMaxLength(SKILL_ROUTER_MAX_CANDIDATES),
  ),
  candidates: Schema.Array(SkillRouterCandidate).check(
    Schema.isMaxLength(SKILL_ROUTER_MAX_CANDIDATES),
  ),
  reasonCodes: BoundedReasonCodes,
  explanation: BoundedExplanation,
  evidenceUsed: Schema.Boolean,
  tieBreak: BoundedExplanation,
  createdAt: BoundedIso,
});
export type SkillRouterDecision = typeof SkillRouterDecision.Type;
