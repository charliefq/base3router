import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runBase3PolicyMigrations } from "./Base3PolicyMigrations.ts";
import { confirmProviderTermination } from "../policy/Base3PolicyGate.ts";
import acceptedBase from "./testkit/fixtures/beforeDelegatedMailbox.json";

it.effect(
  "upgrades a saved accepted-base database through a new ledger entry without backfilling authority",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        assert.equal(acceptedBase.base, "5e33876338a4d32e18846c8416fb975ed3e05727");
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mailbox-upgrade-" });
        const database = NodeSqliteClient.layer({ filename: `${directory}/accepted-base.sqlite` });
        const seed = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // These are actual sqlite_schema statements and ledger rows captured by
          // the accepted-base runners, not today's schema with new tables removed.
          for (const row of acceptedBase.schema) yield* sql.unsafe(row.sql);
          for (const row of acceptedBase.coreLedger)
            yield* sql`INSERT INTO effect_sql_migrations(migration_id,name,created_at)VALUES(${row.migration_id},${row.name},${row.created_at})`;
          for (const row of acceptedBase.policyLedger)
            yield* sql`INSERT INTO base3_policy_migrations(migration_id,name,applied_at)VALUES(${row.migration_id},${row.name},${row.applied_at})`;
          assert.equal(
            (yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('base3_delegated_child_authorities','base3_delegated_mailbox_deliveries')`)
              .length,
            0,
          );
          yield* sql`INSERT INTO base3_execution_grants(grant_id,thread_id,message_id,run_id,operation,actor_id,scopes_json,expires_at,argument_hash,approval_id,revoked_at,created_at)
      VALUES('grant:delegated:legacy-parent','legacy-parent','legacy-command',NULL,'delegation','legacy-owner','["orchestration:operate"]','2000-01-01T00:00:00Z','unbound-legacy-digest',NULL,'2026-10-17T00:00:00Z','2026-10-16T00:00:00Z')`;
          yield* sql`INSERT INTO base3_capacity_leases(lease_id,environment_id,thread_id,message_id,run_id,parent_lease_id,workload_class,status,created_at)
      VALUES('legacy-slot','local','legacy-thread','legacy-message','legacy-run',NULL,'foreground-turn','active','2026-10-16T00:00:00Z')`;
          return {
            ledger: yield* sql`SELECT * FROM base3_policy_migrations ORDER BY migration_id`,
            coreLedger: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
            grants: yield* sql`SELECT * FROM base3_execution_grants ORDER BY grant_id`,
          };
        });
        const original = yield* Effect.scoped(seed.pipe(Effect.provide(database)));
        // Reopen the saved pre-074 file as an existing installation would.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runBase3PolicyMigrations;
            assert.equal(
              (yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('base3_delegated_child_authorities','base3_delegated_mailbox_deliveries')`)
                .length,
              2,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM base3_policy_migrations WHERE migration_id<='b3-073' ORDER BY migration_id`,
              original.ledger,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
              original.coreLedger,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM base3_execution_grants ORDER BY grant_id`,
              original.grants,
            );
            assert.deepEqual(
              yield* sql<{
                migration_id: string;
                name: string;
              }>`SELECT migration_id,name FROM base3_policy_migrations WHERE migration_id>'b3-073'`,
              [{ migration_id: "b3-074", name: "DelegatedMailboxAuthority" }],
            );
            assert.equal((yield* sql`SELECT * FROM base3_delegated_child_authorities`).length, 0);
            assert.equal((yield* sql`SELECT * FROM base3_delegated_mailbox_deliveries`).length, 0);
            // Root termination now also consults the new child provenance table.
            yield* confirmProviderTermination({ threadId: "legacy-thread", runId: "legacy-run" });
            assert.deepEqual(
              yield* sql<{
                status: string;
              }>`SELECT status FROM base3_capacity_leases WHERE lease_id='legacy-slot'`,
              [{ status: "released" }],
            );
            yield* sql`INSERT INTO base3_delegated_mailbox_deliveries(message_id,thread_id,parent_run_id,generation,attempt_id,session_id,turn_id,status)
      VALUES('uncertain-message','legacy-thread','legacy-run',1,'legacy-attempt','legacy-session','legacy-turn','unknown')`;
          }).pipe(Effect.provide(database)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runBase3PolicyMigrations;
            assert.equal(
              (yield* sql`SELECT migration_id FROM base3_policy_migrations WHERE migration_id='b3-074'`)
                .length,
              1,
            );
            assert.deepEqual(
              yield* sql<{ status: string }>`SELECT status FROM base3_delegated_mailbox_deliveries`,
              [{ status: "unknown" }],
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM base3_execution_grants ORDER BY grant_id`,
              original.grants,
            );
            assert.equal((yield* sql`SELECT * FROM base3_delegated_child_authorities`).length, 0);
          }).pipe(Effect.provide(database)),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
