import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";
import { projectWorkflowEvent } from "./Projection.ts";
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
const event: OrchestrationEvent = {
  sequence: 1,
  eventId: EventId.make("event-1"),
  type: "workflow.recorded",
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: at,
  commandId: CommandId.make("command-1"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
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
      const ready = yield* previewWorkflowStage(input, {
        environmentId,
        providers: [provider(true)],
        environmentDefaultModelSelection: null,
      });
      assert.equal(ready.route.gate.decision, "ALLOW");
      assert.equal(ready.route.selected?.target.instanceId, input.preferredRoute.instanceId);
      assert.equal(ready.route.candidates.length, 1);
      assert.equal(ready.cursorCloud, undefined);
      const unavailable = yield* previewWorkflowStage(input, {
        environmentId,
        providers: [provider(false)],
        environmentDefaultModelSelection: null,
      });
      assert.equal(unavailable.route.gate.decision, "DENY");
      assert.equal(unavailable.route.selected, null);
      assert.equal(
        unavailable.route.candidates[0]?.reasonCodes.includes("PROVIDER_NOT_INSTALLED"),
        true,
      );
    }),
  );
});
