import { describe, expect, it } from "vite-plus/test";
import {
  createControllerClient,
  type ControllerRequest,
  type ControllerOutputs,
} from "./client.ts";
import { connectionLabel, onboardingHandoff } from "./onboarding.ts";

describe("controller v1 fixture adapter", () => {
  it("keeps create receipt, accepted start, and terminal result distinct across all six tools", async () => {
    const requests: ControllerRequest[] = [];
    const outputs: ControllerOutputs = {
      create_task: {
        receiptId: "created",
        task: {
          taskId: "t1",
          projectId: "p1",
          supervisorId: "grokbot-1",
          state: "created",
          runId: null,
        },
      },
      start_task: { receiptId: "queued", taskId: "t1", started: false, runId: null },
      get_task: {
        task: {
          taskId: "t1",
          projectId: "p1",
          supervisorId: "grokbot-1",
          state: "running",
          runId: "r1",
        },
      },
      get_result: { taskId: "t1", runId: "r1", terminal: false, result: null },
      submit_feedback: { receiptId: "feedback", accepted: true },
      cancel_task: { receiptId: "cancel", accepted: true },
    };
    const client = createControllerClient({
      callTool: async (request) => {
        requests.push(request);
        return { version: 1, action: request.action, output: outputs[request.action] };
      },
    });
    expect(
      (
        await client.call("create_task", {
          projectId: "p1",
          title: "Task",
          prompt: "Do work",
          idempotencyKey: "create-1",
        })
      ).task.runId,
    ).toBeNull();
    expect(
      (await client.call("start_task", { taskId: "t1", idempotencyKey: "start-1" })).started,
    ).toBe(false);
    expect((await client.call("get_task", { taskId: "t1" })).task.runId).toBe("r1");
    expect(await client.call("get_result", { taskId: "t1" })).toMatchObject({
      terminal: false,
      result: null,
    });
    await client.call("submit_feedback", {
      taskId: "t1",
      runId: "r1",
      feedback: "Revise",
      idempotencyKey: "feedback-1",
    });
    await client.call("cancel_task", { taskId: "t1", idempotencyKey: "cancel-1" });
    expect(requests.map((request) => request.version)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(requests[4]?.input).toMatchObject({ runId: "r1", idempotencyKey: "feedback-1" });
    outputs.get_result = {
      taskId: "t1",
      runId: "r1",
      terminal: true,
      result: "Completed fixture output",
    };
    expect((await client.call("get_result", { taskId: "t1" })).result).toBe(
      "Completed fixture output",
    );
  });
  it("rejects incompatible envelopes, malformed starts and premature results without echoing raw data", async () => {
    for (const reply of [
      { version: 2, action: "get_result", output: { secret: "do-not-echo" } },
      {
        version: 1,
        action: "start_task",
        output: { receiptId: "r", taskId: "t", started: true, runId: null },
      },
      {
        version: 1,
        action: "get_result",
        output: { taskId: "t", runId: "r", terminal: false, result: "premature" },
      },
    ]) {
      const client = createControllerClient({ callTool: async () => reply });
      await expect(
        client.call(reply.action === "start_task" ? "start_task" : "get_result", {
          taskId: "t",
          idempotencyKey: "k",
        }),
      ).rejects.toThrow("incompatible v1 response");
    }
  });
  it("does not retry mutations on uncertain transport failure", async () => {
    let calls = 0;
    const client = createControllerClient({
      callTool: async () => {
        calls++;
        throw new Error("Unavailable");
      },
    });
    await expect(
      client.call("cancel_task", { taskId: "t", idempotencyKey: "cancel-1" }),
    ).rejects.toThrow("Unavailable");
    expect(calls).toBe(1);
  });
  it("prepares a scoped setup draft without claiming a connection", () => {
    expect(connectionLabel(null)).toBe("Needs setup");
    expect(
      onboardingHandoff("grokbot", { projectIds: ["p1"], actions: ["get_task"] }),
    ).toMatchObject({
      version: 1,
      state: "needs_setup",
      requestedGrant: { projectIds: ["p1"], actions: ["get_task"] },
    });
  });
});
