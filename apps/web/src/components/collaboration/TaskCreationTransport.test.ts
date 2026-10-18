import { expect, it } from "vite-plus/test";
import {
  CommandId,
  ThreadId,
  ProjectId,
  MessageId,
  ProviderInstanceId,
  EnvironmentId,
  type OrchestrationV2Command,
  type TaskFirstLaunch,
} from "@t3tools/contracts";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
const text = "Implement the selected model transport regression.";
const creation = (key: string): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${key}`),
  threadId: ThreadId.make(`transport-${key}`),
  projectId: ProjectId.make("project-a"),
  title: `Transport ${key}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "required",
  taskContract: {
    goal: "Prove transport",
    redirect: "Keep fixture scope",
    acceptance: "Owner reads actual linked output",
    brake: { maxProviderStarts: 3, stopConditions: "Scope changed" },
  },
  taskCreationReview: {
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project-a"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
  },
});
it("actual client operations and authenticated WebSocket handlers create, review, launch and reconcile exact model/input/result", async () => {
  await withTaskTransportFixture(async (f) => {
    const original = creation("manual");
    const created = await f.create(original);
    expect(created._tag).toBe("Success");
    if (created._tag !== "Success") throw new Error(String(created.cause));
    const snapshot = await f.snapshot();
    const task = snapshot.tasks.find((t) => t.threadId === original.threadId);
    expect(task).toBeDefined();
    if (!task) throw new Error("No actual HTTP-owned task");
    const before = await f.projection({ threadId: original.threadId });
    expect(before._tag).toBe("Success");
    if (before._tag !== "Success") throw new Error("No actual projection");
    expect(before.value.thread.modelSelection).toEqual(original.modelSelection);
    expect(before.value.messages).toHaveLength(0);
    expect((await f.inspect()).starts).toHaveLength(0);
    const reviewed = await f.review({
      environmentId: "environment-a",
      taskId: task.id,
      projectId: original.projectId,
      threadId: original.threadId,
      revision: 1,
    });
    expect(reviewed._tag).toBe("Success");
    if (reviewed._tag !== "Success" || reviewed.value.status !== "available")
      throw new Error("No actual review");
    const marker: TaskFirstLaunch = {
      commandId: CommandId.make("launch-transport-manual"),
      messageId: MessageId.make("message-transport-manual"),
      threadId: original.threadId,
      reference: reviewed.value.reference,
      contract: reviewed.value.contract,
      text,
      routingMode: "manual",
      modelSelection: before.value.thread.modelSelection,
      runtimeMode: before.value.thread.runtimeMode,
      interactionMode: before.value.thread.interactionMode,
    };
    const launch: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
      type: "message.dispatch",
      commandId: marker.commandId,
      threadId: marker.threadId,
      messageId: marker.messageId,
      text,
      attachments: [],
      modelSelection: marker.modelSelection,
      routingMode: "manual",
      taskFirstLaunch: marker,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    };
    const result = await f.start({
      commandId: marker.commandId,
      threadId: marker.threadId,
      message: { messageId: marker.messageId, role: "user", text, attachments: [] },
      modelSelection: marker.modelSelection,
      routingMode: "manual",
      runtimeMode: marker.runtimeMode,
      interactionMode: marker.interactionMode,
      dispatchMode: "start",
      taskFirstLaunch: marker,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error(String(result.cause));
    await f.drain();
    const status = await f.launchStatus({ command: launch });
    expect(status._tag).toBe("Success");
    if (status._tag !== "Success" || status.value.status !== "admitted")
      throw new Error("No correlated RPC proof");
    expect(status.value.actualModelSelection).toEqual(original.modelSelection);
    expect(status.value.runStatus).toBe("completed");
    expect(status.value.resultPreview).toContain(`Transport answer: ${text}`);
    const after = await f.projection({ threadId: original.threadId });
    if (after._tag !== "Success") throw new Error("No final projection");
    expect(after.value.messages[0]!.taskFirstLaunch?.commandId).toBe(marker.commandId);
    expect(after.value.runs[0]!.id).toBe(status.value.runId);
    expect(after.value.attempts[0]!.id).toBe(status.value.attemptId);
    const actual = await f.inspect();
    expect(actual.starts).toEqual([original.modelSelection]);
    expect(actual.inputs).toEqual([text]);
    expect(actual.commands.map((c) => c.commandId)).toEqual([original.commandId, marker.commandId]);
    await f.disconnect();
    await f.connect();
    expect(await f.launchStatus({ command: launch })).toEqual(status);
    expect((await f.inspect()).starts).toHaveLength(1);
  });
}, 30000);

it("a revoked fixture session cannot create through its already-open WebSocket", async () => {
  await withTaskTransportFixture(async (f) => {
    await f.revokeCurrent();
    const result = await f.create(creation("revoked-open-socket"));
    expect(result._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
const prepare = async (f: Fixture, key: string) => {
  const original = creation(key);
  expect((await f.create(original))._tag).toBe("Success");
  const task = (await f.snapshot()).tasks.find((t) => t.threadId === original.threadId)!;
  const projection = await f.projection({ threadId: original.threadId });
  if (projection._tag !== "Success") throw new Error("No actual projection");
  const review = await f.review({
    environmentId: "environment-a",
    projectId: original.projectId,
    threadId: original.threadId,
    taskId: task.id,
    revision: 1,
  });
  if (review._tag !== "Success" || review.value.status !== "available")
    throw new Error("No actual task review");
  const marker: TaskFirstLaunch = {
    commandId: CommandId.make(`start-${key}`),
    messageId: MessageId.make(`input-${key}`),
    threadId: original.threadId,
    text,
    routingMode: "manual",
    reference: review.value.reference,
    contract: review.value.contract,
    modelSelection: projection.value.thread.modelSelection,
    runtimeMode: projection.value.thread.runtimeMode,
    interactionMode: projection.value.thread.interactionMode,
  };
  const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
    type: "message.dispatch",
    commandId: marker.commandId,
    messageId: marker.messageId,
    threadId: marker.threadId,
    text,
    attachments: [],
    modelSelection: marker.modelSelection,
    routingMode: "manual",
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    taskFirstLaunch: marker,
  };
  return { original, task, marker, command };
};
const launch = (f: Fixture, marker: TaskFirstLaunch) =>
  f.start({
    commandId: marker.commandId,
    threadId: marker.threadId,
    message: { messageId: marker.messageId, role: "user", text: marker.text, attachments: [] },
    modelSelection: marker.modelSelection,
    routingMode: marker.routingMode,
    runtimeMode: marker.runtimeMode,
    interactionMode: marker.interactionMode,
    dispatchMode: "start",
    taskFirstLaunch: marker,
  });
it.each(["read-only", "model", "environment"] as const)(
  "actual transport rejects %s creation without substituting model or starting work",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      if (change === "read-only") {
        await f.disconnect();
        await f.connect(["orchestration:read"]);
      }
      if (change === "model")
        f.setProviders([
          {
            ...f.providers[0]!,
            models: f.providers[0]!.models.filter((m) => m.slug !== "exact-second"),
          },
        ]);
      if (change === "environment") f.setEnvironment("environment-b");
      const original = creation(`deny-${change}`);
      expect((await f.create(original))._tag).toBe("Failure");
      expect((await f.snapshot()).tasks).toHaveLength(0);
      expect((await f.inspect()).starts).toHaveLength(0);
      expect((await f.inspect()).commands[0]!.commandId).toBe(original.commandId);
    });
  },
  30000,
);
it("production session verification rejects a revoked ticket on reconnect", async () => {
  await withTaskTransportFixture(async (f) => {
    await f.revokeCurrent();
    await f.disconnect();
    await expect(f.reconnectRetained()).rejects.toThrow();
    expect((await f.inspect()).commands).toHaveLength(0);
  });
}, 30000);
it("production session environment guard rejects mismatched bootstrap before publishing a session", async () => {
  await withTaskTransportFixture(async (f) => {
    await f.disconnect();
    await expect(f.connect(undefined, "environment-b")).rejects.toThrow();
    expect(f.identity()).toBeNull();
    expect((await f.inspect()).commands).toHaveLength(0);
  });
}, 30000);
it("creation replay and competing real client launches preserve one task and one execution", async () => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepare(f, "competing");
    expect((await f.create(p.original))._tag).toBe("Success");
    expect(
      (await f.snapshot()).tasks.filter((t) => t.threadId === p.original.threadId),
    ).toHaveLength(1);
    expect((await f.inspect()).starts).toHaveLength(0);
    const other = {
      ...p.marker,
      commandId: CommandId.make("other-transport-start"),
      messageId: MessageId.make("other-transport-message"),
    };
    const results = await Promise.all([launch(f, p.marker), launch(f, other)]);
    expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
    await f.drain();
    const projection = await f.projection({ threadId: p.original.threadId });
    if (projection._tag !== "Success") throw new Error("No actual projection");
    expect(projection.value.messages).toHaveLength(1);
    expect(projection.value.runs).toHaveLength(1);
    expect((await f.inspect()).starts).toHaveLength(1);
  });
}, 30000);
it("a retained undispatched launch remains UNKNOWN after real reconnect without a mutation", async () => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepare(f, "unknown");
    const before = (await f.inspect()).commands.length;
    await f.disconnect();
    await f.connect();
    const result = await f.launchStatus({ command: p.command });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("No read response");
    expect(result.value.status).toBe("unknown");
    expect((await f.inspect()).commands).toHaveLength(before);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);
it("a selected model removed after actual review cannot launch through production transport", async () => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepare(f, "withdrawn-launch");
    f.setProviders([
      {
        ...f.providers[0]!,
        models: f.providers[0]!.models.filter((m) => m.slug !== p.marker.modelSelection.model),
      },
    ]);
    expect((await launch(f, p.marker))._tag).toBe("Failure");
    const result = await f.projection({ threadId: p.original.threadId });
    if (result._tag !== "Success") throw new Error("No actual projection");
    expect(result.value.messages).toHaveLength(0);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);
