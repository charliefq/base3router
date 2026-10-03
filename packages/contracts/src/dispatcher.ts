import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  TaskHandoffId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ExecutionPlanV0 } from "./executionPlan.ts";
import { McpRouterDecision } from "./mcpRouter.ts";
import { ModelRouterDecision } from "./modelRouter.ts";
import { OpenRouterTeacherObservationV0 } from "./openRouter.ts";
import { HybridRouteDecisionV1 } from "./routerEvaluation.ts";
import { SkillRouterDecision } from "./skillRouter.ts";

export const DISPATCHER_POLICY_VERSION = "dispatcher.phase-1a.v1" as const;
export const DISPATCHER_MAX_CANDIDATES = 32;
export const DISPATCHER_HANDOFF_MAX_PACKET_CHARS = 16_000;
const DISPATCHER_HANDOFF_MAX_REFERENCES = 32;

const BoundedEnvironmentId = EnvironmentId.check(Schema.isMaxLength(256));
const BoundedProjectId = ProjectId.check(Schema.isMaxLength(256));
const BoundedThreadId = ThreadId.check(Schema.isMaxLength(256));
const BoundedMessageId = MessageId.check(Schema.isMaxLength(256));
const BoundedTurnId = TurnId.check(Schema.isMaxLength(256));
const BoundedTaskHandoffId = TaskHandoffId.check(Schema.isMaxLength(256));
const BoundedWorkspaceRoot = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const BoundedModel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedModelFamily = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedHandoffFact = Schema.String.check(Schema.isMaxLength(4_000));
const BoundedHandoffPacketText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DISPATCHER_HANDOFF_MAX_PACKET_CHARS),
);

export const DispatcherPolicyVersion = Schema.Literal(DISPATCHER_POLICY_VERSION);
export type DispatcherPolicyVersion = typeof DispatcherPolicyVersion.Type;

export const DISPATCHER_REASON_CODES = [
  "ACTION_ALLOWED",
  "ENVIRONMENT_MISMATCH",
  "PROJECT_SELECTOR_REQUIRED",
  "THREAD_NOT_FOUND",
  "THREAD_DELETED",
  "PROJECT_NOT_FOUND",
  "PROJECT_DELETED",
  "PROJECT_AMBIGUOUS",
  "PROJECT_MISMATCH",
  "MESSAGE_NOT_FOUND",
  "NO_ROUTE_CANDIDATES",
  "PROVIDER_INSTANCE_NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_DISABLED",
  "PROVIDER_NOT_INSTALLED",
  "PROVIDER_UNAUTHENTICATED",
  "PROVIDER_ERROR",
  "MODEL_NOT_FOUND",
] as const;
export const DispatcherReasonCode = Schema.Literals(DISPATCHER_REASON_CODES);
export type DispatcherReasonCode = typeof DispatcherReasonCode.Type;

const DispatcherReasonCodes = Schema.Array(DispatcherReasonCode).check(Schema.isMaxLength(16));

export const DispatcherActionKind = Schema.Literals(["read", "workspace-write", "host-operation"]);
export type DispatcherActionKind = typeof DispatcherActionKind.Type;

export const DispatcherRouteTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: BoundedModel,
});
export type DispatcherRouteTarget = typeof DispatcherRouteTarget.Type;

export const DispatcherRouteCandidateSource = Schema.Literals([
  "explicit",
  "thread",
  "project-default",
  "environment-default",
  "provider-default",
]);
export type DispatcherRouteCandidateSource = typeof DispatcherRouteCandidateSource.Type;

export const DispatcherRouteCandidate = Schema.Struct({
  fallbackIndex: NonNegativeInt,
  target: DispatcherRouteTarget,
  driver: Schema.NullOr(ProviderDriverKind),
  modelFamily: BoundedModelFamily,
  source: DispatcherRouteCandidateSource,
  eligible: Schema.Boolean,
  reasonCodes: DispatcherReasonCodes,
});
export type DispatcherRouteCandidate = typeof DispatcherRouteCandidate.Type;

export const DispatcherProjectResolutionSource = Schema.Literals([
  "thread",
  "project-id",
  "workspace-root",
  "none",
]);
export type DispatcherProjectResolutionSource = typeof DispatcherProjectResolutionSource.Type;

export const DispatcherProjectResolution = Schema.Struct({
  status: Schema.Literals(["resolved", "rejected"]),
  source: DispatcherProjectResolutionSource,
  projectId: Schema.NullOr(ProjectId),
  reasonCodes: DispatcherReasonCodes,
});
export type DispatcherProjectResolution = typeof DispatcherProjectResolution.Type;

export const DispatcherContextSummary = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  hasPersistedMessage: Schema.Boolean,
  attachmentCount: NonNegativeInt,
  composerContextKinds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(200)),
});
export type DispatcherContextSummary = typeof DispatcherContextSummary.Type;

export const ActionGateResult = Schema.Struct({
  decision: Schema.Literals(["ALLOW", "DENY"]),
  reasonCodes: DispatcherReasonCodes,
});
export type ActionGateResult = typeof ActionGateResult.Type;

/**
 * The compact, non-sensitive route fact persisted for one turn-start task.
 * The message id that owns the binding lives beside this value in the event
 * and projection key, so the binding cannot be copied to another task by
 * changing an embedded identifier.
 */
export const DispatcherTaskRouteBinding = Schema.Struct({
  policyVersion: DispatcherPolicyVersion,
  target: DispatcherRouteTarget,
  driver: ProviderDriverKind,
  modelFamily: BoundedModelFamily,
  fallbackIndex: NonNegativeInt,
  source: DispatcherRouteCandidateSource,
  gate: ActionGateResult,
  modelRoute: Schema.optional(ModelRouterDecision),
  /** Phase 10 sanitized OpenRouter observation. Absent on pre-Phase-10 bindings. */
  openRouter: Schema.optional(OpenRouterTeacherObservationV0),
  /** Phase 11 Hybrid / policy-shadow decision. Absent on pre-Phase-11 bindings. */
  hybrid: Schema.optional(HybridRouteDecisionV1),
  /** Phase 12 Skill Router decision. Absent on pre-Phase-12 bindings. */
  skillRoute: Schema.optional(SkillRouterDecision),
  /** Phase 12 MCP Router decision. Absent on pre-Phase-12 bindings. */
  mcpRoute: Schema.optional(McpRouterDecision),
  /** Phase 12 immutable execution plan. Absent on pre-Phase-12 bindings. */
  executionPlan: Schema.optional(ExecutionPlanV0),
});
export type DispatcherTaskRouteBinding = typeof DispatcherTaskRouteBinding.Type;

/** The latest persisted task binding projected onto a thread for client display. */
export const DispatcherTaskRouteSnapshot = Schema.Struct({
  messageId: MessageId,
  binding: DispatcherTaskRouteBinding,
});
export type DispatcherTaskRouteSnapshot = typeof DispatcherTaskRouteSnapshot.Type;

export const DispatcherHandoffReference = Schema.Struct({
  kind: Schema.Literals(["message", "file"]),
  value: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type DispatcherHandoffReference = typeof DispatcherHandoffReference.Type;

export const DispatcherHandoffPacket = Schema.Struct({
  originalObjective: BoundedHandoffFact,
  latestUserInstruction: BoundedHandoffFact,
  branch: BoundedHandoffFact,
  commit: BoundedHandoffFact,
  completedWork: BoundedHandoffFact,
  remainingSteps: BoundedHandoffFact,
  testResults: BoundedHandoffFact,
  references: Schema.Array(DispatcherHandoffReference).check(
    Schema.isMaxLength(DISPATCHER_HANDOFF_MAX_REFERENCES),
  ),
});
export type DispatcherHandoffPacket = typeof DispatcherHandoffPacket.Type;

export const DISPATCHER_HANDOFF_UNAVAILABLE_REASON_CODES = [
  "DISPATCHER_DISABLED",
  "SOURCE_TURN_NOT_FOUND",
  "SOURCE_TURN_NOT_SETTLED",
  "SOURCE_SESSION_ACTIVE",
  "SOURCE_ROUTE_NOT_FOUND",
  "TARGET_SAME_AS_SOURCE",
  "TARGET_RUNNER_UNAVAILABLE",
  "HANDOFF_ALREADY_EXISTS",
] as const;
export const DispatcherHandoffUnavailableReasonCode = Schema.Literals(
  DISPATCHER_HANDOFF_UNAVAILABLE_REASON_CODES,
);
export type DispatcherHandoffUnavailableReasonCode =
  typeof DispatcherHandoffUnavailableReasonCode.Type;

export const DispatcherHandoffAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reasonCode: DispatcherHandoffUnavailableReasonCode,
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
]);
export type DispatcherHandoffAvailability = typeof DispatcherHandoffAvailability.Type;

export const DispatcherHandoffPreviewRequest = Schema.Struct({
  environmentId: BoundedEnvironmentId,
  threadId: BoundedThreadId,
  sourceTurnId: BoundedTurnId,
  target: DispatcherRouteTarget,
});
export type DispatcherHandoffPreviewRequest = typeof DispatcherHandoffPreviewRequest.Type;

export const DispatcherHandoffPreview = Schema.Struct({
  handoffId: BoundedTaskHandoffId,
  packet: DispatcherHandoffPacket,
  packetText: BoundedHandoffPacketText,
  route: Schema.NullOr(Schema.suspend(() => DispatcherRouteDecision)),
  availability: DispatcherHandoffAvailability,
});
export type DispatcherHandoffPreview = typeof DispatcherHandoffPreview.Type;

export const DispatcherHandoffTurnStartRequest = Schema.Struct({
  handoffId: BoundedTaskHandoffId,
  sourceTurnId: BoundedTurnId,
  target: DispatcherRouteTarget,
  packetText: BoundedHandoffPacketText,
});
export type DispatcherHandoffTurnStartRequest = typeof DispatcherHandoffTurnStartRequest.Type;

export const DispatcherTaskHandoff = Schema.Struct({
  handoffId: TaskHandoffId,
  sourceTurnId: TurnId,
  target: DispatcherRouteTarget,
});
export type DispatcherTaskHandoff = typeof DispatcherTaskHandoff.Type;

export const DispatcherTaskHandoffStatus = Schema.Literals(["creating", "failed", "continued"]);
export type DispatcherTaskHandoffStatus = typeof DispatcherTaskHandoffStatus.Type;

export const DispatcherTaskHandoffSnapshot = Schema.Struct({
  handoffId: TaskHandoffId,
  sourceTurnId: TurnId,
  destinationMessageId: MessageId,
  destinationTurnId: Schema.NullOr(TurnId),
  target: DispatcherRouteTarget,
  status: DispatcherTaskHandoffStatus,
  failureReason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type DispatcherTaskHandoffSnapshot = typeof DispatcherTaskHandoffSnapshot.Type;

export const DispatcherRoutePreviewRequest = Schema.Struct({
  environmentId: BoundedEnvironmentId,
  threadId: Schema.optional(BoundedThreadId),
  projectId: Schema.optional(BoundedProjectId),
  workspaceRoot: Schema.optional(BoundedWorkspaceRoot),
  messageId: Schema.optional(BoundedMessageId),
  preferredRoute: Schema.optional(DispatcherRouteTarget),
  actionKind: DispatcherActionKind,
}).check(
  Schema.makeFilter(
    (request) =>
      (request.threadId !== undefined ||
        request.projectId !== undefined ||
        request.workspaceRoot !== undefined) &&
      (request.messageId === undefined || request.threadId !== undefined),
    {
      message: "A project selector is required, and messageId requires threadId.",
    },
  ),
);
export type DispatcherRoutePreviewRequest = typeof DispatcherRoutePreviewRequest.Type;

export const DispatcherRouteDecision = Schema.Struct({
  policyVersion: DispatcherPolicyVersion,
  environmentId: EnvironmentId,
  actionKind: DispatcherActionKind,
  projectResolution: DispatcherProjectResolution,
  context: DispatcherContextSummary,
  candidates: Schema.Array(DispatcherRouteCandidate).check(
    Schema.isMaxLength(DISPATCHER_MAX_CANDIDATES),
  ),
  selected: Schema.NullOr(DispatcherRouteCandidate),
  gate: ActionGateResult,
});
export type DispatcherRouteDecision = typeof DispatcherRouteDecision.Type;

export class DispatcherPreviewError extends Schema.TaggedError<DispatcherPreviewError>()(
  "DispatcherPreviewError",
  {
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  },
) {}

export class DispatcherHandoffPreviewError extends Schema.TaggedError<DispatcherHandoffPreviewError>()(
  "DispatcherHandoffPreviewError",
  {
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  },
) {}
