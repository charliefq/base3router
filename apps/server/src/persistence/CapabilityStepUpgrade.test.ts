import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import acceptedBase from "./testkit/fixtures/beforeCapabilityStep.json" with { type: "json" };

it.effect(
  "opens a saved exact accepted-base database and appends only capability migration075, retaining UNKNOWN on reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        assert.equal(acceptedBase.base, "8e63786ee58cde76846ffe1c7a611f9e8248ba88");
        assert.equal(acceptedBase.policyLedger.at(-1)!.migration_id, "b3-074");
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "capability-upgrade-" });
        const database = Sqlite.layer({ filename: `${directory}/accepted-base.sqlite` });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const row of acceptedBase.schema) yield* sql.unsafe(row.sql);
            for (const row of acceptedBase.coreLedger)
              yield* sql`INSERT INTO effect_sql_migrations(migration_id,name,created_at)VALUES(${row.migration_id},${row.name},${row.created_at})`;
            for (const row of acceptedBase.policyLedger)
              yield* sql`INSERT INTO base3_policy_migrations(migration_id,name,applied_at)VALUES(${row.migration_id},${row.name},${row.applied_at})`;
            assert.equal(
              (yield* sql`SELECT name FROM sqlite_schema WHERE name='base3_capability_steps'`)
                .length,
              0,
            );
          }).pipe(Effect.provide(database)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runMigrations();
            assert.deepEqual(
              yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
              acceptedBase.coreLedger,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM base3_policy_migrations WHERE migration_id<='b3-074' ORDER BY migration_id`,
              acceptedBase.policyLedger,
            );
            assert.deepEqual(
              yield* sql`SELECT migration_id,name FROM base3_policy_migrations WHERE migration_id>'b3-074'`,
              [
                { migration_id: "b3-075", name: "GovernedCapabilityStep" },
                { migration_id: "b3-076", name: "WorkflowDispatchIdentity" },
                { migration_id: "b3-077", name: "ExternalControllerBridge" },
              ],
            );
            assert.deepEqual(yield* sql`SELECT * FROM base3_capability_steps`, []);
            assert.deepEqual(yield* sql`SELECT * FROM base3_execution_grants`, []);
            yield* sql`INSERT INTO base3_capability_steps(review_id,thread_id,message_id,command_id,run_id,attempt_id,actor_id,review_json,status,detail)
      VALUES('legacy-uncertain','thread','message','command','run','attempt','owner','{}','unknown','Outcome not proven')`;
          }).pipe(Effect.provide(database)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runMigrations();
            assert.deepEqual(yield* sql`SELECT status,detail FROM base3_capability_steps`, [
              { status: "unknown", detail: "Outcome not proven" },
            ]);
            assert.equal(
              (yield* sql`SELECT migration_id FROM base3_policy_migrations WHERE migration_id='b3-075'`)
                .length,
              1,
            );
            assert.deepEqual(yield* sql`SELECT * FROM base3_execution_grants`, []);
          }).pipe(Effect.provide(database)),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
