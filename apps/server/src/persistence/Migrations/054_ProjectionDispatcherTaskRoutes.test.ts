import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("054_ProjectionDispatcherTaskRoutes", (it) => {
  it.effect("adds task routes without changing existing turn rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          state,
          requested_at,
          checkpoint_files_json
        ) VALUES (
          'existing-thread',
          'existing-turn',
          'existing-message',
          'completed',
          '2026-09-24T00:00:00.000Z',
          '[]'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const turns = yield* sql<{
        readonly threadId: string;
        readonly turnId: string;
        readonly messageId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "messageId"
        FROM projection_turns
      `;
      const routes = yield* sql`SELECT * FROM projection_dispatcher_task_routes`;
      const migrations = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id = 54
      `;

      assert.deepStrictEqual(turns, [
        {
          threadId: "existing-thread",
          turnId: "existing-turn",
          messageId: "existing-message",
        },
      ]);
      assert.deepStrictEqual(routes, []);
      assert.deepStrictEqual(migrations, [{ migrationId: 54 }]);
    }),
  );
});
