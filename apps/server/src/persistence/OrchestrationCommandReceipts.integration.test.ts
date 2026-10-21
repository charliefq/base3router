import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./Layers/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
} from "./Services/OrchestrationCommandReceipts.ts";

const decodeReceipt = Schema.decodeUnknownSync(OrchestrationCommandReceipt);
const receipt = (commandId: string) =>
  decodeReceipt({
    commandId,
    aggregateKind: "thread",
    aggregateId: "thread:receipt-proof",
    commandType: "message.dispatch",
    acceptedAt: "2026-10-13T00:00:00.000Z",
    resultSequence: 0,
    status: "accepted",
    error: null,
  });

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

layer("command receipt persistence with real migrations", (it) => {
  it.effect("migrates command type and finalizes without a duplicate changing identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* runMigrations();
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      assert.deepStrictEqual(
        columns.filter((column) => column.name === "command_type").map((column) => column.notnull),
        [1],
      );
      const original = receipt("command:receipt-finalize");
      assert.strictEqual(yield* repository.insertIfAbsent(original), true);
      assert.strictEqual(
        yield* repository.insertIfAbsent({
          ...original,
          aggregateKind: "project",
          aggregateId: original.aggregateId,
          commandType: "project.delete",
          status: "rejected",
          error: "duplicate must not overwrite",
        }),
        false,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getByCommandId({ commandId: original.commandId })),
        original,
      );
      const final = { ...original, resultSequence: 42 };
      yield* repository.upsert(final);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getByCommandId({ commandId: original.commandId })),
        final,
      );
    }),
  );

  it.effect("rolls back the placeholder when finalization fails on the same SQL service", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* runMigrations();
      const original = receipt("command:receipt-rollback");
      yield* sql`
        CREATE TRIGGER receipt_proof_reject_finalization
        BEFORE UPDATE ON orchestration_command_receipts
        WHEN NEW.command_id = 'command:receipt-rollback' AND NEW.result_sequence > 0
        BEGIN SELECT RAISE(ABORT, 'injected receipt finalization failure'); END
      `;
      const result = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            assert.strictEqual(yield* repository.insertIfAbsent(original), true);
            yield* repository.upsert({ ...original, resultSequence: 42 });
          }),
        ),
      );
      assert.ok(Exit.isFailure(result));
      assert.ok(Option.isNone(yield* repository.getByCommandId({ commandId: original.commandId })));
      yield* sql`DROP TRIGGER receipt_proof_reject_finalization`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          assert.strictEqual(yield* repository.insertIfAbsent(original), true);
          yield* repository.upsert({ ...original, resultSequence: 42 });
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getByCommandId({ commandId: original.commandId }))
          .resultSequence,
        42,
      );
    }),
  );
});
