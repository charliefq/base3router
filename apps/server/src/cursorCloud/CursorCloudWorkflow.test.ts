import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ActionGateResult,
  type CursorCloudRunnerBinding,
  type DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { cursorCloudAgentIdFromDispatch } from "./CursorCloudAgentId.ts";
import { makeCursorCloudAdapter } from "./CursorCloudAdapter.ts";
import { staticCursorCloudCredentialProvider } from "./CursorCloudCredentials.ts";
import {
  type CursorCloudHttpRequest,
  type CursorCloudHttpResponse,
  type CursorCloudHttpTransport,
} from "./CursorCloudHttp.ts";
import { makeMemoryCursorCloudOutbox } from "./CursorCloudOutbox.ts";
import {
  assertCursorCloudDispatch,
  cancelCursorCloudStage,
  createCursorCloudStageBinding,
  cursorCloudDispatchPreview,
  followUpCursorCloudStage,
  requireActionGateAllow,
} from "./CursorCloudWorkflow.ts";

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const at = "2026-09-29T12:00:00.000Z";
const allow: ActionGateResult = { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] };
const deny: ActionGateResult = { decision: "DENY", reasonCodes: ["PROVIDER_UNAVAILABLE"] };
const route: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
  driver: ProviderDriverKind.make("cursor"),
  modelFamily: "cursor",
  fallbackIndex: 0,
  source: "explicit",
  gate: allow,
};
const codexRoute: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("codex_work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit",
  gate: allow,
};
const target = {
  mode: "repository" as const,
  repositoryUrl: "https://github.com/charliefq/base3router",
  startingRef: sha,
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

const identity = {
  runId: "run-one",
  stageId: "research",
  attempt: 1,
  dispatchId: "dispatch-one",
};

const agentFor = (dispatchId: string) => {
  const id = cursorCloudAgentIdFromDispatch({ ...identity, dispatchId });
  return {
    id,
    name: "Stage",
    status: "ACTIVE" as const,
    url: `https://cursor.com/agents/${id}`,
    createdAt: at,
    updatedAt: at,
    latestRunId: "run-00000000-0000-0000-0000-000000000001",
  };
};

const runBody = (agentId: string, runId = "run-00000000-0000-0000-0000-000000000001") => ({
  id: runId,
  agentId,
  status: "CREATING",
  createdAt: at,
  updatedAt: at,
});

const createPosts = (requests: ReadonlyArray<CursorCloudHttpRequest>) =>
  requests.filter((request) => request.method === "POST" && request.path === "/v1/agents");

const followUpPosts = (requests: ReadonlyArray<CursorCloudHttpRequest>) =>
  requests.filter((request) => request.method === "POST" && request.path.endsWith("/runs"));

const cancelPosts = (requests: ReadonlyArray<CursorCloudHttpRequest>) =>
  requests.filter((request) => request.method === "POST" && request.path.endsWith("/cancel"));

const finishedBinding = (agentId: string): CursorCloudRunnerBinding => ({
  provider: ProviderDriverKind.make("cursor"),
  model: "composer-2",
  runnerKind: "cursor-cloud",
  target,
  cursorAgentId: agentId,
  cursorRunId: "run-00000000-0000-0000-0000-000000000001",
  cursorRunStatus: "FINISHED",
  status: "finished",
  createdAt: at,
  updatedAt: at,
  credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
});

describe("Cursor Cloud workflow gating", () => {
  it("keeps ActionGate authoritative before a create payload is built", () => {
    expect(() => requireActionGateAllow(deny)).toThrow(/ActionGate denied/);
    expect(() =>
      assertCursorCloudDispatch({
        configured: true,
        gate: deny,
        routeBinding: route,
        target,
      }),
    ).toThrow(/ActionGate denied/);
    expect(
      assertCursorCloudDispatch({
        configured: true,
        gate: allow,
        routeBinding: route,
        target,
      }),
    ).toMatchObject({
      runnerKind: "cursor-cloud",
      workOnCurrentBranch: false,
      autoCreatePR: false,
      credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      target,
    });
  });

  it("hides the immutable payload when Cursor Cloud is unconfigured", () => {
    const preview = cursorCloudDispatchPreview({
      available: true,
      configured: false,
      gate: allow,
      provider: route.driver,
      model: route.target.model,
      target,
    });
    expect(preview.configured).toBe(false);
    expect(preview.payload).toBeNull();
    expect(() =>
      assertCursorCloudDispatch({
        configured: false,
        gate: allow,
        routeBinding: route,
        target,
      }),
    ).toThrow(/not configured/);
  });

  it("requires an exact repository target before dispatch", () => {
    expect(() =>
      assertCursorCloudDispatch({
        configured: true,
        gate: allow,
        routeBinding: route,
        target: undefined,
      }),
    ).toThrow(/missing/);
  });
});

describe("Cursor Cloud durable dispatch", () => {
  it("retries after workflow.record fails without creating a second Cursor agent", async () => {
    const dispatchId = "dispatch-crash-1";
    const agent = agentFor(dispatchId);
    const { transport, requests } = recordTransport(() =>
      jsonResponse(200, { agent, run: runBody(agent.id) }),
    );
    const args = {
      adapter: adapterFor(transport),
      outbox: makeMemoryCursorCloudOutbox(),
      configured: true,
      gate: allow,
      routeBinding: route,
      target,
      prompt: "Add the adapter",
      at,
      ...identity,
      dispatchId,
    };
    let persistCalls = 0;
    const persist = async (binding: CursorCloudRunnerBinding) => {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error("workflow.record failed");
      return binding;
    };
    const dispatch = async () => persist(await createCursorCloudStageBinding(args));
    await expect(dispatch()).rejects.toThrow(/workflow.record failed/);
    const binding = await dispatch();
    expect(createPosts(requests)).toHaveLength(1);
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe("run-00000000-0000-0000-0000-000000000001");
    expect(persistCalls).toBe(2);
  });

  it("coalesces two concurrent identical dispatch requests into one create", async () => {
    const dispatchId = "dispatch-concurrent-1";
    const agent = agentFor(dispatchId);
    let createCalls = 0;
    let enteredCreate!: () => void;
    const hasEnteredCreate = new Promise<void>((resolve) => {
      enteredCreate = resolve;
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { transport, requests } = recordTransport(async (request) => {
      if (request.method === "POST" && request.path === "/v1/agents") {
        createCalls += 1;
        enteredCreate();
        await createGate;
        return jsonResponse(200, { agent, run: runBody(agent.id) });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const args = {
      adapter: adapterFor(transport),
      outbox: makeMemoryCursorCloudOutbox(),
      configured: true,
      gate: allow,
      routeBinding: route,
      target,
      prompt: "Add the adapter",
      at,
      ...identity,
      dispatchId,
    };
    const firstPromise = createCursorCloudStageBinding(args);
    await hasEnteredCreate;
    const secondPromise = createCursorCloudStageBinding(args);
    releaseCreate();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(createCalls).toBe(1);
    expect(createPosts(requests)).toHaveLength(1);
    expect(first.cursorAgentId).toBe(agent.id);
    expect(second.cursorAgentId).toBe(first.cursorAgentId);
    expect(second.cursorRunId).toBe(first.cursorRunId);
  });

  it("keeps a Phase 5 codex / gpt-5.4 route while omitting Cursor model", async () => {
    const dispatchId = "dispatch-model-1";
    const agent = agentFor(dispatchId);
    const { transport, requests } = recordTransport(() =>
      jsonResponse(200, { agent, run: runBody(agent.id) }),
    );
    const payload = assertCursorCloudDispatch({
      configured: true,
      gate: allow,
      routeBinding: codexRoute,
      target,
    });
    expect(payload.provider).toBe("codex");
    expect(payload.model).toBe("gpt-5.4");
    const binding = await createCursorCloudStageBinding({
      adapter: adapterFor(transport),
      outbox: makeMemoryCursorCloudOutbox(),
      configured: true,
      gate: allow,
      routeBinding: codexRoute,
      target,
      prompt: "Keep the dispatcher model local",
      at,
      ...identity,
      dispatchId,
    });
    expect(requests[0]?.body).toMatchObject({
      agentId: agent.id,
      workOnCurrentBranch: false,
      autoCreatePR: false,
    });
    expect(requests[0]?.body).not.toHaveProperty("model");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("gpt-5.4");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("codex");
    expect(binding.provider).toBe("codex");
    expect(binding.model).toBe("gpt-5.4");
  });

  it("replays a repeated follow-up commandId without a second remote run", async () => {
    const agentId = agentFor("dispatch-follow-1").id;
    const followUp = runBody(agentId, "run-00000000-0000-0000-0000-000000000002");
    const { transport, requests } = recordTransport((request) => {
      if (request.path.endsWith("/runs")) return jsonResponse(200, { run: followUp });
      return jsonResponse(500, { message: "unexpected" });
    });
    const args = {
      adapter: adapterFor(transport),
      outbox: makeMemoryCursorCloudOutbox(),
      gate: allow,
      binding: finishedBinding(agentId),
      prompt: "Also add tests",
      at,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "follow-cmd-1",
    };
    const first = await followUpCursorCloudStage(args);
    const second = await followUpCursorCloudStage(args);
    expect(followUpPosts(requests)).toHaveLength(1);
    expect(first.cursorRunId).toBe(followUp.id);
    expect(second.cursorRunId).toBe(first.cursorRunId);
  });

  it("replays a repeated cancel commandId without a second remote cancel", async () => {
    const agentId = agentFor("dispatch-cancel-1").id;
    const { transport, requests } = recordTransport((request) => {
      if (request.path.endsWith("/cancel")) {
        return jsonResponse(200, { id: "run-00000000-0000-0000-0000-000000000001" });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const args = {
      adapter: adapterFor(transport),
      outbox: makeMemoryCursorCloudOutbox(),
      gate: allow,
      binding: {
        ...finishedBinding(agentId),
        cursorRunStatus: "RUNNING" as const,
        status: "running" as const,
      },
      at,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "cancel-cmd-1",
    };
    const first = await cancelCursorCloudStage(args);
    const second = await cancelCursorCloudStage(args);
    expect(cancelPosts(requests)).toHaveLength(1);
    expect(first.status).toBe("cancelled");
    expect(second.status).toBe("cancelled");
    expect(second.cursorRunStatus).toBe("CANCELLED");
  });
});
