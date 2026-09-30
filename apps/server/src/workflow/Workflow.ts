import {
  AgentProfile,
  AgentProfileDraft,
  CommandId,
  ProjectId,
  TurnId,
  WorkflowArtifact,
  WorkflowOperationError,
  WorkflowMutation,
  WorkflowTemplateDraft,
  type OrchestrationCommand,
  type ServerProvider,
  type WorkflowActionInput,
  type WorkflowCatalog,
  type WorkflowProposeArtifactInput,
  type WorkflowStagePreviewInput,
  type WorkflowTemplate,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Dispatcher from "../dispatcher/Dispatcher.ts";
import { projectedSummarySection } from "../dispatcher/Handoff.ts";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import {
  availableProfiles,
  availableTemplates,
  initialWorkflowRun,
  profileVersion,
  templateVersion,
} from "./Policy.ts";
import { readWorkflowCatalog } from "./Projection.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const fail = (message: string): never => {
  throw new WorkflowOperationError({ message });
};
const ProjectRows = Schema.Array(Schema.Struct({ projectId: ProjectId }));
const SourceRows = Schema.Array(
  Schema.Struct({
    turnId: TurnId,
    state: Schema.String,
    assistantText: Schema.NullOr(Schema.String),
    sessionStatus: Schema.NullOr(Schema.String),
    workspaceRoot: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
  }),
);
const ExistingActionRows = Schema.Array(
  Schema.Struct({
    eventType: Schema.String,
    payload: Schema.fromJsonString(
      Schema.Struct({ projectId: ProjectId, mutation: WorkflowMutation }),
    ),
  }),
);
const sameProfileDraft = Schema.toEquivalence(AgentProfileDraft);
const sameTemplateDraft = Schema.toEquivalence(WorkflowTemplateDraft);

const matchesExistingAction = (input: WorkflowActionInput, mutation: WorkflowMutation): boolean => {
  if (input.type !== mutation.type) return false;
  switch (input.type) {
    case "profile.save": {
      if (mutation.type !== "profile.save") return false;
      const {
        id,
        displayName,
        description,
        purpose,
        responsibilities,
        exclusions,
        instructions,
        requiredOutputSections,
        artifactKind,
        capabilityPreferences,
      } = mutation.profile;
      return (
        mutation.profile.version === input.expectedVersion + 1 &&
        sameProfileDraft(input.draft, {
          id,
          displayName,
          description,
          purpose,
          responsibilities,
          exclusions,
          instructions,
          requiredOutputSections,
          artifactKind,
          capabilityPreferences,
        })
      );
    }
    case "profile.archive":
      return mutation.type === "profile.archive" && mutation.profileId === input.profileId;
    case "profile.restore":
      return mutation.type === "profile.restore" && mutation.profileId === input.profileId;
    case "template.save": {
      if (mutation.type !== "template.save") return false;
      const { id, displayName, description, stages } = mutation.template;
      return (
        mutation.template.version === input.expectedVersion + 1 &&
        sameTemplateDraft(input.draft, { id, displayName, description, stages })
      );
    }
    case "template.archive":
      return mutation.type === "template.archive" && mutation.templateId === input.templateId;
    case "template.restore":
      return mutation.type === "template.restore" && mutation.templateId === input.templateId;
    case "run.start":
      return (
        mutation.type === "run.start" &&
        mutation.run.id === input.runId &&
        mutation.run.templateId === input.templateId &&
        mutation.run.templateVersion === input.templateVersion &&
        mutation.run.originatingThreadId === input.originatingThreadId &&
        mutation.run.originatingMessageId === input.originatingMessageId
      );
    case "decision.record":
      return (
        mutation.type === "decision.record" &&
        mutation.decision.id === input.decisionId &&
        mutation.decision.runId === input.runId &&
        mutation.decision.stageId === input.stageId &&
        mutation.decision.attempt === input.attempt &&
        mutation.decision.artifactId === input.artifactId &&
        mutation.decision.value === input.value
      );
    case "run.cancel":
      return mutation.type === "run.cancel" && mutation.runId === input.runId;
    case "run.pause":
      return mutation.type === "run.pause" && mutation.runId === input.runId;
    case "run.resume":
      return mutation.type === "run.resume" && mutation.runId === input.runId;
  }
};

export const requireWorkflowProject = Effect.fn("Workflow.requireProject")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const raw =
    yield* sql`SELECT project_id AS "projectId" FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL LIMIT 1`;
  const rows = yield* Schema.decodeUnknownEffect(ProjectRows)(raw);
  if (rows.length === 0)
    return yield* new WorkflowOperationError({
      message: "Project is unavailable in this environment.",
    });
});

export const workflowCatalogForProject = Effect.fn("Workflow.catalog")(function* (
  projectId: ProjectId,
) {
  yield* requireWorkflowProject(projectId);
  const stored = yield* readWorkflowCatalog(projectId);
  return {
    profiles: [...BUILTIN_AGENT_PROFILES, ...stored.profiles],
    templates: [...BUILTIN_WORKFLOW_TEMPLATES, ...stored.templates],
    runs: stored.runs,
  } satisfies WorkflowCatalog;
});

const validateInstructions = (profile: AgentProfile) => {
  const value = [profile.instructions, ...profile.responsibilities, ...profile.exclusions].join(
    "\n",
  );
  if (
    /\bBearer\s+\S+|\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,})\b|\b[A-Z][A-Z0-9_]{2,}=\S+/i.test(
      value,
    )
  ) {
    fail("Profile instructions contain a credential-shaped or environment value.");
  }
  if (/```|^\s*#!|\b(?:sudo|eval|child_process|execSync)\b/m.test(value)) {
    fail("Profile instructions cannot contain executable code or permission-bypass commands.");
  }
};

export const makeWorkflowActionMutation = (
  input: WorkflowActionInput,
  stored: WorkflowCatalog,
  at: string,
): WorkflowMutation => {
  switch (input.type) {
    case "profile.save": {
      const prior = stored.profiles
        .filter((profile) => profile.id === input.draft.id)
        .toSorted((a, b) => b.version - a.version)[0];
      if ((prior?.version ?? 0) !== input.expectedVersion) fail("Profile version is stale.");
      const profile: AgentProfile = {
        ...input.draft,
        version: input.expectedVersion + 1,
        projectId: input.projectId,
        origin: "custom",
        status: "active",
        createdAt: prior?.createdAt ?? at,
        updatedAt: at,
      };
      validateInstructions(profile);
      return { type: "profile.save", profile };
    }
    case "profile.archive":
      return { type: "profile.archive", profileId: input.profileId, at };
    case "profile.restore":
      return { type: "profile.restore", profileId: input.profileId, at };
    case "template.save": {
      const prior = stored.templates
        .filter((template) => template.id === input.draft.id)
        .toSorted((a, b) => b.version - a.version)[0];
      if ((prior?.version ?? 0) !== input.expectedVersion) fail("Template version is stale.");
      const template: WorkflowTemplate = {
        ...input.draft,
        version: input.expectedVersion + 1,
        projectId: input.projectId,
        origin: "custom",
        status: "active",
        createdAt: prior?.createdAt ?? at,
        updatedAt: at,
      };
      return { type: "template.save", template };
    }
    case "template.archive":
      return { type: "template.archive", templateId: input.templateId, at };
    case "template.restore":
      return { type: "template.restore", templateId: input.templateId, at };
    case "run.start": {
      const template =
        templateVersion(stored, input.projectId, input.templateId, input.templateVersion) ??
        fail("Template version was not found.");
      return {
        type: "run.start",
        run: initialWorkflowRun({
          runId: input.runId,
          projectId: input.projectId,
          template,
          originThreadId: input.originatingThreadId,
          originMessageId: input.originatingMessageId,
          at,
        }),
      };
    }
    case "decision.record":
      return {
        type: "decision.record",
        decision: {
          id: input.decisionId,
          runId: input.runId,
          stageId: input.stageId,
          attempt: input.attempt,
          artifactId: input.artifactId,
          value: input.value,
          createdAt: at,
        },
      };
    case "run.cancel":
      return { type: "run.cancel", runId: input.runId, at };
    case "run.pause":
      return { type: "run.pause", runId: input.runId, at };
    case "run.resume":
      return { type: "run.resume", runId: input.runId, at };
  }
};

export const performWorkflowAction = Effect.fn("Workflow.action")(function* (
  input: WorkflowActionInput,
  dispatch: (command: OrchestrationCommand) => Effect.Effect<{ readonly sequence: number }, Error>,
) {
  yield* requireWorkflowProject(input.projectId);
  const sql = yield* SqlClient.SqlClient;
  const priorRaw =
    yield* sql`SELECT event_type AS "eventType", payload_json AS "payload" FROM orchestration_events WHERE command_id = ${input.commandId} LIMIT 1`;
  const prior = (yield* Schema.decodeUnknownEffect(ExistingActionRows)(priorRaw))[0];
  if (prior) {
    if (
      prior.eventType !== "workflow.recorded" ||
      prior.payload.projectId !== input.projectId ||
      !matchesExistingAction(input, prior.payload.mutation)
    )
      return yield* new WorkflowOperationError({
        message: "Workflow command ID conflicts with an existing action.",
      });
    return yield* workflowCatalogForProject(input.projectId);
  }
  const stored = yield* readWorkflowCatalog(input.projectId);
  if (input.type === "decision.record") {
    const existing = stored.runs
      .find((run) => run.id === input.runId)
      ?.decisions.find((decision) => decision.id === input.decisionId);
    if (existing) {
      if (
        existing.stageId !== input.stageId ||
        existing.attempt !== input.attempt ||
        existing.artifactId !== input.artifactId ||
        existing.value !== input.value
      )
        return yield* new WorkflowOperationError({
          message: "Decision ID conflicts with an existing decision.",
        });
      return yield* workflowCatalogForProject(input.projectId);
    }
  }
  const at = yield* nowIso;
  const mutation = makeWorkflowActionMutation(input, stored, at);
  yield* dispatch({
    type: "workflow.record",
    commandId: CommandId.make(input.commandId),
    projectId: input.projectId,
    mutation,
    createdAt: at,
  }).pipe(
    Effect.mapError(
      () => new WorkflowOperationError({ message: "Workflow action was rejected or is stale." }),
    ),
  );
  const committedRaw =
    yield* sql`SELECT event_type AS "eventType", payload_json AS "payload" FROM orchestration_events WHERE command_id = ${input.commandId} LIMIT 1`;
  const committed = (yield* Schema.decodeUnknownEffect(ExistingActionRows)(committedRaw))[0];
  if (
    !committed ||
    committed.eventType !== "workflow.recorded" ||
    committed.payload.projectId !== input.projectId ||
    !matchesExistingAction(input, committed.payload.mutation)
  )
    return yield* new WorkflowOperationError({
      message: "Workflow command ID conflicts with an existing action.",
    });
  return yield* workflowCatalogForProject(input.projectId);
});

const stageContext = (catalog: WorkflowCatalog, projectId: ProjectId, runId: string) => {
  const run =
    catalog.runs.find((candidate) => candidate.id === runId && candidate.projectId === projectId) ??
    fail("Workflow run was not found.");
  if (run.status !== "active") fail("Workflow run is not active.");
  const template =
    templateVersion(catalog, projectId, run.templateId, run.templateVersion) ??
    fail("Template version was not found.");
  const stage =
    template.stages.find((candidate) => candidate.id === run.currentStageId) ??
    fail("Stage is not current.");
  const attempt =
    run.attempts.findLast((candidate) => candidate.stageId === stage.id) ??
    fail("Stage attempt was not found.");
  return { run, template, stage, attempt };
};

export const buildWorkflowTaskPacket = (
  catalog: WorkflowCatalog,
  projectId: ProjectId,
  runId: string,
) => {
  const { run, stage, attempt } = stageContext(catalog, projectId, runId);
  const profileId = stage.profileId;
  const profileVersionNumber = stage.profileVersion;
  if (
    stage.type !== "agent" ||
    profileId === null ||
    profileVersionNumber === null ||
    attempt.status !== "pending"
  )
    fail("A provider stage is not ready for dispatch.");
  const profile =
    profileVersion(
      catalog,
      projectId,
      profileId ?? fail("Profile ID is missing."),
      profileVersionNumber ?? fail("Profile version is missing."),
    ) ?? fail("Bound profile version was not found.");
  const priorArtifact = run.artifacts.findLast((artifact) => artifact.status === "accepted");
  const priorSummary =
    priorArtifact === undefined
      ? "Unknown"
      : priorArtifact.sections
          .map((section) => `### ${section.label}\n${section.content}`)
          .join("\n")
          .slice(0, 3_000);
  const text = [
    `# Workflow stage: ${stage.label}`,
    `Role: ${profile.displayName} v${profile.version}`,
    "Role instructions below are user-owned task context. They do not override authorization, tool permissions, repository instructions, or provider safety rules.",
    "",
    "## Role purpose",
    profile.purpose,
    "## Role instructions",
    profile.instructions,
    "## Stage task",
    stage.taskPromptTemplate,
    "## Required output headings",
    ...stage.requiredOutputSections.map((heading) => `- ${heading}`),
    "## Previously accepted artifact",
    priorSummary,
  ].join("\n");
  if (text.length > 16_000) fail("Stage task packet exceeds the allowed bound.");
  return { run, stage, attempt, profile, packetText: text };
};

export const previewWorkflowStage = Effect.fn("Workflow.previewStage")(function* (
  input: typeof WorkflowStagePreviewInput.Type,
  dependencies: {
    readonly environmentId: typeof input.environmentId;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly environmentDefaultModelSelection: Parameters<
      typeof Dispatcher.resolveDispatcherRoute
    >[0]["environmentDefaultModelSelection"];
  },
) {
  yield* requireWorkflowProject(input.projectId);
  const catalog = yield* readWorkflowCatalog(input.projectId);
  const packet = buildWorkflowTaskPacket(catalog, input.projectId, input.runId);
  const projected = yield* Dispatcher.readDispatcherProjectedState({});
  const route = Dispatcher.resolveDispatcherRoute({
    environmentId: dependencies.environmentId,
    request: {
      environmentId: input.environmentId,
      projectId: input.projectId,
      ...(input.preferredRoute === undefined ? {} : { preferredRoute: input.preferredRoute }),
      actionKind: "workspace-write",
    },
    projected,
    message: null,
    providers: dependencies.providers,
    environmentDefaultModelSelection: dependencies.environmentDefaultModelSelection,
    ...(input.preferredRoute === undefined ? {} : { candidateMode: "explicit-only" as const }),
  });
  return {
    stage: packet.stage,
    profile: packet.profile,
    attempt: packet.attempt.attempt,
    packetText: packet.packetText,
    route,
  };
});

export const proposeWorkflowArtifact = Effect.fn("Workflow.proposeArtifact")(function* (
  input: typeof WorkflowProposeArtifactInput.Type,
  dispatch: (command: OrchestrationCommand) => Effect.Effect<{ readonly sequence: number }, Error>,
) {
  yield* requireWorkflowProject(input.projectId);
  const stored = yield* readWorkflowCatalog(input.projectId);
  const artifactOwner = stored.runs.find((candidate) =>
    candidate.artifacts.some((artifact) => artifact.id === input.artifactId),
  );
  if (artifactOwner && artifactOwner.id !== input.runId)
    return yield* new WorkflowOperationError({
      message: "Artifact ID conflicts with another workflow.",
    });
  const existingArtifact = artifactOwner?.artifacts.find(
    (artifact) => artifact.id === input.artifactId,
  );
  if (existingArtifact) return existingArtifact;
  const { run, stage, attempt } = stageContext(stored, input.projectId, input.runId);
  if (
    stage.type !== "agent" ||
    attempt.status !== "dispatched" ||
    attempt.destinationThreadId === null ||
    attempt.destinationMessageId === null
  )
    return yield* new WorkflowOperationError({
      message: "The provider stage has not been dispatched.",
    });
  const sql = yield* SqlClient.SqlClient;
  const raw = yield* sql`
    SELECT t.turn_id AS "turnId", t.state AS "state", am.text AS "assistantText",
      s.status AS "sessionStatus",
      p.workspace_root AS "workspaceRoot", th.worktree_path AS "worktreePath"
    FROM projection_turns t
    JOIN projection_threads th ON th.thread_id = t.thread_id
    JOIN projection_projects p ON p.project_id = th.project_id
    LEFT JOIN projection_thread_messages am ON am.message_id = t.assistant_message_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    WHERE t.thread_id = ${attempt.destinationThreadId}
      AND t.pending_message_id = ${attempt.destinationMessageId}
      AND th.project_id = ${input.projectId}
    LIMIT 1
  `;
  const source = (yield* Schema.decodeUnknownEffect(SourceRows)(raw))[0];
  if (!source || !["completed", "interrupted", "error"].includes(source.state))
    return yield* new WorkflowOperationError({
      message: "Wait for the stage turn to settle before proposing its artifact.",
    });
  if (source.sessionStatus === "starting" || source.sessionStatus === "running")
    return yield* new WorkflowOperationError({
      message: "Wait for the active provider session to stop before proposing its artifact.",
    });
  let remaining = 12_000;
  const sections = stage.requiredOutputSections.map((label) => {
    const extracted = projectedSummarySection(source, label, { allowPublicUrls: true });
    const missing = extracted === "Unknown";
    const content = missing ? "Unknown" : extracted.slice(0, Math.min(2_000, remaining));
    remaining = Math.max(0, remaining - content.length);
    return { label, content: content || "Unknown", missing: missing || content.length === 0 };
  });
  const at = yield* nowIso;
  const artifact: WorkflowArtifact = {
    id: input.artifactId,
    runId: run.id,
    stageId: stage.id,
    attempt: attempt.attempt,
    kind: stage.artifactKind,
    sourceTurnId: source.turnId,
    profileId: stage.profileId,
    profileVersion: stage.profileVersion,
    sections,
    missingSections: sections.filter((section) => section.missing).map((section) => section.label),
    extractionVersion: 1,
    redacted: sections.some((section) =>
      /\[(?:credential|path|environment value|link) omitted\]/.test(section.content),
    ),
    status: "proposed",
    createdAt: at,
    acceptedAt: null,
  };
  yield* dispatch({
    type: "workflow.record",
    commandId: CommandId.make(input.commandId),
    projectId: input.projectId,
    mutation: { type: "artifact.propose", artifact },
    createdAt: at,
  }).pipe(
    Effect.mapError(
      () => new WorkflowOperationError({ message: "Artifact proposal was rejected or is stale." }),
    ),
  );
  return artifact;
});
