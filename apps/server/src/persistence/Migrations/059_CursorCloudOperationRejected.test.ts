import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("059_CursorCloudOperationRejected", (it) => {
  it.effect("copies outbox history and allows a finalized rejected state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`INSERT INTO cursor_cloud_operations (
        operation_key, kind, state, command_id, environment_id, project_id, run_id, stage_id,
        attempt, cursor_agent_id, request_fingerprint, claimed_at, created_at, updated_at
      ) VALUES (
        'follow-up\u001fenvironment-1\u001fproject-1\u001frun-1\u001fresearch\u001f1\u001fcmd-1',
        'follow-up', 'pending', 'cmd-1', 'environment-1', 'project-1', 'run-1',
        'research', 1, 'bc-agent', 'fingerprint', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z',
        '2026-09-29T00:00:00Z'
      )`;
      yield* runMigrations({ toMigrationInclusive: 59 });
      assert.deepStrictEqual(
        yield* sql<{
          readonly commandId: string;
          readonly state: string;
          readonly errorJson: string | null;
        }>`SELECT command_id AS "commandId", state, error_json AS "errorJson" FROM cursor_cloud_operations`,
        [{ commandId: "cmd-1", state: "pending", errorJson: null }],
      );
      assert.deepStrictEqual(
        yield* sql<{
          readonly migrationId: number;
        }>`SELECT migration_id AS "migrationId" FROM effect_sql_migrations WHERE migration_id = 59`,
        [{ migrationId: 59 }],
      );
      yield* sql`INSERT INTO cursor_cloud_operations (
        operation_key, kind, state, command_id, environment_id, project_id, run_id, stage_id,
        attempt, cursor_agent_id, request_fingerprint, claimed_at, error_json, created_at, updated_at
      ) VALUES (
        'follow-up\u001fenvironment-1\u001fproject-1\u001frun-1\u001fresearch\u001f1\u001fcmd-2',
        'follow-up', 'rejected', 'cmd-2', 'environment-1', 'project-1', 'run-1',
        'research', 1, 'bc-agent', 'fingerprint', '2026-09-29T00:00:00Z',
        '{"code":"agent_busy","message":"The Cursor agent is busy with another run."}',
        '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z'
      )`;
      const stateRejected = yield* Effect.exit(
        sql`INSERT INTO cursor_cloud_operations (
          operation_key, kind, state, command_id, environment_id, project_id, run_id, stage_id,
          attempt, cursor_agent_id, request_fingerprint, claimed_at, created_at, updated_at
        ) VALUES (
          'bad-state', 'follow-up', 'accepted', 'command', 'environment-1', 'project-1', 'run-1',
          'research', 1, 'bc-agent', 'fingerprint', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z',
          '2026-09-29T00:00:00Z'
        )`,
      );
      assert.isTrue(Exit.isFailure(stateRejected));
    }),
  );
});
