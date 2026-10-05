import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS action_gate_approvals_idempotency`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS action_gate_approvals_env_idempotency
    ON action_gate_approvals (environment_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS action_gate_approvals_live_fingerprint
    ON action_gate_approvals (environment_id, fingerprint)
    WHERE status IN ('pending', 'granted')
  `;
  // Duplicate live fingerprints fail closed. Do not merge rows. Inspect both
  // approvals, move the unintended live row to a terminal status, retry this
  // migration, or restore a compatible backup taken before the upgrade.
});
