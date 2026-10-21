import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agents_task_creation_rejections (
    command_id TEXT PRIMARY KEY REFERENCES orchestration_command_receipts(command_id),
    actor_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    command_json TEXT NOT NULL,
    rejected_at TEXT NOT NULL,
    result_sequence INTEGER NOT NULL
  )`;
});
