import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS concurrency_budget_audit (
      event_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS concurrency_budget_audit_env_recorded
    ON concurrency_budget_audit (environment_id, recorded_at, event_id)
  `;
});
