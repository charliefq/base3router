import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS action_gate_approvals (
      approval_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS action_gate_approvals_idempotency
    ON action_gate_approvals (idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS action_gate_audit (
      event_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS action_gate_audit_env_recorded
    ON action_gate_audit (environment_id, recorded_at, event_id)
  `;
});
