import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE router_turn_observations ADD COLUMN thread_id TEXT`;
  yield* sql`ALTER TABLE router_turn_observations ADD COLUMN message_id TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS router_turn_observations_env_thread
    ON router_turn_observations (environment_id, thread_id, recorded_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS router_observation_events (
      event_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      observation_id TEXT,
      event_type TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS router_observation_events_env_idempotency
    ON router_observation_events (environment_id, idempotency_key)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS router_observation_events_env_sequence
    ON router_observation_events (environment_id, sequence, event_id)
  `;
});
