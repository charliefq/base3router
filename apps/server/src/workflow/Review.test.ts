import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  WorkflowOperationError,
  type WorkflowDispatchStageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import {
  performWorkflowAction,
  previewWorkflowStage,
  dispatchWorkflowStage,
  reconcileWorkflowDispatch,
} from "./Workflow.ts";
const projectId = ProjectId.make("workflow-review-project");
const environmentId = EnvironmentId.make("workflow-review-environment");
const target = { instanceId: ProviderInstanceId.make("review-fake"), model: "fixture-model" };
const provider: ServerProvider = {
  instanceId: target.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-19T00:00:00Z",
  models: [{ slug: target.model, name: "Fixture", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const actor = {
  kind: "session" as const,
  actorId: "owner",
  sessionId: "session",
  scopes: ["orchestration:operate" as const],
};
const deps = { environmentId, providers: [provider], environmentDefaultModelSelection: null };
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM base3_workflow_dispatches`;
  yield* sql`DELETE FROM base3_workflow_commands`;
  for (const table of [
    "projection_workflow_runs",
    "projection_workflow_stage_attempts",
    "projection_workflow_artifacts",
    "projection_workflow_decisions",
    "projection_workflow_cursors",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT OR IGNORE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Fixture','/tmp','[]','2026-10-19T00:00:00Z','2026-10-19T00:00:00Z')`;
  yield* sql`UPDATE projection_projects SET deleted_at=NULL WHERE project_id=${projectId}`;
  yield* performWorkflowAction(
    {
      type: "run.start",
      projectId,
      commandId: "review-create",
      runId: "review-run",
      brief: "Original review-bound brief",
      templateId: "saas-production",
      templateVersion: 1,
      originatingThreadId: null,
      originatingMessageId: null,
    },
    () => Effect.succeed({ sequence: 1 }),
  );
  const taskContract = {
    goal: "Discovery evidence",
    redirect: "Current stage only",
    acceptance: "Owner inspects output",
    brake: {
      maxProviderStarts: 1,
      maxTokens: 4000,
      deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
      stopConditions: "Stop before successor",
    },
  };
  const preview = yield* previewWorkflowStage(
    { environmentId, projectId, runId: "review-run", preferredRoute: target, taskContract },
    deps,
  );
  if (!preview.review) return yield* Effect.die("Missing review");
  const input: typeof WorkflowDispatchStageInput.Type = {
    environmentId,
    projectId,
    runId: "review-run",
    stageId: "discovery",
    attempt: 1,
    dispatchId: "review-dispatch",
    target,
    additionalInstruction: "",
    review: preview.review,
  };
  return { sql, input, preview };
});
const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("reviewed workflow dispatch", (it) => {
  it.effect.each([
    "contract",
    "model",
    "instruction",
    "brief",
    "expiry",
    "deadline",
    "starts",
    "tokens",
    "pause",
    "delete",
    "environment",
    "read-only",
    "revoked",
  ] as const)("fails closed after %s changes with zero launch entries", (change) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let input = f.input;
      let subject: import("../policy/executionContext.ts").PolicyExecutionContext = actor;
      if (change === "contract")
        input = {
          ...input,
          review: {
            ...input.review!,
            taskContract: { ...input.review!.taskContract, goal: "Changed" },
          },
        };
      if (change === "model") input = { ...input, target: { ...target, model: "changed" } };
      if (change === "instruction") input = { ...input, additionalInstruction: "Changed" };
      if (change === "expiry")
        input = { ...input, review: { ...input.review!, expiresAt: "1970-01-01T00:00:00Z" } };
      if (["deadline", "starts", "tokens"].includes(change)) {
        const contract = {
          ...input.review!.taskContract,
          brake: {
            ...input.review!.taskContract.brake,
            ...(change === "deadline" ? { deadlineAt: "1970-01-01T00:00:00Z" } : {}),
            ...(change === "starts" ? { maxProviderStarts: 2 } : {}),
            ...(change === "tokens" ? { maxTokens: 100001 } : {}),
          },
        };
        const preview = yield* previewWorkflowStage(
          {
            environmentId,
            projectId,
            runId: input.runId,
            preferredRoute: target,
            taskContract: contract,
          },
          deps,
        );
        if (!preview.review) return yield* Effect.die("Missing review");
        input = { ...input, review: preview.review };
      }
      if (change === "brief")
        yield* f.sql`UPDATE projection_workflow_runs SET run_json=json_set(run_json, '$.brief', 'Changed after review') WHERE run_id=${input.runId}`;
      if (change === "pause")
        yield* performWorkflowAction(
          { type: "run.pause", projectId, commandId: "pause", runId: input.runId },
          () => Effect.succeed({ sequence: 1 }),
        );
      if (change === "delete")
        yield* f.sql`UPDATE projection_projects SET deleted_at='2026-10-19T00:00:00Z' WHERE project_id=${projectId}`;
      if (change === "environment")
        input = { ...input, environmentId: EnvironmentId.make("other") };
      if (change === "read-only") subject = { ...actor, scopes: ["orchestration:read"] };
      if (change === "revoked") subject = { ...actor, expiresAt: "1970-01-01T00:00:00Z" };
      let launches = 0;
      const result = yield* Effect.exit(
        dispatchWorkflowStage(input, {
          ...deps,
          launch: () =>
            Effect.sync(() => {
              launches++;
              return { sequence: 1 };
            }),
        }).pipe(Effect.provideService(PolicyExecutionContext, subject)),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(launches, 0);
      assert.equal((yield* f.sql`SELECT * FROM base3_workflow_dispatches`).length, 0);
    }).pipe(Effect.provideService(PolicyExecutionContext, actor)),
  );
  it.effect(
    "persists the original identity before launch and retains UNKNOWN without blind resend",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.equal((yield* f.sql`SELECT * FROM base3_workflow_dispatches`).length, 0);
        let launches = 0;
        const dependencies = {
          ...deps,
          launch: () =>
            Effect.gen(function* () {
              launches++;
              assert.equal((yield* f.sql`SELECT * FROM base3_workflow_dispatches`).length, 1);
              return yield* Effect.fail(new WorkflowOperationError({ message: "lost response" }));
            }),
        };
        assert.equal(
          (yield* Effect.exit(dispatchWorkflowStage(f.input, dependencies)))._tag,
          "Failure",
        );
        assert.equal((yield* reconcileWorkflowDispatch(f.input)).status, "unknown");
        assert.equal(
          (yield* Effect.exit(dispatchWorkflowStage(f.input, dependencies)))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            dispatchWorkflowStage({ ...f.input, dispatchId: "fresh-blind-resend" }, dependencies),
          ))._tag,
          "Failure",
        );
        assert.equal(launches, 1);
      }).pipe(Effect.provideService(PolicyExecutionContext, actor)),
  );
});
