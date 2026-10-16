/**
 * Chat-hub identities and cross-agent tasks.
 * A provider CLI is not an employee. A simulated transport is not a live contractor.
 */
import * as Schema from "effect/Schema";

import {
  OrchestrationV2RunStatus,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderFailure,
} from "./orchestrationV2.ts";

import {
  TaskContract,
  TaskContractPhase,
  TaskContractReviewHint,
  TaskContractReviewInput,
  TaskContractReviewReference,
} from "./taskContract.ts";
import { ExplicitUserFeedbackV0 } from "./routerEvaluation.ts";
import { ModelRouterMode, ModelRouterTarget, ModelRouterSelectionBasis } from "./modelRouter.ts";
import { ModelSelection } from "./modelSelection.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CollaborationConnection = Schema.Literals(["NOT_CONNECTED", "SIMULATED"]);
export type CollaborationConnection = typeof CollaborationConnection.Type;

export const CollaborationAvailability = Schema.Literals([
  "working",
  "waiting",
  "offline",
  "unknown",
]);
export type CollaborationAvailability = typeof CollaborationAvailability.Type;

export const CollaborationOrigin = Schema.Literals(["internal", "external"]);
export type CollaborationOrigin = typeof CollaborationOrigin.Type;

export const CollaborationTaskState = Schema.Literals([
  "running",
  "blocked",
  "review-ready",
  "completed",
]);
export type CollaborationTaskState = typeof CollaborationTaskState.Type;

export const CollaborationMessageKind = Schema.Literals([
  "delegation",
  "clarification",
  "reply",
  "result",
]);
export type CollaborationMessageKind = typeof CollaborationMessageKind.Type;

export const CollaborationGateDecision = Schema.Literals(["ALLOW", "DENY", "ASK"]);
export type CollaborationGateDecision = typeof CollaborationGateDecision.Type;

export const GROKBOT_INTEGRATION_REQUIREMENTS = [
  "Grokbot API base URL",
  "An owner-held credential that is not written into this repository",
  "A capability advertisement that names the target agent",
] as const;

export const CollaborationAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  origin: CollaborationOrigin,
  role: TrimmedNonEmptyString,
  capabilities: Schema.Array(TrimmedNonEmptyString),
  connection: CollaborationConnection,
  availability: CollaborationAvailability,
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(TrimmedNonEmptyString),
});
export type CollaborationAgent = typeof CollaborationAgent.Type;

/** Read-only facts from the validated linked thread, never task title/body defaults. */
export const CollaborationTaskContractReadout = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    contract: TaskContract,
    phase: Schema.NullOr(TaskContractPhase),
    acceptedRevision: Schema.NullOr(PositiveInt),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "ordinary_chat",
      "missing_contract",
      "invalid_contract",
      "invalid_thread_link",
    ]),
  }),
]);
export type CollaborationTaskContractReadout = typeof CollaborationTaskContractReadout.Type;

/** Persisted dispatch facts; a configured model is not provider-attested execution. */
export const CollaborationTaskRoutingReadout = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("available"),
    threadId: TrimmedNonEmptyString,
    messageId: TrimmedNonEmptyString,
    runId: Schema.NullOr(TrimmedNonEmptyString),
    mode: Schema.NullOr(ModelRouterMode),
    selected: Schema.NullOr(ModelRouterTarget),
    source: Schema.NullOr(Schema.String),
    reasons: Schema.Array(Schema.String),
    explanation: Schema.NullOr(Schema.String),
    selectionBasis: Schema.optional(ModelRouterSelectionBasis),
    selectionUnknownReason: Schema.NullOr(Schema.String),
    configuredModel: Schema.NullOr(ModelSelection),
    execution: Schema.Union([
      Schema.Struct({
        status: Schema.Literal("unknown"),
        reason: Schema.String,
        providerTurnId: Schema.Null,
        providerStatus: Schema.Null,
        startedAt: Schema.Null,
      }),
      Schema.Struct({
        status: Schema.Literal("observed"),
        reason: Schema.Null,
        providerTurnId: TrimmedNonEmptyString,
        providerStatus: Schema.Literals([
          "running",
          "completed",
          "interrupted",
          "failed",
          "cancelled",
        ]),
        startedAt: TrimmedNonEmptyString,
      }),
    ]),
  }),
]);
export type CollaborationTaskRoutingReadout = typeof CollaborationTaskRoutingReadout.Type;

/** UTF-16 length cap; output is a plain-text preview, not an accepted answer. */
export const COLLABORATION_RESULT_PREVIEW_MAX_CHARS = 2_048;
export const CollaborationTaskResultReadout = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("available"),
    runId: TrimmedNonEmptyString,
    messageId: TrimmedNonEmptyString,
    runStatus: OrchestrationV2RunStatus,
    attemptId: Schema.NullOr(TrimmedNonEmptyString),
    providerTurnId: Schema.NullOr(TrimmedNonEmptyString),
    providerTurnStatus: Schema.NullOr(OrchestrationV2ProviderTurn.fields.status),
    modelIdentity: OrchestrationV2ProviderTurn.fields.modelIdentity,
    content: Schema.Union([
      Schema.Struct({ status: Schema.Literal("unknown"), reason: Schema.String }),
      Schema.Struct({
        status: Schema.Literal("output"),
        itemId: TrimmedNonEmptyString,
        preview: Schema.String.check(Schema.isMaxLength(COLLABORATION_RESULT_PREVIEW_MAX_CHARS)),
        truncated: Schema.Boolean,
      }),
      Schema.Struct({
        status: Schema.Literal("failure"),
        itemId: TrimmedNonEmptyString,
        failure: Schema.Struct({
          class: OrchestrationV2ProviderFailure.fields.class,
          code: OrchestrationV2ProviderFailure.fields.code,
          message: Schema.String.check(Schema.isMaxLength(COLLABORATION_RESULT_PREVIEW_MAX_CHARS)),
        }),
        truncated: Schema.Boolean,
      }),
    ]),
  }),
]);
export type CollaborationTaskResultReadout = typeof CollaborationTaskResultReadout.Type;

/** Snapshot evidence only. Neither availability nor remaining budget grants execution. */
const BudgetAmount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export const CollaborationTaskBudgetReadout = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("available"),
    taskId: TrimmedNonEmptyString,
    threadId: TrimmedNonEmptyString,
    rootThreadId: TrimmedNonEmptyString,
    environmentId: TrimmedNonEmptyString,
    contractRevision: PositiveInt,
    observedAt: TrimmedNonEmptyString,
    reservedStarts: NonNegativeInt,
    declaredStarts: PositiveInt,
    remainingStarts: NonNegativeInt,
    declared: Schema.Struct({
      tokens: Schema.NullOr(Schema.Number),
      costUsd: Schema.NullOr(BudgetAmount),
      deadline: Schema.NullOr(Schema.String),
    }),
    frozen: Schema.NullOr(
      Schema.Struct({
        tokens: Schema.NullOr(Schema.Number),
        costUsd: Schema.NullOr(BudgetAmount),
        deadline: Schema.String,
        frozenAt: Schema.String,
      }),
    ),
    usage: Schema.Struct({
      status: Schema.Literals(["complete", "partial", "unknown"]),
      attempts: NonNegativeInt,
      reportedTokens: Schema.NullOr(NonNegativeInt),
      reportedCostUsd: Schema.NullOr(BudgetAmount),
      priceStatus: Schema.Literals(["synthetic_verified", "unverified", "no_attempts"]),
      remainingTokens: Schema.NullOr(NonNegativeInt),
      verifiedRemainingCostUsd: Schema.NullOr(BudgetAmount),
    }),
    issues: Schema.Array(Schema.String),
  }),
]);
export type CollaborationTaskBudgetReadout = typeof CollaborationTaskBudgetReadout.Type;

export const CollaborationTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  ownerAgentId: TrimmedNonEmptyString,
  assigneeAgentId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  state: CollaborationTaskState,
  waitReason: Schema.NullOr(Schema.String),
  acceptance: TrimmedNonEmptyString,
  threadId: Schema.NullOr(TrimmedNonEmptyString),
  correlationId: TrimmedNonEmptyString,
  revision: Schema.Number,
  pendingClarificationId: Schema.NullOr(TrimmedNonEmptyString),
  gateDecision: CollaborationGateDecision,
  contractReadout: Schema.optionalKey(CollaborationTaskContractReadout),
  review: Schema.optionalKey(TaskContractReviewHint),
  routingReadout: Schema.optionalKey(CollaborationTaskRoutingReadout),
  resultReadout: Schema.optionalKey(CollaborationTaskResultReadout),
  budgetReadout: Schema.optionalKey(CollaborationTaskBudgetReadout),
});
export type CollaborationTask = typeof CollaborationTask.Type;

export const CollaborationMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  senderId: TrimmedNonEmptyString,
  recipientId: TrimmedNonEmptyString,
  replyTo: Schema.NullOr(TrimmedNonEmptyString),
  kind: CollaborationMessageKind,
  body: TrimmedNonEmptyString,
  correlationId: TrimmedNonEmptyString,
  revision: Schema.Number,
  grantsExecution: Schema.Literal(false),
  transport: Schema.Literals(["simulated", "internal"]),
});
export type CollaborationMessage = typeof CollaborationMessage.Type;

export const CollaborationSnapshot = Schema.Struct({
  environmentId: Schema.optionalKey(TrimmedNonEmptyString),
  agents: Schema.Array(CollaborationAgent),
  tasks: Schema.Array(CollaborationTask),
  messages: Schema.Array(CollaborationMessage),
  realGrokbot: Schema.Literal("NOT_CONNECTED"),
  grokbotIntegration: Schema.Array(TrimmedNonEmptyString),
});
export type CollaborationSnapshot = typeof CollaborationSnapshot.Type;

export const CollaborationCommand = Schema.Struct({
  type: Schema.Literals([
    "agent.register",
    "transport.simulate",
    "delegate",
    "resolve",
    "clarify",
    "reply",
    "result",
    "accept",
    "thread.bind",
    "task.enroll",
    "scenario.rehearse",
  ]),
  commandId: TrimmedNonEmptyString,
  agentId: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  origin: Schema.optional(CollaborationOrigin),
  role: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  projectId: Schema.optional(TrimmedNonEmptyString),
  correlationId: Schema.optional(TrimmedNonEmptyString),
  fromAgentId: Schema.optional(TrimmedNonEmptyString),
  toAgentId: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(TrimmedNonEmptyString),
  acceptance: Schema.optional(TrimmedNonEmptyString),
  actor: Schema.optional(Schema.Literal("owner")),
  name: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(TrimmedNonEmptyString),
  replyTo: Schema.optional(TrimmedNonEmptyString),
  scenario: Schema.optional(Schema.Literals(["A", "B"])),
  threadId: Schema.optional(TrimmedNonEmptyString),
  admittedBy: Schema.optional(TrimmedNonEmptyString),
  admissionSource: Schema.optional(Schema.Literal("server")),
  originCommandId: Schema.optionalKey(TrimmedNonEmptyString),
  upgradeCommandId: Schema.optionalKey(TrimmedNonEmptyString),
  upgradeEventId: Schema.optionalKey(TrimmedNonEmptyString),
  gateDecision: Schema.optional(CollaborationGateDecision),
  revision: Schema.optional(Schema.Number),
});
export type CollaborationCommand = typeof CollaborationCommand.Type;

export const CollaborationRejection = Schema.Literals([
  "ambiguous-target",
  "not-connected",
  "cross-project",
  "unknown-agent",
  "unauthorized",
  "identity-conflict",
  "not-ready",
]);
export type CollaborationRejection = typeof CollaborationRejection.Type;

export const CollaborationCommandResult = Schema.Struct({
  outcome: Schema.Literals(["applied", "rejected"]),
  code: Schema.NullOr(CollaborationRejection),
  detail: Schema.String,
  idempotent: Schema.Boolean,
  gateDecision: Schema.NullOr(CollaborationGateDecision),
  snapshot: CollaborationSnapshot,
});
export type CollaborationCommandResult = typeof CollaborationCommandResult.Type;

export const CollaborationOpenThreadInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  providerId: TrimmedNonEmptyString,
});
export type CollaborationOpenThreadInput = typeof CollaborationOpenThreadInput.Type;

export const TaskResultFeedbackInput = TaskContractReviewInput;
export type TaskResultFeedbackInput = typeof TaskResultFeedbackInput.Type;
export const TaskResultFeedbackState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("available"),
    target: TaskResultFeedbackInput,
    reference: TaskContractReviewReference,
    fingerprint: TrimmedNonEmptyString,
    contextKey: TrimmedNonEmptyString,
    title: Schema.String,
    model: ModelSelection,
    result: CollaborationTaskResultReadout,
    feedback: Schema.Array(ExplicitUserFeedbackV0),
    feedbackForResult: Schema.Boolean,
  }),
]);
export type TaskResultFeedbackState = typeof TaskResultFeedbackState.Type;
export const TaskResultFeedbackSubmit = Schema.Struct({
  ...TaskResultFeedbackInput.fields,
  reference: TaskContractReviewReference,
  fingerprint: TrimmedNonEmptyString,
  contextKey: TrimmedNonEmptyString,
  kind: Schema.Literals(["helpful", "not_helpful"]),
  confirm: Schema.Literal(true),
});
export type TaskResultFeedbackSubmit = typeof TaskResultFeedbackSubmit.Type;
