import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Nullable and additive: legacy task definitions and history remain readable.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_occurrence_json TEXT`;
});
