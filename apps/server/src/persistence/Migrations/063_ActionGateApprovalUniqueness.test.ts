import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const upgradeLayer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

upgradeLayer("063_ActionGateApprovalUniqueness upgrade", (it) => {
  it.effect("upgrades unique approval rows from the Phase 12 schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO action_gate_approvals (
          approval_id, environment_id, fingerprint, status, idempotency_key,
          created_at, expires_at, payload_json
        ) VALUES (
          'apr-1', 'env-1', 'fp-1', 'pending', 'idem-1',
          '2026-10-03T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '{}'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 63 });
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'action_gate_approvals_env_idempotency',
          'action_gate_approvals_live_fingerprint'
        )
      `;
      assert.equal(indexes.length, 2);
    }),
  );
});

const conflictLayer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

conflictLayer("063_ActionGateApprovalUniqueness conflict", (it) => {
  it.effect("refuses duplicate live fingerprint rows instead of inventing a merge", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO action_gate_approvals (
          approval_id, environment_id, fingerprint, status, idempotency_key,
          created_at, expires_at, payload_json
        ) VALUES
          (
            'apr-dup-1', 'env-1', 'fp-dup', 'pending', 'idem-a',
            '2026-10-03T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '{}'
          ),
          (
            'apr-dup-2', 'env-1', 'fp-dup', 'granted', 'idem-b',
            '2026-10-03T00:00:01.000Z', '2099-01-01T00:00:00.000Z', '{}'
          )
      `;
      const upgraded = yield* runMigrations({ toMigrationInclusive: 63 }).pipe(Effect.exit);
      assert.equal(upgraded._tag, "Failure");
      const liveIndex = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'action_gate_approvals_live_fingerprint'
      `;
      assert.equal(liveIndex.length, 0);
      const rows = yield* sql<{ readonly approvalId: string }>`
        SELECT approval_id AS "approvalId" FROM action_gate_approvals ORDER BY approval_id
      `;
      assert.deepEqual(
        rows.map((row) => row.approvalId),
        ["apr-dup-1", "apr-dup-2"],
      );
      // Fail-closed: do not merge live fingerprints. Inspect both rows, move the
      // unintended one to a terminal status, then retry the migration — or restore
      // a compatible backup taken before the upgrade.
    }),
  );
});
