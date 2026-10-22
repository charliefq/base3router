import * as Schema from "effect/Schema";
import { ProjectId, RunId, ThreadId } from "./baseSchemas.ts";
import {
  OrchestrationV2RunJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

/** Read directly from durable V2 projections; includes ordinary chat and governed runs. */
export const TaskRunRecord = Schema.Struct({
  run: OrchestrationV2RunJson,
  title: Schema.String,
  projectId: ProjectId,
  governance: Schema.String,
  revision: Schema.NullOr(Schema.Number),
  goal: Schema.NullOr(Schema.String),
  attempts: Schema.Array(OrchestrationV2RunAttemptJson),
  turns: Schema.Array(
    Schema.Struct({
      turn: OrchestrationV2ProviderTurnJson,
      provider: Schema.NullOr(Schema.String),
      accounting: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            inputTokens: Schema.NullOr(Schema.Number),
            outputTokens: Schema.NullOr(Schema.Number),
            status: Schema.String,
          }),
        ),
      ),
    }),
  ),
});
export type TaskRunRecord = typeof TaskRunRecord.Type;
export const TaskRunRecordsPage = Schema.Struct({
  records: Schema.Array(TaskRunRecord),
  nextOffset: Schema.NullOr(Schema.Number),
});
export type TaskRunRecordsPage = typeof TaskRunRecordsPage.Type;
export const TaskRunRecordDetail = Schema.Struct({
  record: TaskRunRecord,
  steps: Schema.Array(OrchestrationV2TurnItemJson),
  hasMoreSteps: Schema.Boolean,
});
export type TaskRunRecordDetail = typeof TaskRunRecordDetail.Type;
export const TaskRunRecordsQuery = Schema.Struct({
  offset: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(10_000_000),
  ),
});
export const TaskRunRecordParams = Schema.Struct({ threadId: ThreadId, runId: RunId });
