import { describe, expect, it } from "vite-plus/test";
import { ControllerTaskView, type ControllerInput, type ControllerTool } from "@t3tools/contracts";
import { createControllerClient, ControllerClientError } from "./client.ts";
import { connectionLabel, onboardingHandoff } from "./onboarding.ts";

const view: ControllerTaskView = {
  version: 1,
  controllerId: "grok-owner",
  taskId: "task-1",
  threadId: "thread-1",
  projectId: "p1",
  fence: 2,
  contractRevision: 1,
  admission: "admitted",
  execution: "not_started",
  terminal: false,
  run: null,
  result: { status: "unavailable", reason: "No execution evidence" },
  feedback: null,
  receipt: { commandId: "command-1", status: "accepted" },
};
const inputs: { [A in ControllerTool]: ControllerInput<A> } = {
  create_task: {
    idempotencyKey: "create-1",
    projectId: "p1",
    title: "Reviewed task",
    modelSelection: { instanceId: "codex", model: "fixture-model" },
    contract: {
      goal: "Fix parser",
      redirect: "Ask before scope changes",
      acceptance: "Focused check passes",
      brake: { maxProviderStarts: 1, stopConditions: "Scope change", maxTokens: 1000 },
    },
  },
  start_task: {
    taskId: "task-1",
    idempotencyKey: "start-1",
    expectedFence: 2,
    expectedRevision: 1,
    text: "Reviewed instructions",
    routingMode: "manual",
  },
  get_task: { taskId: "task-1" },
  get_result: { taskId: "task-1" },
  submit_feedback: {
    taskId: "task-1",
    idempotencyKey: "feedback-1",
    expectedFence: 3,
    expectedRevision: 1,
    runId: "run-1",
    attemptId: "attempt-1",
    fingerprint: "current-fingerprint",
    contextKey: "current-context",
    kind: "not_helpful",
    confirm: true,
  },
  cancel_task: {
    taskId: "task-1",
    idempotencyKey: "cancel-1",
    expectedFence: 3,
    expectedRevision: 1,
    runId: "run-1",
    attemptId: "attempt-1",
  },
};
describe("authoritative controller bridge v1 adapter", () => {
  it("sends plain HTTP tool inputs with all governance and result-target guards", async () => {
    const calls: { path: string; input: unknown }[] = [];
    const client = createControllerClient(
      {
        protocol: "http",
        post: async (path, input) => {
          calls.push({ path, input });
          return view;
        },
      },
      "grok-owner",
    );
    for (const tool of Object.keys(inputs) as ControllerTool[]) {
      const result = await client.call(tool, inputs[tool]);
      expect(result.execution).toBe("not_started");
      expect(result.receipt?.status).toBe("accepted");
    }
    expect(calls.map((call) => call.path)).toEqual(
      Object.keys(inputs).map((tool) => `/api/controller/v1/tools/${tool}`),
    );
    expect(calls.map((call) => call.input)).toEqual(Object.values(inputs));
  });
  it("reads MCP structuredContent and preserves typed denial and stale failures", async () => {
    let output: unknown = {
      isError: false,
      content: [{ type: "text", text: "not authoritative" }],
      structuredContent: { ...view, receipt: null },
    };
    const client = createControllerClient(
      { protocol: "mcp", callTool: async () => output },
      "grok-owner",
    );
    expect((await client.call("get_result", inputs.get_result)).receipt).toBeNull();
    for (const error of ["unauthorized", "denied", "stale", "conflict", "unavailable"] as const) {
      output = {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ version: 1, error }) }],
      };
      await expect(client.call("get_task", inputs.get_task)).rejects.toMatchObject({ code: error });
    }
    output = { isError: false, content: [{ type: "text", text: JSON.stringify(view) }] };
    await expect(client.call("get_task", inputs.get_task)).rejects.toMatchObject({
      code: "incompatible_response",
    });
  });
  it("recovers uncertain mutations with one retained payload/key and no automatic retry", async () => {
    const calls: unknown[] = [];
    const input = { ...inputs.start_task };
    const client = createControllerClient(
      {
        protocol: "http",
        post: async (_path, body) => {
          calls.push(structuredClone(body));
          if (calls.length === 1) throw new Error("connection lost");
          return view;
        },
      },
      "grok-owner",
    );
    const attempt = client.prepare("start_task", input);
    input.text = "Unreviewed replacement";
    await expect(attempt.send()).rejects.toMatchObject({ code: "uncertain" });
    expect(calls).toHaveLength(1);
    await attempt.send();
    expect(calls).toEqual([inputs.start_task, inputs.start_task]);
  });
  it("rejects the old prompt/feedback envelope and cross-task evidence", async () => {
    let calls = 0;
    const client = createControllerClient(
      {
        protocol: "http",
        post: async () => {
          calls++;
          return { ...view, taskId: "other" };
        },
      },
      "grok-owner",
    );
    expect(() =>
      client.prepare("create_task", {
        ...inputs.create_task,
        prompt: "Not a start",
      } as ControllerInput<"create_task">),
    ).toThrow(ControllerClientError);
    expect(calls).toBe(0);
    await expect(client.call("get_task", inputs.get_task)).rejects.toMatchObject({
      code: "incompatible_response",
    });
  });
  it("keeps setup and feedback separate from live verification or correction prompts", () => {
    expect(connectionLabel(null)).toContain("Needs setup");
    const handoff = onboardingHandoff("grokbot", { projectIds: ["p1"], actions: ["get_task"] });
    expect(handoff.state).toBe("needs_setup");
    expect(handoff.prerequisites.join(" ")).toContain("create a new reviewed task");
  });
});
