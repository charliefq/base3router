/**
 * Immutable execution-plan contracts (Phase 12).
 *
 * The plan is the authorization input. Argument values are stored only as a
 * canonical digest. A mutation of tool, arguments, server, schema, route,
 * policy, or material scope invalidates existing approvals.
 *
 * @module executionPlan
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  ActionFingerprint,
  ActionGateDecision,
  ActionId,
  ActionRiskClass,
  SideEffectClass,
} from "./actionGate.ts";
import { McpNamespacedToolId, McpRouterDecision, McpServerId } from "./mcpRouter.ts";
import { SkillId, SkillRouterDecision } from "./skillRouter.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const EXECUTION_PLAN_VERSION = "execution-plan.v0" as const;
export const ExecutionPlanVersion = Schema.Literal(EXECUTION_PLAN_VERSION);
export type ExecutionPlanVersion = typeof ExecutionPlanVersion.Type;

export const ExecutionPlanId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ExecutionPlanId"),
);
export type ExecutionPlanId = typeof ExecutionPlanId.Type;

const BoundedSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedHash = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedPolicy = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const PlannedActionV0 = Schema.Struct({
  actionId: ActionId,
  serverId: McpServerId,
  toolId: McpNamespacedToolId,
  argumentDigest: BoundedHash,
  schemaDigest: BoundedHash,
  riskClass: ActionRiskClass,
  sideEffectClass: SideEffectClass,
  fingerprint: ActionFingerprint,
  requiresApproval: Schema.Boolean,
  gate: Schema.optional(ActionGateDecision),
});
export type PlannedActionV0 = typeof PlannedActionV0.Type;

export const ExecutionPlanModelSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: BoundedSlug,
  policyVersion: BoundedPolicy,
});
export type ExecutionPlanModelSummary = typeof ExecutionPlanModelSummary.Type;

export const ExecutionPlanV0 = Schema.Struct({
  planVersion: ExecutionPlanVersion,
  planId: ExecutionPlanId,
  turnId: TurnId,
  threadId: ThreadId,
  projectId: ProjectId,
  environmentId: EnvironmentId,
  modelRoute: Schema.NullOr(ExecutionPlanModelSummary),
  skillIds: Schema.Array(SkillId).check(Schema.isMaxLength(8)),
  skillRoute: SkillRouterDecision,
  mcpRoute: McpRouterDecision,
  actions: Schema.Array(PlannedActionV0).check(Schema.isMaxLength(32)),
  policyVersions: Schema.Array(BoundedPolicy).check(Schema.isMaxLength(16)),
  descriptorVersions: Schema.Array(BoundedPolicy).check(Schema.isMaxLength(16)),
  provenance: BoundedHash,
  createdAt: BoundedIso,
  expiresAt: Schema.optional(BoundedIso),
});
export type ExecutionPlanV0 = typeof ExecutionPlanV0.Type;
