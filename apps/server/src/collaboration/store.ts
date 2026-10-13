import {
  CollaborationCommand,
  type OrchestrationV2Command,
  TaskContractBrake,
  AuthOrchestrationOperateScope,
  type CollaborationTask,
  type TaskContractReviewInput,
  type TaskContractReviewState,
  type TaskContractReviewReference,
  type TaskContractReviewAction,
  RawEventId,
  OrchestrationV2AppThreadJson,
  COLLABORATION_RESULT_PREVIEW_MAX_CHARS,
  type CollaborationTaskResultReadout,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItemStatus,
  type CollaborationSnapshot,
  type CollaborationTaskContractReadout,
  type CollaborationTaskRoutingReadout,
  DispatcherTaskRouteBinding,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  TaskContract,
  TaskContractPhase,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OwnedChat from "./ownedChat.ts";

import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";

import { applyCollaboration, foldCollaboration, foldCollaborationState } from "./decide.ts";

export class GovernedEnrollmentError extends Schema.TaggedError<GovernedEnrollmentError>()(
  "GovernedEnrollmentError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "Governed task enrollment requires consistent persisted root ownership.";
  }
}
const decodeGovernedThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeSelectionMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      runId: Schema.optionalKey(OrchestrationV2Run.fields.id),
      nodeId: Schema.optionalKey(OrchestrationV2ExecutionNode.fields.id),
      driver: Schema.optionalKey(OrchestrationV2ProviderThread.fields.driver),
      providerInstanceId: Schema.optionalKey(
        OrchestrationV2ProviderThread.fields.providerInstanceId,
      ),
      rawEventId: Schema.optionalKey(RawEventId),
    }),
  ),
);
const isGovernedRoot = (thread: OrchestrationV2AppThreadJson) =>
  thread.taskGovernance === "required" &&
  thread.creationSource !== "provider" &&
  thread.lineage.rootThreadId === thread.id &&
  thread.lineage.parentThreadId === null &&
  thread.lineage.relationshipToParent === null &&
  thread.forkedFrom === null;
const isActiveGovernedRoot = (thread: OrchestrationV2AppThreadJson) =>
  isGovernedRoot(thread) && thread.archivedAt === null && thread.deletedAt === null;

const StoredContract = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  providerInstanceId: Schema.optionalKey(Schema.String),
  taskGovernance: Schema.optionalKey(Schema.Literals(["chat", "required"])),
  taskContract: Schema.optionalKey(Schema.NullOr(TaskContract)),
  taskContractPhase: Schema.optionalKey(TaskContractPhase),
  taskAcceptedRevision: Schema.optionalKey(
    Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  ),
});
const decodeStoredContract = Schema.decodeUnknownOption(Schema.fromJsonString(StoredContract));
const contractReadout = (row: {
  readonly thread_id: string;
  readonly project_id: string;
  readonly provider_instance_id: string;
  readonly payload_json: string;
}): CollaborationTaskContractReadout => {
  const decoded = decodeStoredContract(row.payload_json);
  if (decoded._tag === "None") return { status: "unavailable", reason: "invalid_contract" };
  const value = decoded.value;
  if (
    (value.id !== undefined && value.id !== row.thread_id) ||
    (value.projectId !== undefined && value.projectId !== row.project_id) ||
    (value.providerInstanceId !== undefined &&
      value.providerInstanceId !== row.provider_instance_id)
  )
    return { status: "unavailable", reason: "invalid_contract" };
  if (value.taskContract == null)
    return {
      status: "unavailable",
      reason: value.taskGovernance === "required" ? "missing_contract" : "ordinary_chat",
    };
  return {
    status: "available",
    contract: value.taskContract,
    phase: value.taskContractPhase ?? null,
    acceptedRevision: value.taskAcceptedRevision ?? null,
  };
};

const StoredRunEvidence = Schema.Struct({
  id: OrchestrationV2Run.fields.id,
  threadId: OrchestrationV2Run.fields.threadId,
  ordinal: OrchestrationV2Run.fields.ordinal,
  providerInstanceId: OrchestrationV2Run.fields.providerInstanceId,
  modelSelection: OrchestrationV2Run.fields.modelSelection,
  userMessageId: OrchestrationV2Run.fields.userMessageId,
  activeAttemptId: OrchestrationV2Run.fields.activeAttemptId,
  rootNodeId: OrchestrationV2Run.fields.rootNodeId,
  providerThreadId: OrchestrationV2Run.fields.providerThreadId,
  status: OrchestrationV2Run.fields.status,
});
const StoredAttemptEvidence = Schema.Struct({
  id: OrchestrationV2RunAttempt.fields.id,
  runId: OrchestrationV2RunAttempt.fields.runId,
  rootNodeId: OrchestrationV2RunAttempt.fields.rootNodeId,
  providerInstanceId: OrchestrationV2RunAttempt.fields.providerInstanceId,
  providerThreadId: OrchestrationV2RunAttempt.fields.providerThreadId,
  providerTurnId: OrchestrationV2RunAttempt.fields.providerTurnId,
});
const StoredProviderThreadEvidence = Schema.Struct({
  id: OrchestrationV2ProviderThread.fields.id,
  appThreadId: OrchestrationV2ProviderThread.fields.appThreadId,
  providerInstanceId: OrchestrationV2ProviderThread.fields.providerInstanceId,
});
const StoredTurnEvidence = Schema.Struct({
  id: OrchestrationV2ProviderTurn.fields.id,
  providerThreadId: OrchestrationV2ProviderTurn.fields.providerThreadId,
  nodeId: OrchestrationV2ProviderTurn.fields.nodeId,
  runAttemptId: OrchestrationV2ProviderTurn.fields.runAttemptId,
  status: OrchestrationV2ProviderTurn.fields.status,
  startedAt: Schema.NullOr(Schema.String),
});
const decodeRunEvidence = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRunEvidence));
const decodeAttemptEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredAttemptEvidence),
);
const decodeProviderThreadEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredProviderThreadEvidence),
);
const decodeTurnEvidence = Schema.decodeUnknownOption(Schema.fromJsonString(StoredTurnEvidence));
const decodeRouteEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(DispatcherTaskRouteBinding),
);
const unknownExecution = (reason: string) => ({
  status: "unknown" as const,
  reason,
  providerTurnId: null,
  providerStatus: null,
  startedAt: null,
});

const readRoutingEvidence = (
  sql: SqlClient.SqlClient,
  threadId: string,
): Effect.Effect<CollaborationTaskRoutingReadout> =>
  Effect.gen(function* () {
    const runs = yield* sql<{
      run_id: string;
      thread_id: string;
      ordinal: number;
      provider_instance_id: string;
      status: string;
      payload_json: string;
    }>`
      SELECT run_id, thread_id, ordinal, provider_instance_id, status, payload_json
      FROM orchestration_v2_projection_runs WHERE thread_id=${threadId}
      ORDER BY ordinal DESC, run_id DESC LIMIT 1
    `;
    const row = runs[0];
    const parsedRun = row === undefined ? null : decodeRunEvidence(row.payload_json);
    if (parsedRun?._tag === "None")
      return { status: "unavailable" as const, reason: "invalid_run" };
    const run = parsedRun?._tag === "Some" ? parsedRun.value : null;
    if (
      run !== null &&
      row !== undefined &&
      (run.id !== row.run_id ||
        run.threadId !== threadId ||
        row.thread_id !== threadId ||
        run.ordinal !== row.ordinal ||
        run.providerInstanceId !== row.provider_instance_id ||
        run.modelSelection.instanceId !== run.providerInstanceId ||
        run.status !== row.status)
    )
      return { status: "unavailable" as const, reason: "invalid_run" };
    // With a run, require that exact message; never borrow an older route.
    const routes =
      run === null
        ? yield* sql<{
            message_id: string;
            binding_json: string;
          }>`SELECT message_id, binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} ORDER BY created_at DESC, message_id DESC LIMIT 1`
        : yield* sql<{
            message_id: string;
            binding_json: string;
          }>`SELECT message_id, binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${run.userMessageId} LIMIT 1`;
    const routeRow = routes[0];
    if (run === null && routeRow === undefined)
      return { status: "unavailable" as const, reason: "no_dispatch_evidence" };
    const parsedRoute = routeRow === undefined ? null : decodeRouteEvidence(routeRow.binding_json);
    const binding = parsedRoute?._tag === "Some" ? parsedRoute.value : null;
    const decision = binding?.modelRoute;
    const selected =
      decision === undefined ? (binding?.target ?? null) : (decision.selected?.target ?? null);
    const routeConsistent =
      binding !== null &&
      (selected === null ||
        (selected.instanceId === binding.target.instanceId &&
          selected.model === binding.target.model));
    const result = {
      status: "available" as const,
      threadId,
      messageId: run?.userMessageId ?? routeRow!.message_id,
      runId: run?.id ?? null,
      mode: routeConsistent ? (decision?.mode ?? null) : null,
      selected: routeConsistent ? selected : null,
      source: routeConsistent ? binding.source : null,
      reasons: routeConsistent ? (decision?.reasonCodes ?? binding.gate.reasonCodes) : [],
      explanation: routeConsistent ? (decision?.explanation ?? null) : null,
      selectionUnknownReason:
        routeRow === undefined
          ? "route_missing"
          : !routeConsistent
            ? "route_invalid"
            : selected === null
              ? "selection_not_recorded"
              : null,
      configuredModel: run?.modelSelection ?? null,
      execution: unknownExecution(run === null ? "route_only" : "missing_attempt"),
    };
    if (run === null || run.activeAttemptId === null) return result;
    const attempts = yield* sql<{
      attempt_id: string;
      thread_id: string;
      run_id: string;
      provider_instance_id: string;
      payload_json: string;
    }>`SELECT attempt_id, thread_id, run_id, provider_instance_id, payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=${run.activeAttemptId} AND thread_id=${threadId} AND run_id=${run.id} LIMIT 1`;
    const attemptRow = attempts[0];
    if (attemptRow === undefined) return result;
    const parsedAttempt = decodeAttemptEvidence(attemptRow.payload_json);
    if (parsedAttempt._tag === "None")
      return { ...result, execution: unknownExecution("invalid_attempt") };
    const attempt = parsedAttempt.value;
    if (
      attempt.id !== attemptRow.attempt_id ||
      attempt.runId !== run.id ||
      attemptRow.provider_instance_id !== run.providerInstanceId ||
      attempt.providerInstanceId !== run.providerInstanceId ||
      attempt.providerThreadId !== run.providerThreadId ||
      attempt.rootNodeId !== run.rootNodeId
    )
      return { ...result, execution: unknownExecution("invalid_attempt") };
    const providerThreads = yield* sql<{
      provider_thread_id: string;
      thread_id: string;
      provider_instance_id: string;
      payload_json: string;
    }>`SELECT provider_thread_id, thread_id, provider_instance_id, payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=${attempt.providerThreadId} AND thread_id=${threadId} LIMIT 1`;
    const providerThreadRow = providerThreads[0];
    if (providerThreadRow === undefined)
      return { ...result, execution: unknownExecution("missing_provider_thread") };
    const parsedThread = decodeProviderThreadEvidence(providerThreadRow.payload_json);
    if (
      parsedThread._tag === "None" ||
      parsedThread.value.id !== attempt.providerThreadId ||
      parsedThread.value.appThreadId !== threadId ||
      parsedThread.value.providerInstanceId !== run.providerInstanceId ||
      providerThreadRow.provider_instance_id !== run.providerInstanceId
    )
      return { ...result, execution: unknownExecution("invalid_provider_thread") };
    if (attempt.providerTurnId === null)
      return { ...result, execution: unknownExecution("missing_provider_turn") };
    const turns = yield* sql<{
      provider_turn_id: string;
      provider_thread_id: string;
      run_attempt_id: string | null;
      node_id: string;
      status: string;
      started_at: string | null;
      payload_json: string;
    }>`SELECT provider_turn_id, provider_thread_id, run_attempt_id, node_id, status, started_at, payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=${attempt.providerTurnId} AND thread_id=${threadId} LIMIT 1`;
    const turnRow = turns[0];
    if (turnRow === undefined)
      return { ...result, execution: unknownExecution("missing_provider_turn") };
    const parsedTurn = decodeTurnEvidence(turnRow.payload_json);
    if (parsedTurn._tag === "None")
      return { ...result, execution: unknownExecution("invalid_provider_turn") };
    const turn = parsedTurn.value;
    if (
      turn.id !== turnRow.provider_turn_id ||
      turn.providerThreadId !== attempt.providerThreadId ||
      turnRow.provider_thread_id !== attempt.providerThreadId ||
      turn.runAttemptId !== attempt.id ||
      turnRow.run_attempt_id !== attempt.id ||
      turn.nodeId !== attempt.rootNodeId ||
      turnRow.node_id !== attempt.rootNodeId ||
      turn.status !== turnRow.status ||
      turn.startedAt !== turnRow.started_at
    )
      return { ...result, execution: unknownExecution("invalid_provider_turn") };
    if (turn.status === "pending")
      return { ...result, execution: unknownExecution("provider_turn_pending") };
    if (turn.startedAt === null || !Number.isFinite(Date.parse(turn.startedAt)))
      return { ...result, execution: unknownExecution("provider_turn_not_started") };
    return {
      ...result,
      execution: {
        status: "observed" as const,
        reason: null,
        providerTurnId: turn.id,
        providerStatus: turn.status,
        startedAt: turn.startedAt,
      },
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      status: "unavailable" as const,
      reason: "evidence_unavailable",
    })),
  );

const StoredResultAttempt = Schema.Struct({
  ...StoredAttemptEvidence.fields,
  status: OrchestrationV2RunAttempt.fields.status,
});
const StoredResultThread = Schema.Struct({
  ...StoredProviderThreadEvidence.fields,
  driver: OrchestrationV2ProviderThread.fields.driver,
});
const StoredResultTurn = Schema.Struct({
  ...StoredTurnEvidence.fields,
  completedAt: Schema.NullOr(Schema.String),
});
const resultItemFields = {
  id: Schema.String,
  threadId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
  providerThreadId: Schema.NullOr(Schema.String),
  providerTurnId: Schema.NullOr(Schema.String),
  parentItemId: Schema.NullOr(Schema.String),
  ordinal: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  status: OrchestrationV2TurnItemStatus,
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  completedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
};
const StoredResultItem = Schema.Union([
  Schema.Struct({
    ...resultItemFields,
    type: Schema.Literal("assistant_message"),
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...resultItemFields,
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optionalKey(Schema.Unknown),
  }),
]);
const StoredResultNode = Schema.Struct({
  id: OrchestrationV2ExecutionNode.fields.id,
  threadId: OrchestrationV2ExecutionNode.fields.threadId,
  runId: OrchestrationV2ExecutionNode.fields.runId,
  parentNodeId: OrchestrationV2ExecutionNode.fields.parentNodeId,
  rootNodeId: OrchestrationV2ExecutionNode.fields.rootNodeId,
  kind: OrchestrationV2ExecutionNode.fields.kind,
  status: OrchestrationV2ExecutionNode.fields.status,
  providerThreadId: OrchestrationV2ExecutionNode.fields.providerThreadId,
  providerTurnId: OrchestrationV2ExecutionNode.fields.providerTurnId,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
const decodeResultNode = Schema.decodeUnknownOption(Schema.fromJsonString(StoredResultNode));

const decodeResultAttempt = Schema.decodeUnknownOption(Schema.fromJsonString(StoredResultAttempt));
const decodeResultThread = Schema.decodeUnknownOption(Schema.fromJsonString(StoredResultThread));
const decodeResultTurn = Schema.decodeUnknownOption(Schema.fromJsonString(StoredResultTurn));
const decodeResultItem = Schema.decodeUnknownOption(Schema.fromJsonString(StoredResultItem));
const unknownResult = (reason: string) => ({ status: "unknown" as const, reason });
const resultPreview = (text: string) => {
  let end = COLLABORATION_RESULT_PREVIEW_MAX_CHARS;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return { preview: text.slice(0, end), truncated: text.length > end };
};

/** Revalidate the latest run against the already checked execution chain before reading items. */
const readResultEvidence = (
  sql: SqlClient.SqlClient,
  threadId: string,
  providerId: string,
  routing: CollaborationTaskRoutingReadout,
): Effect.Effect<CollaborationTaskResultReadout> =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      run_id: string;
      thread_id: string;
      ordinal: number;
      provider_instance_id: string;
      status: string;
      payload_json: string;
    }>`
      SELECT run_id, thread_id, ordinal, provider_instance_id, status, payload_json FROM orchestration_v2_projection_runs
      WHERE thread_id=${threadId} ORDER BY ordinal DESC, run_id DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { status: "unavailable" as const, reason: "no_run" };
    const parsed = decodeRunEvidence(row.payload_json);
    if (parsed._tag === "None") return { status: "unavailable" as const, reason: "invalid_run" };
    const run = parsed.value;
    if (
      run.id !== row.run_id ||
      run.threadId !== threadId ||
      row.thread_id !== threadId ||
      run.ordinal !== row.ordinal ||
      run.providerInstanceId !== providerId ||
      row.provider_instance_id !== providerId ||
      run.modelSelection.instanceId !== providerId ||
      run.status !== row.status
    )
      return { status: "unavailable" as const, reason: "invalid_run" };
    const base = {
      status: "available" as const,
      runId: run.id,
      messageId: run.userMessageId,
      runStatus: run.status,
      attemptId: null,
      providerTurnId: null,
      providerTurnStatus: null,
      content: unknownResult("execution_evidence_unavailable"),
    };
    // A concurrent newer run or absent/legacy execution proof must not borrow an older result.
    if (
      routing.status !== "available" ||
      routing.runId !== run.id ||
      routing.messageId !== run.userMessageId
    )
      return base;
    const observedTurnId =
      routing.execution.status === "observed" ? routing.execution.providerTurnId : null;
    return yield* Effect.gen(function* () {
      const attempts = yield* sql<{
        attempt_id: string;
        thread_id: string;
        run_id: string;
        root_node_id: string;
        provider_instance_id: string;
        provider_thread_id: string | null;
        provider_turn_id: string | null;
        status: string;
        payload_json: string;
      }>`
        SELECT attempt_id, thread_id, run_id, root_node_id, provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        FROM orchestration_v2_projection_run_attempts WHERE attempt_id=${run.activeAttemptId} AND thread_id=${threadId} AND run_id=${run.id} LIMIT 1
      `;
      const attemptRow = attempts[0];
      const parsedAttempt = attemptRow ? decodeResultAttempt(attemptRow.payload_json) : null;
      if (!attemptRow || parsedAttempt?._tag !== "Some")
        return { ...base, content: unknownResult("invalid_attempt") };
      const attempt = parsedAttempt.value;
      if (
        attempt.id !== run.activeAttemptId ||
        attempt.id !== attemptRow.attempt_id ||
        attempt.runId !== run.id ||
        attemptRow.root_node_id !== run.rootNodeId ||
        attempt.rootNodeId !== run.rootNodeId ||
        attempt.providerInstanceId !== providerId ||
        attemptRow.provider_instance_id !== providerId ||
        attempt.providerThreadId !== run.providerThreadId ||
        attemptRow.provider_thread_id !== run.providerThreadId ||
        attempt.providerTurnId !== attemptRow.provider_turn_id ||
        (observedTurnId !== null && attempt.providerTurnId !== observedTurnId) ||
        attempt.status !== attemptRow.status
      )
        return { ...base, content: unknownResult("invalid_attempt") };
      if (attempt.providerTurnId === null)
        return { ...base, attemptId: attempt.id, content: unknownResult("missing_provider_turn") };
      const currentTurnId = attempt.providerTurnId;
      const threads = yield* sql<{
        driver: string;
        provider_instance_id: string;
        payload_json: string;
      }>`
        SELECT driver, provider_instance_id, payload_json FROM orchestration_v2_projection_provider_threads
        WHERE provider_thread_id=${run.providerThreadId} AND thread_id=${threadId} LIMIT 1
      `;
      const threadRow = threads[0];
      const parsedThread = threadRow ? decodeResultThread(threadRow.payload_json) : null;
      if (
        !threadRow ||
        parsedThread?._tag !== "Some" ||
        parsedThread.value.id !== run.providerThreadId ||
        parsedThread.value.appThreadId !== threadId ||
        parsedThread.value.providerInstanceId !== providerId ||
        threadRow.provider_instance_id !== providerId ||
        parsedThread.value.driver !== threadRow.driver
      )
        return { ...base, content: unknownResult("invalid_provider_thread") };
      const turns = yield* sql<{
        provider_turn_id: string;
        provider_thread_id: string;
        run_attempt_id: string | null;
        node_id: string;
        status: string;
        started_at: string | null;
        completed_at: string | null;
        payload_json: string;
      }>`
        SELECT provider_turn_id, provider_thread_id, run_attempt_id, node_id, status, started_at, completed_at, payload_json
        FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=${currentTurnId} AND thread_id=${threadId} LIMIT 1
      `;
      const turnRow = turns[0];
      const parsedTurn = turnRow ? decodeResultTurn(turnRow.payload_json) : null;
      if (!turnRow || parsedTurn?._tag !== "Some")
        return { ...base, content: unknownResult("invalid_provider_turn") };
      const turn = parsedTurn.value;
      if (
        turn.id !== currentTurnId ||
        turnRow.provider_turn_id !== turn.id ||
        turn.providerThreadId !== run.providerThreadId ||
        turnRow.provider_thread_id !== run.providerThreadId ||
        turn.runAttemptId !== attempt.id ||
        turnRow.run_attempt_id !== attempt.id ||
        turn.nodeId !== run.rootNodeId ||
        turnRow.node_id !== run.rootNodeId ||
        turn.status !== turnRow.status ||
        turn.startedAt !== turnRow.started_at ||
        turn.completedAt !== turnRow.completed_at
      )
        return { ...base, content: unknownResult("invalid_provider_turn") };
      const correlated = {
        ...base,
        attemptId: attempt.id,
        providerTurnId: turn.id,
        providerTurnStatus: turn.status,
      };
      if (run.status !== turn.status || attempt.status !== run.status)
        return { ...correlated, content: unknownResult("run_turn_disagreement") };
      if (turn.startedAt === null || !Number.isFinite(Date.parse(turn.startedAt)))
        return { ...correlated, content: unknownResult("provider_turn_not_started") };
      if (
        (run.status !== "completed" && run.status !== "failed") ||
        turn.completedAt === null ||
        !Number.isFinite(Date.parse(turn.completedAt)) ||
        Date.parse(turn.completedAt) < Date.parse(turn.startedAt)
      )
        return { ...correlated, content: unknownResult("no_completed_result") };
      const ids = yield* IdAllocator.IdAllocatorV2.pipe(Effect.provide(IdAllocator.layer));
      const terminalFailureId = ids.derive.turnItemFromProviderItem({
        driver: parsedThread.value.driver,
        nativeItemId: `terminal-failure:${turn.id}`,
      });
      return yield* Effect.gen(function* () {
        const items =
          run.status === "completed"
            ? yield* sql<{
                turn_item_id: string;
                thread_id: string;
                run_id: string;
                node_id: string;
                provider_thread_id: string;
                provider_turn_id: string;
                parent_item_id: string | null;
                ordinal: number;
                type: string;
                status: string;
                updated_at: string;
                payload_json: string;
              }>`
              SELECT turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
              FROM orchestration_v2_projection_turn_items WHERE thread_id=${threadId} AND run_id=${run.id}
                AND provider_thread_id=${run.providerThreadId} AND provider_turn_id=${turn.id} AND parent_item_id IS NULL AND type='assistant_message'
              ORDER BY ordinal DESC, turn_item_id DESC LIMIT 1
            `
            : yield* sql<{
                turn_item_id: string;
                thread_id: string;
                run_id: string;
                node_id: string;
                provider_thread_id: string;
                provider_turn_id: string;
                parent_item_id: string | null;
                ordinal: number;
                type: string;
                status: string;
                updated_at: string;
                payload_json: string;
              }>`
              SELECT turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
              FROM orchestration_v2_projection_turn_items WHERE turn_item_id=${terminalFailureId} AND thread_id=${threadId} AND run_id=${run.id} AND node_id=${run.rootNodeId}
                AND provider_thread_id=${run.providerThreadId} AND provider_turn_id=${turn.id} AND parent_item_id IS NULL AND type='error' LIMIT 1
            `;
        const itemRow = items[0];
        if (!itemRow) return { ...correlated, content: unknownResult("no_attributable_output") };
        const parsedItem = decodeResultItem(itemRow.payload_json);
        if (parsedItem._tag === "None")
          return { ...correlated, content: unknownResult("invalid_result_item") };
        const item = parsedItem.value;
        if (
          item.id !== itemRow.turn_item_id ||
          item.threadId !== threadId ||
          item.runId !== run.id ||
          item.nodeId !== itemRow.node_id ||
          item.providerThreadId !== run.providerThreadId ||
          item.providerTurnId !== turn.id ||
          item.parentItemId !== null ||
          item.ordinal !== itemRow.ordinal ||
          item.type !== itemRow.type ||
          item.status !== itemRow.status ||
          item.updatedAt !== itemRow.updated_at ||
          item.completedAt === null ||
          !Number.isFinite(Date.parse(item.completedAt)) ||
          !Number.isFinite(Date.parse(item.updatedAt)) ||
          Date.parse(item.completedAt) < Date.parse(turn.startedAt!)
        )
          return { ...correlated, content: unknownResult("invalid_result_item") };
        if (item.type === "assistant_message") {
          // Select the newest candidate first. A bad node must never uncover an older answer.
          if (item.nodeId === null || item.nodeId === run.rootNodeId)
            return { ...correlated, content: unknownResult("invalid_assistant_node") };
          const readNode = (nodeId: string | null) =>
            Effect.gen(function* () {
              const nodes = yield* sql<{
                node_id: string;
                thread_id: string;
                run_id: string | null;
                parent_node_id: string | null;
                root_node_id: string;
                kind: string;
                status: string;
                provider_thread_id: string | null;
                provider_turn_id: string | null;
                started_at: string | null;
                completed_at: string | null;
                payload_json: string;
              }>`
              SELECT node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json
              FROM orchestration_v2_projection_nodes WHERE node_id=${nodeId} AND thread_id=${threadId} AND run_id=${run.id} LIMIT 1
            `;
              const row = nodes[0];
              const parsed = row ? decodeResultNode(row.payload_json) : null;
              if (!row || parsed?._tag !== "Some") return null;
              const node = parsed.value;
              if (
                node.id !== row.node_id ||
                node.threadId !== threadId ||
                node.runId !== run.id ||
                node.parentNodeId !== row.parent_node_id ||
                node.rootNodeId !== row.root_node_id ||
                node.kind !== row.kind ||
                node.status !== row.status ||
                node.providerThreadId !== row.provider_thread_id ||
                node.providerTurnId !== row.provider_turn_id ||
                node.startedAt !== row.started_at ||
                node.completedAt !== row.completed_at ||
                node.startedAt === null ||
                node.completedAt === null ||
                !Number.isFinite(Date.parse(node.startedAt)) ||
                !Number.isFinite(Date.parse(node.completedAt)) ||
                Date.parse(node.startedAt) > Date.parse(node.completedAt)
              )
                return null;
              return node;
            });
          const node = yield* readNode(item.nodeId);
          const root = yield* readNode(run.rootNodeId);
          if (
            !node ||
            !root ||
            node.kind !== "assistant_message" ||
            node.status !== "completed" ||
            node.rootNodeId !== run.rootNodeId ||
            node.parentNodeId !== run.rootNodeId ||
            node.providerThreadId !== run.providerThreadId ||
            node.providerTurnId !== turn.id ||
            root.id !== run.rootNodeId ||
            root.kind !== "root_turn" ||
            root.status !== "completed" ||
            root.rootNodeId !== root.id ||
            root.parentNodeId !== null ||
            // Captured root records may legitimately omit provider links; child links may not.
            (root.providerThreadId !== null && root.providerThreadId !== run.providerThreadId) ||
            (root.providerTurnId !== null && root.providerTurnId !== turn.id)
          )
            return { ...correlated, content: unknownResult("invalid_assistant_node") };
          if (
            item.startedAt == null ||
            !Number.isFinite(Date.parse(item.startedAt)) ||
            Date.parse(item.startedAt) !== Date.parse(node.startedAt!) ||
            Date.parse(item.completedAt) !== Date.parse(node.completedAt!) ||
            Date.parse(item.updatedAt) < Date.parse(item.completedAt) ||
            Date.parse(node.startedAt!) < Date.parse(turn.startedAt!) ||
            Date.parse(node.completedAt!) > Date.parse(turn.completedAt!) ||
            Date.parse(node.startedAt!) < Date.parse(root.startedAt!) ||
            Date.parse(node.completedAt!) > Date.parse(root.completedAt!)
          )
            return { ...correlated, content: unknownResult("invalid_assistant_node_times") };
        }
        if (
          item.type === "assistant_message" &&
          run.status === "completed" &&
          item.status === "completed" &&
          !item.streaming &&
          item.text.trim().length > 0
        )
          return {
            ...correlated,
            content: { status: "output" as const, itemId: item.id, ...resultPreview(item.text) },
          };
        if (
          item.type === "error" &&
          run.status === "failed" &&
          item.status === "failed" &&
          item.id === terminalFailureId &&
          item.nodeId === run.rootNodeId &&
          item.retry === undefined
        ) {
          const preview = resultPreview(item.failure.message);
          return {
            ...correlated,
            content: {
              status: "failure" as const,
              itemId: item.id,
              failure: {
                class: item.failure.class,
                code: item.failure.code,
                message: preview.preview,
              },
              truncated: preview.truncated,
            },
          };
        }
        return { ...correlated, content: unknownResult("result_not_complete_or_retry") };
      }).pipe(
        Effect.orElseSucceed(() => ({
          ...correlated,
          content: unknownResult("items_unavailable"),
        })),
      );
    }).pipe(Effect.orElseSucceed(() => base));
  }).pipe(
    Effect.orElseSucceed(() => ({
      status: "unavailable" as const,
      reason: "evidence_unavailable",
    })),
  );

const CommandJson = Schema.fromJsonString(CollaborationCommand);
const decodeCommand = Schema.decodeUnknownEffect(CommandJson);
const encodeCommand = Schema.encodeEffect(CommandJson);

export const readCommands = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly command_id: string;
      readonly payload_json: string;
    }>`
      SELECT command_id, payload_json
      FROM collaboration_commands
      ORDER BY sequence
    `;
    return yield* Effect.forEach(
      rows.filter((row) => !OwnedChat.isPrivateRecord(row)),
      (row) => decodeCommand(row.payload_json),
    );
  });

/** Called only inside a server-owned create or verified upgrade transaction, never client admission or reads. */
export const enrollGovernedTask = Effect.fn("collaboration.enrollGovernedTask")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly principalId: string;
    readonly threadId: string;
    readonly creationCommandId: string;
    readonly originCommandId?: string;
    readonly upgradeCommandId?: string;
    readonly upgradeEventId?: string;
  },
) {
  const refusal = () => new GovernedEnrollmentError({ threadId: input.threadId });
  if (!input.principalId.trim()) return yield* refusal();
  const rows = yield* sql<{
    thread_id: string;
    project_id: string;
    provider_instance_id: string;
    payload_json: string;
  }>`SELECT t.thread_id,t.project_id,t.provider_instance_id,t.payload_json
     FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
     WHERE t.thread_id=${input.threadId} AND t.archived_at IS NULL AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
  const row = rows[0];
  const decoded = row === undefined ? undefined : decodeGovernedThread(row.payload_json);
  if (!row || decoded?._tag !== "Some") return yield* refusal();
  const thread = decoded.value;
  if (
    thread.id !== row.thread_id ||
    thread.projectId !== row.project_id ||
    thread.providerInstanceId !== row.provider_instance_id ||
    thread.modelSelection.instanceId !== row.provider_instance_id ||
    !isActiveGovernedRoot(thread)
  )
    return yield* refusal();
  const command: CollaborationCommand = {
    type: "task.enroll",
    commandId: `task:enroll:${input.creationCommandId}`,
    admissionSource: "server",
    admittedBy: input.principalId,
    threadId: thread.id,
    projectId: thread.projectId,
    agentId: thread.providerInstanceId,
    title: thread.title,
    acceptance: thread.taskContract?.acceptance ?? "Acceptance requires a recorded task contract.",
    gateDecision: "DENY",
    ...(input.originCommandId === undefined ? {} : { originCommandId: input.originCommandId }),
    ...(input.upgradeCommandId === undefined ? {} : { upgradeCommandId: input.upgradeCommandId }),
    ...(input.upgradeEventId === undefined ? {} : { upgradeEventId: input.upgradeEventId }),
  };
  const commands = yield* readCommands(sql);
  if (
    commands.some(
      (item) =>
        item.commandId === command.commandId ||
        (item.type === "task.enroll" && item.threadId === thread.id),
    )
  )
    return yield* refusal();
  const result = applyCollaboration(
    foldCollaborationState(
      ownedCommands(commands, input.principalId).filter(
        (item) => projectFor(commands, item) === thread.projectId,
      ),
    ),
    command,
  );
  if (result.outcome !== "applied") return yield* refusal();
  const next = yield* sql<{
    next: number;
  }>`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM collaboration_commands`;
  yield* sql`INSERT INTO collaboration_commands (command_id,sequence,payload_json,created_at)
    VALUES (${command.commandId},${Number(next[0]?.next ?? 1)},${yield* encodeCommand(command)},${DateTime.formatIso(yield* DateTime.now)})`;
});

const owner = (command: CollaborationCommand) =>
  command.admissionSource === "server" ? command.admittedBy : undefined;

// A ledger row with no verifiable seal is never assigned to the current reader.
export const ownedCommands = (commands: ReadonlyArray<CollaborationCommand>, principalId: string) =>
  commands.filter((command) => principalId.length > 0 && owner(command) === principalId);

const projectFor = (
  commands: ReadonlyArray<CollaborationCommand>,
  command: CollaborationCommand,
) => {
  if (command.projectId) return command.projectId;
  if (!command.taskId) return undefined;
  const projects = new Set(
    commands
      .filter(
        (item) =>
          item.projectId &&
          ((item.type === "task.enroll" &&
            command.taskId === `task:governed:thread:${item.threadId}`) ||
            (item.type === "thread.bind" && command.taskId === `task:thread:${item.threadId}`) ||
            (item.correlationId && command.taskId === `task:${item.correlationId}`)),
      )
      .map((item) => item.projectId),
  );
  return projects.size === 1 ? [...projects][0] : undefined;
};

const scopedSnapshot = (commands: ReadonlyArray<CollaborationCommand>, principalId: string) => {
  const owned = ownedCommands(commands, principalId);
  const projects = new Set(owned.map((command) => projectFor(owned, command)).filter(Boolean));
  const empty = foldCollaboration([]);
  const snapshots = [...projects].map((projectId) =>
    foldCollaboration(owned.filter((command) => projectFor(owned, command) === projectId)),
  );
  const tasks = snapshots.flatMap((snapshot) => snapshot.tasks);
  const ambiguous = new Set(
    tasks
      .filter((task) =>
        tasks.some((other) => other.id === task.id && other.projectId !== task.projectId),
      )
      .map((task) => task.id),
  );
  return {
    ...empty,
    agents: [
      ...empty.agents,
      ...snapshots.flatMap((snapshot) =>
        snapshot.agents.filter((agent) => agent.origin === "internal"),
      ),
    ],
    tasks: tasks.map((task) =>
      ambiguous.has(task.id)
        ? {
            ...task,
            threadId: null,
            state: "blocked" as const,
            gateDecision: "DENY" as const,
            waitReason:
              "The task identity is ambiguous across projects. Explicit repair is required.",
          }
        : task,
    ),
    messages: snapshots
      .flatMap((snapshot) => snapshot.messages)
      .filter((message) => !ambiguous.has(message.taskId)),
  };
};

export const hasCanonicalCollaborationLink = (
  snapshot: CollaborationSnapshot,
  scope: {
    readonly principalId: string;
    readonly projectId: string;
    readonly agentId: string;
    readonly threadId: string;
  },
) =>
  snapshot.agents.some(
    (agent) =>
      agent.origin === "internal" &&
      agent.id === scope.agentId &&
      agent.projectId === scope.projectId &&
      agent.threadId === scope.threadId,
  ) &&
  snapshot.tasks.some(
    (task) =>
      task.id === `task:thread:${scope.threadId}` &&
      task.correlationId === `thread:${scope.threadId}` &&
      task.ownerAgentId === scope.principalId &&
      task.assigneeAgentId === scope.agentId &&
      task.projectId === scope.projectId &&
      task.threadId === scope.threadId,
  );

const validateThreadLinks = (
  sql: SqlClient.SqlClient,
  snapshot: CollaborationSnapshot,
  commands: ReadonlyArray<CollaborationCommand>,
  principalId: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly provider_instance_id: string;
      readonly archived_at: string | null;
      readonly deleted_at: string | null;
    }>`SELECT thread_id, project_id, provider_instance_id, archived_at, deleted_at
     FROM orchestration_v2_projection_threads`;
    const invalid = new Set<string>();
    const agents = snapshot.agents.map((agent) => {
      if (agent.origin !== "internal" || !agent.threadId || !agent.projectId) return agent;
      const thread = rows.find((row) => row.thread_id === agent.threadId);
      if (
        !thread ||
        thread.project_id !== agent.projectId ||
        thread.provider_instance_id !== agent.id ||
        thread.archived_at !== null ||
        thread.deleted_at !== null ||
        bindingConflict(commands, principalId, agent.projectId, agent.id, agent.threadId) ||
        !hasCanonicalCollaborationLink(snapshot, {
          principalId,
          projectId: agent.projectId,
          agentId: agent.id,
          threadId: agent.threadId,
        })
      ) {
        invalid.add(agent.threadId);
        return { ...agent, threadId: null };
      }
      return agent;
    });
    const tasks = yield* Effect.forEach(snapshot.tasks, (task) =>
      Effect.gen(function* () {
        const invalidTask = () => ({
          ...task,
          ...(task.threadId === null
            ? {}
            : {
                threadId: null,
                state: "blocked" as const,
                gateDecision: "DENY" as const,
                waitReason: "The thread link is invalid. Explicit repair is required.",
              }),
          routingReadout: { status: "unavailable" as const, reason: "invalid_thread_link" },
          resultReadout: { status: "unavailable" as const, reason: "invalid_thread_link" },
          contractReadout: {
            status: "unavailable" as const,
            reason: "invalid_thread_link" as const,
          },
        });
        const enrollment = commands.find(
          (command) =>
            command.type === "task.enroll" &&
            owner(command) === principalId &&
            command.threadId === task.threadId &&
            command.projectId === task.projectId &&
            command.agentId === task.assigneeAgentId &&
            task.ownerAgentId === principalId &&
            task.id === `task:governed:thread:${task.threadId}` &&
            task.correlationId === `governed:thread:${task.threadId}`,
        );
        const enrolledRow =
          enrollment === undefined
            ? undefined
            : rows.find((row) => row.thread_id === task.threadId);
        const validEnrollment =
          enrollment !== undefined &&
          enrolledRow !== undefined &&
          enrolledRow.project_id === task.projectId &&
          enrolledRow.archived_at === null &&
          enrolledRow.deleted_at === null &&
          !commands.some(
            (command) =>
              command.type === "task.enroll" &&
              command.threadId === task.threadId &&
              (owner(command) !== principalId ||
                command.projectId !== task.projectId ||
                command.agentId !== task.assigneeAgentId),
          );
        const linked =
          enrollment !== undefined
            ? validEnrollment
            : task.threadId !== null &&
              !invalid.has(task.threadId) &&
              agents.some(
                (agent) =>
                  agent.id === task.assigneeAgentId &&
                  agent.projectId === task.projectId &&
                  agent.threadId === task.threadId,
              );
        if (!linked) return invalidTask();
        // The root seal is immutable; a server-committed selection may change its assignee.
        const evidenceProviderId =
          validEnrollment && enrolledRow !== undefined
            ? enrolledRow.provider_instance_id
            : task.assigneeAgentId;
        // Payload reads follow sealed ownership and canonical conversation or governed root validation.
        const payloads = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id=${task.threadId} AND project_id=${task.projectId}
          AND provider_instance_id=${evidenceProviderId} AND archived_at IS NULL AND deleted_at IS NULL
        LIMIT 1
      `;
        const payload = payloads[0];
        if (payload === undefined || task.threadId === null) return invalidTask();
        let enrolledThread: OrchestrationV2AppThreadJson | undefined;
        if (enrollment !== undefined) {
          const decoded = decodeGovernedThread(payload.payload_json);
          const projects =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${task.projectId} AND deleted_at IS NULL`;
          if (
            decoded._tag !== "Some" ||
            !isActiveGovernedRoot(decoded.value) ||
            decoded.value.id !== task.threadId ||
            decoded.value.projectId !== task.projectId ||
            decoded.value.providerInstanceId !== evidenceProviderId ||
            decoded.value.modelSelection.instanceId !== evidenceProviderId ||
            projects.length !== 1
          )
            return invalidTask();
          const upgraded =
            enrollment.originCommandId !== undefined ||
            enrollment.upgradeCommandId !== undefined ||
            enrollment.upgradeEventId !== undefined;
          if (upgraded && !(yield* OwnedChat.verifyUpgrade(sql, enrollment, decoded.value)))
            return invalidTask();
          const selected = yield* sql<{
            payload_json: string;
            metadata_json: string;
          }>`SELECT payload_json,metadata_json FROM orchestration_events
            WHERE aggregate_kind='thread' AND application_event_version=2 AND stream_id=${task.threadId}
              AND event_type IN ('thread.created','thread.provider-switched','thread.model-selection-updated')
            ORDER BY sequence DESC LIMIT 1`;
          const attested =
            selected[0] === undefined ? undefined : decodeGovernedThread(selected[0].payload_json);
          const metadata =
            selected[0] === undefined
              ? undefined
              : decodeSelectionMetadata(selected[0].metadata_json);
          if (
            metadata?._tag !== "Some" ||
            (metadata.value.providerInstanceId !== undefined &&
              metadata.value.providerInstanceId !== evidenceProviderId) ||
            attested?._tag !== "Some" ||
            (!upgraded && !isGovernedRoot(attested.value)) ||
            attested.value.id !== task.threadId ||
            attested.value.projectId !== task.projectId ||
            attested.value.providerInstanceId !== evidenceProviderId ||
            attested.value.modelSelection.instanceId !== evidenceProviderId
          )
            return invalidTask();
          enrolledThread = decoded.value;
        }
        const threadEvidence = decodeStoredContract(payload.payload_json);
        const validThreadEvidence =
          threadEvidence._tag === "Some" &&
          (threadEvidence.value.id === undefined || threadEvidence.value.id === task.threadId) &&
          (threadEvidence.value.projectId === undefined ||
            threadEvidence.value.projectId === task.projectId) &&
          (threadEvidence.value.providerInstanceId === undefined ||
            threadEvidence.value.providerInstanceId === evidenceProviderId);
        const routingReadout = validThreadEvidence
          ? yield* readRoutingEvidence(sql, task.threadId)
          : { status: "unavailable" as const, reason: "invalid_thread_evidence" };
        return {
          ...task,
          ...(enrolledThread === undefined
            ? {}
            : { title: enrolledThread.title, assigneeAgentId: evidenceProviderId }),
          routingReadout,
          resultReadout: validThreadEvidence
            ? yield* readResultEvidence(sql, task.threadId, evidenceProviderId, routingReadout)
            : { status: "unavailable" as const, reason: "invalid_thread_evidence" },
          contractReadout: contractReadout({
            thread_id: task.threadId,
            project_id: task.projectId,
            provider_instance_id: evidenceProviderId,
            payload_json: payload.payload_json,
          }),
        };
      }),
    );
    return { ...snapshot, agents, tasks };
  });

const primaryTaskLinks = (commands: ReadonlyArray<CollaborationCommand>, threadId: string) =>
  commands.filter(
    (command) =>
      (command.type === "task.enroll" || command.type === "thread.bind") &&
      command.threadId === threadId,
  );
const sealedTaskOwner = (commands: ReadonlyArray<CollaborationCommand>, threadId: string) => {
  const links = primaryTaskLinks(commands, threadId);
  if (links.length === 0) return null;
  if (links.some((link) => link.admissionSource !== "server" || !link.admittedBy)) return false;
  const owners = new Set(links.map((link) => link.admittedBy!));
  return owners.size === 1 ? [...owners][0]! : false;
};
const reviewFacts = Effect.fn("collaboration.reviewFacts")(function* (
  sql: SqlClient.SqlClient,
  commands: ReadonlyArray<CollaborationCommand>,
  task: CollaborationTask,
  actorId: string,
  environmentId: string,
): Effect.fn.Return<TaskContractReviewState, import("effect/unstable/sql/SqlError").SqlError> {
  const no = (reason: string): TaskContractReviewState => ({ status: "unavailable", reason });
  if (
    task.ownerAgentId !== actorId ||
    !task.threadId ||
    task.contractReadout?.status !== "available"
  )
    return no("task-link-unavailable");
  if (sealedTaskOwner(commands, task.threadId) !== actorId) return no("task-owner-unavailable");
  const rows = yield* sql<{
    thread_id: string;
    project_id: string;
    provider_instance_id: string;
    created_at: string;
    updated_at: string;
    payload_json: string;
  }>`SELECT t.thread_id,t.project_id,t.provider_instance_id,t.created_at,t.updated_at,t.payload_json FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=${task.threadId} AND t.archived_at IS NULL AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
  const row = rows[0];
  const decoded = row === undefined ? undefined : decodeGovernedThread(row.payload_json);
  if (!row || decoded?._tag !== "Some") return no("invalid-task-link");
  const thread = decoded.value;
  if (
    !isActiveGovernedRoot(thread) ||
    !thread.taskContract ||
    thread.id !== task.threadId ||
    thread.projectId !== task.projectId ||
    row.thread_id !== thread.id ||
    row.project_id !== thread.projectId ||
    row.provider_instance_id !== thread.providerInstanceId ||
    thread.modelSelection.instanceId !== row.provider_instance_id ||
    DateTime.formatIso(thread.createdAt) !== row.created_at ||
    DateTime.formatIso(thread.updatedAt) !== row.updated_at ||
    !(yield* OwnedChat.selectionMatches(sql, thread))
  )
    return no("invalid-task-link");
  if (thread.taskContractPhase !== "active" && thread.taskContractPhase !== "redirected")
    return no("contract-phase-unavailable");
  const versions = yield* sql<{
    sequence: number | null;
  }>`SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE aggregate_kind='thread' AND application_event_version=2 AND stream_id=${thread.id} AND event_type LIKE 'thread.%'`;
  if (versions[0]?.sequence == null) return no("task-version-unavailable");
  const acceptedRevision = thread.taskAcceptedRevision ?? null;
  const actions: TaskContractReviewAction[] =
    thread.taskContractPhase === "redirected"
      ? ["resume"]
      : acceptedRevision === thread.taskContract.revision
        ? []
        : ["accept", "redirect"];
  return {
    status: "available",
    taskId: task.id,
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    contract: thread.taskContract,
    phase: thread.taskContractPhase,
    acceptedRevision,
    actions,
    canEditInstructions:
      thread.taskContractPhase === "redirected" &&
      acceptedRevision !== thread.taskContract.revision,
    reference: {
      environmentId,
      taskId: task.id,
      projectId: thread.projectId,
      threadUpdatedAt: DateTime.formatIso(thread.updatedAt),
      threadSequence: Number(versions[0].sequence),
    },
  };
});

/** Review hints are read-only. Commands independently revalidate authenticated authority. */
export const readCollaborationSnapshot = (
  sql: SqlClient.SqlClient,
  principalId: string,
  reviewContext?: { readonly environmentId: string; readonly canOperate: boolean },
) =>
  Effect.gen(function* () {
    const commands = yield* readCommands(sql);
    const snapshot = yield* validateThreadLinks(
      sql,
      scopedSnapshot(commands, principalId),
      commands,
      principalId,
    );
    if (!reviewContext) return snapshot;
    if (!reviewContext.canOperate)
      return { ...snapshot, environmentId: reviewContext.environmentId };
    const tasks = yield* Effect.forEach(snapshot.tasks, (task) =>
      Effect.gen(function* () {
        const facts = yield* reviewFacts(
          sql,
          commands,
          task,
          principalId,
          reviewContext.environmentId,
        );
        return facts.status === "available"
          ? {
              ...task,
              review: {
                reference: facts.reference,
                revision: facts.contract.revision,
                actions: facts.actions,
                canEditInstructions: facts.canEditInstructions === true,
              },
            }
          : task;
      }),
    );
    return { ...snapshot, environmentId: reviewContext.environmentId, tasks };
  });

class TaskReviewDeniedError extends Schema.TaggedError<TaskReviewDeniedError>()(
  "TaskReviewDeniedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Task review unavailable: ${this.reason}. Refresh task facts before another decision.`;
  }
}
const reviewContext = Effect.gen(function* () {
  const context = yield* PolicyExecutionContext;
  if (
    context.kind !== "session" ||
    !context.scopes.includes(AuthOrchestrationOperateScope) ||
    !context.actorId.trim()
  )
    return null;
  if (
    context.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(context.expiresAt)) ||
      Date.parse(context.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now))
  )
    return null;
  return context;
});
export const readTaskReview = Effect.fn("collaboration.readTaskReview")(function* (
  sql: SqlClient.SqlClient,
  input: TaskContractReviewInput,
) {
  const no = (reason: string): TaskContractReviewState => ({ status: "unavailable", reason });
  const context = yield* reviewContext;
  if (!context) return no("operate-scope-required");
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  if (environment._tag !== "Some") return no("environment-unavailable");
  if ((yield* environment.value.getEnvironmentId) !== input.environmentId)
    return no("wrong-environment");
  const commands = yield* readCommands(sql);
  const snapshot = yield* validateThreadLinks(
    sql,
    scopedSnapshot(commands, context.actorId),
    commands,
    context.actorId,
  );
  const task = snapshot.tasks.find(
    (item) =>
      item.id === input.taskId &&
      item.projectId === input.projectId &&
      item.threadId === input.threadId,
  );
  if (!task) return no("task-link-unavailable");
  const facts = yield* reviewFacts(sql, commands, task, context.actorId, input.environmentId);
  if (facts.status === "available" && facts.contract.revision !== input.revision)
    return no("stale-revision");
  return facts;
});
// A local child contract does not confer authority over its cancellation root.
// Resolve the actual parent chain, including old selector-less command paths.
const decisionRoot = Effect.fn("collaboration.decisionRoot")(function* (
  sql: SqlClient.SqlClient,
  commands: ReadonlyArray<CollaborationCommand>,
  actorId: string,
  threadId: string,
  action: TaskContractReviewAction | "set",
) {
  const deny = () => new TaskReviewDeniedError({ reason: "invalid-decision-lineage" });
  const load = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        thread_id: string;
        project_id: string;
        provider_instance_id: string;
        created_at: string;
        updated_at: string;
        archived_at: string | null;
        deleted_at: string | null;
        payload_json: string;
      }>`SELECT thread_id,project_id,provider_instance_id,created_at,updated_at,archived_at,deleted_at,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${id}`;
      const row = rows[0];
      const decoded = row === undefined ? undefined : decodeGovernedThread(row.payload_json);
      if (!row || decoded?._tag !== "Some") return yield* deny();
      const thread = decoded.value;
      if (
        thread.id !== id ||
        row.thread_id !== id ||
        row.project_id !== thread.projectId ||
        row.provider_instance_id !== thread.providerInstanceId ||
        thread.modelSelection.instanceId !== row.provider_instance_id ||
        DateTime.formatIso(thread.createdAt) !== row.created_at ||
        DateTime.formatIso(thread.updatedAt) !== row.updated_at
      )
        return yield* deny();
      return {
        thread,
        active:
          row.archived_at === null &&
          row.deleted_at === null &&
          thread.archivedAt === null &&
          thread.deletedAt === null,
      };
    });
  const leaf = yield* load(threadId);
  const rootId = leaf.thread.lineage.rootThreadId;
  const seen = new Set<string>();
  let node = leaf;
  let active = true;
  while (true) {
    if (
      seen.has(node.thread.id) ||
      node.thread.lineage.rootThreadId !== rootId ||
      node.thread.projectId !== leaf.thread.projectId
    )
      return yield* deny();
    seen.add(node.thread.id);
    active = active && node.active;
    const ownerId = sealedTaskOwner(commands, node.thread.id);
    if (ownerId === false || (ownerId !== null && ownerId !== actorId))
      return yield* new TaskReviewDeniedError({ reason: "task-owner-mismatch" });
    if (node.thread.id === rootId) {
      if (
        node.thread.lineage.parentThreadId !== null ||
        node.thread.lineage.relationshipToParent !== null
      )
        return yield* deny();
      break;
    }
    if (
      node.thread.lineage.parentThreadId === null ||
      node.thread.lineage.relationshipToParent === null
    )
      return yield* deny();
    node = yield* load(node.thread.lineage.parentThreadId);
  }
  const rootOwner = sealedTaskOwner(commands, rootId);
  if (rootOwner !== null) {
    if (
      !active ||
      (yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${node.thread.projectId} AND deleted_at IS NULL`)
        .length !== 1 ||
      !(yield* OwnedChat.selectionMatches(sql, node.thread))
    )
      return yield* deny();
    if (action !== "set") {
      const snapshot = yield* validateThreadLinks(
        sql,
        scopedSnapshot(commands, actorId),
        commands,
        actorId,
      );
      const task = snapshot.tasks.find(
        (item) =>
          item.threadId === rootId &&
          (item.id === `task:governed:thread:${rootId}` || item.id === `task:thread:${rootId}`),
      );
      if (
        !task ||
        (yield* reviewFacts(sql, commands, task, actorId, "legacy-command")).status !== "available"
      )
        return yield* deny();
    }
  }
  return { thread: leaf.thread, root: node.thread, rootOwner };
});
export const validateTaskDecision = Effect.fn("collaboration.validateTaskDecision")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly reviewTask?: TaskContractReviewReference;
  } & (
    | { readonly action: TaskContractReviewAction; readonly revision: number }
    | { readonly action: "set"; readonly expectedRevision?: number }
  ),
) {
  const context = yield* reviewContext;
  if (!context) return yield* new TaskReviewDeniedError({ reason: "operate-scope-required" });
  const commands = yield* readCommands(sql);
  const ownerId = sealedTaskOwner(commands, input.threadId);
  const current = yield* decisionRoot(sql, commands, context.actorId, input.threadId, input.action);
  if (input.action === "set") {
    if (input.expectedRevision === undefined && input.reviewTask === undefined) return;
    if (input.expectedRevision === undefined || input.reviewTask === undefined)
      return yield* new TaskReviewDeniedError({ reason: "incomplete-reviewed-set" });
    const facts = yield* readTaskReview(sql, {
      ...input.reviewTask,
      threadId: input.threadId,
      revision: input.expectedRevision,
    });
    if (
      facts.status !== "available" ||
      facts.canEditInstructions !== true ||
      facts.reference.threadUpdatedAt !== input.reviewTask.threadUpdatedAt ||
      facts.reference.threadSequence !== input.reviewTask.threadSequence
    )
      return yield* new TaskReviewDeniedError({ reason: "stale-paused-instruction-review" });
    return;
  }
  if (!input.reviewTask) {
    if (ownerId === null && current.rootOwner === null) return;
    if (
      (ownerId !== null && current.thread.id !== current.root.id) ||
      current.thread.taskContract?.revision !== input.revision
    )
      return yield* new TaskReviewDeniedError({ reason: "invalid-current-task" });
    return;
  }
  const facts = yield* readTaskReview(sql, {
    ...input.reviewTask,
    threadId: input.threadId,
    revision: input.revision,
  });
  if (facts.status !== "available")
    return yield* new TaskReviewDeniedError({ reason: facts.reason });
  if (
    facts.reference.threadUpdatedAt !== input.reviewTask.threadUpdatedAt ||
    facts.reference.threadSequence !== input.reviewTask.threadSequence ||
    !facts.actions.includes(input.action)
  )
    return yield* new TaskReviewDeniedError({ reason: "stale-review" });
});

// Server seals carry all semantic fields. Property order is not command semantics.
const semanticKey = (command: CollaborationCommand) =>
  JSON.stringify(
    Object.entries(command)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

export const bindingConflict = (
  commands: ReadonlyArray<CollaborationCommand>,
  principalId: string,
  projectId: string,
  agentId: string,
  threadId?: string,
) => {
  const bindings = commands.filter((item) => item.type === "thread.bind");
  const tuple = bindings.filter((item) => item.projectId === projectId && item.agentId === agentId);
  if (tuple.some((item) => !owner(item))) return true;
  const own = tuple.filter((item) => owner(item) === principalId);
  if (new Set(own.map((item) => item.threadId)).size > 1) return true;
  if (threadId && own.some((item) => item.threadId !== threadId)) return true;
  const candidateIds = new Set(own.map((item) => item.threadId));
  if (threadId) candidateIds.add(threadId);
  return bindings.some(
    (item) =>
      candidateIds.has(item.threadId) &&
      (owner(item) !== principalId || item.projectId !== projectId || item.agentId !== agentId),
  );
};

export const submitCollaborationCommand = (
  sql: SqlClient.SqlClient,
  command: CollaborationCommand,
  // Only the server recovery service supplies this after verifying a scoped create receipt.
  options: { readonly allowNewBinding: boolean } = { allowNewBinding: false },
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const commands = yield* readCommands(sql);
      const principalId = owner(command) ?? "";
      const snapshot = yield* validateThreadLinks(
        sql,
        scopedSnapshot(commands, principalId),
        commands,
        principalId,
      );
      const refusal = (code: "unauthorized" | "identity-conflict", detail: string) => ({
        outcome: "rejected" as const,
        code,
        detail,
        idempotent: false,
        gateDecision: "DENY" as const,
        snapshot,
      });
      if (!principalId) return refusal("unauthorized", "The server admission seal is required.");
      if (command.type === "task.enroll")
        return refusal(
          "unauthorized",
          "Only successful server governed creation can enroll a task.",
        );
      const prior = commands.find((item) => item.commandId === command.commandId);
      if (prior) {
        if (owner(prior) !== principalId || semanticKey(prior) !== semanticKey(command))
          return refusal(
            "identity-conflict",
            "The command identity cannot be replayed with different ownership or semantics.",
          );
        if (
          command.type === "thread.bind" &&
          !hasCanonicalCollaborationLink(snapshot, {
            principalId,
            projectId: command.projectId ?? "",
            agentId: command.agentId ?? "",
            threadId: command.threadId ?? "",
          })
        )
          return refusal(
            "identity-conflict",
            "The binding cannot be replayed without a consistent canonical task.",
          );
        return {
          outcome: "applied" as const,
          code: null,
          detail: "This command was already applied.",
          idempotent: true,
          gateDecision: null,
          snapshot,
        };
      }
      const owned = ownedCommands(commands, principalId);
      const projectId = projectFor(owned, command);
      if (!projectId)
        return refusal("unauthorized", "The command does not identify one owned project.");
      const correlationId =
        command.type === "thread.bind" && command.threadId
          ? `thread:${command.threadId}`
          : command.type === "delegate" || command.type === "resolve"
            ? command.correlationId
            : undefined;
      if (
        correlationId &&
        snapshot.tasks.some(
          (task) => task.correlationId === correlationId && task.projectId !== projectId,
        )
      )
        return refusal(
          "identity-conflict",
          "That task correlation belongs to a different project.",
        );
      if (
        command.type === "thread.bind" &&
        !options.allowNewBinding &&
        !owned.some(
          (item) =>
            item.type === "thread.bind" &&
            item.projectId === projectId &&
            item.agentId === command.agentId &&
            item.threadId === command.threadId,
        )
      )
        return refusal(
          "unauthorized",
          "An unowned thread cannot be adopted. Use server conversation recovery.",
        );
      if (
        command.type === "thread.bind" &&
        command.agentId &&
        bindingConflict(commands, principalId, projectId, command.agentId, command.threadId)
      )
        return refusal(
          "identity-conflict",
          "The binding has unknown, conflicting, or different ownership.",
        );
      if (command.type === "thread.bind") {
        const rows = yield* sql<{
          readonly project_id: string;
          readonly provider_instance_id: string;
          readonly archived_at: string | null;
          readonly deleted_at: string | null;
        }>`
          SELECT project_id, provider_instance_id, archived_at, deleted_at
          FROM orchestration_v2_projection_threads WHERE thread_id = ${command.threadId ?? ""}
        `;
        const thread = rows[0];
        if (
          !thread ||
          thread.project_id !== projectId ||
          thread.provider_instance_id !== command.agentId ||
          thread.archived_at !== null ||
          thread.deleted_at !== null
        )
          return refusal("identity-conflict", "The thread is missing, invalid, or archived.");
      }
      const state = foldCollaborationState(
        owned.filter((item) => projectFor(owned, item) === projectId),
      );
      const result = applyCollaboration(state, command);
      if (result.outcome === "rejected") return { ...result, snapshot };
      const sequenceRows = yield* sql<{ readonly next: number | string }>`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM collaboration_commands
      `;
      const sequence = Number(sequenceRows[0]?.next ?? 1);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO collaboration_commands (command_id, sequence, payload_json, created_at)
        VALUES (${command.commandId}, ${sequence}, ${yield* encodeCommand(command)}, ${createdAt})
      `;
      return {
        ...result,
        snapshot: yield* validateThreadLinks(
          sql,
          scopedSnapshot([...commands, command], principalId),
          [...commands, command],
          principalId,
        ),
      };
    }),
  );

const sameReviewBrake = Schema.toEquivalence(TaskContractBrake);

export const verifyTaskDecisionReplay = Effect.fn("collaboration.verifyTaskDecisionReplay")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly commandId: string;
      readonly threadId: string;
      readonly reviewTask?: TaskContractReviewReference;
      readonly reviewedSet?: Extract<OrchestrationV2Command, { type: "thread.task-contract.set" }>;
    } & (
      | { readonly action: TaskContractReviewAction; readonly revision: number }
      | { readonly action: "set" }
    ),
  ) {
    const context = yield* reviewContext;
    const deny = () => new TaskReviewDeniedError({ reason: "decision-replay-mismatch" });
    if (!context) return yield* deny();
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_events WHERE command_id=${input.commandId} AND stream_id=${input.threadId} AND aggregate_kind='thread' AND application_event_version=2 AND event_type='thread.metadata-updated'`;
    const decoded = rows.length === 1 ? decodeGovernedThread(rows[0]!.payload_json) : undefined;
    const decision = decoded?._tag === "Some" ? decoded.value.taskDecisions?.at(-1) : undefined;
    if (
      !decision ||
      decision.actorId !== context.actorId ||
      decision.kind !== input.action ||
      (input.action !== "set" && decision.revision !== input.revision)
    )
      return yield* deny();
    const stored = decision.reviewTask;
    const incoming = input.action === "set" ? input.reviewedSet?.reviewTask : input.reviewTask;
    if (
      (stored === undefined) !== (incoming === undefined) ||
      (stored &&
        incoming &&
        (stored.environmentId !== incoming.environmentId ||
          stored.taskId !== incoming.taskId ||
          stored.projectId !== incoming.projectId ||
          stored.threadUpdatedAt !== incoming.threadUpdatedAt ||
          stored.threadSequence !== incoming.threadSequence))
    )
      return yield* deny();
    if (input.action === "set") {
      const command = input.reviewedSet;
      if (
        decision.expectedRevision !== command?.expectedRevision ||
        (decision.expectedRevision === undefined) !== (stored === undefined)
      )
        return yield* deny();
      if (stored !== undefined) {
        const original = decoded?._tag === "Some" ? decoded.value : undefined;
        if (
          !command ||
          command.commandId !== input.commandId ||
          command.threadId !== input.threadId ||
          !original?.taskContract ||
          original.taskContractPhase !== "redirected" ||
          original.taskAcceptedRevision !== null ||
          decision.revision !== original.taskContract.revision ||
          decision.revision !== command.expectedRevision! + 1 ||
          command.goal.trim() !== original.taskContract.goal ||
          command.redirect.trim() !== original.taskContract.redirect ||
          command.acceptance.trim() !== original.taskContract.acceptance ||
          !sameReviewBrake(command.brake, original.taskContract.brake)
        )
          return yield* deny();
      }
    }
    const commands = yield* readCommands(sql);
    const currentRoot = yield* decisionRoot(
      sql,
      commands,
      context.actorId,
      input.threadId,
      input.action,
    );
    const original = decoded?._tag === "Some" ? decoded.value : undefined;
    if (
      !original ||
      original.projectId !== currentRoot.thread.projectId ||
      original.lineage.rootThreadId !== currentRoot.thread.lineage.rootThreadId ||
      original.lineage.parentThreadId !== currentRoot.thread.lineage.parentThreadId ||
      original.lineage.relationshipToParent !== currentRoot.thread.lineage.relationshipToParent
    )
      return yield* deny();
    if (incoming) {
      // A receipt proves the original command. Later human decisions or revisions
      // must not turn an authentic retry into a new mutation or erase that proof.
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${input.threadId}`;
      const projection =
        rows[0] === undefined ? undefined : decodeGovernedThread(rows[0].payload_json);
      if (projection?._tag !== "Some" || !projection.value.taskContract) return yield* deny();
      const current = yield* readTaskReview(sql, {
        ...incoming,
        threadId: input.threadId,
        revision: projection.value.taskContract.revision,
      });
      if (current.status !== "available") return yield* deny();
    }
  },
);
