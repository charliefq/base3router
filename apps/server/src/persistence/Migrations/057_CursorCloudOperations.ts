import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cursor_cloud_operations (
      command_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      cursor_agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      dispatch_id TEXT,
      binding_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
