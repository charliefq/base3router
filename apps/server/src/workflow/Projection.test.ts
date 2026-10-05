import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";
import {
  projectWorkflowEvent,
  readWorkflowCatalog,
  type WorkflowRecordedEvent,
} from "./Projection.ts";

const projectId = ProjectId.make("project-1");
const at = "2026-09-28T00:00:00.000Z";
const event: WorkflowRecordedEvent = {
  sequence: 1,
  type: "workflow.recorded",
  commandId: "workflow-command-1",
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
layer("workflow projection", (it) => {
  it.effect("reloads durable runs, skips repeated events, and rebuilds deterministically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* projectWorkflowEvent(event);
      const first = yield* readWorkflowCatalog(projectId);
      assert.equal(first.runs[0]?.templateVersion, 1);
      yield* projectWorkflowEvent(event);
      assert.deepStrictEqual(yield* readWorkflowCatalog(projectId), first);
      yield* sql`DELETE FROM projection_workflow_runs`;
      yield* sql`DELETE FROM projection_workflow_stage_attempts`;
      yield* sql`DELETE FROM projection_workflow_cursors`;
      yield* projectWorkflowEvent(event);
      assert.deepStrictEqual(yield* readWorkflowCatalog(projectId), first);
    }),
  );

  it.effect("projects equal custom IDs independently across projects", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      const secondProject = ProjectId.make("project-2");
      const profile = {
        ...BUILTIN_AGENT_PROFILES[0]!,
        id: "shared-name",
        projectId,
        origin: "custom" as const,
      };
      yield* projectWorkflowEvent({
        ...event,
        sequence: 10,
        payload: { projectId, mutation: { type: "profile.save", profile } },
      });
      assert.deepStrictEqual(
        (yield* readWorkflowCatalog(projectId)).profiles.map((entry) => entry.version),
        [1],
      );
      yield* projectWorkflowEvent({
        ...event,
        sequence: 11,
        payload: {
          projectId,
          mutation: { type: "profile.save", profile: { ...profile, version: 2 } },
        },
      });
      yield* projectWorkflowEvent({
        ...event,
        sequence: 12,
        payload: {
          projectId: secondProject,
          mutation: { type: "profile.save", profile: { ...profile, projectId: secondProject } },
        },
      });
      const first = yield* readWorkflowCatalog(projectId);
      const second = yield* readWorkflowCatalog(secondProject);
      assert.deepStrictEqual(
        first.profiles.map((entry) => entry.version),
        [1, 2],
      );
      assert.deepStrictEqual(
        second.profiles.map((entry) => entry.version),
        [1],
      );
      assert.equal(second.profiles[0]?.projectId, secondProject);
    }),
  );
});
