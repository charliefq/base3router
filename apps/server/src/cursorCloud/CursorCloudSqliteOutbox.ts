import { CursorCloudRunnerBinding } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  CursorCloudOperationIntent,
  CursorCloudOutbox,
  CursorCloudOutboxRecord,
} from "./CursorCloudOutbox.ts";

type StoredRow = {
  readonly commandId: string;
  readonly kind: CursorCloudOperationIntent["kind"];
  readonly state: "pending" | "completed";
  readonly cursorAgentId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly dispatchId: string | null;
  readonly bindingJson: string | null;
};

const BindingFromJson = Schema.fromJsonString(CursorCloudRunnerBinding);
const decodeBindingJson = Schema.decodeUnknownSync(BindingFromJson);
const encodeBindingJson = Schema.encodeSync(BindingFromJson);

const intentFromRow = (row: StoredRow): CursorCloudOperationIntent => ({
  commandId: row.commandId,
  kind: row.kind,
  cursorAgentId: row.cursorAgentId,
  runId: row.runId,
  stageId: row.stageId,
  attempt: row.attempt,
  ...(row.dispatchId === null ? {} : { dispatchId: row.dispatchId }),
});

const recordFromRow = (row: StoredRow): CursorCloudOutboxRecord => {
  const intent = intentFromRow(row);
  if (row.state === "completed" && row.bindingJson !== null) {
    return {
      state: "completed",
      intent,
      binding: decodeBindingJson(row.bindingJson),
    };
  }
  return { state: "pending", intent };
};

export const makeSqliteCursorCloudOutbox = (
  run: <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>) => Promise<A>,
): CursorCloudOutbox => ({
  async claim(intent) {
    return run(
      Effect.orDie(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT OR IGNORE INTO cursor_cloud_operations (
              command_id,
              kind,
              state,
              cursor_agent_id,
              run_id,
              stage_id,
              attempt,
              dispatch_id,
              binding_json,
              created_at,
              updated_at
            ) VALUES (
              ${intent.commandId},
              ${intent.kind},
              'pending',
              ${intent.cursorAgentId},
              ${intent.runId},
              ${intent.stageId},
              ${intent.attempt},
              ${intent.dispatchId ?? null},
              NULL,
              ${now},
              ${now}
            )
          `;
          const rows = yield* sql<StoredRow>`
            SELECT
              command_id AS "commandId",
              kind,
              state,
              cursor_agent_id AS "cursorAgentId",
              run_id AS "runId",
              stage_id AS "stageId",
              attempt,
              dispatch_id AS "dispatchId",
              binding_json AS "bindingJson"
            FROM cursor_cloud_operations
            WHERE command_id = ${intent.commandId}
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) {
            return { state: "pending" as const, intent };
          }
          return recordFromRow(row);
        }),
      ),
    );
  },
  async complete(commandId, binding) {
    const bindingJson = encodeBindingJson(binding);
    await run(
      Effect.orDie(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE cursor_cloud_operations
            SET
              state = 'completed',
              binding_json = ${bindingJson},
              updated_at = ${now}
            WHERE command_id = ${commandId}
          `;
        }),
      ),
    );
  },
});
