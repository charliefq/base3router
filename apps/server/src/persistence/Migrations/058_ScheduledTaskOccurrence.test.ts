import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds nullable occurrence evidence without rewriting legacy task history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count
      ) VALUES ('legacy', 'Legacy', 'Review', 0, '{"type":"interval","everyMs":60000}',
        'project:test', '{"type":"root"}', '{"instanceId":"codex","model":"fake"}',
        'full-access', 'default', 'user', 'web', '2026-10-16T00:00:00Z',
        '2026-10-16T00:00:00Z', 'running', 7)`;
      const before = yield* sql`SELECT * FROM scheduled_tasks`;
      yield* runMigrations({ toMigrationInclusive: 58 });
      assert.deepStrictEqual(
        (yield* sql`SELECT scheduled_tasks.* FROM scheduled_tasks`).map((row) => ({ ...row })),
        before.map((row) => ({ ...row, last_occurrence_json: null })),
      );
      yield* runMigrations({ toMigrationInclusive: 58 });
      assert.equal((yield* sql`SELECT * FROM scheduled_tasks`).length, 1);
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
