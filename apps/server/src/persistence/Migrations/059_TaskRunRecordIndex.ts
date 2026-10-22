import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_runs_record_order_idx ON orchestration_v2_projection_runs(requested_at DESC, run_id DESC)`;
});
