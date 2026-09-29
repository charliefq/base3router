import { CursorCloudRunnerBinding } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  cloneCursorCloudIntent,
  cursorCloudCommandConflict,
  cursorCloudIntentConflicts,
  cursorCloudOperationKey,
  type CursorCloudOperationIntent,
  type CursorCloudOperationKind,
  type CursorCloudOperationState,
  type CursorCloudOutbox,
  type CursorCloudOutboxRecord,
} from "./CursorCloudOutbox.ts";

type StoredRow = {
  readonly operationKey: string;
  readonly kind: CursorCloudOperationKind;
  readonly state: CursorCloudOperationState;
  readonly commandId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly dispatchId: string | null;
  readonly cursorAgentId: string;
  readonly previousRunId: string | null;
  readonly requestFingerprint: string;
  readonly claimedAt: string;
  readonly bindingJson: string | null;
};

const BindingFromJson = Schema.fromJsonString(CursorCloudRunnerBinding);
const decodeBindingJson = Schema.decodeUnknownSync(BindingFromJson);
const encodeBindingJson = Schema.encodeSync(BindingFromJson);

const intentFromRow = (row: StoredRow): CursorCloudOperationIntent => ({
  commandId: row.commandId,
  kind: row.kind,
  environmentId: row.environmentId,
  projectId: row.projectId,
  runId: row.runId,
  stageId: row.stageId,
  attempt: row.attempt,
  cursorAgentId: row.cursorAgentId,
  requestFingerprint: row.requestFingerprint,
  claimedAt: row.claimedAt,
  ...(row.dispatchId === null ? {} : { dispatchId: row.dispatchId }),
  ...(row.previousRunId === null ? {} : { previousRunId: row.previousRunId }),
});

const recordFromRow = (row: StoredRow, inserted: boolean): CursorCloudOutboxRecord => {
  const intent = intentFromRow(row);
  if (row.state === "completed" && row.bindingJson !== null) {
    return { state: "completed", intent, binding: decodeBindingJson(row.bindingJson) };
  }
  if (row.state === "indeterminate") {
    return { state: "indeterminate", intent };
  }
  return { state: inserted ? "accepted" : "pending", intent };
};

export const makeSqliteCursorCloudOutbox = (
  run: <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>) => Promise<A>,
): CursorCloudOutbox => ({
  async claim(intent) {
    const key = cursorCloudOperationKey(intent);
    const { inserted, row } = await run(
      Effect.orDie(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const sql = yield* SqlClient.SqlClient;
          const insertedRows = yield* sql<{ readonly operationKey: string }>`
            INSERT OR IGNORE INTO cursor_cloud_operations (
              operation_key,
              kind,
              state,
              command_id,
              environment_id,
              project_id,
              run_id,
              stage_id,
              attempt,
              dispatch_id,
              cursor_agent_id,
              previous_run_id,
              request_fingerprint,
              claimed_at,
              binding_json,
              created_at,
              updated_at
            ) VALUES (
              ${key},
              ${intent.kind},
              'pending',
              ${intent.commandId},
              ${intent.environmentId},
              ${intent.projectId},
              ${intent.runId},
              ${intent.stageId},
              ${intent.attempt},
              ${intent.dispatchId ?? null},
              ${intent.cursorAgentId},
              ${intent.previousRunId ?? null},
              ${intent.requestFingerprint},
              ${intent.claimedAt ?? now},
              NULL,
              ${now},
              ${now}
            )
            RETURNING operation_key AS "operationKey"
          `;
          const rows = yield* sql<StoredRow>`
            SELECT
              operation_key AS "operationKey",
              kind,
              state,
              command_id AS "commandId",
              environment_id AS "environmentId",
              project_id AS "projectId",
              run_id AS "runId",
              stage_id AS "stageId",
              attempt,
              dispatch_id AS "dispatchId",
              cursor_agent_id AS "cursorAgentId",
              previous_run_id AS "previousRunId",
              request_fingerprint AS "requestFingerprint",
              claimed_at AS "claimedAt",
              binding_json AS "bindingJson"
            FROM cursor_cloud_operations
            WHERE operation_key = ${key}
            LIMIT 1
          `;
          return { inserted: insertedRows.length === 1, row: rows[0] };
        }),
      ),
    );
    if (row === undefined) {
      return { state: "accepted", intent: cloneCursorCloudIntent(intent) };
    }
    if (cursorCloudIntentConflicts(intentFromRow(row), intent)) {
      throw cursorCloudCommandConflict();
    }
    return recordFromRow(row, inserted);
  },
  async complete(intent, binding) {
    const key = cursorCloudOperationKey(intent);
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
            WHERE operation_key = ${key}
          `;
        }),
      ),
    );
  },
  async markIndeterminate(intent) {
    const key = cursorCloudOperationKey(intent);
    await run(
      Effect.orDie(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE cursor_cloud_operations
            SET
              state = 'indeterminate',
              updated_at = ${now}
            WHERE operation_key = ${key}
          `;
        }),
      ),
    );
  },
});
