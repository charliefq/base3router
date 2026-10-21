import { WorktreeMcpStatusResult } from "./worktreeMcp.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { DispatcherTaskRouteBinding } from "./dispatcher.ts";

/** A server-prepared proposal; only the matching authenticated command can admit it. */
const StepFields = {
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
  /** Absent on the compatible explicit Manual path. Authority remains server persisted. */
  reviewedIntent: Schema.optional(
    Schema.Struct({
      text: TrimmedNonEmptyString,
      /** Absent on earlier saved-summary reviews, which retain summary meaning. */
      question: Schema.optional(Schema.Literals(["summary", "open", "draft", "workspace"])),
      configuredModelSelection: ModelSelection,
      route: DispatcherTaskRouteBinding,
      routingBasisDigest: TrimmedNonEmptyString,
    }),
  ),
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
};
const StepSchema = Schema.Union([
  Schema.Struct({
    ...StepFields,
    version: Schema.Literal("server-owned-pr-read.v1"),
    toolId: Schema.Literal("t3-pull-requests/list_thread_pull_requests"),
  }),
  Schema.Struct({
    ...StepFields,
    version: Schema.Literal("server-owned-workspace-read.v1"),
    toolId: Schema.Literal("t3-code/t3_worktree_status"),
    recordedBranch: Schema.NullOr(Schema.String),
    recordedWorktreePath: Schema.NullOr(Schema.String),
  }),
]);
const decodeStrictStep = Schema.decodeUnknownOption(StepSchema);
export const TaskCapabilityStep = Schema.Unknown.check(
  Schema.makeFilter((raw) => Option.isSome(decodeStrictStep(raw, { onExcessProperty: "error" })), {
    message: "Invalid or expanded capability review.",
  }),
).pipe(Schema.decodeTo(StepSchema));
export type TaskCapabilityStep = typeof TaskCapabilityStep.Type;
const RequestSchema = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  capability: Schema.optional(Schema.Literal("recorded-workspace")),
  suggestFromInstructions: Schema.optional(Schema.Literal(true)),
});
const decodeStrictRequest = Schema.decodeUnknownOption(RequestSchema);
export const TaskCapabilityStepRequest = Schema.Unknown.check(
  Schema.makeFilter(
    (raw) => Option.isSome(decodeStrictRequest(raw, { onExcessProperty: "error" })),
    { message: "Invalid or expanded capability request." },
  ),
).pipe(Schema.decodeTo(RequestSchema));
export const TaskCapabilityStepState = Schema.Struct({
  review: TaskCapabilityStep,
  status: Schema.Literals(["reviewed", "admitted", "unknown", "succeeded", "failed"]),
  detail: Schema.NullOr(Schema.String),
  observedAt: Schema.NullOr(IsoDateTime),
  resultJson: Schema.NullOr(Schema.String),
  resultDigest: Schema.NullOr(Schema.String),
  source: Schema.Literals(["persisted-thread-pr-state", "recorded-thread-project-settings"]),
});
export type TaskCapabilityStepState = typeof TaskCapabilityStepState.Type;

/** Operation provenance is persisted with the bounded metadata, independently of model success. */
export const TaskRecordedWorkspaceResult = Schema.Struct({
  ...WorktreeMcpStatusResult.fields,
  readAuthorization: Schema.Struct({
    fingerprint: TrimmedNonEmptyString,
    approvalId: Schema.NullOr(TrimmedNonEmptyString),
  }),
});
