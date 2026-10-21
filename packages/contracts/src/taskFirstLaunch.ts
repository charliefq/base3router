import {
  TaskContinuationResult,
  TaskResultHandoff,
  TaskResultHandoffDelivery,
} from "./taskResultHandoff.ts";
export { TaskContinuationResult } from "./taskResultHandoff.ts";
import { TaskReferenceFileReview, TaskReferenceFileDelivery } from "./taskReferenceFile.ts";
import { ChatFileAttachment } from "./chatAttachment.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  TaskInstructionSkillReview,
  TaskInstructionSkillRef,
  TaskInstructionSkillDelivery,
} from "./taskInstructionSkill.ts";
import { CommandId, MessageId, RunId, RunAttemptId, ThreadId } from "./baseSchemas.ts";
import { TaskContract, TaskContractReviewReference } from "./taskContract.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

/** Reviewed input plus a current-task precondition, never a grant or an Auto target lock. */
const LaunchFields = {
  commandId: CommandId,
  messageId: MessageId,
  threadId: ThreadId,
  reference: TaskContractReviewReference,
  contract: TaskContract,
  text: Schema.String,
  routingMode: Schema.Literals(["manual", "auto"]),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
};
const LaunchSchema = Schema.Struct({
  ...LaunchFields,
  resultHandoff: Schema.optionalKey(TaskResultHandoff),
  instructionSkill: Schema.optionalKey(TaskInstructionSkillReview),
  referenceFile: Schema.optionalKey(TaskReferenceFileReview),
});
const decodeStrictLaunch = Schema.decodeUnknownOption(LaunchSchema);
export const TaskFirstLaunch = Schema.Unknown.check(
  Schema.makeFilter((raw) => Option.isSome(decodeStrictLaunch(raw, { onExcessProperty: "error" }))),
).pipe(Schema.decodeTo(LaunchSchema));
const ReviewInputSchema = Schema.Struct({
  launch: TaskFirstLaunch,
  module: TaskInstructionSkillRef,
});
const decodeStrictReviewInput = Schema.decodeUnknownOption(ReviewInputSchema);
export const TaskInstructionSkillReviewInput = Schema.Unknown.check(
  Schema.makeFilter((raw) =>
    Option.isSome(decodeStrictReviewInput(raw, { onExcessProperty: "error" })),
  ),
).pipe(Schema.decodeTo(ReviewInputSchema));
export type TaskInstructionSkillReviewInput = typeof TaskInstructionSkillReviewInput.Type;
export type TaskFirstLaunch = typeof TaskFirstLaunch.Type;
const FileReviewInput = Schema.Struct({
  module: Schema.optionalKey(TaskInstructionSkillRef),
  launch: TaskFirstLaunch,
  attachment: ChatFileAttachment,
  contentSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeFileReviewInput = Schema.decodeUnknownOption(FileReviewInput);
export const TaskReferenceFileReviewInput = Schema.Unknown.check(
  Schema.makeFilter((raw) =>
    Option.isSome(decodeFileReviewInput(raw, { onExcessProperty: "error" })),
  ),
).pipe(Schema.decodeTo(FileReviewInput));
export type TaskReferenceFileReviewInput = typeof TaskReferenceFileReviewInput.Type;

export const TaskResultContinuation = Schema.Struct({
  ...LaunchFields,
  priorResult: TaskContinuationResult,
});
export type TaskResultContinuation = typeof TaskResultContinuation.Type;
export const TaskFirstLaunchStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["unknown", "unavailable", "rejected"]),
    reason: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("admitted"),
    runId: RunId,
    attemptId: RunAttemptId,
    actualModelSelection: ModelSelection,
    resultHandoffSelection: Schema.optionalKey(TaskResultHandoff),
    resultHandoffDelivery: Schema.optionalKey(TaskResultHandoffDelivery),
    referenceFileSelection: Schema.optionalKey(TaskReferenceFileReview),
    referenceFileDelivery: Schema.optionalKey(TaskReferenceFileDelivery),
    instructionSkillSelection: Schema.optionalKey(TaskInstructionSkillReview),
    instructionSkillDelivery: Schema.optionalKey(TaskInstructionSkillDelivery),
    runStatus: Schema.String,
    resultPreview: Schema.NullOr(Schema.String),
  }),
]);
export type TaskFirstLaunchStatus = typeof TaskFirstLaunchStatus.Type;
