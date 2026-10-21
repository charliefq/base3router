import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type WorkflowTemplate,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";
import { projectWorkflowEvent, type WorkflowRecordedEvent } from "./Projection.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { previewWorkflowStage } from "./Workflow.ts";

const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("environment-1");
const at = "2026-09-28T00:00:00.000Z";
const provider = (installed: boolean): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed,
  version: null,
  status: installed ? "ready" : "error",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const event: WorkflowRecordedEvent = {
  sequence: 1,
  type: "workflow.recorded",
  commandId: "command-1",
  payload: {
    projectId,
    mutation: {
      type: "run.start",
      run: initialWorkflowRun({
        runId: "run-1",
        projectId,
        template: BUILTIN_WORKFLOW_TEMPLATES[0]!,
        originThreadId: null,
        originMessageId: null,
        at,
      }),
    },
  },
};
const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("workflow route preview", (it) => {
  it.effect("uses dispatcher readiness and fails closed for an unavailable exact runner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/tmp/workflow-preview', '[]', ${at}, ${at})`;
      yield* projectWorkflowEvent(event);
      const input = {
        environmentId,
        projectId,
        runId: "run-1",
        preferredRoute: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
      };
      const humanStage = BUILTIN_WORKFLOW_TEMPLATES[0]!.stages.find(
        (stage) => stage.type === "human_gate",
      )!;
      const humanTemplate: WorkflowTemplate = {
        ...BUILTIN_WORKFLOW_TEMPLATES[0]!,
        id: "human-template",
        projectId,
        origin: "custom",
        stages: [{ ...humanStage, nextStageId: null }],
      };
      yield* projectWorkflowEvent({
        ...event,
        sequence: 2,
        commandId: "template-command",
        payload: { projectId, mutation: { type: "template.save", template: humanTemplate } },
      });
      const humanRun = initialWorkflowRun({
        runId: "human-run",
        projectId,
        template: humanTemplate,
        originThreadId: null,
        originMessageId: null,
        at,
      });
      yield* projectWorkflowEvent({
        ...event,
        sequence: 3,
        commandId: "human-command",
        payload: { projectId, mutation: { type: "run.start", run: humanRun } },
      });
      const before = yield* sql`SELECT total_changes() AS changes`;
      let launches = 0;
      let starts = 0;
      let providerLookups = 0;
      const fakeAdapter: ProviderAdapterV2Shape = {
        instanceId: input.preferredRoute.instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.die("Preview must not probe provider capabilities"),
        planSelectionTransition: () => Effect.die("Preview must not prepare a provider"),
        openSession: () => {
          starts++;
          return Effect.die("Preview must not start a provider");
        },
      };
      const readonlyPreview = (installed: boolean, runId = input.runId) =>
        previewWorkflowStage(
          { ...input, runId },
          {
            environmentId,
            providers: [provider(installed)],
            environmentDefaultModelSelection: null,
          },
        ).pipe(
          Effect.provideService(ThreadLaunchService, {
            launch: () => {
              launches++;
              return Effect.die("Preview must not launch a thread");
            },
          }),
          Effect.provideService(ProviderAdapterRegistryV2, {
            get: () => {
              providerLookups++;
              return Effect.succeed(fakeAdapter);
            },
            list: () => Effect.succeed([fakeAdapter.instanceId]),
          }),
        );
      // SQLite rejects any accidental write, including ledger/admission changes.
      yield* sql`PRAGMA query_only = ON`;
      const ready = yield* readonlyPreview(true);
      assert.equal(ready.route.gate.decision, "ALLOW");
      assert.equal(ready.route.selected?.target.instanceId, input.preferredRoute.instanceId);
      assert.equal(ready.route.candidates.length, 1);
      assert.equal(ready.cursorCloud, undefined);
      const unavailable = yield* readonlyPreview(false);
      assert.equal(unavailable.route.gate.decision, "DENY");
      assert.equal(unavailable.route.selected, null);
      const humanPreview = yield* readonlyPreview(true, "human-run").pipe(Effect.exit);
      assert.equal(humanPreview._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT total_changes() AS changes`, before);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM base3_workflow_commands`, [
        { count: 0 },
      ]);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM task_contract_admissions`, [
        { count: 0 },
      ]);
      assert.equal(launches, 0);
      assert.equal(starts, 0);
      assert.equal(providerLookups, 0);
      assert.equal(
        unavailable.route.candidates[0]?.reasonCodes.includes("PROVIDER_NOT_INSTALLED"),
        true,
      );
    }),
  );
});
