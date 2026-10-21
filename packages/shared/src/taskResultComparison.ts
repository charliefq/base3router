import {
  CollaborationTask,
  OrchestrationV2ThreadProjection,
  TaskContract,
  ModelSelection,
  type EnvironmentId,
  type TaskContractReviewState,
  type TaskContinuationResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { digestCanonical } from "./actionCanonical.ts";
import { taskResultReviewFacts, continuationResult } from "./taskRevisionRequest.ts";

const sameContract = Schema.toEquivalence(TaskContract);
const sameModel = Schema.toEquivalence(ModelSelection);
const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

/** Historical records are data for one comparison, never current-result or execution authority. */
export function taskResultComparison(
  task: CollaborationTask,
  environmentId: EnvironmentId,
  review: TaskContractReviewState,
  projection: OrchestrationV2ThreadProjection,
) {
  const facts = taskResultReviewFacts(task, environmentId, review, projection);
  if (!facts) {
    if (
      Schema.is(CollaborationTask)(task) &&
      Schema.is(OrchestrationV2ThreadProjection)(projection)
    ) {
      const result = task.resultReadout;
      if (
        result?.status === "available" &&
        result.runStatus === "completed" &&
        result.content.status === "output"
      ) {
        const input = projection.messages.find(
          (m) => m.id === result.messageId && m.threadId === task.threadId,
        );
        if (input && !input.taskFirstLaunch && !input.taskResultContinuation)
          return unavailable(
            "The current recorded input has no revision-continuation binding. Ordinary follow-ups and legacy inputs do not identify a predecessor.",
          );
      }
    }
    return unavailable(
      "The current result is not a confirmed complete attributable output. Running, failed, incomplete or mismatched evidence cannot be compared.",
    );
  }
  const currentMessage = projection.messages.find((m) => m.id === facts.result.messageId)!;
  if (currentMessage.taskFirstLaunch)
    return unavailable(
      "This output comes from a first launch. No persisted revision predecessor is recorded.",
    );
  const continuation = currentMessage.taskResultContinuation;
  if (!continuation || !continuation.text.trim())
    return unavailable(
      "Persisted requested changes and an explicit predecessor binding are required for comparison.",
    );

  // Resolve only named identities; ordinal checks reject conflict, never select a predecessor.
  const recorded = (identity: TaskContinuationResult) => {
    const run = projection.runs.find((v) => v.id === identity.runId);
    const attempt = projection.attempts.find((v) => v.id === identity.attemptId);
    const turn = projection.providerTurns.find((v) => v.id === identity.providerTurnId);
    const provider = projection.providerThreads.find((v) => v.id === identity.providerThreadId);
    const root = projection.nodes.find((v) => v.id === identity.rootNodeId);
    const node = projection.nodes.find((v) => v.id === identity.nodeId);
    const item = projection.turnItems.find((v) => v.id === identity.itemId);
    const message = projection.messages.find((v) => v.id === identity.messageId);
    if (!run || !attempt || !turn || !provider || !root || !node || !item || !message) return null;
    if (
      run.threadId !== task.threadId ||
      run.status !== "completed" ||
      !run.startedAt ||
      !run.completedAt ||
      run.activeAttemptId !== attempt.id ||
      run.rootNodeId !== root.id ||
      run.providerThreadId !== provider.id ||
      run.userMessageId !== message.id ||
      run.modelSelection.instanceId !== run.providerInstanceId ||
      projection.runs.some((v) => v.id !== run.id && v.ordinal === run.ordinal) ||
      attempt.runId !== run.id ||
      attempt.rootNodeId !== root.id ||
      attempt.providerInstanceId !== run.providerInstanceId ||
      attempt.providerThreadId !== provider.id ||
      attempt.providerTurnId !== turn.id ||
      attempt.status !== "completed" ||
      !attempt.startedAt ||
      !attempt.completedAt ||
      projection.attempts.some(
        (v) =>
          v.runId === run.id && v.id !== attempt.id && v.attemptOrdinal >= attempt.attemptOrdinal,
      ) ||
      turn.runAttemptId !== attempt.id ||
      turn.nodeId !== root.id ||
      turn.providerThreadId !== provider.id ||
      turn.status !== "completed" ||
      !turn.startedAt ||
      !turn.completedAt ||
      projection.providerTurns.some(
        (v) => v.id !== turn.id && v.runAttemptId === attempt.id && v.ordinal >= turn.ordinal,
      ) ||
      provider.appThreadId !== task.threadId ||
      provider.providerInstanceId !== run.providerInstanceId ||
      root.threadId !== task.threadId ||
      root.runId !== run.id ||
      root.rootNodeId !== root.id ||
      root.parentNodeId !== null ||
      (root.providerThreadId !== null && root.providerThreadId !== provider.id) ||
      (root.providerTurnId !== null && root.providerTurnId !== turn.id) ||
      root.kind !== "root_turn" ||
      root.status !== "completed" ||
      node.threadId !== task.threadId ||
      node.runId !== run.id ||
      node.rootNodeId !== root.id ||
      node.parentNodeId !== root.id ||
      node.kind !== "assistant_message" ||
      node.status !== "completed" ||
      node.providerThreadId !== provider.id ||
      node.providerTurnId !== turn.id ||
      item.type !== "assistant_message" ||
      item.threadId !== task.threadId ||
      item.runId !== run.id ||
      item.nodeId !== node.id ||
      item.providerThreadId !== provider.id ||
      item.providerTurnId !== turn.id ||
      item.parentItemId !== null ||
      item.status !== "completed" ||
      item.streaming ||
      !item.startedAt ||
      !item.completedAt ||
      !item.text.trim() ||
      projection.turnItems.some(
        (v) =>
          v.id !== item.id &&
          v.type === "assistant_message" &&
          v.runId === run.id &&
          v.providerThreadId === provider.id &&
          v.providerTurnId === turn.id &&
          v.parentItemId === null &&
          v.ordinal >= item.ordinal,
      ) ||
      message.threadId !== task.threadId ||
      message.runId !== run.id ||
      message.nodeId !== root.id ||
      message.role !== "user" ||
      message.streaming
    )
      return null;
    const input = message.taskFirstLaunch ?? message.taskResultContinuation;
    if (
      !input ||
      (message.taskFirstLaunch && message.taskResultContinuation) ||
      input.threadId !== task.threadId ||
      input.messageId !== message.id ||
      input.reference.environmentId !== environmentId ||
      input.reference.projectId !== task.projectId ||
      input.reference.taskId !== task.id ||
      input.reference.threadSequence > facts.review.reference.threadSequence ||
      input.contract.revision > facts.review.contract.revision ||
      (input.contract.revision === facts.review.contract.revision &&
        !sameContract(input.contract, facts.review.contract)) ||
      (input.routingMode === "manual" && !sameModel(input.modelSelection, run.modelSelection))
    )
      return null;
    return {
      identity,
      text: item.text,
      contract: input.contract,
      input,
      runOrdinal: run.ordinal,
      runSelection: run.modelSelection,
      modelIdentity: turn.modelIdentity,
    };
  };
  const current = recorded(continuationResult(facts));
  const previous = recorded(continuation.priorResult);
  if (!current || !previous)
    return unavailable(
      "The named predecessor execution chain or its own persisted input/criteria is missing, ambiguous or mismatched.",
    );
  if (
    previous.identity.runId === current.identity.runId ||
    previous.runOrdinal >= current.runOrdinal ||
    currentMessage.text !== continuation.text
  )
    return unavailable(
      "The persisted revision input does not establish an earlier distinct predecessor and matching requested changes.",
    );
  if (digestCanonical(previous.text) !== continuation.priorResult.outputSha256)
    return unavailable(
      "The predecessor full text no longer matches the digest recorded by this revision request.",
    );
  return {
    status: "available" as const,
    previous,
    current,
    requestedChanges: continuation.text,
    ownerAgentId: task.ownerAgentId,
    environmentId,
    projectId: task.projectId,
    taskId: task.id,
    threadId: task.threadId,
  };
}
export type TaskResultComparison = ReturnType<typeof taskResultComparison>;
