import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("064_DreamMemory and 065_ConcurrencyBudgetAudit", (it) => {
  it.effect("upgrades a pre-Phase-13 schema without rewriting older tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dream_memories'
      `;
      assert.deepStrictEqual(before, []);
      yield* runMigrations({ toMigrationInclusive: 65 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'dream_memories',
          'dream_deleted_sources',
          'dream_jobs',
          'dream_memory_audit',
          'concurrency_budget_audit'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "concurrency_budget_audit",
          "dream_deleted_sources",
          "dream_jobs",
          "dream_memories",
          "dream_memory_audit",
        ],
      );
    }),
  );

  it.effect("fresh initialization creates Phase 12 and 13 tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'action_gate_approvals',
          'dream_memories',
          'concurrency_budget_audit'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["action_gate_approvals", "concurrency_budget_audit", "dream_memories"],
      );
    }),
  );

  it.effect("malformed optional memory payloads do not block later valid rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO dream_memories (
          memory_id, environment_id, actor_id, project_id, thread_id, scope_kind,
          status, source_fingerprint, content_present, payload_json, created_at, updated_at
        ) VALUES (
          'mem-malformed', 'env-1', 'actor-1', NULL, NULL, 'environment',
          'active', 'fp-malformed', 1, '{not-json', '2026-10-03T00:00:00.000Z',
          '2026-10-03T00:00:00.000Z'
        )
      `;
      const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM dream_memories
      `;
      assert.equal(count[0]?.count, 1);
    }),
  );
});
