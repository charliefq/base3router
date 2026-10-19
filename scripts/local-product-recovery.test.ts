// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { RunId, ProviderInstanceId } from "@t3tools/contracts";
import {
  assertRecovery,
  RecoveryObservation,
  type RecoveryCheckpoint,
} from "./local-product-recovery.ts";

const decodeObservation = Schema.decodeUnknownSync(RecoveryObservation);
const before = () =>
  decodeObservation({
    environmentId: "fixture-environment",
    providerStarts: 2,
    proofs: [
      {
        file: "original-first-command.json",
        commandId: "first",
        commandSha256: "original-content",
        threadId: "completed",
        proof: {
          status: "admitted",
          runId: "run-1",
          attemptId: "attempt-1",
          actualModelSelection: { instanceId: "codex", model: "fixture-manual" },
          runStatus: "completed",
          resultPreview: "attributed output",
        },
      },
      {
        file: "original-restart-unstarted-start-command.json",
        commandId: "unstarted",
        commandSha256: "never-submitted",
        threadId: "unstarted",
        proof: { status: "unknown", reason: "No matching durable command receipt. Do not resend." },
      },
    ],
    tasks: [
      {
        id: "completed",
        title: "Fixture",
        ownerAgentId: "owner",
        assigneeAgentId: "owner",
        projectId: "project",
        state: "completed",
        waitReason: null,
        acceptance: "Explicit acceptance",
        threadId: "completed",
        correlationId: "correlation",
        revision: 1,
        pendingClarificationId: null,
        gateDecision: "DENY",
        review: {
          reference: {
            environmentId: "fixture-environment",
            taskId: "completed",
            projectId: "project",
            threadUpdatedAt: "2026-10-19T00:00:00.000Z",
            threadSequence: 10,
          },
          revision: 1,
          actions: [],
          canEditInstructions: false,
        },
        resultReadout: {
          status: "available",
          runId: "run-1",
          messageId: "message-1",
          runStatus: "completed",
          attemptId: "attempt-1",
          providerTurnId: "provider-turn-1",
          providerTurnStatus: "completed",
          content: {
            status: "output",
            itemId: "output-1",
            preview: "attributed output",
            truncated: false,
          },
        },
        routingReadout: {
          status: "available",
          threadId: "completed",
          messageId: "message-1",
          runId: "run-1",
          mode: "manual",
          selected: { instanceId: "codex", model: "fixture-manual" },
          source: "explicit",
          reasons: [],
          explanation: "Manual fixture",
          selectionUnknownReason: null,
          configuredModel: { instanceId: "codex", model: "fixture-manual" },
          execution: {
            status: "observed",
            reason: null,
            providerTurnId: "provider-turn-1",
            providerStatus: "completed",
            startedAt: "2026-10-19T00:00:00.000Z",
          },
        },
      },
    ],
  });
const checkpoint = (): RecoveryCheckpoint => ({
  kind: "graceful",
  serverPid: 100,
  before: before(),
});
it("accepts unchanged original state", () => assertRecovery(checkpoint(), before()));
it.each([
  ["startup replay", (after: RecoveryObservation) => ({ ...after, providerStarts: 3 })],
  [
    "missing durable receipt",
    (after: RecoveryObservation) => ({
      ...after,
      proofs: after.proofs.map((p, i) =>
        i === 0 ? { ...p, proof: { status: "unknown" as const, reason: "No receipt" } } : p,
      ),
    }),
  ],
  [
    "changed run identity",
    (after: RecoveryObservation) => ({
      ...after,
      proofs: after.proofs.map((p, i) =>
        i === 0 && p.proof.status === "admitted"
          ? { ...p, proof: { ...p.proof, runId: RunId.make("different-run") } }
          : p,
      ),
    }),
  ],
  [
    "lost original file",
    (after: RecoveryObservation) => ({ ...after, proofs: after.proofs.slice(1) }),
  ],
  [
    "changed result",
    (after: RecoveryObservation) => ({
      ...after,
      proofs: after.proofs.map((p, i) =>
        i === 0 && p.proof.status === "admitted"
          ? { ...p, proof: { ...p.proof, resultPreview: "different output" } }
          : p,
      ),
    }),
  ],
  [
    "admitted unsubmitted original",
    (after: RecoveryObservation) => ({
      ...after,
      proofs: after.proofs.map((p, i) => (i === 1 ? { ...p, proof: after.proofs[0]!.proof } : p)),
    }),
  ],
] as const)("rejects %s", (_name, change) => {
  assert.throws(() => assertRecovery(checkpoint(), change(before())));
});

it("allows refreshed review timestamps without weakening stable state", () => {
  const after = before();
  const refreshed = {
    ...after,
    tasks: after.tasks.map((t) =>
      t.review
        ? {
            ...t,
            review: {
              ...t.review,
              reference: { ...t.review.reference, threadUpdatedAt: "2026-10-19T00:01:00.000Z" },
            },
          }
        : t,
    ),
  };
  assertRecovery(checkpoint(), refreshed);
});
it.each([
  [
    "changed original command",
    (after: RecoveryObservation) => ({
      ...after,
      proofs: after.proofs.map((p, i) => (i === 0 ? { ...p, commandSha256: "changed" } : p)),
    }),
  ],
  ["lost task", (after: RecoveryObservation) => ({ ...after, tasks: [] })],
  [
    "changed accepted task revision",
    (after: RecoveryObservation) => ({
      ...after,
      tasks: after.tasks.map((t) => ({ ...t, revision: 2 })),
    }),
  ],
  [
    "changed attributed task output",
    (after: RecoveryObservation) => ({
      ...after,
      tasks: after.tasks.map((t) =>
        t.resultReadout?.status === "available"
          ? {
              ...t,
              resultReadout: {
                ...t.resultReadout,
                content: {
                  status: "output" as const,
                  itemId: "replacement-output",
                  preview: "wrong result",
                  truncated: false,
                },
              },
            }
          : t,
      ),
    }),
  ],
  [
    "changed actual route",
    (after: RecoveryObservation) => ({
      ...after,
      tasks: after.tasks.map((t) =>
        t.routingReadout?.status === "available"
          ? {
              ...t,
              routingReadout: {
                ...t.routingReadout,
                selected: { instanceId: ProviderInstanceId.make("codex"), model: "wrong-model" },
              },
            }
          : t,
      ),
    }),
  ],
] as const)("rejects %s", (_name, change) =>
  assert.throws(() => assertRecovery(checkpoint(), change(before()))),
);

function crashFixture() {
  const initial = before();
  const task = initial.tasks[0]!;
  const original = initial.proofs[0]!;
  assert.equal(original.proof.status, "admitted");
  if (original.proof.status !== "admitted") throw Error("Missing fixture run");
  const heldProof = {
    ...original,
    file: "original-restart-inflight-start-command.json",
    commandId: "held-start",
    commandSha256: "held-original",
    threadId: "held",
    proof: {
      ...original.proof,
      runId: RunId.make("held-run"),
      runStatus: "running",
      resultPreview: null,
    },
  };
  const heldTask = {
    ...task,
    id: "held",
    threadId: "held",
    state: "running",
    resultReadout: {
      status: "available",
      runId: "held-run",
      messageId: "held-message",
      runStatus: "running",
      attemptId: "attempt-1",
      providerTurnId: "provider-turn-2",
      providerTurnStatus: "running",
      content: { status: "unknown", reason: "no_completed_result" },
    },
  };
  const captured = decodeObservation({
    ...initial,
    providerStarts: 3,
    proofs: [...initial.proofs, heldProof],
    tasks: [...initial.tasks, heldTask],
  });
  const after = decodeObservation({
    ...captured,
    proofs: captured.proofs.map((p) =>
      p.file === heldProof.file && p.proof.status === "admitted"
        ? { ...p, proof: { ...p.proof, runStatus: "cancelled" } }
        : p,
    ),
    tasks: captured.tasks.map((t) =>
      t.id === "held" && t.resultReadout?.status === "available"
        ? {
            ...t,
            resultReadout: {
              ...t.resultReadout,
              runStatus: "cancelled",
              providerTurnStatus: "cancelled",
            },
          }
        : t,
    ),
  });
  return {
    checkpoint: { kind: "crash", serverPid: 100, before: captured } satisfies RecoveryCheckpoint,
    after,
  };
}
it("requires the same crash-held run to cancel without a completed result", () => {
  const { checkpoint, after } = crashFixture();
  assertRecovery(checkpoint, after);
});
it.each(["completed", "running"])("rejects crash-held status %s", (status) => {
  const { checkpoint, after } = crashFixture();
  assert.throws(() =>
    assertRecovery(checkpoint, {
      ...after,
      proofs: after.proofs.map((p) =>
        p.file.includes("inflight") && p.proof.status === "admitted"
          ? { ...p, proof: { ...p.proof, runStatus: status } }
          : p,
      ),
    }),
  );
});
it("rejects a fabricated completed output after crash cancellation", () => {
  const { checkpoint, after } = crashFixture();
  assert.throws(() =>
    assertRecovery(checkpoint, {
      ...after,
      tasks: after.tasks.map((t) =>
        t.id === "held" && t.resultReadout?.status === "available"
          ? {
              ...t,
              resultReadout: {
                ...t.resultReadout,
                content: {
                  status: "output",
                  itemId: "fake-output",
                  preview: "not completed",
                  truncated: false,
                },
              },
            }
          : t,
      ),
    }),
  );
});
