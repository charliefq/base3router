import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds rejection proofs without changing or attributing legacy receipts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error,command_type) VALUES ('legacy','thread','legacy-thread','2026-10-13T00:00:00Z',0,'rejected','private error','thread.create')`;
      const before = yield* sql`SELECT * FROM orchestration_command_receipts`;
      yield* runMigrations({ toMigrationInclusive: 57 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_command_receipts`, before);
      assert.deepStrictEqual(yield* sql`SELECT * FROM agents_task_creation_rejections`, []);
      yield* runMigrations({ toMigrationInclusive: 57 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_command_receipts`, before);
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
