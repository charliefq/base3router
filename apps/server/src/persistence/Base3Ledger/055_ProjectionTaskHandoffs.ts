import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_task_handoffs (
      handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      destination_message_id TEXT NOT NULL,
      destination_turn_id TEXT,
      target_json TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (thread_id, source_turn_id),
      UNIQUE (thread_id, destination_message_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_task_handoffs_thread_created
    ON projection_task_handoffs(thread_id, created_at DESC, handoff_id DESC)
  `;
});
