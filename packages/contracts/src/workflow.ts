import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  DispatcherRouteDecision,
  DispatcherRouteTarget,
  DispatcherTaskRouteBinding,
} from "./dispatcher.ts";
import { EnvironmentId } from "./baseSchemas.ts";

export const WORKFLOW_MAX_STAGES = 12;
export const WORKFLOW_MAX_ATTEMPTS = 5;
export const WORKFLOW_MAX_ARTIFACT_CHARS = 12_000;
export const WORKFLOW_MAX_RECORDS = 1_024;

const Id = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/),
);
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(400));
const Instruction = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
const Version = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));
const Attempt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WORKFLOW_MAX_ATTEMPTS }));
const Sections = Schema.Array(Label).check(Schema.isMinLength(1), Schema.isMaxLength(20));
const BoundedList = Schema.Array(ShortText).check(Schema.isMaxLength(16));

export const AgentProfileId = Id;
export const WorkflowTemplateId = Id;
export const WorkflowStageId = Id;
const RecordId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export const WorkflowRunId = RecordId;
export const WorkflowArtifactId = RecordId;
export const WorkflowDecisionId = RecordId;

export const WorkflowCapabilityPreference = Schema.Literals([
  "web-research",
  "long-context-repository",
  "backend-correctness",
  "ui-implementation",
  "independent-review",
]);

export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  version: Version,
  projectId: Schema.NullOr(ProjectId),
  origin: Schema.Literals(["built-in", "custom"]),
  status: Schema.Literals(["active", "archived"]),
  displayName: Label,
  description: ShortText,
  purpose: ShortText,
  responsibilities: BoundedList,
  exclusions: BoundedList,
  instructions: Instruction,
  requiredOutputSections: Sections,
  artifactKind: Id,
  capabilityPreferences: Schema.Array(WorkflowCapabilityPreference).check(Schema.isMaxLength(5)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentProfile = typeof AgentProfile.Type;

export const WorkflowStage = Schema.Struct({
  id: WorkflowStageId,
  label: Label,
  type: Schema.Literals(["agent", "human_gate", "manual"]),
  profileId: Schema.NullOr(AgentProfileId),
  profileVersion: Schema.NullOr(Version),
  artifactKind: Id,
  requiredOutputSections: Schema.Array(Label).check(Schema.isMaxLength(20)),
  approvalRequired: Schema.Boolean,
  nextStageId: Schema.NullOr(WorkflowStageId),
  capabilityPreferences: Schema.Array(WorkflowCapabilityPreference).check(Schema.isMaxLength(5)),
  taskPromptTemplate: Schema.String.check(Schema.isMaxLength(4_000)),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WORKFLOW_MAX_ATTEMPTS })),
});
export type WorkflowStage = typeof WorkflowStage.Type;

export const WorkflowTemplate = Schema.Struct({
  id: WorkflowTemplateId,
  version: Version,
  projectId: Schema.NullOr(ProjectId),
  origin: Schema.Literals(["built-in", "custom"]),
  status: Schema.Literals(["active", "archived"]),
  displayName: Label,
  description: ShortText,
  stages: Schema.Array(WorkflowStage).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(WORKFLOW_MAX_STAGES),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkflowTemplate = typeof WorkflowTemplate.Type;

export const WorkflowStageAttempt = Schema.Struct({
  stageId: WorkflowStageId,
  attempt: Attempt,
  profileId: Schema.NullOr(AgentProfileId),
  profileVersion: Schema.NullOr(Version),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
  sourceTurnId: Schema.NullOr(TurnId),
  destinationThreadId: Schema.NullOr(ThreadId),
  destinationMessageId: Schema.NullOr(MessageId),
  destinationTurnId: Schema.NullOr(TurnId),
  routeBinding: Schema.NullOr(DispatcherTaskRouteBinding),
  status: Schema.Literals(["pending", "dispatched", "proposed", "accepted", "rejected"]),
  createdAt: IsoDateTime,
});
export type WorkflowStageAttempt = typeof WorkflowStageAttempt.Type;

export const WorkflowArtifactSection = Schema.Struct({
  label: Label,
  content: Schema.String.check(Schema.isMaxLength(2_000)),
  missing: Schema.Boolean,
});
export const WorkflowArtifact = Schema.Struct({
  id: WorkflowArtifactId,
  runId: WorkflowRunId,
  stageId: WorkflowStageId,
  attempt: Attempt,
  kind: Id,
  sourceTurnId: Schema.NullOr(TurnId),
  profileId: Schema.NullOr(AgentProfileId),
  profileVersion: Schema.NullOr(Version),
  sections: Schema.Array(WorkflowArtifactSection).check(Schema.isMaxLength(20)),
  missingSections: Schema.Array(Label).check(Schema.isMaxLength(20)),
  extractionVersion: Schema.Literal(1),
  redacted: Schema.Boolean,
  status: Schema.Literals(["proposed", "accepted"]),
  createdAt: IsoDateTime,
  acceptedAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowArtifact = typeof WorkflowArtifact.Type;

export const WorkflowDecision = Schema.Struct({
  id: WorkflowDecisionId,
  runId: WorkflowRunId,
  stageId: WorkflowStageId,
  attempt: Attempt,
  artifactId: Schema.NullOr(WorkflowArtifactId),
  value: Schema.Literals(["approve", "reject", "request_revision"]),
  createdAt: IsoDateTime,
});
export type WorkflowDecision = typeof WorkflowDecision.Type;

export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  projectId: ProjectId,
  templateId: WorkflowTemplateId,
  templateVersion: Version,
  status: Schema.Literals(["active", "paused", "rejected", "cancelled", "completed"]),
  currentStageId: Schema.NullOr(WorkflowStageId),
  originatingThreadId: Schema.NullOr(ThreadId),
  originatingMessageId: Schema.NullOr(MessageId),
  attempts: Schema.Array(WorkflowStageAttempt).check(Schema.isMaxLength(60)),
  artifacts: Schema.Array(WorkflowArtifact).check(Schema.isMaxLength(60)),
  decisions: Schema.Array(WorkflowDecision).check(Schema.isMaxLength(60)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  pausedAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const WorkflowCatalog = Schema.Struct({
  profiles: Schema.Array(AgentProfile).check(Schema.isMaxLength(WORKFLOW_MAX_RECORDS)),
  templates: Schema.Array(WorkflowTemplate).check(Schema.isMaxLength(WORKFLOW_MAX_RECORDS)),
  runs: Schema.Array(WorkflowRun).check(Schema.isMaxLength(WORKFLOW_MAX_RECORDS)),
});
export type WorkflowCatalog = typeof WorkflowCatalog.Type;

export const WorkflowReadInput = Schema.Struct({ projectId: ProjectId });
export const WorkflowReadRunInput = Schema.Struct({ projectId: ProjectId, runId: WorkflowRunId });

export const AgentProfileDraft = Schema.Struct({
  id: AgentProfileId,
  displayName: AgentProfile.fields.displayName,
  description: AgentProfile.fields.description,
  purpose: AgentProfile.fields.purpose,
  responsibilities: AgentProfile.fields.responsibilities,
  exclusions: AgentProfile.fields.exclusions,
  instructions: AgentProfile.fields.instructions,
  requiredOutputSections: AgentProfile.fields.requiredOutputSections,
  artifactKind: AgentProfile.fields.artifactKind,
  capabilityPreferences: AgentProfile.fields.capabilityPreferences,
});

export const WorkflowTemplateDraft = Schema.Struct({
  id: WorkflowTemplateId,
  displayName: WorkflowTemplate.fields.displayName,
  description: WorkflowTemplate.fields.description,
  stages: WorkflowTemplate.fields.stages,
});

const WorkflowActionBase = {
  projectId: ProjectId,
  commandId: RecordId,
} as const;

export const WorkflowActionInput = Schema.Union([
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("profile.save"),
    expectedVersion: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9_999 })),
    draft: AgentProfileDraft,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("profile.archive"),
    profileId: AgentProfileId,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("profile.restore"),
    profileId: AgentProfileId,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("template.save"),
    expectedVersion: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9_999 })),
    draft: WorkflowTemplateDraft,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("template.archive"),
    templateId: WorkflowTemplateId,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("template.restore"),
    templateId: WorkflowTemplateId,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("run.start"),
    runId: WorkflowRunId,
    templateId: WorkflowTemplateId,
    templateVersion: Version,
    originatingThreadId: Schema.NullOr(ThreadId),
    originatingMessageId: Schema.NullOr(MessageId),
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("decision.record"),
    decisionId: WorkflowDecisionId,
    runId: WorkflowRunId,
    stageId: WorkflowStageId,
    attempt: Attempt,
    artifactId: Schema.NullOr(WorkflowArtifactId),
    value: WorkflowDecision.fields.value,
  }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("run.cancel"),
    runId: WorkflowRunId,
  }),
  Schema.Struct({ ...WorkflowActionBase, type: Schema.Literal("run.pause"), runId: WorkflowRunId }),
  Schema.Struct({
    ...WorkflowActionBase,
    type: Schema.Literal("run.resume"),
    runId: WorkflowRunId,
  }),
]);
export type WorkflowActionInput = typeof WorkflowActionInput.Type;

export const WorkflowStagePreviewInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  runId: WorkflowRunId,
  preferredRoute: Schema.optional(DispatcherRouteTarget),
});
export const WorkflowStagePreview = Schema.Struct({
  stage: WorkflowStage,
  profile: AgentProfile,
  attempt: Attempt,
  packetText: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  route: DispatcherRouteDecision,
});
export type WorkflowStagePreview = typeof WorkflowStagePreview.Type;
export const WorkflowDispatchStageInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  runId: WorkflowRunId,
  stageId: WorkflowStageId,
  attempt: Attempt,
  dispatchId: RecordId.check(Schema.isMaxLength(100)),
  target: DispatcherRouteTarget,
  additionalInstruction: Schema.String.check(Schema.isMaxLength(2_000)),
});
export const WorkflowDispatchStageResult = Schema.Struct({
  run: WorkflowRun,
  threadId: ThreadId,
  messageId: MessageId,
});
export const WorkflowProposeArtifactInput = Schema.Struct({
  projectId: ProjectId,
  runId: WorkflowRunId,
  artifactId: WorkflowArtifactId,
  commandId: RecordId,
});

export const WorkflowStageDispatchMutation = Schema.Struct({
  type: Schema.Literal("stage.dispatch"),
  runId: WorkflowRunId,
  stageId: WorkflowStageId,
  attempt: Attempt,
  threadId: ThreadId,
  messageId: MessageId,
  routeBinding: DispatcherTaskRouteBinding,
  at: IsoDateTime,
});
export type WorkflowStageDispatchMutation = typeof WorkflowStageDispatchMutation.Type;

export const WorkflowMutation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("profile.save"), profile: AgentProfile }),
  Schema.Struct({
    type: Schema.Literal("profile.archive"),
    profileId: AgentProfileId,
    at: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("profile.restore"),
    profileId: AgentProfileId,
    at: IsoDateTime,
  }),
  Schema.Struct({ type: Schema.Literal("template.save"), template: WorkflowTemplate }),
  Schema.Struct({
    type: Schema.Literal("template.archive"),
    templateId: WorkflowTemplateId,
    at: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("template.restore"),
    templateId: WorkflowTemplateId,
    at: IsoDateTime,
  }),
  Schema.Struct({ type: Schema.Literal("run.start"), run: WorkflowRun }),
  WorkflowStageDispatchMutation,
  Schema.Struct({ type: Schema.Literal("artifact.propose"), artifact: WorkflowArtifact }),
  Schema.Struct({ type: Schema.Literal("decision.record"), decision: WorkflowDecision }),
  Schema.Struct({ type: Schema.Literal("run.cancel"), runId: WorkflowRunId, at: IsoDateTime }),
  Schema.Struct({ type: Schema.Literal("run.pause"), runId: WorkflowRunId, at: IsoDateTime }),
  Schema.Struct({ type: Schema.Literal("run.resume"), runId: WorkflowRunId, at: IsoDateTime }),
]);
export type WorkflowMutation = typeof WorkflowMutation.Type;

export const WorkflowMutationRequest = Schema.Struct({
  projectId: ProjectId,
  commandId: RecordId,
  mutation: WorkflowMutation,
});

export class WorkflowOperationError extends Schema.TaggedError<WorkflowOperationError>()(
  "WorkflowOperationError",
  { message: TrimmedNonEmptyString.check(Schema.isMaxLength(400)) },
) {}
