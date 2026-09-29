import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE cursor_cloud_operations_scoped (
      operation_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'follow-up', 'cancel')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'indeterminate')),
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`DROP TABLE IF EXISTS cursor_cloud_operations`;
  yield* sql`ALTER TABLE cursor_cloud_operations_scoped RENAME TO cursor_cloud_operations`;
});
