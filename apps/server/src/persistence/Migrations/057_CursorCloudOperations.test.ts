import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("057_CursorCloudOperations", (it) => {
  it.effect("adds an empty Cursor Cloud outbox without touching workflow projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`INSERT INTO projection_workflow_runs (run_id, project_id, run_json, created_at, updated_at) VALUES ('run-1', 'project-1', '{}', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z')`;
      yield* runMigrations({ toMigrationInclusive: 57 });
      assert.equal((yield* sql`SELECT * FROM projection_workflow_runs`).length, 1);
      assert.deepStrictEqual(yield* sql`SELECT * FROM cursor_cloud_operations`, []);
      assert.deepStrictEqual(
        yield* sql<{
          readonly migrationId: number;
        }>`SELECT migration_id AS "migrationId" FROM effect_sql_migrations WHERE migration_id = 57`,
        [{ migrationId: 57 }],
      );
    }),
  );
});
