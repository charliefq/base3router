import {
  ProjectId,
  ThreadId,
  MessageId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  type WorkflowMutation,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";
import { projectWorkflowEvent, type WorkflowRecordedEvent } from "./Projection.ts";
import { proposeWorkflowArtifact, type WorkflowRecordCommand } from "./Workflow.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("user-1");
const at = "2026-09-28T00:00:00.000Z";
const route = {
  policyVersion: "dispatcher.phase-1a.v1" as const,
  target: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit" as const,
  gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED" as const] },
};
const event = (sequence: number, mutation: WorkflowMutation): WorkflowRecordedEvent => ({
  sequence,
  type: "workflow.recorded",
  commandId: `command-${sequence}`,
  payload: { projectId, mutation },
});

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("workflow artifact extraction", (it) => {
  it.effect(
    "requires a settled turn and redacts credentials and external paths without inventing sections",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/tmp/workflow-repo', '[]', ${at}, ${at})`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES (${threadId}, ${projectId}, 'Thread', '{"instanceId":"codex-work","model":"gpt-5.4"}', 'approval-required', 'default', ${at}, ${at})`;
        yield* projectWorkflowEvent(
          event(1, {
            type: "run.start",
            run: initialWorkflowRun({
              runId: "run-1",
              projectId,
              template: BUILTIN_WORKFLOW_TEMPLATES[0]!,
              originThreadId: null,
              originMessageId: null,
              at,
            }),
          }),
        );
        yield* projectWorkflowEvent(
          event(2, {
            type: "stage.dispatch",
            runId: "run-1",
            stageId: "discovery",
            attempt: 1,
            threadId,
            messageId,
            routeBinding: route,
            at,
          }),
        );
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, checkpoint_files_json) VALUES (${threadId}, ${TurnId.make("turn-1")}, ${messageId}, 'assistant-1', 'running', ${at}, '[]')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES ('assistant-1', ${threadId}, ${TurnId.make("turn-1")}, 'assistant', ${"# Product\nOne useful product. Token sk-secretvalue1234. Inspect /home/example/private and /tmp/workflow-repo/src/app.ts.\n\n# Current evidence with URLs and dates\n[Source](https://example.org/article?secret=abc) dated 2026-09-28."}, 0, ${at}, ${at})`;
        const commands: WorkflowRecordCommand[] = [];
        const dispatch = (command: WorkflowRecordCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 3 };
          });
        const input = {
          projectId,
          runId: "run-1",
          artifactId: "artifact-1",
          commandId: "artifact-command-1",
        };
        const unsettled = yield* Effect.exit(proposeWorkflowArtifact(input, dispatch));
        assert.equal(unsettled._tag, "Failure");
        assert.equal(commands.length, 0);
        yield* sql`UPDATE projection_turns SET state = 'completed' WHERE thread_id = ${threadId}`;
        const artifact = yield* proposeWorkflowArtifact(input, dispatch);
        assert.equal(commands.length, 1);
        assert.equal(artifact.sourceTurnId, TurnId.make("turn-1"));
        assert.equal(artifact.status, "proposed");
        assert.equal(artifact.missingSections.includes("First customer"), true);
        const product =
          artifact.sections.find((section) => section.label === "Product")?.content ?? "";
        assert.equal(product.includes("sk-secretvalue1234"), false);
        assert.equal(product.includes("/home/example/private"), false);
        assert.equal(product.includes("src/app.ts"), true);
        const evidence =
          artifact.sections.find(
            (section) => section.label === "Current evidence with URLs and dates",
          )?.content ?? "";
        assert.equal(evidence.includes("https://example.org/article"), true);
        assert.equal(evidence.includes("secret=abc"), false);
      }),
  );
});
