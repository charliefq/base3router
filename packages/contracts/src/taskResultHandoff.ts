import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  PositiveInt,
  ThreadId,
  RunId,
  RunAttemptId,
  MessageId,
  IsoDateTime,
} from "./baseSchemas.ts";
import { TaskContractReviewReference } from "./taskContract.ts";
import { ModelSelection } from "./modelSelection.ts";
export const TASK_RESULT_HANDOFF_MAX_CHARS = 16_000;
export const TASK_RESULT_HANDOFF_MAX_BYTES = 65_536;
/** Complete attributed output identity; digest covers the full text, never its preview. */
export const TaskContinuationResult = Schema.Struct({
  runId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  attemptId: TrimmedNonEmptyString,
  providerThreadId: TrimmedNonEmptyString,
  providerTurnId: TrimmedNonEmptyString,
  itemId: TrimmedNonEmptyString,
  rootNodeId: TrimmedNonEmptyString,
  nodeId: TrimmedNonEmptyString,
  outputSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type TaskContinuationResult = typeof TaskContinuationResult.Type;
/** Data provenance only: never a grant, dependency or execution lineage. */
export const TaskResultHandoff = Schema.Struct({
  reference: TaskContractReviewReference,
  threadId: ThreadId,
  revision: PositiveInt,
  eventSequence: PositiveInt,
  title: TrimmedNonEmptyString,
  result: TaskContinuationResult,
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(TASK_RESULT_HANDOFF_MAX_CHARS),
  ),
});
export type TaskResultHandoff = typeof TaskResultHandoff.Type;
export const TaskResultHandoffDelivery = Schema.Struct({
  status: Schema.Literals(["unknown", "adapter-accepted"]),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  inputSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  runId: RunId,
  attemptId: RunAttemptId,
  messageId: MessageId,
  modelSelection: ModelSelection,
  observedAt: IsoDateTime,
});
export type TaskResultHandoffDelivery = typeof TaskResultHandoffDelivery.Type;
