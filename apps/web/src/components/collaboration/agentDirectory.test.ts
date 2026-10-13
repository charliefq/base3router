import {
  CollaborationAgent,
  CollaborationTask,
  ServerProvider,
  type CollaborationSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { buildAgentDirectory } from "./agentDirectory";

const providerId = Schema.decodeSync(ServerProvider.fields.instanceId);
const provider = Schema.decodeSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  displayName: "Configured name",
  installed: true,
  version: "fixture",
  checkedAt: "2026-10-13T00:00:00Z",
  enabled: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [
    {
      slug: "fixture-model",
      name: "Fixture",
      isDefault: true,
      isCustom: false,
      capabilities: null,
    },
  ],
});
const saved = Schema.decodeSync(CollaborationAgent)({
  id: "codex",
  displayName: "Saved name",
  origin: "internal",
  role: "provider",
  capabilities: [],
  connection: "NOT_CONNECTED",
  availability: "working",
  projectId: "project-a",
  threadId: "thread-a",
});
const task = Schema.decodeSync(CollaborationTask)({
  id: "task-a",
  title: "Owned task",
  ownerAgentId: "owner",
  assigneeAgentId: "codex",
  projectId: "project-a",
  state: "running",
  waitReason: null,
  acceptance: "Owner reviews",
  threadId: "thread-a",
  correlationId: "message-a",
  revision: 1,
  pendingClarificationId: null,
  gateDecision: "DENY",
});
const snapshot: CollaborationSnapshot = {
  agents: [saved],
  tasks: [task],
  messages: [],
  realGrokbot: "NOT_CONNECTED",
  grokbotIntegration: [],
};
const directory = (
  providers: ReadonlyArray<ServerProvider>,
  currentSnapshot: CollaborationSnapshot | null = snapshot,
  projectId: string | null = "project-a",
  sourceEnvironmentId = "environment-a",
) =>
  buildAgentDirectory({
    environmentId: "environment-a",
    projectId,
    source: { environmentId: sourceEnvironmentId, providers, snapshot: currentSnapshot },
  });

describe("agent directory continuity", () => {
  it("shows configured-only identities without inventing saved bindings", () => {
    const rows = directory([provider], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Configured name");
    expect(rows[0]?.saved).toBeUndefined();
    expect(rows[0]?.readiness).toBe("ready");
    expect(rows[0]?.tasks).toEqual([]);
  });
  it("preserves saved identity, name and task when configuration disappears", () => {
    const rows = directory([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.saved).toBe(saved);
    expect(rows[0]?.displayName).toBe("Saved name");
    expect(rows[0]?.provider).toBeUndefined();
    expect(rows[0]?.readiness).toBe("unavailable");
    expect(rows[0]?.tasks).toEqual([task]);
  });
  it("removal and restoration reconcile the same identity once", () => {
    expect(directory([provider, provider], { ...snapshot, agents: [saved, saved] })).toHaveLength(
      1,
    );
    const removed = directory([]);
    const restored = directory([provider]);
    expect(removed).toHaveLength(1);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(removed[0]?.id);
    expect(restored[0]?.displayName).toBe("Saved name");
    expect(restored[0]?.provider).toBe(provider);
    expect(restored[0]?.readiness).toBe("ready");
  });
  it("isolates same provider id across projects and excludes unrelated tasks", () => {
    const foreign = {
      ...saved,
      projectId: "project-b",
      displayName: "Foreign name",
      threadId: "thread-b",
    };
    const foreignTask = {
      ...task,
      id: "task-b",
      projectId: "project-b",
      title: "Foreign task",
      threadId: "thread-b",
    };
    const unrelated = { ...task, id: "task-other", assigneeAgentId: "other" };
    const input = { ...snapshot, agents: [foreign, saved], tasks: [foreignTask, unrelated, task] };
    expect(directory([], input)[0]?.saved).toBe(saved);
    expect(directory([], input)[0]?.tasks).toEqual([task]);
    expect(directory([], input, "project-b")[0]?.saved).toBe(foreign);
    expect(directory([], input, "project-b")[0]?.tasks).toEqual([foreignTask]);
    expect(directory([], input, null)).toEqual([]);
  });
  it("rejects another environment's provider list and snapshot", () => {
    expect(directory([provider], snapshot, "project-a", "environment-b")).toEqual([]);
    expect(
      buildAgentDirectory({
        environmentId: null,
        projectId: "project-a",
        source: { environmentId: "environment-a", providers: [provider], snapshot },
      }),
    ).toEqual([]);
  });
  it.each([
    { ...provider, enabled: false },
    { ...provider, installed: false },
    { ...provider, status: "error" as const },
    { ...provider, auth: { status: "unauthenticated" as const } },
    { ...provider, availability: "unavailable" as const },
    { ...provider, models: [] },
    { ...provider, supportsTextGeneration: false },
  ])("does not turn historical working/completed ledger into provider readiness", (unready) => {
    const completed = { ...task, id: "completed-task", state: "completed" as const };
    const row = directory([unready], { ...snapshot, tasks: [task, completed] })[0];
    expect(row?.readiness).toBe("unavailable");
    expect(row?.saved?.availability).toBe("working");
    expect(row?.tasks.map((item) => item.state)).toEqual(["running", "completed"]);
  });
  it("does not promote external or reserved Grokbot identities", () => {
    const external = { ...saved, id: "grokbot", origin: "external" as const };
    expect(
      directory([], { ...snapshot, agents: [external, { ...external, id: "external-other" }] }),
    ).toEqual([]);
    const reserved = {
      ...provider,
      instanceId: providerId("grokbot"),
    };
    expect(directory([reserved], { ...snapshot, agents: [external] })).toEqual([]);
  });
});
