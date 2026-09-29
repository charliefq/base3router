import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("058_CursorCloudOperationScope", (it) => {
  it.effect("rebuilds the outbox with scoped keys and kind/state checks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`INSERT INTO cursor_cloud_operations (
        command_id, kind, state, cursor_agent_id, run_id, stage_id, attempt, created_at, updated_at
      ) VALUES (
        'legacy-command', 'create', 'pending', 'bc-agent', 'run-1', 'research', 1,
        '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z'
      )`;
      yield* runMigrations({ toMigrationInclusive: 58 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM cursor_cloud_operations`, []);
      assert.deepStrictEqual(
        yield* sql<{
          readonly migrationId: number;
        }>`SELECT migration_id AS "migrationId" FROM effect_sql_migrations WHERE migration_id = 58`,
        [{ migrationId: 58 }],
      );
      yield* sql`INSERT INTO cursor_cloud_operations (
        operation_key, kind, state, command_id, environment_id, project_id, run_id, stage_id,
        attempt, cursor_agent_id, request_fingerprint, claimed_at, created_at, updated_at
      ) VALUES (
        'create\u001fenvironment-1\u001fproject-1\u001frun-1\u001fresearch\u001f1\u001fdispatch-1',
        'create', 'pending', 'cursor-create-dispatch-1', 'environment-1', 'project-1', 'run-1',
        'research', 1, 'bc-agent', 'fingerprint', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z',
        '2026-09-29T00:00:00Z'
      )`;
      const kindRejected = yield* Effect.exit(
        sql`INSERT INTO cursor_cloud_operations (
          operation_key, kind, state, command_id, environment_id, project_id, run_id, stage_id,
          attempt, cursor_agent_id, request_fingerprint, claimed_at, created_at, updated_at
        ) VALUES (
          'bad-kind', 'replay', 'pending', 'command', 'environment-1', 'project-1', 'run-1',
          'research', 1, 'bc-agent', 'fingerprint', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z',
          '2026-09-29T00:00:00Z'
        )`,
      );
      const stateRejected = yield* Effect.exit(
        sql`INSERT INTO cursor_cloud_operations (
          operation_key, kind, state, command_id, environment_id, project_id, run_id, stage_id,
          attempt, cursor_agent_id, request_fingerprint, claimed_at, created_at, updated_at
        ) VALUES (
          'bad-state', 'cancel', 'accepted', 'command', 'environment-1', 'project-1', 'run-1',
          'research', 1, 'bc-agent', 'fingerprint', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z',
          '2026-09-29T00:00:00Z'
        )`,
      );
      assert.isTrue(Exit.isFailure(kindRejected));
      assert.isTrue(Exit.isFailure(stateRejected));
    }),
  );
});
