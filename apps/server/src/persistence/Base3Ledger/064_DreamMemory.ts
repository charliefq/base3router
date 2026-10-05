import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS dream_memories (
      memory_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      project_id TEXT,
      thread_id TEXT,
      scope_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      content_present INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS dream_memories_env_scope
    ON dream_memories (environment_id, scope_kind, status, updated_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS dream_memories_source
    ON dream_memories (source_fingerprint)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS dream_deleted_sources (
      source_fingerprint TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS dream_jobs (
      job_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS dream_memory_audit (
      event_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS dream_memory_audit_env_recorded
    ON dream_memory_audit (environment_id, recorded_at, event_id)
  `;
});
