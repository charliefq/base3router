import {
  AgentProfile,
  ProjectId,
  WorkflowArtifact,
  WorkflowCatalog,
  WorkflowDecision,
  WorkflowRun,
  WorkflowStageAttempt,
  WorkflowMutation,
  WorkflowTemplate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { applyWorkflowMutation, emptyWorkflowCatalog } from "./Policy.ts";

const ProfileJson = Schema.fromJsonString(AgentProfile);
const TemplateJson = Schema.fromJsonString(WorkflowTemplate);
const RunJson = Schema.fromJsonString(WorkflowRun);
const AttemptJson = Schema.fromJsonString(WorkflowStageAttempt);
const ArtifactJson = Schema.fromJsonString(WorkflowArtifact);
const DecisionJson = Schema.fromJsonString(WorkflowDecision);
const ProfileRows = Schema.Array(Schema.Struct({ projectId: ProjectId, profile: ProfileJson }));
const TemplateRows = Schema.Array(Schema.Struct({ projectId: ProjectId, template: TemplateJson }));
const RunRows = Schema.Array(Schema.Struct({ projectId: ProjectId, run: RunJson }));

export const readWorkflowCatalog = Effect.fn("WorkflowProjection.readCatalog")(function* (
  projectId?: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [profileRows, templateRows, runRows] = yield* Effect.all([
    projectId === undefined
      ? sql`SELECT project_id AS "projectId", profile_json AS "profile" FROM projection_agent_profile_versions`
      : sql`SELECT project_id AS "projectId", profile_json AS "profile" FROM projection_agent_profile_versions WHERE project_id = ${projectId}`,
    projectId === undefined
      ? sql`SELECT project_id AS "projectId", template_json AS "template" FROM projection_workflow_template_versions`
      : sql`SELECT project_id AS "projectId", template_json AS "template" FROM projection_workflow_template_versions WHERE project_id = ${projectId}`,
    projectId === undefined
      ? sql`SELECT project_id AS "projectId", run_json AS "run" FROM projection_workflow_runs`
      : sql`SELECT project_id AS "projectId", run_json AS "run" FROM projection_workflow_runs WHERE project_id = ${projectId}`,
  ]).pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.readCatalog:query")));
  const [profiles, templates, runs] = yield* Effect.all([
    Schema.decodeUnknownEffect(ProfileRows)(profileRows),
    Schema.decodeUnknownEffect(TemplateRows)(templateRows),
    Schema.decodeUnknownEffect(RunRows)(runRows),
  ]).pipe(Effect.mapError(toPersistenceDecodeError("WorkflowProjection.readCatalog:decode")));
  return {
    profiles: profiles.map((row) => row.profile),
    templates: templates.map((row) => row.template),
    runs: runs.map((row) => row.run),
  } satisfies WorkflowCatalog;
});

export interface WorkflowRecordedEvent {
  readonly type: "workflow.recorded";
  readonly sequence: number;
  readonly commandId?: string;
  readonly payload: {
    readonly projectId: ProjectId;
    readonly mutation: WorkflowMutation;
  };
}

export const projectWorkflowEvent = Effect.fn("WorkflowProjection.projectEvent")(function* (
  event: WorkflowRecordedEvent,
) {
  if (event.type !== "workflow.recorded") return;
  const sql = yield* SqlClient.SqlClient;
  const cursorRows =
    yield* sql`SELECT last_sequence AS "lastSequence" FROM projection_workflow_cursors WHERE project_id = ${event.payload.projectId}`.pipe(
      Effect.mapError(toPersistenceSqlError("WorkflowProjection.cursor:read")),
    );
  const cursors = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ lastSequence: Schema.Int })),
  )(cursorRows).pipe(Effect.mapError(toPersistenceDecodeError("WorkflowProjection.cursor:decode")));
  if ((cursors[0]?.lastSequence ?? 0) >= event.sequence) return;
  const catalog = yield* readWorkflowCatalog(event.payload.projectId);
  const next = yield* Effect.try({
    try: () => applyWorkflowMutation(catalog, event.payload.projectId, event.payload.mutation),
    catch: toPersistenceSqlError("WorkflowProjection.projectEvent:policy"),
  });
  const mutation = event.payload.mutation;
  if (
    mutation.type === "profile.save" ||
    mutation.type === "profile.archive" ||
    mutation.type === "profile.restore"
  ) {
    const id = mutation.type === "profile.save" ? mutation.profile.id : mutation.profileId;
    const profile = next.profiles
      .filter((entry) => entry.id === id && entry.projectId === event.payload.projectId)
      .toSorted((a, b) => b.version - a.version)[0];
    if (!profile) return;
    const json = yield* Schema.encodeEffect(ProfileJson)(profile).pipe(
      Effect.mapError(toPersistenceDecodeError("WorkflowProjection.profile:encode")),
    );
    yield* sql`
      INSERT INTO projection_agent_profile_versions (project_id, profile_id, version, profile_json)
      VALUES (${event.payload.projectId}, ${profile.id}, ${profile.version}, ${json})
      ON CONFLICT (project_id, profile_id, version) DO UPDATE SET profile_json = excluded.profile_json
    `.pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.profile:upsert")));
    yield* sql`INSERT INTO projection_workflow_cursors (project_id, last_sequence) VALUES (${event.payload.projectId}, ${event.sequence}) ON CONFLICT (project_id) DO UPDATE SET last_sequence = excluded.last_sequence`.pipe(
      Effect.mapError(toPersistenceSqlError("WorkflowProjection.cursor:upsert")),
    );
    return;
  }
  if (
    mutation.type === "template.save" ||
    mutation.type === "template.archive" ||
    mutation.type === "template.restore"
  ) {
    const id = mutation.type === "template.save" ? mutation.template.id : mutation.templateId;
    const template = next.templates
      .filter((entry) => entry.id === id && entry.projectId === event.payload.projectId)
      .toSorted((a, b) => b.version - a.version)[0];
    if (!template) return;
    const json = yield* Schema.encodeEffect(TemplateJson)(template).pipe(
      Effect.mapError(toPersistenceDecodeError("WorkflowProjection.template:encode")),
    );
    yield* sql`
      INSERT INTO projection_workflow_template_versions (project_id, template_id, version, template_json)
      VALUES (${event.payload.projectId}, ${template.id}, ${template.version}, ${json})
      ON CONFLICT (project_id, template_id, version) DO UPDATE SET template_json = excluded.template_json
    `.pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.template:upsert")));
    yield* sql`INSERT INTO projection_workflow_cursors (project_id, last_sequence) VALUES (${event.payload.projectId}, ${event.sequence}) ON CONFLICT (project_id) DO UPDATE SET last_sequence = excluded.last_sequence`.pipe(
      Effect.mapError(toPersistenceSqlError("WorkflowProjection.cursor:upsert")),
    );
    return;
  }
  const runId =
    mutation.type === "run.start"
      ? mutation.run.id
      : mutation.type === "artifact.propose"
        ? mutation.artifact.runId
        : mutation.type === "decision.record"
          ? mutation.decision.runId
          : mutation.runId;
  const run = next.runs.find((entry) => entry.id === runId);
  if (!run) return;
  const runJson = yield* Schema.encodeEffect(RunJson)(run).pipe(
    Effect.mapError(toPersistenceDecodeError("WorkflowProjection.run:encode")),
  );
  yield* sql`
    INSERT INTO projection_workflow_runs (run_id, project_id, run_json, created_at, updated_at)
    VALUES (${run.id}, ${run.projectId}, ${runJson}, ${run.createdAt}, ${run.updatedAt})
    ON CONFLICT (run_id) DO UPDATE SET run_json = excluded.run_json, updated_at = excluded.updated_at
  `.pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.run:upsert")));
  for (const attempt of run.attempts) {
    const json = yield* Schema.encodeEffect(AttemptJson)(attempt).pipe(
      Effect.mapError(toPersistenceDecodeError("WorkflowProjection.attempt:encode")),
    );
    yield* sql`
      INSERT INTO projection_workflow_stage_attempts (run_id, stage_id, attempt, attempt_json)
      VALUES (${run.id}, ${attempt.stageId}, ${attempt.attempt}, ${json})
      ON CONFLICT (run_id, stage_id, attempt) DO UPDATE SET attempt_json = excluded.attempt_json
    `.pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.attempt:upsert")));
  }
  for (const artifact of run.artifacts) {
    const json = yield* Schema.encodeEffect(ArtifactJson)(artifact).pipe(
      Effect.mapError(toPersistenceDecodeError("WorkflowProjection.artifact:encode")),
    );
    yield* sql`
      INSERT INTO projection_workflow_artifacts (artifact_id, run_id, stage_id, attempt, artifact_json)
      VALUES (${artifact.id}, ${run.id}, ${artifact.stageId}, ${artifact.attempt}, ${json})
      ON CONFLICT (artifact_id) DO UPDATE SET artifact_json = excluded.artifact_json
    `.pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.artifact:upsert")));
  }
  for (const decision of run.decisions) {
    const json = yield* Schema.encodeEffect(DecisionJson)(decision).pipe(
      Effect.mapError(toPersistenceDecodeError("WorkflowProjection.decision:encode")),
    );
    yield* sql`
      INSERT OR IGNORE INTO projection_workflow_decisions (decision_id, run_id, stage_id, attempt, decision_json)
      VALUES (${decision.id}, ${run.id}, ${decision.stageId}, ${decision.attempt}, ${json})
    `.pipe(Effect.mapError(toPersistenceSqlError("WorkflowProjection.decision:insert")));
  }
  yield* sql`INSERT INTO projection_workflow_cursors (project_id, last_sequence) VALUES (${event.payload.projectId}, ${event.sequence}) ON CONFLICT (project_id) DO UPDATE SET last_sequence = excluded.last_sequence`.pipe(
    Effect.mapError(toPersistenceSqlError("WorkflowProjection.cursor:upsert")),
  );
});
