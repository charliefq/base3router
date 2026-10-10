/**
 * Base3Router policy schema lives in its own ledger.
 *
 * Upstream's migrator keys on numeric ids in `effect_sql_migrations`. Fork
 * ids 054–065 would mask Orchestration V2's migrations, so these statements
 * never go through that table. Applied scripts record `b3-*` ids here.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import migration054 from "./Base3Ledger/054_ProjectionDispatcherTaskRoutes.ts";
import migration055 from "./Base3Ledger/055_ProjectionTaskHandoffs.ts";
import migration056 from "./Base3Ledger/056_ProjectionWorkflowOs.ts";
import migration057 from "./Base3Ledger/057_CursorCloudOperations.ts";
import migration058 from "./Base3Ledger/058_CursorCloudOperationScope.ts";
import migration059 from "./Base3Ledger/059_CursorCloudOperationRejected.ts";
import migration060 from "./Base3Ledger/060_RouterEvaluationObservations.ts";
import migration061 from "./Base3Ledger/061_RouterObservationEvents.ts";
import migration062 from "./Base3Ledger/062_ActionGateApprovals.ts";
import migration063 from "./Base3Ledger/063_ActionGateApprovalUniqueness.ts";
import migration064 from "./Base3Ledger/064_DreamMemory.ts";
import migration065 from "./Base3Ledger/065_ConcurrencyBudgetAudit.ts";

const ledgerTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_policy_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `;
});

const integrationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_capacity_leases (
      lease_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT,
      run_id TEXT,
      parent_lease_id TEXT,
      workload_class TEXT NOT NULL,
      status TEXT NOT NULL,
      interrupt_requested INTEGER NOT NULL DEFAULT 0,
      disconnect_unconfirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      released_at TEXT,
      release_reason TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS base3_capacity_leases_run
    ON base3_capacity_leases (run_id)
    WHERE run_id IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_execution_grants (
      grant_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      run_id TEXT,
      operation TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      expires_at TEXT,
      argument_hash TEXT NOT NULL,
      approval_id TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_execution_attempts (
      attempt_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      started_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_import_batches (
      batch_id TEXT PRIMARY KEY,
      source_fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_import_map (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (source_table, source_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_import_holds (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (source_table, source_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS base3_workflow_commands (
      command_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      mutation_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
});

const taskContractTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_contract_admissions (
      root_thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      contract_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (root_thread_id, command_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_contract_members (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL
    )
  `;
});

const taskContractAdmissionMessage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE task_contract_admissions ADD COLUMN message_id TEXT
  `;
});

const taskUsageTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_usage_attempts (
      environment_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      root_thread_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      message_id TEXT,
      contract_revision INTEGER,
      provider_instance_id TEXT,
      status TEXT NOT NULL,
      attempt_role TEXT NOT NULL,
      usage_status TEXT NOT NULL,
      basis TEXT NOT NULL,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_creation_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      reported_cost_usd REAL,
      source_event_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, provider_turn_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_usage_events (
      environment_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      PRIMARY KEY (environment_id, event_id)
    )
  `;
  // The attempt write records its event id in the same statement. A second
  // client statement yields inside the projection transaction.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS task_usage_attempts_record_event
    AFTER INSERT ON task_usage_attempts
    WHEN NEW.source_event_id IS NOT NULL
    BEGIN
      INSERT INTO task_usage_events (environment_id, event_id, provider_turn_id)
      VALUES (NEW.environment_id, NEW.source_event_id, NEW.provider_turn_id);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS task_usage_attempts_record_event_update
    AFTER UPDATE ON task_usage_attempts
    WHEN NEW.source_event_id IS NOT NULL
      AND NEW.source_event_id IS NOT OLD.source_event_id
    BEGIN
      INSERT INTO task_usage_events (environment_id, event_id, provider_turn_id)
      VALUES (NEW.environment_id, NEW.source_event_id, NEW.provider_turn_id);
    END
  `;
});

const steps: ReadonlyArray<
  readonly [string, string, Effect.Effect<void, SqlError, SqlClient.SqlClient>]
> = [
  ["b3-054", "ProjectionDispatcherTaskRoutes", migration054],
  ["b3-055", "ProjectionTaskHandoffs", migration055],
  ["b3-056", "ProjectionWorkflowOs", migration056],
  ["b3-057", "CursorCloudOperations", migration057],
  ["b3-058", "CursorCloudOperationScope", migration058],
  ["b3-059", "CursorCloudOperationRejected", migration059],
  ["b3-060", "RouterEvaluationObservations", migration060],
  ["b3-061", "RouterObservationEvents", migration061],
  ["b3-062", "ActionGateApprovals", migration062],
  ["b3-063", "ActionGateApprovalUniqueness", migration063],
  ["b3-064", "DreamMemory", migration064],
  ["b3-065", "ConcurrencyBudgetAudit", migration065],
  ["b3-066", "PolicyIntegrationTables", integrationTables],
  ["b3-067", "TaskContractAdmissions", taskContractTables],
  ["b3-068", "TaskContractAdmissionMessage", taskContractAdmissionMessage],
  ["b3-069", "TaskUsageAttempts", taskUsageTables],
];

export const runBase3PolicyMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ledgerTables;
  for (const [id, name, migration] of steps) {
    const existing = yield* sql<{ readonly migration_id: string }>`
      SELECT migration_id FROM base3_policy_migrations WHERE migration_id = ${id}
    `;
    if (existing.length > 0) continue;
    yield* migration;
    const appliedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* sql`
      INSERT INTO base3_policy_migrations (migration_id, name, applied_at)
      VALUES (${id}, ${name}, ${appliedAt})
    `;
  }
});
