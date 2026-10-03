/**
 * Independent ActionGate contracts (Phase 12).
 *
 * This is not the dispatcher route gate (`ActionGateResult` in dispatcher.ts),
 * which only answers whether a routed turn may start. These types authorize
 * each side-effecting action after an immutable execution plan exists.
 *
 * @module actionGate
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelRouterMetricValue } from "./modelRouter.ts";

export const ACTION_GATE_POLICY_VERSION = "action-gate.v0" as const;
export const ActionGatePolicyVersion = Schema.Literal(ACTION_GATE_POLICY_VERSION);
export type ActionGatePolicyVersion = typeof ActionGatePolicyVersion.Type;

export const ACTION_RISK_CLASSES = [
  "read-only-local",
  "local-mutation",
  "network-access",
  "external-write",
  "destructive",
  "financial",
  "credential",
  "administrative",
  "unclassified",
] as const;
export const ActionRiskClass = Schema.Literals(ACTION_RISK_CLASSES);
export type ActionRiskClass = typeof ActionRiskClass.Type;

export const SIDE_EFFECT_CLASSES = [
  "none",
  "read",
  "local-write",
  "network",
  "external-write",
  "unknown",
] as const;
export const SideEffectClass = Schema.Literals(SIDE_EFFECT_CLASSES);
export type SideEffectClass = typeof SideEffectClass.Type;

export const ACTION_GATE_DECISIONS = ["ALLOW", "DENY", "ASK"] as const;
export const ActionGateDecisionKind = Schema.Literals(ACTION_GATE_DECISIONS);
export type ActionGateDecisionKind = typeof ActionGateDecisionKind.Type;

export const ACTION_GATE_REASON_CODES = [
  "ACTION_ALLOWED",
  "ACTION_DENIED",
  "APPROVAL_REQUIRED",
  "UNCLASSIFIED_SIDE_EFFECT",
  "HIGH_RISK_DEFAULT",
  "SECRET_EXPOSURE_RISK",
  "TRUST_DENIED",
  "POLICY_DENIED",
  "PLAN_EXPIRED",
  "PLAN_MUTATED",
  "FINGERPRINT_MISMATCH",
  "APPROVAL_EXPIRED",
  "APPROVAL_CANCELLED",
  "APPROVAL_DENIED",
  "APPROVAL_CONSUMED",
  "REPLAY_REJECTED",
  "IDEMPOTENCY_CONFLICT",
  "CONCURRENT_CONSUME_REJECTED",
  "BASELINE_SAFETY",
  "PAID_TIER_CANNOT_DISABLE_SAFETY",
] as const;
export const ActionGateReasonCode = Schema.Literals(ACTION_GATE_REASON_CODES);
export type ActionGateReasonCode = typeof ActionGateReasonCode.Type;

export const APPROVAL_STATUSES = [
  "pending",
  "granted",
  "denied",
  "expired",
  "cancelled",
  "consumed",
  "invalidated",
] as const;
export const ActionApprovalStatus = Schema.Literals(APPROVAL_STATUSES);
export type ActionApprovalStatus = typeof ActionApprovalStatus.Type;

export const APPROVAL_REUSE_POLICIES = ["one-time", "explicit-reuse"] as const;
export const ActionApprovalReusePolicy = Schema.Literals(APPROVAL_REUSE_POLICIES);
export type ActionApprovalReusePolicy = typeof ActionApprovalReusePolicy.Type;

const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedHash = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedReasonCodes = Schema.Array(ActionGateReasonCode).check(Schema.isMaxLength(16));

export const ActionId = BoundedId.pipe(Schema.brand("ActionId"));
export type ActionId = typeof ActionId.Type;

export const ActionFingerprint = BoundedHash.pipe(Schema.brand("ActionFingerprint"));
export type ActionFingerprint = typeof ActionFingerprint.Type;

export const ActionApprovalId = BoundedId.pipe(Schema.brand("ActionApprovalId"));
export type ActionApprovalId = typeof ActionApprovalId.Type;

export const ActionIdempotencyKey = BoundedId.pipe(Schema.brand("ActionIdempotencyKey"));
export type ActionIdempotencyKey = typeof ActionIdempotencyKey.Type;

export const ActionGateDecision = Schema.Struct({
  policyVersion: ActionGatePolicyVersion,
  actionId: ActionId,
  decision: ActionGateDecisionKind,
  riskClass: ActionRiskClass,
  sideEffectClass: SideEffectClass,
  fingerprint: ActionFingerprint,
  reasonCodes: BoundedReasonCodes,
  explanation: BoundedExplanation,
  requiresApproval: Schema.Boolean,
  approvalId: Schema.optional(ActionApprovalId),
});
export type ActionGateDecision = typeof ActionGateDecision.Type;

export const ActionApprovalRecord = Schema.Struct({
  approvalId: ActionApprovalId,
  actionId: ActionId,
  fingerprint: ActionFingerprint,
  planId: BoundedId,
  environmentId: EnvironmentId,
  serverId: BoundedSlug,
  toolId: BoundedSlug,
  argumentDigest: BoundedHash,
  policyVersion: ActionGatePolicyVersion,
  reusePolicy: ActionApprovalReusePolicy,
  status: ActionApprovalStatus,
  scope: BoundedSlug,
  createdAt: BoundedIso,
  expiresAt: BoundedIso,
  decidedAt: Schema.optional(BoundedIso),
  consumedAt: Schema.optional(BoundedIso),
  idempotencyKey: Schema.optional(ActionIdempotencyKey),
  reasonCodes: BoundedReasonCodes,
});
export type ActionApprovalRecord = typeof ActionApprovalRecord.Type;

export const ACTION_AUDIT_EVENT_KINDS = [
  "plan.created",
  "skill.routed",
  "mcp.routed",
  "action.gate.decided",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "approval.expired",
  "approval.cancelled",
  "approval.consumed",
  "action.started",
  "action.succeeded",
  "action.failed",
  "action.interrupted",
  "action.retry",
  "action.fallback",
  "action.circuit_breaker",
] as const;
export const ActionAuditEventKind = Schema.Literals(ACTION_AUDIT_EVENT_KINDS);
export type ActionAuditEventKind = typeof ActionAuditEventKind.Type;

export const ACTION_OUTCOME_CLASSES = [
  "success",
  "failure",
  "interrupted",
  "denied",
  "cancelled",
  "timeout",
  "circuit_open",
] as const;
export const ActionOutcomeClass = Schema.Literals(ACTION_OUTCOME_CLASSES);
export type ActionOutcomeClass = typeof ActionOutcomeClass.Type;

export const ActionAuditEventV0 = Schema.Struct({
  eventId: BoundedId,
  kind: ActionAuditEventKind,
  at: BoundedIso,
  environmentId: EnvironmentId,
  planId: BoundedId,
  actionId: Schema.optional(ActionId),
  decision: Schema.optional(ActionGateDecisionKind),
  outcome: Schema.optional(ActionOutcomeClass),
  reasonCodes: BoundedReasonCodes,
  fingerprint: Schema.optional(ActionFingerprint),
  policyVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  cost: ModelRouterMetricValue,
});
export type ActionAuditEventV0 = typeof ActionAuditEventV0.Type;

export const ActionGovernanceSnapshotV0 = Schema.Struct({
  environmentId: EnvironmentId,
  policyVersion: ActionGatePolicyVersion,
  configuredSkillCount: NonNegativeInt,
  enabledSkillCount: NonNegativeInt,
  configuredMcpServerCount: NonNegativeInt,
  enabledMcpServerCount: NonNegativeInt,
  degradedMcpServerCount: NonNegativeInt,
  pendingApprovalCount: NonNegativeInt,
  deniedCount: NonNegativeInt,
  expiredCount: NonNegativeInt,
  recentOutcomes: Schema.Array(ActionOutcomeClass).check(Schema.isMaxLength(32)),
  preventedUnsafeCount: NonNegativeInt,
  knownCostUsd: ModelRouterMetricValue,
  estimatedCostUsd: ModelRouterMetricValue,
  compliance: Schema.Literals(["compliant", "attention", "unknown"]),
});
export type ActionGovernanceSnapshotV0 = typeof ActionGovernanceSnapshotV0.Type;

export const ActionGateRespondApprovalRequest = Schema.Struct({
  approvalId: ActionApprovalId,
  decision: Schema.Literals(["grant", "deny", "cancel"]),
  idempotencyKey: Schema.optional(ActionIdempotencyKey),
});
export type ActionGateRespondApprovalRequest = typeof ActionGateRespondApprovalRequest.Type;

export const ActionGateRespondApprovalResult = Schema.Struct({
  approval: ActionApprovalRecord,
});
export type ActionGateRespondApprovalResult = typeof ActionGateRespondApprovalResult.Type;

export class ActionGateError extends Schema.TaggedError<ActionGateError>()("ActionGateError", {
  reason: Schema.Literals([
    "not_found",
    "expired",
    "replay",
    "conflict",
    "invalid",
    "unauthorized",
  ]),
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
}) {
  override get message(): string {
    return `ActionGate failed (${this.reason}): ${this.detail}`;
  }
}

export class McpActionGateBlockedError extends Schema.TaggedError<McpActionGateBlockedError>()(
  "McpActionGateBlockedError",
  {
    toolName: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    decision: ActionGateDecisionKind,
    reasonCodes: BoundedReasonCodes,
    approvalId: Schema.optional(ActionApprovalId),
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
