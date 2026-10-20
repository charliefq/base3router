import { digestCanonical } from "./actionCanonical.ts";
import type { TaskContinuationResult } from "@t3tools/contracts";
import {
  COLLABORATION_RESULT_PREVIEW_MAX_CHARS,
  CollaborationTask,
  CollaborationSnapshot,
  OrchestrationV2ThreadProjection,
  TaskContract,
  TaskContractReviewState,
  TaskContractReviewReference,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

type Review = Extract<TaskContractReviewState, { status: "available" }>;
const validTask = Schema.is(CollaborationTask);
const validProjection = Schema.is(OrchestrationV2ThreadProjection);
const validReview = Schema.is(TaskContractReviewState);
const validSnapshot = Schema.is(CollaborationSnapshot);
const sameContract = Schema.toEquivalence(TaskContract);
const sameReference = Schema.toEquivalence(TaskContractReviewReference);
// Budget observation timestamps are display facts, not revision preparation
// preconditions. Keep every existing task field in the original operation gate.
const { budgetReadout: _budgetReadout, ...revisionFields } = CollaborationTask.fields;
const RevisionTask = Schema.Struct(revisionFields);
export const sameRevisionTask = Schema.toEquivalence(RevisionTask);
export const sameRevisionProjection = Schema.toEquivalence(OrchestrationV2ThreadProjection);
export const sameRevisionReview = Schema.toEquivalence(TaskContractReviewState);
export const revisionTaskKey = Schema.encodeSync(Schema.fromJsonString(RevisionTask));

export function hasRevisionOutput(task: CollaborationTask) {
  const r = task.resultReadout;
  return (
    validTask(task) &&
    r?.status === "available" &&
    r.runStatus === "completed" &&
    r.providerTurnStatus === "completed" &&
    r.attemptId !== null &&
    r.providerTurnId !== null &&
    r.content.status === "output" &&
    r.content.preview.trim().length > 0 &&
    task.contractReadout?.status === "available" &&
    task.contractReadout.phase === "active" &&
    task.contractReadout.acceptedRevision === null &&
    task.review?.actions.includes("accept")
  );
}

export function revisionSnapshotTask(
  snapshot: CollaborationSnapshot,
  environmentId: EnvironmentId,
  task: CollaborationTask,
) {
  if (!validSnapshot(snapshot) || snapshot.environmentId !== environmentId) return null;
  const matches = snapshot.tasks.filter((t) => t.id === task.id);
  const t = matches[0];
  return matches.length === 1 && t?.projectId === task.projectId && t.threadId === task.threadId
    ? t
    : null;
}

/** One canonical, surrogate-safe bounded preview; the full text remains the identity authority. */
export function taskResultPreview(text: string) {
  let end = COLLABORATION_RESULT_PREVIEW_MAX_CHARS;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return { preview: text.slice(0, end), truncated: text.length > end };
}

/** Server resultReadout validates attribution; these reads must agree on the same latest result. */
function outputFacts(
  task: CollaborationTask,
  environmentId: EnvironmentId,
  review: TaskContractReviewState,
  projection: OrchestrationV2ThreadProjection,
  accepted: boolean | "inspect",
) {
  const inspecting = accepted === "inspect";
  const contract = task.contractReadout?.status === "available" ? task.contractReadout : null;
  const r = task.resultReadout;
  const eligible = inspecting
    ? validTask(task) &&
      r?.status === "available" &&
      r.runStatus === "completed" &&
      r.providerTurnStatus === "completed" &&
      r.attemptId !== null &&
      r.providerTurnId !== null &&
      r.content.status === "output" &&
      task.contractReadout?.status === "available"
    : accepted
      ? hasAcceptedOutput(task)
      : hasRevisionOutput(task);
  if (
    !eligible ||
    !validReview(review) ||
    review.status !== "available" ||
    !validProjection(projection)
  )
    return null;
  if (r?.status !== "available" || r.content.status !== "output") return null;
  const t = projection.thread;
  if (
    review.reference.environmentId !== environmentId ||
    review.reference.taskId !== task.id ||
    review.reference.projectId !== task.projectId ||
    review.taskId !== task.id ||
    review.projectId !== task.projectId ||
    review.threadId !== task.threadId ||
    review.phase !== (inspecting ? contract?.phase : "active") ||
    (inspecting
      ? review.acceptedRevision !== contract?.acceptedRevision
      : accepted
        ? review.acceptedRevision !== review.contract.revision
        : review.acceptedRevision !== null || !review.actions.includes("accept")) ||
    !task.review ||
    !sameReference(review.reference, task.review.reference) ||
    task.contractReadout?.status !== "available" ||
    !sameContract(review.contract, task.contractReadout.contract) ||
    t.id !== task.threadId ||
    t.projectId !== task.projectId ||
    t.title !== review.title ||
    t.providerInstanceId !== task.assigneeAgentId ||
    t.modelSelection.instanceId !== t.providerInstanceId ||
    t.taskGovernance !== "required" ||
    !t.taskContract ||
    !sameContract(t.taskContract, review.contract) ||
    t.taskContractPhase !== (inspecting ? review.phase : "active") ||
    (inspecting
      ? t.taskAcceptedRevision !== review.acceptedRevision
      : accepted
        ? t.taskAcceptedRevision !== review.contract.revision
        : t.taskAcceptedRevision !== null) ||
    t.archivedAt !== null ||
    t.deletedAt !== null ||
    t.forkedFrom !== null ||
    t.lineage.rootThreadId !== t.id ||
    t.lineage.parentThreadId !== null ||
    t.lineage.relationshipToParent !== null ||
    DateTime.formatIso(t.updatedAt) !== review.reference.threadUpdatedAt
  )
    return null;
  const busy = new Set(["preparing", "queued", "starting", "pending", "running", "waiting"]);
  if (
    projection.runs.some((v) => busy.has(v.status)) ||
    projection.attempts.some((v) => busy.has(v.status)) ||
    projection.providerTurns.some((v) => busy.has(v.status)) ||
    projection.providerSessions.some((v) => busy.has(v.status)) ||
    projection.nodes.some((v) => busy.has(v.status)) ||
    projection.subagents.some((v) => busy.has(v.status)) ||
    projection.runtimeRequests.some((v) => v.status === "pending") ||
    projection.providerThreads.some((v) => (v.pendingBackgroundTasks?.length ?? 0) > 0)
  )
    return null;
  if (
    [
      projection.runs,
      projection.attempts,
      projection.nodes,
      projection.providerThreads,
      projection.providerTurns,
      projection.messages,
      projection.turnItems,
    ].some((records) => new Set(records.map((record) => record.id)).size !== records.length)
  )
    return null;
  const runs = [...projection.runs].sort((a, b) => b.ordinal - a.ordinal);
  const run = runs[0];
  if (
    !run ||
    runs[1]?.ordinal === run.ordinal ||
    run.id !== r.runId ||
    run.threadId !== t.id ||
    run.status !== "completed" ||
    run.providerInstanceId !== t.providerInstanceId ||
    run.userMessageId !== r.messageId ||
    run.activeAttemptId !== r.attemptId ||
    !run.providerThreadId ||
    !run.rootNodeId ||
    !run.startedAt ||
    !run.completedAt
  )
    return null;
  const message = projection.messages.filter((v) => v.id === r.messageId);
  const attempts = projection.attempts.filter((v) => v.id === r.attemptId);
  const turns = projection.providerTurns.filter((v) => v.id === r.providerTurnId);
  const threads = projection.providerThreads.filter((v) => v.id === run.providerThreadId);
  const attempt = attempts[0],
    turn = turns[0],
    provider = threads[0];
  if (
    message.length !== 1 ||
    message[0]!.role !== "user" ||
    message[0]!.runId !== run.id ||
    attempts.length !== 1 ||
    turns.length !== 1 ||
    threads.length !== 1 ||
    !attempt ||
    !turn ||
    !provider ||
    attempt.runId !== run.id ||
    attempt.rootNodeId !== run.rootNodeId ||
    attempt.providerInstanceId !== run.providerInstanceId ||
    attempt.providerThreadId !== run.providerThreadId ||
    attempt.providerTurnId !== turn.id ||
    attempt.status !== "completed" ||
    !attempt.completedAt ||
    turn.nodeId !== run.rootNodeId ||
    turn.runAttemptId !== attempt.id ||
    turn.providerThreadId !== run.providerThreadId ||
    turn.status !== "completed" ||
    !turn.startedAt ||
    !turn.completedAt ||
    provider.appThreadId !== t.id ||
    provider.providerInstanceId !== run.providerInstanceId
  )
    return null;
  if (accepted === true) {
    const input = message[0]?.taskFirstLaunch ?? message[0]?.taskResultContinuation;
    // Acceptance of a later contract cannot attest an output produced under an older intent.
    if (
      !input ||
      !sameContract(input.contract, review.contract) ||
      input.threadId !== t.id ||
      input.messageId !== run.userMessageId ||
      (message[0]?.taskFirstLaunch && message[0]?.taskResultContinuation)
    )
      return null;
  }
  if (
    [...projection.attempts]
      .filter((v) => v.runId === run.id)
      .sort((a, b) => b.attemptOrdinal - a.attemptOrdinal)[0]?.id !== attempt.id ||
    [...projection.providerTurns]
      .filter((v) => v.providerThreadId === run.providerThreadId)
      .sort((a, b) => b.ordinal - a.ordinal)[0]?.id !== turn.id
  )
    return null;
  // A completed run cannot override conflicting execution evidence for its current thread/turn.
  if (
    provider.status === "active" ||
    projection.turnItems.some(
      (item) =>
        item.runId === run.id &&
        item.providerThreadId === provider.id &&
        item.providerTurnId === turn.id &&
        ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
        ["pending", "running", "waiting"].includes(item.status),
    )
  )
    return null;
  const items = projection.turnItems
    .filter(
      (v) =>
        v.type === "assistant_message" &&
        v.runId === run.id &&
        v.providerThreadId === run.providerThreadId &&
        v.providerTurnId === turn.id &&
        v.parentItemId === null,
    )
    .sort((a, b) => b.ordinal - a.ordinal);
  const item = items[0];
  if (
    !item ||
    items[1]?.ordinal === item.ordinal ||
    item.type !== "assistant_message" ||
    item.id !== r.content.itemId ||
    item.threadId !== t.id ||
    item.status !== "completed" ||
    item.streaming ||
    !item.startedAt ||
    !item.completedAt ||
    !item.text.trim() ||
    taskResultPreview(item.text).preview !== r.content.preview ||
    taskResultPreview(item.text).truncated !== r.content.truncated
  )
    return null;
  const root = projection.nodes.find((v) => v.id === run.rootNodeId),
    node = projection.nodes.find((v) => v.id === item.nodeId);
  if (
    !root ||
    !node ||
    root.kind !== "root_turn" ||
    root.status !== "completed" ||
    root.runId !== run.id ||
    root.parentNodeId !== null ||
    root.rootNodeId !== root.id ||
    node.kind !== "assistant_message" ||
    node.status !== "completed" ||
    node.threadId !== t.id ||
    node.runId !== run.id ||
    node.parentNodeId !== root.id ||
    node.rootNodeId !== root.id ||
    node.providerThreadId !== run.providerThreadId ||
    node.providerTurnId !== turn.id
  )
    return null;
  return { task, review: review as Review, projection, result: { ...r, content: r.content } };
}
// Keep accepted-source handoff and unaccepted continuation policy separate.
export const revisionRequestFacts = (
  task: CollaborationTask,
  environmentId: EnvironmentId,
  review: TaskContractReviewState,
  projection: OrchestrationV2ThreadProjection,
) => outputFacts(task, environmentId, review, projection, false);
export const acceptedResultFacts = (
  task: CollaborationTask,
  environmentId: EnvironmentId,
  review: TaskContractReviewState,
  projection: OrchestrationV2ThreadProjection,
) => outputFacts(task, environmentId, review, projection, true);
export function hasAcceptedOutput(task: CollaborationTask) {
  const r = task.resultReadout,
    c = task.contractReadout;
  return (
    validTask(task) &&
    r?.status === "available" &&
    r.runStatus === "completed" &&
    r.providerTurnStatus === "completed" &&
    r.attemptId !== null &&
    r.providerTurnId !== null &&
    r.content.status === "output" &&
    c?.status === "available" &&
    c.phase === "active" &&
    c.acceptedRevision === c.contract.revision &&
    task.review !== undefined
  );
}
export type RevisionRequestFacts = NonNullable<ReturnType<typeof revisionRequestFacts>>;
export const sameRevisionFacts = (a: RevisionRequestFacts, b: RevisionRequestFacts) =>
  sameRevisionTask(a.task, b.task) &&
  sameRevisionReview(a.review, b.review) &&
  sameRevisionProjection(a.projection, b.projection);

export function continuationResult(facts: RevisionRequestFacts): TaskContinuationResult {
  const r = facts.result;
  const run = facts.projection.runs.find((v) => v.id === r.runId)!;
  const item = facts.projection.turnItems.find((v) => v.id === r.content.itemId)!;
  return {
    runId: r.runId,
    messageId: r.messageId,
    attemptId: r.attemptId!,
    providerThreadId: run.providerThreadId!,
    providerTurnId: r.providerTurnId!,
    itemId: item.id,
    rootNodeId: run.rootNodeId!,
    nodeId: item.nodeId!,
    outputSha256: digestCanonical(item.type === "assistant_message" ? item.text : ""),
  };
}

/** Read-only full review still requires an output produced under these exact criteria. */
export function taskResultReviewFacts(
  task: CollaborationTask,
  environmentId: EnvironmentId,
  review: TaskContractReviewState,
  projection: OrchestrationV2ThreadProjection,
) {
  const facts = outputFacts(task, environmentId, review, projection, "inspect");
  if (!facts) return null;
  if (
    projection.thread.agentsTaskCreation &&
    projection.thread.agentsTaskCreation.actorId !== task.ownerAgentId
  )
    return null;
  const message = projection.messages.find((m) => m.id === facts.result.messageId);
  const input = message?.taskFirstLaunch ?? message?.taskResultContinuation;
  if (
    !input ||
    (message?.taskFirstLaunch && message?.taskResultContinuation) ||
    !sameContract(input.contract, facts.review.contract) ||
    input.reference.environmentId !== environmentId ||
    input.reference.taskId !== task.id ||
    input.reference.projectId !== task.projectId ||
    input.threadId !== task.threadId ||
    input.messageId !== facts.result.messageId
  )
    return null;
  return facts;
}
export function completeResultText(facts: RevisionRequestFacts) {
  const item = facts.projection.turnItems.find((i) => i.id === facts.result.content.itemId);
  return item?.type === "assistant_message" ? item.text : null;
}
