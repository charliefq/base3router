import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS router_turn_observations (
      observation_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS router_turn_observations_env_recorded
    ON router_turn_observations (environment_id, recorded_at, observation_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS router_policies (
      policy_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS router_policies_env_state
    ON router_policies (environment_id, state)
  `;
});
