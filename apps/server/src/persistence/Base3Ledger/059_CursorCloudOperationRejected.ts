import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE cursor_cloud_operations_rejected (
      operation_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'follow-up', 'cancel')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'indeterminate', 'rejected')),
      command_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      dispatch_id TEXT,
      cursor_agent_id TEXT NOT NULL,
      previous_run_id TEXT,
      request_fingerprint TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      binding_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO cursor_cloud_operations_rejected (
      operation_key,
      kind,
      state,
      command_id,
      environment_id,
      project_id,
      run_id,
      stage_id,
      attempt,
      dispatch_id,
      cursor_agent_id,
      previous_run_id,
      request_fingerprint,
      claimed_at,
      binding_json,
      error_json,
      created_at,
      updated_at
    )
    SELECT
      operation_key,
      kind,
      state,
      command_id,
      environment_id,
      project_id,
      run_id,
      stage_id,
      attempt,
      dispatch_id,
      cursor_agent_id,
      previous_run_id,
      request_fingerprint,
      claimed_at,
      binding_json,
      NULL,
      created_at,
      updated_at
    FROM cursor_cloud_operations
  `;
  yield* sql`DROP TABLE cursor_cloud_operations`;
  yield* sql`ALTER TABLE cursor_cloud_operations_rejected RENAME TO cursor_cloud_operations`;
});
