import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("056_ProjectionWorkflowOs", (it) => {
  it.effect("adds empty workflow projections without backfilling old tasks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json) VALUES ('legacy-thread', 'legacy-turn', 'legacy-message', 'completed', '2026-09-28T00:00:00Z', '[]')`;
      yield* runMigrations({ toMigrationInclusive: 56 });
      assert.equal((yield* sql`SELECT * FROM projection_turns`).length, 1);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_workflow_runs`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_agent_profile_versions`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_workflow_template_versions`, []);
      assert.deepStrictEqual(
        yield* sql<{
          readonly migrationId: number;
        }>`SELECT migration_id AS "migrationId" FROM effect_sql_migrations WHERE migration_id = 56`,
        [{ migrationId: 56 }],
      );
    }),
  );
});
