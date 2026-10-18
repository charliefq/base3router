import * as Schema from "effect/Schema";
import { CommandId, MessageId, RunId, RunAttemptId, ThreadId } from "./baseSchemas.ts";
import { TaskContract, TaskContractReviewReference } from "./taskContract.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

/** Reviewed input plus a current-task precondition, never a grant or an Auto target lock. */
export const TaskFirstLaunch = Schema.Struct({
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
});
export type TaskFirstLaunch = typeof TaskFirstLaunch.Type;
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
    runStatus: Schema.String,
    resultPreview: Schema.NullOr(Schema.String),
  }),
]);
export type TaskFirstLaunchStatus = typeof TaskFirstLaunchStatus.Type;
