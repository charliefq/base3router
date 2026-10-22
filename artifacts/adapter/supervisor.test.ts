import { ProviderInstanceId } from "../../packages/contracts/src/providerInstance.ts";
import { describe, expect, it } from "vite-plus/test";
import type {
  ControllerTaskView,
  ControllerInput,
  ControllerIdentityView,
} from "../../packages/contracts/src/controllerBridge.ts";
import {
  bindProducts,
  createSupervisor,
  supervisionState,
  type Checkpoint,
  type Product,
} from "./supervisor.ts";

const identity = (id: string): typeof ControllerIdentityView.Type => ({
  id,
  displayName: id,
  projects: ["fixture-project"],
  actions: [
    "create_task",
    "start_task",
    "get_task",
    "get_result",
    "submit_feedback",
    "cancel_task",
  ],
  generation: 1,
  expiresAt: "2099-01-01T00:00:00Z",
  revokedAt: null,
  supervisedTasks: 0,
});
const created = (id: string): ControllerTaskView => ({
  version: 1,
  controllerId: id,
  projectId: "fixture-project",
  taskId: "fixture-task",
  threadId: "fixture-thread",
  fence: 1,
  contractRevision: 1,
  admission: "created",
  execution: "not_started",
  terminal: false,
  run: null,
  result: { status: "unavailable", reason: "No execution evidence" },
  feedback: null,
  receipt: null,
});
const task: ControllerInput<"create_task"> = {
  idempotencyKey: "fixture-create-1",
  projectId: "fixture-project",
  title: "Fixture only",
  modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
  contract: {
    goal: "Test synthetic lifecycle",
    redirect: "Stop on scope change",
    acceptance: "Fixture passes",
    brake: { maxProviderStarts: 1, stopConditions: "No live requests" },
  },
};
const start: ControllerInput<"start_task"> = {
  taskId: "fixture-task",
  idempotencyKey: "fixture-start-1",
  expectedFence: 1,
  expectedRevision: 1,
  text: "Synthetic prompt",
  routingMode: "manual",
};
const cancel: ControllerInput<"cancel_task"> = {
  taskId: "fixture-task",
  idempotencyKey: "fixture-cancel-1",
  expectedFence: 2,
  expectedRevision: 1,
  runId: "fixture-run",
  attemptId: "fixture-attempt",
};
function harness(product: Product, protocol: "http" | "mcp") {
  const id = `${product}-fixture`;
  let view = created(id);
  let failure: "lost" | "denied" | null = null;
  let mutationView: ControllerTaskView | null = null;
  let journal: Checkpoint | null = null;
  const calls: { name: string; input: unknown }[] = [];
  const transport = async (name: string, input: unknown) => {
    calls.push({ name, input: structuredClone(input) });
    if (name !== "get_task" && name !== "get_result") {
      expect(journal).not.toBeNull();
      if (failure === "lost") throw new Error("synthetic lost reply");
      if (failure === "denied") return { version: 1, error: "denied" };
    }
    return structuredClone(
      name === "get_task" || name === "get_result" ? view : (mutationView ?? view),
    );
  };
  const options = {
    binding: { product, identity: identity(id) },
    now: () => 0,
    savePending: async (checkpoint: Checkpoint | null) => {
      journal = structuredClone(checkpoint);
    },
    transport:
      protocol === "http"
        ? {
            protocol: "http" as const,
            post: (path: string, input: unknown) => transport(path.split("/").at(-1)!, input),
          }
        : {
            protocol: "mcp" as const,
            callTool: async (name: string, input: unknown) => {
              const output = await transport(name, input);
              return "error" in output
                ? { isError: true, content: [{ type: "text", text: JSON.stringify(output) }] }
                : { isError: false, structuredContent: output };
            },
          },
  };
  return {
    adapter: createSupervisor(options),
    options,
    calls,
    setMutationView: (next: ControllerTaskView) => {
      mutationView = next;
    },
    setView: (next: ControllerTaskView) => {
      view = next;
    },
    setFailure: (next: typeof failure) => {
      failure = next;
    },
    view: () => structuredClone(view),
    journal: () => structuredClone(journal),
  };
}
const running = (view: ControllerTaskView): ControllerTaskView => ({
  ...view,
  fence: 2,
  admission: "admitted",
  execution: "observed",
  run: { runId: "fixture-run", attemptId: "fixture-attempt", status: "running" },
});
const finished = (view: ControllerTaskView): ControllerTaskView => ({
  ...running(view),
  terminal: true,
  run: { runId: cancel.runId, attemptId: cancel.attemptId, status: "completed" },
  result: {
    status: "available",
    runId: "fixture-run",
    messageId: "fixture-message",
    runStatus: "completed",
    attemptId: "fixture-attempt",
    providerTurnId: null,
    providerTurnStatus: null,
    modelIdentity: { requested: "fixture-model" },
    content: {
      status: "output",
      itemId: "fixture-item",
      preview: "Synthetic result",
      truncated: false,
    },
  },
});

describe("dot and Muse external supervisor adapters", () => {
  it("runs dot HTTP create/start/read/result and cancels only the observed target", async () => {
    const h = harness("dot", "http");
    await h.adapter.mutate("create_task", task);
    await h.adapter.mutate("start_task", start);
    h.setView(running(h.view()));
    expect(supervisionState(await h.adapter.readTask("fixture-task"))).toBe("running");
    await h.adapter.readResult("fixture-task");
    await h.adapter.mutate("cancel_task", cancel);
    expect(h.calls.map((x) => x.name)).toEqual([
      "create_task",
      "get_task",
      "start_task",
      "get_task",
      "get_result",
      "get_task",
      "cancel_task",
    ]);
    expect(h.calls.at(-1)?.input).toEqual(cancel);
    expect(h.journal()).toBeNull();
  });
  it("runs Muse MCP result review -> new task -> separately guarded first prompt", async () => {
    const h = harness("muse", "mcp");
    h.setView(finished(h.view()));
    expect(supervisionState(await h.adapter.readResult("fixture-task"))).toBe("review");
    await h.adapter.nextTask(
      { ...cancel, rationale: "Reviewed synthetic result; use a new task for correction" },
      task,
    );
    expect(h.calls.at(-1)?.name).toBe("create_task");
    expect(h.calls.map((x) => x.name)).not.toContain("submit_feedback");
    h.setView(created("muse-fixture"));
    await h.adapter.mutate("start_task", start);
    expect(h.calls.at(-1)?.input).toEqual(start);
  });
  it("records explicit helpful rating only against the current correlated result", async () => {
    const h = harness("muse", "mcp");
    const done = finished(h.view());
    h.setView({
      ...done,
      feedback: {
        status: "available",
        target: {
          environmentId: "fixture-env",
          taskId: done.taskId,
          projectId: done.projectId,
          threadId: done.threadId,
          revision: 1,
        },
        reference: {
          environmentId: "fixture-env",
          taskId: done.taskId,
          projectId: done.projectId,
          threadUpdatedAt: "2026-10-22T00:00:00.000Z",
          threadSequence: 1,
        },
        fingerprint: "fixture-fp",
        contextKey: "fixture-context",
        title: "Fixture",
        model: { instanceId: ProviderInstanceId.make("fixture-provider"), model: "fixture-model" },
        result: done.result,
        feedback: [],
        feedbackForResult: false,
      },
    });
    const rating: ControllerInput<"submit_feedback"> = {
      ...cancel,
      idempotencyKey: "fixture-rating",
      fingerprint: "fixture-fp",
      contextKey: "fixture-context",
      kind: "helpful",
      confirm: true,
    };
    await expect(
      h.adapter.mutate("submit_feedback", { ...rating, fingerprint: "old-fp" }),
    ).rejects.toMatchObject({ code: "not_reviewable" });
    await h.adapter.mutate("submit_feedback", rating);
    expect(h.calls.map((x) => x.name)).toEqual(["get_task", "get_task", "submit_feedback"]);
    expect(h.calls.at(-1)?.input).toEqual(rating);
  });
  it("durably retains exact payload/key across loss, caller mutation and restart", async () => {
    const h = harness("dot", "http");
    h.setFailure("lost");
    const input = { ...start };
    const send = h.adapter.mutate("start_task", input);
    input.text = "caller mutation";
    await expect(send).rejects.toMatchObject({ code: "uncertain" });
    const checkpoint = h.journal()!;
    expect(checkpoint.input).toEqual(start);
    await expect(h.adapter.mutate("create_task", task)).rejects.toMatchObject({ code: "pending" });
    expect(h.calls.filter((x) => x.name === "start_task")).toHaveLength(1);
    h.setFailure(null);
    const restored = createSupervisor({ ...h.options, restored: checkpoint });
    await restored.recover();
    expect(h.calls.filter((x) => x.name === "start_task").map((x) => x.input)).toEqual([
      start,
      start,
    ]);
    expect(h.journal()).toBeNull();
  });
  it("settles accepted delivery while retaining unknown execution for later supervision", async () => {
    const h = harness("dot", "http");
    h.setMutationView({
      ...running(h.view()),
      admission: "unknown",
      execution: "unknown",
      receipt: { commandId: "fixture-command", status: "accepted" },
    });
    const accepted = await h.adapter.mutate("start_task", start);
    expect(supervisionState(accepted)).toBe("unknown");
    expect(h.journal()).toBeNull();
    h.setView(running(h.view()));
    await h.adapter.mutate("cancel_task", cancel);
    expect(h.calls.at(-1)?.name).toBe("cancel_task");
  });
  it("preserves unknown admission and blocks new writes despite later read progress", async () => {
    const h = harness("muse", "mcp");
    h.setView({ ...h.view(), admission: "unknown" });
    expect(supervisionState(await h.adapter.mutate("create_task", task))).toBe("unknown");
    h.setView(running(h.view()));
    await h.adapter.readTask("fixture-task");
    await expect(h.adapter.mutate("cancel_task", cancel)).rejects.toMatchObject({
      code: "pending",
    });
    expect(h.adapter.checkpoint()?.action).toBe("create_task");
  });
  it("does not dispatch stale revision, fence, attempt, start or reviewed result", async () => {
    const h = harness("dot", "http");
    h.setView(running(h.view()));
    await expect(
      h.adapter.mutate("cancel_task", { ...cancel, attemptId: "old" }),
    ).rejects.toMatchObject({ code: "target_changed" });
    await expect(
      h.adapter.mutate("cancel_task", { ...cancel, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "target_changed" });
    await expect(h.adapter.mutate("start_task", start)).rejects.toMatchObject({
      code: "target_changed",
    });
    h.setView(finished(h.view()));
    await expect(
      h.adapter.nextTask({ ...cancel, expectedFence: 1, rationale: "Old review" }, task),
    ).rejects.toMatchObject({ code: "target_changed" });
    const mismatched = finished(h.view());
    if (mismatched.result.status !== "available") throw new Error("Fixture result required");
    h.setView({ ...mismatched, result: { ...mismatched.result, attemptId: "other-attempt" } });
    await expect(
      h.adapter.nextTask({ ...cancel, rationale: "Review" }, task),
    ).rejects.toMatchObject({ code: "not_reviewable" });
    expect(h.calls.every((x) => x.name === "get_task")).toBe(true);
  });
  it("requires separate identity and exact project/action grants, expiry and revocation", async () => {
    const h = harness("dot", "http");
    expect(() => bindProducts(identity("same"), identity("same"))).toThrow();
    expect(bindProducts(identity("dot"), identity("muse")).map((x) => x.identity.id)).toEqual([
      "dot",
      "muse",
    ]);
    await expect(
      h.adapter.mutate("create_task", { ...task, projectId: "outside-grant" }),
    ).rejects.toMatchObject({ code: "denied" });
    h.adapter.updateIdentity({ ...identity("dot-fixture"), actions: ["get_task"] });
    await expect(h.adapter.mutate("create_task", task)).rejects.toMatchObject({ code: "denied" });
    h.adapter.updateIdentity({ ...identity("dot-fixture"), revokedAt: "2026-01-01T00:00:00Z" });
    await expect(h.adapter.readTask("fixture-task")).rejects.toMatchObject({ code: "denied" });
    h.adapter.updateIdentity({ ...identity("dot-fixture"), expiresAt: "invalid" });
    await expect(h.adapter.readTask("fixture-task")).rejects.toMatchObject({ code: "denied" });
    expect(h.calls).toHaveLength(0);
  });
  it("stops on definitive denial and rejects mismatched identity responses", async () => {
    const h = harness("muse", "mcp");
    h.setFailure("denied");
    await expect(h.adapter.mutate("create_task", task)).rejects.toMatchObject({ code: "denied" });
    expect(h.journal()).toBeNull();
    await expect(h.adapter.recover()).rejects.toMatchObject({ code: "pending" });
    expect(h.calls).toHaveLength(1);
    h.setView(created("dot-fixture"));
    await expect(h.adapter.readTask("fixture-task")).rejects.toMatchObject({
      code: "incompatible_response",
    });
  });
  it("fails closed if journaling fails, and rejects free-text helpful ratings before I/O", async () => {
    const h = harness("dot", "http");
    const adapter = createSupervisor({
      ...h.options,
      savePending: async () => {
        throw new Error("disk unavailable");
      },
    });
    await expect(adapter.mutate("create_task", task)).rejects.toThrow("disk unavailable");
    await expect(
      h.adapter.mutate("submit_feedback", {
        ...cancel,
        fingerprint: "fp",
        contextKey: "context",
        kind: "helpful",
        confirm: true,
        text: "correction",
      } as ControllerInput<"submit_feedback">),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.calls).toHaveLength(0);
  });
});
