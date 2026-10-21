import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  MessageId,
  ProviderThreadId,
  CommandId,
  type OrchestrationV2ThreadProjection as Projection,
  type TaskResultContinuation,
} from "@t3tools/contracts";
import { taskResultComparison } from "@t3tools/shared/taskResultComparison";
import { revisionRequestFacts, continuationResult } from "@t3tools/shared/taskRevisionRequest";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
import { completed, continuation, send } from "./testkit/resultContinuationJourney";

type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
const previousText = "Previous 😀\n" + "x".repeat(2300) + "\nPREVIOUS TAIL\n  ";
const currentText = "Current 🧪\n" + "y".repeat(2300) + "\nCURRENT TAIL\n  ";
const changes = "Exact persisted feedback 😀\n  Preserve this ending.\n  ";
async function pair(f: Fixture, key: string, mode: "manual" | "auto" = "manual") {
  f.setWorkflowOutput(previousText);
  const c = await completed(f, key);
  const { m: initial } = await continuation(f, c, key, mode);
  const m = { ...initial, text: changes };
  if (mode === "auto")
    f.setProviders([
      {
        ...f.providers[0]!,
        models: [
          { ...f.providers[0]!.models[0]!, slug: "aaa-next-result", name: "Next recorded model" },
          ...f.providers[0]!.models,
        ],
      },
    ]);
  f.setWorkflowOutput(currentText);
  expect((await send(f, m, m))._tag).toBe("Success");
  await f.settle(m.messageId);
  const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
  const r = await f.review({
    environmentId: "environment-a",
    taskId: task.id,
    projectId: task.projectId,
    threadId: c.threadId,
    revision: 1,
  });
  const p = await f.projection({ threadId: c.threadId });
  if (r._tag !== "Success" || r.value.status !== "available" || p._tag !== "Success")
    throw new Error("missing paired fixture");
  return { c, m, task, review: r.value, projection: p.value };
}
it.each(["manual", "auto"] as const)(
  "comparison follows the persisted %s link and records both models without inference",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      const data = await pair(f, `comparison-${mode}`, mode),
        before = await f.executionCounts();
      const value = taskResultComparison(
        data.task,
        EnvironmentId.make("environment-a"),
        data.review,
        {
          ...data.projection,
          runs: [...data.projection.runs].reverse(),
          turnItems: [...data.projection.turnItems].reverse(),
        },
      );
      expect(value.status).toBe("available");
      if (value.status !== "available") throw new Error(value.reason);
      expect(value.previous.identity).toEqual(data.m.priorResult);
      expect(value.previous.text).toBe(previousText);
      expect(value.current.text).toBe(currentText);
      expect(value.requestedChanges).toBe(changes);
      expect(value.current.identity.runId).not.toBe(value.previous.identity.runId);
      expect(value.previous.runSelection.model).toBe("exact-second");
      expect(value.current.runSelection.model).toBe(
        mode === "manual" ? "exact-second" : "aaa-next-result",
      );
      expect(value.current.modelIdentity).toBeUndefined();
      expect(await f.executionCounts()).toEqual(before);
    });
  },
  30000,
);

const replace = <A extends { id: string }>(
  values: ReadonlyArray<A>,
  id: string,
  update: (value: A) => A,
) => values.map((v) => (v.id === id ? update(v) : v));
it("comparison rejects missing, ambiguous, altered and mismatched historical chains without positional substitution", async () => {
  await withTaskTransportFixture(async (f) => {
    const d = await pair(f, "comparison-invalid"),
      p = d.projection,
      prior = d.m.priorResult;
    const modifyInput = (
      update: (m: TaskResultContinuation) => TaskResultContinuation,
    ): Projection => ({
      ...p,
      messages: replace(p.messages, d.m.messageId, (m) => ({
        ...m,
        taskResultContinuation: update(m.taskResultContinuation!),
      })),
    });
    const modes: Array<[string, Projection]> = [];
    for (const field of [
      "runId",
      "messageId",
      "attemptId",
      "providerThreadId",
      "providerTurnId",
      "itemId",
      "rootNodeId",
      "nodeId",
      "outputSha256",
    ] as const)
      modes.push([
        `binding-${field}`,
        modifyInput((m) => ({
          ...m,
          priorResult: {
            ...m.priorResult,
            [field]: field === "outputSha256" ? "0".repeat(64) : `missing-${field}`,
          },
        })),
      ]);
    modes.push(
      [
        "historical-full-tail",
        {
          ...p,
          turnItems: replace(p.turnItems, prior.itemId, (item) =>
            item.type === "assistant_message"
              ? { ...item, text: previousText.replace("PREVIOUS TAIL", "ALTERED TAIL") }
              : item,
          ),
        },
      ],
      [
        "historical-run-thread",
        {
          ...p,
          runs: replace(p.runs, prior.runId, (run) => ({
            ...run,
            threadId: ThreadId.make(d.c.threadId + "-sibling"),
          })),
        },
      ],
      [
        "historical-run-failed",
        { ...p, runs: replace(p.runs, prior.runId, (run) => ({ ...run, status: "failed" })) },
      ],
      [
        "historical-run-ordinal-tie",
        {
          ...p,
          runs: [
            ...p.runs,
            { ...p.runs[0]!, id: RunId.make(p.runs[0]!.id + "-duplicate-ordinal") },
          ],
        },
      ],
      [
        "historical-run-attempt",
        {
          ...p,
          runs: replace(p.runs, prior.runId, (run) => ({
            ...run,
            activeAttemptId: d.projection.runs[1]!.activeAttemptId,
          })),
        },
      ],
      [
        "historical-attempt-run",
        {
          ...p,
          attempts: replace(p.attempts, prior.attemptId, (a) => ({ ...a, runId: p.runs[1]!.id })),
        },
      ],
      [
        "historical-attempt-turn",
        {
          ...p,
          attempts: replace(p.attempts, prior.attemptId, (a) => ({
            ...a,
            providerTurnId: p.providerTurns[1]!.id,
          })),
        },
      ],
      [
        "historical-provider-sibling",
        {
          ...p,
          providerThreads: replace(p.providerThreads, prior.providerThreadId, (t) => ({
            ...t,
            appThreadId: ThreadId.make(d.c.threadId + "-sibling"),
          })),
        },
      ],
      [
        "historical-turn-node",
        {
          ...p,
          providerTurns: replace(p.providerTurns, prior.providerTurnId, (t) => ({
            ...t,
            nodeId: p.runs[1]!.rootNodeId!,
          })),
        },
      ],
      [
        "historical-turn-failed",
        {
          ...p,
          providerTurns: replace(p.providerTurns, prior.providerTurnId, (t) => ({
            ...t,
            status: "failed",
          })),
        },
      ],
      [
        "historical-root-thread",
        {
          ...p,
          nodes: replace(p.nodes, prior.rootNodeId, (n) => ({
            ...n,
            threadId: ThreadId.make(d.c.threadId + "-sibling"),
          })),
        },
      ],
      [
        "historical-root-provider",
        {
          ...p,
          nodes: replace(p.nodes, prior.rootNodeId, (n) => ({
            ...n,
            providerThreadId: ProviderThreadId.make("wrong-provider-thread"),
          })),
        },
      ],
      [
        "historical-node-parent",
        {
          ...p,
          nodes: replace(p.nodes, prior.nodeId, (n) => ({
            ...n,
            parentNodeId: p.runs[1]!.rootNodeId,
          })),
        },
      ],
      [
        "historical-item-streaming",
        {
          ...p,
          turnItems: replace(p.turnItems, prior.itemId, (item) => ({ ...item, streaming: true })),
        },
      ],
      [
        "historical-item-empty",
        {
          ...p,
          turnItems: replace(p.turnItems, prior.itemId, (item) =>
            item.type === "assistant_message" ? { ...item, text: "  " } : item,
          ),
        },
      ],
      [
        "historical-item-node",
        {
          ...p,
          turnItems: replace(p.turnItems, prior.itemId, (item) => ({
            ...item,
            nodeId: p.runs[1]!.rootNodeId,
          })),
        },
      ],
      [
        "historical-message-sibling",
        {
          ...p,
          messages: replace(p.messages, prior.messageId, (m) => ({
            ...m,
            threadId: ThreadId.make(d.c.threadId + "-sibling"),
          })),
        },
      ],
      [
        "historical-input-missing",
        {
          ...p,
          messages: replace(p.messages, prior.messageId, (m) => {
            const { taskFirstLaunch: _first, taskResultContinuation: _next, ...rest } = m;
            return rest;
          }),
        },
      ],
      [
        "historical-input-task",
        {
          ...p,
          messages: replace(p.messages, prior.messageId, (m) => ({
            ...m,
            taskFirstLaunch: {
              ...m.taskFirstLaunch!,
              reference: { ...m.taskFirstLaunch!.reference, taskId: "sibling-task" },
            },
          })),
        },
      ],
      [
        "historical-input-environment",
        {
          ...p,
          messages: replace(p.messages, prior.messageId, (m) => ({
            ...m,
            taskFirstLaunch: {
              ...m.taskFirstLaunch!,
              reference: {
                ...m.taskFirstLaunch!.reference,
                environmentId: EnvironmentId.make("environment-b"),
              },
            },
          })),
        },
      ],
      [
        "historical-criteria-conflict",
        {
          ...p,
          messages: replace(p.messages, prior.messageId, (m) => ({
            ...m,
            taskFirstLaunch: {
              ...m.taskFirstLaunch!,
              contract: {
                ...m.taskFirstLaunch!.contract,
                goal: "Contradicts the same immutable revision",
              },
            },
          })),
        },
      ],
      [
        "historical-input-model",
        {
          ...p,
          messages: replace(p.messages, prior.messageId, (m) => ({
            ...m,
            taskFirstLaunch: {
              ...m.taskFirstLaunch!,
              modelSelection: { ...m.taskFirstLaunch!.modelSelection, model: "unrecorded-model" },
            },
          })),
        },
      ],
      [
        "duplicate-historical-item",
        { ...p, turnItems: [...p.turnItems, p.turnItems.find((v) => v.id === prior.itemId)!] },
      ],
      [
        "requested-input-changed",
        modifyInput((m) => ({ ...m, text: "Changed separately from the stored message" })),
      ],
      [
        "current-message-changed",
        {
          ...p,
          messages: replace(p.messages, d.m.messageId, (m) => ({
            ...m,
            text: "Changed separately from persisted feedback",
          })),
        },
      ],
      [
        "self-predecessor",
        modifyInput((m) => ({
          ...m,
          priorResult: continuationResult(
            revisionRequestFacts(d.task, EnvironmentId.make("environment-a"), d.review, p)!,
          ),
        })),
      ],
    );
    const before = await f.executionCounts();
    for (const [mode, projection] of modes) {
      const result = taskResultComparison(
        d.task,
        EnvironmentId.make("environment-a"),
        d.review,
        projection,
      );
      expect(result.status, mode).toBe("unavailable");
      expect("previous" in result, mode).toBe(false);
    }
    expect(
      taskResultComparison(d.task, EnvironmentId.make("environment-b"), d.review, p).status,
    ).toBe("unavailable");
    expect(
      taskResultComparison(
        d.task,
        EnvironmentId.make("environment-a"),
        { status: "unavailable", reason: "owner-or-operate-required" },
        p,
      ).status,
    ).toBe("unavailable");
    expect(await f.executionCounts()).toEqual(before);
  });
}, 30000);

it("comparison keeps each historical contract from its own actual persisted input", async () => {
  await withTaskTransportFixture(async (f) => {
    f.setWorkflowOutput(previousText);
    const c = await completed(f, "comparison-criteria");
    const read = async (revision: number) => {
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
      const r = await f.review({
        environmentId: "environment-a",
        taskId: task.id,
        projectId: task.projectId,
        threadId: c.threadId,
        revision,
      });
      if (r._tag !== "Success" || r.value.status !== "available") throw new Error("missing review");
      return { task, review: r.value };
    };
    let current = await read(1);
    expect(
      (
        await f.dispatch({
          type: "thread.task-contract.redirect",
          commandId: CommandId.make("comparison-pause"),
          threadId: c.threadId,
          revision: 1,
          reviewTask: current.review.reference,
        })
      )._tag,
    ).toBe("Success");
    current = await read(1);
    expect(
      (
        await f.dispatch({
          type: "thread.task-contract.set",
          commandId: CommandId.make("comparison-set"),
          threadId: c.threadId,
          expectedRevision: 1,
          goal: "Revised contract Goal",
          redirect: "Revised contract Redirect",
          acceptance: "Revised contract Acceptance",
          brake: current.review.contract.brake,
          reviewTask: current.review.reference,
        })
      )._tag,
    ).toBe("Success");
    current = await read(2);
    expect(
      (
        await f.dispatch({
          type: "thread.task-contract.resume",
          commandId: CommandId.make("comparison-resume"),
          threadId: c.threadId,
          revision: 2,
          reviewTask: current.review.reference,
        })
      )._tag,
    ).toBe("Success");
    current = await read(2);
    const p = await f.projection({ threadId: c.threadId });
    if (p._tag !== "Success") throw new Error("missing projection");
    const facts = revisionRequestFacts(
      current.task,
      EnvironmentId.make("environment-a"),
      current.review,
      p.value,
    );
    if (!facts) throw new Error("missing continuation facts");
    const m: TaskResultContinuation = {
      commandId: CommandId.make("comparison-next"),
      messageId: MessageId.make(c.threadId + "-next"),
      threadId: c.threadId,
      reference: facts.review.reference,
      contract: facts.review.contract,
      text: changes,
      routingMode: "manual",
      modelSelection: c.modelSelection,
      runtimeMode: c.runtimeMode,
      interactionMode: c.interactionMode,
      priorResult: continuationResult(facts),
    };
    f.setWorkflowOutput(currentText);
    expect((await send(f, m, m))._tag).toBe("Success");
    await f.settle(m.messageId);
    current = await read(2);
    const final = await f.projection({ threadId: c.threadId });
    if (final._tag !== "Success") throw new Error("missing final projection");
    const value = taskResultComparison(
      current.task,
      EnvironmentId.make("environment-a"),
      current.review,
      final.value,
    );
    expect(value.status).toBe("available");
    if (value.status !== "available") throw new Error(value.reason);
    expect(value.previous.contract).toMatchObject({ revision: 1, goal: "Prove transport" });
    expect(value.current.contract).toMatchObject({ revision: 2, goal: "Revised contract Goal" });
  });
}, 30000);
