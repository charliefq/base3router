import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("055_ProjectionTaskHandoffs", (it) => {
  it.effect("adds an empty handoff projection without changing existing routes or turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES ('thread-1', 'turn-1', 'message-1', 'completed', '2026-09-26T00:00:00Z', '[]')
      `;
      yield* sql`
        INSERT INTO projection_dispatcher_task_routes (
          thread_id, message_id, binding_json, created_at
        ) VALUES ('thread-1', 'message-1', '{}', '2026-09-26T00:00:00Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_task_handoffs`, []);
      assert.equal((yield* sql`SELECT * FROM projection_turns`).length, 1);
      assert.equal((yield* sql`SELECT * FROM projection_dispatcher_task_routes`).length, 1);
      assert.deepStrictEqual(
        yield* sql<{ readonly migrationId: number }>`
          SELECT migration_id AS "migrationId"
          FROM effect_sql_migrations
          WHERE migration_id = 55
        `,
        [{ migrationId: 55 }],
      );
    }),
  );
});
