import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const DISPATCHER_POLICY_VERSION = "dispatcher.phase-1a.v1" as const;
export const DISPATCHER_MAX_CANDIDATES = 32;

const BoundedEnvironmentId = EnvironmentId.check(Schema.isMaxLength(256));
const BoundedProjectId = ProjectId.check(Schema.isMaxLength(256));
const BoundedThreadId = ThreadId.check(Schema.isMaxLength(256));
const BoundedMessageId = MessageId.check(Schema.isMaxLength(256));
const BoundedWorkspaceRoot = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const BoundedModel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedModelFamily = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

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
