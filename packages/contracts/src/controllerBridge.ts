import * as Schema from "effect/Schema";
import { PositiveInt, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TaskContractFields } from "./taskContract.ts";
import { TaskResultFeedbackState } from "./collaboration.ts";
import { CollaborationTaskResultReadout } from "./collaboration.ts";

const Key = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(32000));
export const ControllerTool = Schema.Literals([
  "create_task",
  "start_task",
  "get_task",
  "get_result",
  "submit_feedback",
  "cancel_task",
]);
export type ControllerTool = typeof ControllerTool.Type;
const TaskSelector = { taskId: Key };
const Mutation = {
  ...TaskSelector,
  idempotencyKey: Key,
  expectedRevision: PositiveInt,
  expectedFence: PositiveInt,
};
const Target = { runId: Key, attemptId: Key };
/** No paths, generic commands, caller identities, runtime overrides, or provider options. */
export const ControllerToolInputs = {
  create_task: Schema.Struct({
    idempotencyKey: Key,
    projectId: Key,
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
    modelSelection: Schema.Struct({ instanceId: Key, model: Key }),
    contract: TaskContractFields,
  }),
  start_task: Schema.Struct({
    ...Mutation,
    text: Text,
    routingMode: Schema.Literals(["manual", "auto"]),
  }),
  get_task: Schema.Struct(TaskSelector),
  get_result: Schema.Struct(TaskSelector),
  submit_feedback: Schema.Struct({
    ...Mutation,
    ...Target,
    fingerprint: Key,
    contextKey: Key,
    kind: Schema.Literals(["helpful", "not_helpful"]),
    confirm: Schema.Literal(true),
  }),
  cancel_task: Schema.Struct({ ...Mutation, ...Target }),
} as const;
export type ControllerInput<T extends ControllerTool> = (typeof ControllerToolInputs)[T]["Type"];
export const ControllerTaskView = Schema.Struct({
  version: Schema.Literal(1),
  controllerId: Key,
  taskId: Key,
  threadId: Key,
  projectId: Key,
  fence: PositiveInt,
  contractRevision: PositiveInt,
  admission: Schema.Literals(["created", "admitted", "not_started", "unknown"]),
  execution: Schema.Literals(["not_started", "unknown", "observed"]),
  terminal: Schema.Boolean,
  run: Schema.NullOr(Schema.Struct({ ...Target, status: Schema.String })),
  result: CollaborationTaskResultReadout,
  feedback: Schema.NullOr(TaskResultFeedbackState),
  receipt: Schema.NullOr(
    Schema.Struct({ commandId: Key, status: Schema.Literals(["accepted", "rejected", "unknown"]) }),
  ),
});
export type ControllerTaskView = typeof ControllerTaskView.Type;
export const ControllerIdentityView = Schema.Struct({
  id: Key,
  displayName: Schema.String,
  projects: Schema.Array(Key),
  actions: Schema.Array(ControllerTool),
  generation: PositiveInt,
  expiresAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  supervisedTasks: NonNegativeInt,
});
export const ControllerBridgeFailure = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Literals([
    "unauthorized",
    "denied",
    "invalid_request",
    "stale",
    "conflict",
    "unavailable",
  ]),
});
/** Owner-session administration. Configuration and recent traffic do not prove remote connectivity. */
export const ControllerStatus = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  configuration: Schema.Literals(["not_configured", "configured", "revoked", "expired"]),
  identity: Schema.NullOr(ControllerIdentityView),
  lastAuthenticatedAt: Schema.NullOr(Schema.String),
  tasks: Schema.Array(ControllerTaskView),
});
