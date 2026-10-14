import {
  EnvironmentId,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  TurnItemId,
  type CollaborationTask,
  type TaskContractReviewState,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { withTaskRevisionRequestFixture } from "./testkit/taskRevisionRequestFixture";
import {
  revisionRequestFacts,
  revisionSnapshotTask,
  sameRevisionFacts,
} from "./taskRevisionRequest";

it("requires the exact current owned root and latest completed attributed identities", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const original = f.snapshot.tasks[0]!;
    const reviewed = await f.readOwnedReviewAsync();
    if (reviewed.status !== "available") throw new Error("Owned review unavailable");
    const before = await f.dbChangesAsync();
    const valid = revisionRequestFacts(
      original,
      EnvironmentId.make("environment-a"),
      reviewed,
      f.projection,
    );
    expect(valid).not.toBeNull();
    for (const mode of [
      "environment",
      "owner",
      "readonly",
      "root",
      "revision",
      "reference",
      "paused",
      "accepted",
      "deleted",
      "project",
      "run",
      "message",
      "attempt",
      "turn",
      "item",
      "streaming",
      "unknown",
      "failed",
      "newer-run",
      "queued",
      "running",
      "newer-item",
      "edited-item",
      "background",
      "duplicate-task",
      "projection-unavailable",
      "later-attempt",
      "later-turn",
      "duplicate-item",
    ] as const) {
      let task: CollaborationTask = original,
        review: TaskContractReviewState = reviewed,
        projection: OrchestrationV2ThreadProjection = f.projection;
      if (
        review.status !== "available" ||
        task.resultReadout?.status !== "available" ||
        task.resultReadout.content.status !== "output"
      )
        throw new Error("Fixture facts unavailable");
      const result = task.resultReadout;
      if (result.content.status !== "output") throw new Error("Fixture output unavailable");
      if (mode === "environment")
        review = {
          ...review,
          reference: { ...reviewed.reference, environmentId: "environment-b" },
        };
      if (mode === "owner" || mode === "readonly")
        review = { status: "unavailable", reason: "owner-or-operate-required" };
      if (mode === "root")
        projection = {
          ...projection,
          thread: {
            ...projection.thread,
            lineage: {
              ...projection.thread.lineage,
              parentThreadId: f.command.threadId,
              relationshipToParent: "subagent",
            },
          },
        };
      if (mode === "revision")
        review = { ...reviewed, contract: { ...reviewed.contract, revision: 2 } };
      if (mode === "reference")
        review = {
          ...reviewed,
          reference: {
            ...reviewed.reference,
            threadSequence: reviewed.reference.threadSequence + 1,
          },
        };
      if (mode === "paused")
        projection = {
          ...projection,
          thread: { ...projection.thread, taskContractPhase: "redirected" },
        };
      if (mode === "accepted")
        projection = { ...projection, thread: { ...projection.thread, taskAcceptedRevision: 1 } };
      if (mode === "deleted")
        projection = {
          ...projection,
          thread: { ...projection.thread, deletedAt: projection.thread.updatedAt },
        };
      if (mode === "project") task = { ...task, projectId: "other-project" };
      if (mode === "run" || mode === "message" || mode === "attempt" || mode === "turn")
        task = {
          ...task,
          resultReadout: {
            ...result,
            [mode === "run"
              ? "runId"
              : mode === "message"
                ? "messageId"
                : mode === "attempt"
                  ? "attemptId"
                  : "providerTurnId"]: "other-id",
          },
        };
      if (mode === "item")
        task = {
          ...task,
          resultReadout: { ...result, content: { ...result.content, itemId: "other-item" } },
        };
      if (mode === "unknown")
        task = {
          ...task,
          resultReadout: { ...result, content: { status: "unknown", reason: "missing-evidence" } },
        };
      if (mode === "failed") task = { ...task, resultReadout: { ...result, runStatus: "failed" } };
      if (mode === "queued" || mode === "running")
        projection = { ...projection, runs: projection.runs.map((r) => ({ ...r, status: mode })) };
      if (mode === "newer-run")
        projection = {
          ...projection,
          runs: [
            ...projection.runs,
            { ...projection.runs[0]!, id: RunId.make("newer-run"), ordinal: 2 },
          ],
        };
      if (mode === "streaming" || mode === "newer-item" || mode === "edited-item")
        projection = {
          ...projection,
          turnItems: projection.turnItems.map((i) =>
            i.type === "assistant_message"
              ? {
                  ...i,
                  ...(mode === "streaming"
                    ? { streaming: true }
                    : mode === "newer-item"
                      ? { id: TurnItemId.make("newer-output"), ordinal: i.ordinal + 1 }
                      : { text: "changed output" }),
                }
              : i,
          ),
        };
      if (mode === "background")
        projection = {
          ...projection,
          providerTurns: projection.providerTurns.map((t) => ({ ...t, status: "running" })),
        };
      if (mode === "later-attempt")
        projection = {
          ...projection,
          attempts: [
            ...projection.attempts,
            {
              ...projection.attempts[0]!,
              id: RunAttemptId.make("later-attempt"),
              attemptOrdinal: 2,
            },
          ],
        };
      if (mode === "later-turn")
        projection = {
          ...projection,
          providerTurns: [
            ...projection.providerTurns,
            { ...projection.providerTurns[0]!, id: ProviderTurnId.make("later-turn"), ordinal: 2 },
          ],
        };
      if (mode === "duplicate-item")
        projection = {
          ...projection,
          turnItems: [...projection.turnItems, projection.turnItems[0]!],
        };
      if (mode === "projection-unavailable") projection = { ...projection, runs: [] };
      if (mode === "duplicate-task") {
        expect(
          revisionSnapshotTask(
            { ...f.snapshot, tasks: [original, original] },
            EnvironmentId.make("environment-a"),
            original,
          ),
        ).toBeNull();
        continue;
      }
      expect(
        revisionRequestFacts(task, EnvironmentId.make("environment-a"), review, projection),
        mode,
      ).toBeNull();
    }
    if (!valid) throw new Error("Fixture eligibility missing");
    const changed = revisionRequestFacts(original, EnvironmentId.make("environment-a"), reviewed, {
      ...f.projection,
      turnItems: f.projection.turnItems.map((i) =>
        i.type === "assistant_message" ? { ...i, text: i.text + " changed beyond excerpt" } : i,
      ),
    });
    expect(changed).not.toBeNull();
    expect(sameRevisionFacts(valid, changed!)).toBe(false);
    expect(
      revisionSnapshotTask(
        { ...f.snapshot, environmentId: "environment-b" },
        EnvironmentId.make("environment-a"),
        original,
      ),
    ).toBeNull();
    expect(await f.dbChangesAsync()).toEqual(before);
  });
});

it.each([
  "active-thread",
  "command_execution:pending",
  "command_execution:running",
  "command_execution:waiting",
  "dynamic_tool:pending",
  "dynamic_tool:running",
  "dynamic_tool:waiting",
  "subagent:pending",
  "subagent:running",
  "subagent:waiting",
] as const)(
  "refuses current completed-result preparation with %s execution evidence",
  async (mode) => {
    await withTaskRevisionRequestFixture(async (f) => {
      const env = EnvironmentId.make("environment-a");
      expect(
        revisionRequestFacts(
          f.snapshot.tasks[0]!,
          env,
          await f.readOwnedReviewAsync(),
          f.projection,
        ),
      ).not.toBeNull();
      if (mode === "active-thread") await f.setSelectedThreadStatusAsync("active");
      else {
        const [type, status] = mode.split(":") as [
          "command_execution" | "dynamic_tool" | "subagent",
          "pending" | "running" | "waiting",
        ];
        await f.insertRecoveryItemAsync(type, status);
      }
      const marker = await f.dbChangesAsync();
      const facts = await f.freshFactsAsync(),
        review = await f.readOwnedReviewAsync();
      expect(facts.snapshot.tasks[0]?.resultReadout).toMatchObject({
        status: "available",
        runStatus: "completed",
        providerTurnStatus: "completed",
        content: { status: "output" },
      });
      expect(review.status).toBe("available");
      expect(
        revisionRequestFacts(facts.snapshot.tasks[0]!, env, review, facts.projection),
      ).toBeNull();
      expect(await f.dbChangesAsync()).toEqual(marker);
    });
  },
);

it("keeps historical recovery items separate from the selected completed result turn", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    await f.insertRecoveryItemAsync("command_execution", "running", true);
    const marker = await f.dbChangesAsync(),
      facts = await f.freshFactsAsync();
    expect(
      revisionRequestFacts(
        facts.snapshot.tasks[0]!,
        EnvironmentId.make("environment-a"),
        await f.readOwnedReviewAsync(),
        facts.projection,
      ),
    ).not.toBeNull();
    expect(await f.dbChangesAsync()).toEqual(marker);
  });
});
