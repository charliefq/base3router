import {
  TaskRunRecord,
  OrchestrationV2TurnItemJson,
  type TaskRunRecordDetail,
  type TaskRunRecordsPage,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class TaskRecordsReadError extends Schema.TaggedError<TaskRecordsReadError>()(
  "TaskRecordsReadError",
  { cause: Schema.Defect() },
) {}
export class TaskRecords extends Context.Service<
  TaskRecords,
  {
    readonly list: (offset: number) => Effect.Effect<TaskRunRecordsPage, TaskRecordsReadError>;
    readonly detail: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<TaskRunRecordDetail | null, TaskRecordsReadError>;
  }
>()("t3/orchestration-v2/TaskRecords") {}

const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(TaskRunRecord));
const decodeStep = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.fn("TaskRecords.read")(function* (
    offset: number,
    threadId?: ThreadId,
    runId?: RunId,
  ) {
    // Paginate runs before joining their evidence. Archived/settled threads are included;
    // deleted threads follow the same visibility boundary as conversation history.
    const rows = yield* sql<{ payload: string }>`
      SELECT json_object(
        'run', json(r.payload_json), 'title', t.title, 'projectId', t.project_id,
        'governance', COALESCE(json_extract(t.payload_json, '$.taskGovernance'), 'chat'),
        'revision', (SELECT contract_revision FROM task_usage_attempts WHERE run_id = r.run_id AND thread_id = r.thread_id ORDER BY updated_at DESC LIMIT 1),
        'goal', (SELECT json_extract(m.payload_json, '$.text') FROM orchestration_v2_projection_messages m WHERE m.message_id = json_extract(r.payload_json, '$.userMessageId')),
        'attempts', json((SELECT json_group_array(json(a.payload_json)) FROM (SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE run_id = r.run_id ORDER BY attempt_ordinal) a)),
        'turns', json((SELECT json_group_array(json_object('turn', json(p.payload_json), 'provider', json_extract(pt.payload_json, '$.driver'), 'accounting', json((SELECT json_object('inputTokens', u.input_tokens, 'outputTokens', u.output_tokens, 'status', u.usage_status) FROM task_usage_attempts u WHERE u.provider_turn_id = p.provider_turn_id AND u.thread_id = p.thread_id ORDER BY u.updated_at DESC LIMIT 1)))) FROM orchestration_v2_projection_provider_turns p LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = p.provider_thread_id WHERE p.thread_id = r.thread_id AND (
          p.node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE run_id = r.run_id)
          OR p.run_attempt_id IN (SELECT attempt_id FROM orchestration_v2_projection_run_attempts WHERE run_id = r.run_id)
          OR p.provider_turn_id IN (SELECT provider_turn_id FROM orchestration_v2_projection_run_attempts WHERE run_id = r.run_id)
        )))
      ) AS payload
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE t.deleted_at IS NULL AND ${threadId === undefined ? sql`1 = 1` : sql`r.thread_id = ${threadId} AND r.run_id = ${runId!}`}
      ORDER BY r.requested_at DESC, r.run_id DESC LIMIT ${threadId === undefined ? 51 : 1} OFFSET ${offset}
    `;
    return yield* Effect.forEach(rows, (row) => decodeRecord(row.payload));
  });
  return TaskRecords.of({
    list: (offset) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const records = yield* read(offset);
            return {
              records: records.slice(0, 50),
              nextOffset: records.length > 50 ? offset + 50 : null,
            };
          }),
        )
        .pipe(Effect.mapError((cause) => new TaskRecordsReadError({ cause }))),
    detail: (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const records = yield* read(0, threadId, runId);
            const record = records[0];
            if (!record) return null;
            const rows = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} AND run_id = ${runId} ORDER BY ordinal DESC, turn_item_id DESC LIMIT 201`;
            const steps = yield* Effect.forEach(rows.slice(0, 200).toReversed(), (row) =>
              decodeStep(row.payload_json),
            );
            return { record, steps, hasMoreSteps: rows.length > 200 };
          }),
        )
        .pipe(Effect.mapError((cause) => new TaskRecordsReadError({ cause }))),
  });
});
export const layer = Layer.effect(TaskRecords, make);
