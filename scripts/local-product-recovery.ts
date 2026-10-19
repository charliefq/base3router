// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  CollaborationTask,
  TaskFirstLaunchStatus,
  OrchestrationV2RpcSchemas,
} from "@t3tools/contracts";

const Proof = Schema.Union([
  TaskFirstLaunchStatus,
  OrchestrationV2RpcSchemas.getAgentsCreationStatus.output,
]);
export const RecoveryObservation = Schema.Struct({
  environmentId: Schema.String,
  providerStarts: Schema.Number,
  proofs: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      commandId: Schema.String,
      commandSha256: Schema.String,
      threadId: Schema.String,
      proof: Proof,
    }),
  ),
  tasks: Schema.Array(CollaborationTask),
});
export type RecoveryObservation = typeof RecoveryObservation.Type;
export const RecoveryCheckpoint = Schema.Struct({
  kind: Schema.Literals(["graceful", "crash"]),
  serverPid: Schema.Number,
  before: RecoveryObservation,
});
export type RecoveryCheckpoint = typeof RecoveryCheckpoint.Type;
export const decodeRecoveryCheckpoint = Schema.decodeUnknownSync(
  Schema.fromJsonString(RecoveryCheckpoint),
);

const neverSubmittedFile = "original-restart-unstarted-start-command.json";
const crashHeldFile = "original-restart-inflight-start-command.json";
function stableTask(task: CollaborationTask) {
  const reference = task.review?.reference;
  const { threadUpdatedAt: _observedReviewTime, ...stableReference } = reference ?? {};
  const budget = task.budgetReadout;
  const stableBudget =
    budget?.status === "available"
      ? (({ observedAt: _observedAt, ...rest }) => rest)(budget)
      : budget;
  return {
    ...task,
    ...(task.review ? { review: { ...task.review, reference: stableReference } } : {}),
    ...(budget ? { budgetReadout: stableBudget } : {}),
  };
}
export function assertRecoveryCheckpoint(checkpoint: RecoveryCheckpoint): void {
  const before = checkpoint.before;
  NodeAssert.ok(Number.isInteger(before.providerStarts) && before.providerStarts > 0);
  NodeAssert.equal(new Set(before.proofs.map((p) => p.file)).size, before.proofs.length);
  NodeAssert.equal(new Set(before.proofs.map((p) => p.commandId)).size, before.proofs.length);
  const completed = before.proofs.find((p) => p.file === "original-first-command.json");
  NodeAssert.ok(
    completed?.proof.status === "admitted" && completed.proof.runStatus === "completed",
    "Checkpoint must include the completed original journey",
  );
  const unsubmitted = before.proofs.find((p) => p.file === neverSubmittedFile);
  NodeAssert.ok(
    unsubmitted?.proof.status === "unknown" &&
      "reason" in unsubmitted.proof &&
      unsubmitted.proof.reason.includes("No matching durable command receipt"),
    "Never-submitted original must have no receipt before restart",
  );
  for (const original of before.proofs) {
    NodeAssert.ok(
      ["committed", "admitted", "unknown"].includes(original.proof.status),
      "Checkpoint cannot bless a rejected or unavailable receipt",
    );
  }
  if (checkpoint.kind === "crash") {
    const held = before.proofs.find((p) => p.file === crashHeldFile);
    NodeAssert.ok(
      held?.proof.status === "admitted" && held.proof.runStatus === "running",
      "Crash checkpoint must capture the admitted running original",
    );
    NodeAssert.ok(before.tasks.some((t) => t.threadId === held.threadId));
  }
}
export function assertRecovery(checkpoint: RecoveryCheckpoint, after: RecoveryObservation): void {
  assertRecoveryCheckpoint(checkpoint);
  const before = checkpoint.before;
  NodeAssert.equal(after.environmentId, before.environmentId, "Environment identity changed");
  NodeAssert.equal(
    after.providerStarts,
    before.providerStarts,
    "Native provider replay or journal loss across restart",
  );
  NodeAssert.deepStrictEqual(
    after.proofs.map((p) => p.file).sort(),
    before.proofs.map((p) => p.file).sort(),
    "Original command inventory changed",
  );
  const held =
    checkpoint.kind === "crash" ? before.proofs.find((p) => p.file === crashHeldFile) : undefined;
  for (const expected of before.proofs) {
    const observed = after.proofs.find((p) => p.file === expected.file);
    const proof =
      held === expected && expected.proof.status === "admitted"
        ? { ...expected.proof, runStatus: "cancelled", resultPreview: null }
        : expected.proof;
    NodeAssert.deepStrictEqual(
      observed,
      { ...expected, proof },
      `Original receipt/run/route/result changed: ${expected.file}`,
    );
  }
  NodeAssert.deepStrictEqual(
    after.tasks.map((t) => t.id).sort(),
    before.tasks.map((t) => t.id).sort(),
    "Task inventory changed",
  );
  for (const expected of before.tasks) {
    const observed = after.tasks.find((t) => t.id === expected.id);
    NodeAssert.ok(observed, "Original task disappeared");
    if (held && expected.threadId === held.threadId && held.proof.status === "admitted") {
      const runningResult = expected.resultReadout;
      const runningRoute = expected.routingReadout;
      NodeAssert.ok(
        runningResult?.status === "available" &&
          runningResult.runStatus === "running" &&
          runningResult.providerTurnStatus === "running",
        "Checkpoint must retain the running native result linkage",
      );
      NodeAssert.ok(
        runningRoute?.status === "available" &&
          runningRoute.execution.status === "observed" &&
          runningRoute.execution.providerStatus === "running",
        "Checkpoint must retain observed running route linkage",
      );
      NodeAssert.equal(runningResult.runId, held.proof.runId);
      NodeAssert.equal(runningResult.attemptId, held.proof.attemptId);
      NodeAssert.equal(runningRoute.runId, runningResult.runId);
      NodeAssert.equal(runningRoute.messageId, runningResult.messageId);
      NodeAssert.equal(runningRoute.execution.providerTurnId, runningResult.providerTurnId);
      NodeAssert.deepStrictEqual(runningRoute.selected, held.proof.actualModelSelection);
      NodeAssert.deepStrictEqual(runningResult.content, {
        status: "unknown",
        reason: "no_completed_result",
      });
      // Startup cancellation changes only these terminal statuses. Preserve every
      // original message/native-turn/model/result/route field and all task state.
      const cancelled = {
        ...expected,
        resultReadout: {
          ...runningResult,
          runStatus: "cancelled" as const,
          providerTurnStatus: "cancelled" as const,
        },
        routingReadout: {
          ...runningRoute,
          execution: { ...runningRoute.execution, providerStatus: "cancelled" as const },
        },
      };
      NodeAssert.deepStrictEqual(
        stableTask(observed),
        stableTask(cancelled),
        "Crash-held task/result/route/native linkage changed",
      );
    } else {
      NodeAssert.deepStrictEqual(
        stableTask(observed),
        stableTask(expected),
        "Stable task/result/actual route changed",
      );
    }
  }
}
