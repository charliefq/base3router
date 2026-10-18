import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** A server-prepared proposal; only the matching authenticated command can admit it. */
export const TaskCapabilityStep = Schema.Struct({
  version: Schema.Literal("server-owned-pr-read.v1"),
  reviewId: TrimmedNonEmptyString,
  actorId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  workspace: TrimmedNonEmptyString,
  projectWorkspace: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  threadId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  revision: PositiveInt,
  contractDigest: TrimmedNonEmptyString,
  threadUpdatedAt: IsoDateTime,
  threadSequence: Schema.Int,
  modelSelection: ModelSelection,
  toolId: Schema.Literal("t3-pull-requests/list_thread_pull_requests"),
  schemaDigest: TrimmedNonEmptyString,
  argumentsJson: Schema.Literal("{}"),
  commandId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  promptDigest: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  attemptId: TrimmedNonEmptyString,
  maxCalls: Schema.Literal(1),
  maxResultBytes: Schema.Literal(32768),
  expiresAt: IsoDateTime,
  fingerprint: TrimmedNonEmptyString,
});
export type TaskCapabilityStep = typeof TaskCapabilityStep.Type;
export const TaskCapabilityStepRequest = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export const TaskCapabilityStepState = Schema.Struct({
  review: TaskCapabilityStep,
  status: Schema.Literals(["reviewed", "admitted", "unknown", "succeeded", "failed"]),
  detail: Schema.NullOr(Schema.String),
  observedAt: Schema.NullOr(IsoDateTime),
  resultJson: Schema.NullOr(Schema.String),
  resultDigest: Schema.NullOr(Schema.String),
  source: Schema.Literal("persisted-thread-pr-state"),
});
export type TaskCapabilityStepState = typeof TaskCapabilityStepState.Type;
