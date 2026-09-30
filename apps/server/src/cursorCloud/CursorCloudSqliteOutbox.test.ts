// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  ProviderDriverKind,
  ProviderInstanceId,
  type ActionGateResult,
  type DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { cursorCloudAgentIdFromDispatch } from "./CursorCloudAgentId.ts";
import { makeCursorCloudAdapter } from "./CursorCloudAdapter.ts";
import { staticCursorCloudCredentialProvider } from "./CursorCloudCredentials.ts";
import {
  type CursorCloudHttpRequest,
  type CursorCloudHttpResponse,
  type CursorCloudHttpTransport,
} from "./CursorCloudHttp.ts";
import {
  cursorCloudRequestFingerprint,
  type CursorCloudOperationIntent,
} from "./CursorCloudOutbox.ts";
import { makeSqliteCursorCloudOutbox } from "./CursorCloudSqliteOutbox.ts";
import {
  cancelCursorCloudStage,
  createCursorCloudStageBinding,
  followUpCursorCloudStage,
} from "./CursorCloudWorkflow.ts";

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const at = "2026-09-29T12:00:00.000Z";
const allow: ActionGateResult = { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] };
const route: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
  driver: ProviderDriverKind.make("cursor"),
  modelFamily: "cursor",
  fallbackIndex: 0,
  source: "explicit",
  gate: allow,
};
const target = {
  mode: "repository" as const,
  repositoryUrl: "https://github.com/charliefq/base3router",
  startingRef: sha,
};
const identity = {
  environmentId: "environment-1",
  projectId: "project-1",
  runId: "run-one",
  stageId: "research",
  attempt: 1,
};

const jsonResponse = (status: number, body: unknown): CursorCloudHttpResponse => ({
  status,
  headers: {},
  bodyText: JSON.stringify(body),
});

const recordTransport = (
  handler: (
    request: CursorCloudHttpRequest,
  ) => CursorCloudHttpResponse | Promise<CursorCloudHttpResponse>,
) => {
  const requests: CursorCloudHttpRequest[] = [];
  const transport: CursorCloudHttpTransport = async (request) => {
    requests.push(request);
    return handler(request);
  };
  return { transport, requests };
};

const adapterFor = (transport: CursorCloudHttpTransport) =>
  makeCursorCloudAdapter({
    transport,
    credentials: staticCursorCloudCredentialProvider("test-cursor-token"),
  });

const runBody = (agentId: string, runId: string, status = "CREATING") => ({
  id: runId,
  agentId,
  status,
  createdAt: at,
  updatedAt: at,
});

const finishedBinding = (agentId: string, runId = "run-00000000-0000-0000-0000-000000000001") => ({
  provider: ProviderDriverKind.make("cursor"),
  model: "composer-2",
  runnerKind: "cursor-cloud" as const,
  target,
  cursorAgentId: agentId,
  cursorRunId: runId,
  cursorAgentStatus: "IDLE" as const,
  cursorRunStatus: "FINISHED" as const,
  status: "finished" as const,
  createdAt: at,
  updatedAt: at,
  credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
});

const sqliteOutbox = (dbPath: string) => {
  const layer = NodeSqliteClient.layer({ filename: dbPath });
  return makeSqliteCursorCloudOutbox((effect) =>
    // The outbox API is Promise-based and this restart test must open a fresh
    // SQLite connection after discarding the first instance.
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests
    Effect.runPromise(effect.pipe(Effect.provide(layer))),
  );
};

const withSqliteDb = async (run: (dbPath: string) => Promise<void>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-cloud-outbox-"));
  const dbPath = NodePath.join(directory, "state.sqlite");
  try {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests
    await Effect.runPromise(
      runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
    );
    await run(dbPath);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

describe("Cursor Cloud sqlite restart crash window", () => {
  it("reconciles a follow-up after HTTP success without posting a duplicate", async () => {
    const dispatchId = "dispatch-sqlite-follow-1";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const followUpId = "run-00000000-0000-0000-0000-000000000002";
    const prompt = "Also add tests";
    const commandId = "follow-sqlite-1";
    const intent: CursorCloudOperationIntent = {
      commandId,
      kind: "follow-up",
      ...identity,
      cursorAgentId: agentId,
      requestFingerprint: cursorCloudRequestFingerprint({
        kind: "follow-up",
        cursorAgentId: agentId,
        prompt,
        previousRunId: previous,
      }),
      previousRunId: previous,
      claimedAt: at,
    };
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.method === "POST" && request.path.endsWith("/runs")) {
          return jsonResponse(200, { run: runBody(agentId, followUpId) });
        }
        if (request.method === "GET" && request.path.includes("/runs?")) {
          return jsonResponse(200, {
            items: [
              runBody(agentId, followUpId),
              { ...runBody(agentId, previous, "FINISHED"), createdAt: "2026-09-29T11:00:00.000Z" },
            ],
          });
        }
        return jsonResponse(500, { message: "unexpected" });
      });
      const adapter = adapterFor(transport);
      const outboxA = sqliteOutbox(dbPath);
      const claimed = await outboxA.claim(intent);
      expect(claimed.state).toBe("accepted");
      await adapter.createFollowUpRun({
        binding: finishedBinding(agentId, previous),
        prompt,
        at,
      });
      const outboxB = sqliteOutbox(dbPath);
      const recovered = await followUpCursorCloudStage({
        adapter,
        outbox: outboxB,
        gate: allow,
        binding: finishedBinding(agentId, previous),
        prompt,
        at,
        ...identity,
        commandId,
      });
      expect(
        requests.filter((request) => request.method === "POST" && request.path.endsWith("/runs")),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === "GET" && request.path.includes("/runs?")),
      ).toHaveLength(1);
      expect(recovered.cursorRunId).toBe(followUpId);
    });
  });

  it("reconciles a cancel after HTTP success without posting a duplicate", async () => {
    const dispatchId = "dispatch-sqlite-cancel-1";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const runId = "run-00000000-0000-0000-0000-000000000001";
    const commandId = "cancel-sqlite-1";
    const intent: CursorCloudOperationIntent = {
      commandId,
      kind: "cancel",
      ...identity,
      cursorAgentId: agentId,
      requestFingerprint: cursorCloudRequestFingerprint({
        kind: "cancel",
        cursorAgentId: agentId,
        previousRunId: runId,
      }),
      previousRunId: runId,
      claimedAt: at,
    };
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.path.endsWith("/cancel")) {
          return jsonResponse(200, { id: runId });
        }
        if (request.method === "GET" && request.path.endsWith(`/runs/${runId}`)) {
          return jsonResponse(200, runBody(agentId, runId, "CANCELLED"));
        }
        return jsonResponse(500, { message: "unexpected" });
      });
      const adapter = adapterFor(transport);
      const outboxA = sqliteOutbox(dbPath);
      const claimed = await outboxA.claim(intent);
      expect(claimed.state).toBe("accepted");
      await adapter.cancelRun({
        binding: {
          ...finishedBinding(agentId, runId),
          cursorRunStatus: "RUNNING",
          status: "running",
        },
        at,
      });
      const outboxB = sqliteOutbox(dbPath);
      const recovered = await cancelCursorCloudStage({
        adapter,
        outbox: outboxB,
        gate: allow,
        binding: {
          ...finishedBinding(agentId, runId),
          cursorRunStatus: "RUNNING",
          status: "running",
        },
        at,
        ...identity,
        commandId,
      });
      expect(
        requests.filter((request) => request.method === "POST" && request.path.endsWith("/cancel")),
      ).toHaveLength(1);
      expect(
        requests.filter(
          (request) => request.method === "GET" && request.path.endsWith(`/runs/${runId}`),
        ),
      ).toHaveLength(1);
      expect(recovered.status).toBe("cancelled");
      expect(recovered.cursorRunStatus).toBe("CANCELLED");
    });
  });

  it("reconciles a create after HTTP success without posting a duplicate agent", async () => {
    const dispatchId = "dispatch-sqlite-create-1";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const agent = {
      id: agentId,
      name: "Stage",
      status: "ACTIVE" as const,
      url: `https://cursor.com/agents/${agentId}`,
      createdAt: at,
      updatedAt: at,
      latestRunId: "run-00000000-0000-0000-0000-000000000001",
    };
    const prompt = "Add the adapter";
    const intent: CursorCloudOperationIntent = {
      commandId: `cursor-create-${dispatchId}`,
      kind: "create",
      ...identity,
      cursorAgentId: agentId,
      requestFingerprint: cursorCloudRequestFingerprint({
        kind: "create",
        cursorAgentId: agentId,
        prompt,
      }),
      dispatchId,
      claimedAt: at,
    };
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.method === "POST" && request.path === "/v1/agents") {
          return jsonResponse(200, { agent, run: runBody(agentId, agent.latestRunId) });
        }
        if (request.method === "GET" && request.path === `/v1/agents/${agentId}`) {
          return jsonResponse(200, agent);
        }
        if (request.method === "GET" && request.path.endsWith(`/runs/${agent.latestRunId}`)) {
          return jsonResponse(200, runBody(agentId, agent.latestRunId, "RUNNING"));
        }
        return jsonResponse(500, { message: "unexpected" });
      });
      const adapter = adapterFor(transport);
      const outboxA = sqliteOutbox(dbPath);
      const claimed = await outboxA.claim(intent);
      expect(claimed.state).toBe("accepted");
      await adapter.createAgent({
        prompt,
        agentId,
        target,
        provider: ProviderDriverKind.make("cursor"),
        dispatcherModel: "composer-2",
        at,
      });
      const outboxB = sqliteOutbox(dbPath);
      const recovered = await createCursorCloudStageBinding({
        adapter,
        outbox: outboxB,
        configured: true,
        gate: allow,
        routeBinding: route,
        target,
        prompt,
        at,
        ...identity,
        dispatchId,
      });
      expect(
        requests.filter((request) => request.method === "POST" && request.path === "/v1/agents"),
      ).toHaveLength(1);
      expect(recovered.cursorAgentId).toBe(agentId);
      expect(recovered.cursorRunId).toBe(agent.latestRunId);
    });
  });

  it("marks a pending follow-up indeterminate when the run list is empty after restart", async () => {
    const dispatchId = "dispatch-sqlite-follow-empty";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const prompt = "Also add tests";
    const commandId = "follow-sqlite-empty";
    const intent: CursorCloudOperationIntent = {
      commandId,
      kind: "follow-up",
      ...identity,
      cursorAgentId: agentId,
      requestFingerprint: cursorCloudRequestFingerprint({
        kind: "follow-up",
        cursorAgentId: agentId,
        prompt,
        previousRunId: previous,
      }),
      previousRunId: previous,
      claimedAt: at,
    };
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.method === "GET" && request.path.includes("/runs?")) {
          return jsonResponse(200, { items: [] });
        }
        return jsonResponse(500, { message: "unexpected" });
      });
      const outboxA = sqliteOutbox(dbPath);
      expect((await outboxA.claim(intent)).state).toBe("accepted");
      const outboxB = sqliteOutbox(dbPath);
      await expect(
        followUpCursorCloudStage({
          adapter: adapterFor(transport),
          outbox: outboxB,
          gate: allow,
          binding: finishedBinding(agentId, previous),
          prompt,
          at,
          ...identity,
          commandId,
        }),
      ).rejects.toMatchObject({ code: "indeterminate" });
      expect(
        requests.filter((request) => request.method === "POST" && request.path.endsWith("/runs")),
      ).toHaveLength(0);
    });
  });

  it("does not POST when more than 20 newer runs hide the pending follow-up target", async () => {
    const dispatchId = "dispatch-sqlite-follow-page";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const prompt = "Also add tests";
    const commandId = "follow-sqlite-page";
    const newer = Array.from({ length: 20 }, (_, index) =>
      runBody(agentId, `run-newer-${String(index).padStart(2, "0")}`, "FINISHED"),
    );
    const intent: CursorCloudOperationIntent = {
      commandId,
      kind: "follow-up",
      ...identity,
      cursorAgentId: agentId,
      requestFingerprint: cursorCloudRequestFingerprint({
        kind: "follow-up",
        cursorAgentId: agentId,
        prompt,
        previousRunId: previous,
      }),
      previousRunId: previous,
      claimedAt: at,
    };
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.method !== "GET" || !request.path.includes("/runs?")) {
          return jsonResponse(500, { message: "unexpected" });
        }
        if (request.path.includes("cursor=")) {
          return jsonResponse(200, {
            items: [
              { ...runBody(agentId, previous, "FINISHED"), createdAt: "2026-09-29T11:00:00.000Z" },
            ],
          });
        }
        return jsonResponse(200, { items: newer, nextCursor: "page-2" });
      });
      const outboxA = sqliteOutbox(dbPath);
      expect((await outboxA.claim(intent)).state).toBe("accepted");
      const outboxB = sqliteOutbox(dbPath);
      await expect(
        followUpCursorCloudStage({
          adapter: adapterFor(transport),
          outbox: outboxB,
          gate: allow,
          binding: finishedBinding(agentId, previous),
          prompt,
          at,
          ...identity,
          commandId,
        }),
      ).rejects.toMatchObject({ code: "indeterminate" });
      expect(
        requests.filter((request) => request.method === "POST" && request.path.endsWith("/runs")),
      ).toHaveLength(0);
      expect(
        requests.filter((request) => request.method === "GET" && request.path.includes("/runs?")),
      ).toHaveLength(2);
    });
  });

  it("replays a finalized 409 agent_busy follow-up after restart without another POST", async () => {
    const dispatchId = "dispatch-sqlite-follow-rejected";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const prompt = "Also add tests";
    const commandId = "follow-sqlite-rejected";
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.method === "POST" && request.path.endsWith("/runs")) {
          return jsonResponse(409, { code: "agent_busy", message: "agent_busy" });
        }
        return jsonResponse(500, { message: "unexpected" });
      });
      const adapter = adapterFor(transport);
      const outboxA = sqliteOutbox(dbPath);
      await expect(
        followUpCursorCloudStage({
          adapter,
          outbox: outboxA,
          gate: allow,
          binding: finishedBinding(agentId, previous),
          prompt,
          at,
          ...identity,
          commandId,
        }),
      ).rejects.toMatchObject({
        code: "agent_busy",
        message: "The Cursor agent is busy with another run.",
      });
      const outboxB = sqliteOutbox(dbPath);
      await expect(
        followUpCursorCloudStage({
          adapter,
          outbox: outboxB,
          gate: allow,
          binding: finishedBinding(agentId, previous),
          prompt,
          at,
          ...identity,
          commandId,
        }),
      ).rejects.toMatchObject({
        code: "agent_busy",
        message: "The Cursor agent is busy with another run.",
      });
      expect(
        requests.filter((request) => request.method === "POST" && request.path.endsWith("/runs")),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === "GET" && request.path.includes("/runs?")),
      ).toHaveLength(0);
    });
  });

  it("posts exactly once for a freshly accepted follow-up", async () => {
    const dispatchId = "dispatch-sqlite-follow-accepted";
    const agentId = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const followUpId = "run-00000000-0000-0000-0000-000000000002";
    const prompt = "Also add tests";
    await withSqliteDb(async (dbPath) => {
      const { transport, requests } = recordTransport((request) => {
        if (request.method === "POST" && request.path.endsWith("/runs")) {
          return jsonResponse(200, { run: runBody(agentId, followUpId) });
        }
        return jsonResponse(500, { message: "unexpected" });
      });
      const binding = await followUpCursorCloudStage({
        adapter: adapterFor(transport),
        outbox: sqliteOutbox(dbPath),
        gate: allow,
        binding: finishedBinding(agentId, previous),
        prompt,
        at,
        ...identity,
        commandId: "follow-sqlite-accepted",
      });
      expect(
        requests.filter((request) => request.method === "POST" && request.path.endsWith("/runs")),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === "GET" && request.path.includes("/runs?")),
      ).toHaveLength(0);
      expect(binding.cursorRunId).toBe(followUpId);
    });
  });
});
