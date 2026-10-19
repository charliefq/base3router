import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { TaskCapabilityStep, TaskCapabilityStepRequest } from "./taskCapabilityStep.ts";
const common = {
  reviewId: "review",
  actorId: "actor",
  environmentId: "environment",
  projectId: "project",
  workspace: "/recorded/workspace",
  projectWorkspace: "/recorded/workspace",
  runtimeMode: "approval-required",
  interactionMode: "default",
  threadId: "thread",
  taskId: "task",
  revision: 1,
  contractDigest: "contract",
  threadUpdatedAt: "2026-10-19T00:00:00.000Z",
  threadSequence: 1,
  modelSelection: { instanceId: "codex", model: "fake" },
  schemaDigest: "schema",
  argumentsJson: "{}",
  commandId: "command",
  messageId: "message",
  promptDigest: "prompt",
  runId: "run",
  attemptId: "attempt",
  maxCalls: 1,
  maxResultBytes: 32768,
  expiresAt: "2026-10-19T00:10:00.000Z",
  fingerprint: "fingerprint",
};
const decodeStep = Schema.decodeUnknownSync(TaskCapabilityStep);
const workspace = {
  ...common,
  version: "server-owned-workspace-read.v1",
  toolId: "t3-code/t3_worktree_status",
  recordedBranch: null,
  recordedWorktreePath: null,
};
it("retains compatible saved PR reviews and accepts explicit recorded workspace reviews", () => {
  const read = decodeStep;
  expect(
    read({
      ...common,
      version: "server-owned-pr-read.v1",
      toolId: "t3-pull-requests/list_thread_pull_requests",
    }).version,
  ).toBe("server-owned-pr-read.v1");
  expect(read(workspace).version).toBe("server-owned-workspace-read.v1");
});
it.each([
  { toolId: "t3-code/t3_worktree_handoff" },
  { version: "server-owned-pr-read.v1" },
  { argumentsJson: '{"path":"/tmp/other"}' },
  { maxCalls: 2 },
  { maxResultBytes: 65536 },
  { unexpected: true },
])("rejects forged or expanded review authority %j", (change) => {
  expect(() => decodeStep({ ...workspace, ...change })).toThrow();
});
it("requires explicit supported selection and refuses unknown request arguments", () => {
  const decode = Schema.decodeUnknownSync(TaskCapabilityStepRequest);
  const value = {
    commandId: "c",
    messageId: "m",
    text: "Explain recorded workspace",
    capability: "recorded-workspace",
  };
  expect(decode(value).capability).toBe("recorded-workspace");
  expect(() => decode({ ...value, capability: "handoff" })).toThrow();
  expect(() => decode({ ...value, arguments: { path: "/tmp" } })).toThrow();
  expect(
    decode({ commandId: "c", messageId: "m", text: "workspace keywords" }).capability,
  ).toBeUndefined();
});
