import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Additive fork schema; never collides with upstream numeric migration ids. */
export const controllerTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS controller_identities (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_sha256 TEXT UNIQUE NOT NULL,
    projects_json TEXT NOT NULL, actions_json TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1, expires_at TEXT NOT NULL, revoked_at TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS controller_tasks (
    task_id TEXT PRIMARY KEY, controller_id TEXT NOT NULL, project_id TEXT NOT NULL,
    thread_id TEXT UNIQUE NOT NULL, fence INTEGER NOT NULL DEFAULT 1,
    pending_key TEXT, create_command_json TEXT NOT NULL, launch_command_json TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS controller_receipts (
    controller_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, tool TEXT NOT NULL,
    request_sha256 TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL,
    operation_json TEXT NOT NULL, response_json TEXT, error_code TEXT,
    PRIMARY KEY(controller_id, idempotency_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS controller_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, controller_id TEXT,
    tool TEXT NOT NULL, task_id TEXT, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL
  )`;
});
