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
import { isCursorCloudError } from "./CursorCloudErrors.ts";
import {
  cursorCloudOperationKey,
  cursorCloudRequestFingerprint,
  makeMemoryCursorCloudOutbox,
  type CursorCloudOperationIntent,
  type CursorCloudOutbox,
} from "./CursorCloudOutbox.ts";
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
  environmentId: "environment-1",
  projectId: "project-1",
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

const listRunGets = (requests: ReadonlyArray<CursorCloudHttpRequest>) =>
  requests.filter((request) => request.method === "GET" && request.path.includes("/runs?"));

const getRunGets = (requests: ReadonlyArray<CursorCloudHttpRequest>, runId: string) =>
  requests.filter((request) => request.method === "GET" && request.path.endsWith(`/runs/${runId}`));

const cancelPosts = (requests: ReadonlyArray<CursorCloudHttpRequest>) =>
  requests.filter((request) => request.method === "POST" && request.path.endsWith("/cancel"));

const finishedBinding = (agentId: string): CursorCloudRunnerBinding => ({
  provider: ProviderDriverKind.make("cursor"),
  model: "composer-2",
  runnerKind: "cursor-cloud",
  target,
  cursorAgentId: agentId,
  cursorRunId: "run-00000000-0000-0000-0000-000000000001",
  cursorAgentStatus: "IDLE",
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
      environmentId: identity.environmentId,
      projectId: identity.projectId,
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

  it("does not POST a follow-up while the durable agent is ACTIVE after a terminal run", async () => {
    const agentId = agentFor("dispatch-follow-active").id;
    const { transport, requests } = recordTransport(() =>
      jsonResponse(200, { run: runBody(agentId) }),
    );
    await expect(
      followUpCursorCloudStage({
        adapter: adapterFor(transport),
        outbox: makeMemoryCursorCloudOutbox(),
        gate: allow,
        binding: {
          ...finishedBinding(agentId),
          cursorAgentStatus: "ACTIVE",
          status: "busy",
        },
        prompt: "Also add tests",
        at,
        environmentId: identity.environmentId,
        projectId: identity.projectId,
        runId: identity.runId,
        stageId: identity.stageId,
        attempt: identity.attempt,
        commandId: "follow-active-1",
      }),
    ).rejects.toMatchObject({ code: "agent_busy" });
    expect(followUpPosts(requests)).toHaveLength(0);
  });

  it("finalizes a 409 agent_busy follow-up and replays the same rejection", async () => {
    const agentId = agentFor("dispatch-follow-busy").id;
    const followUp = runBody(agentId, "run-00000000-0000-0000-0000-000000000002");
    let posts = 0;
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path.endsWith("/runs")) {
        posts += 1;
        if (posts === 1) {
          return jsonResponse(409, { code: "agent_busy", message: "agent_busy" });
        }
        return jsonResponse(200, { run: followUp });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const outbox = makeMemoryCursorCloudOutbox();
    const args = {
      adapter: adapterFor(transport),
      outbox,
      gate: allow,
      binding: finishedBinding(agentId),
      prompt: "Also add tests",
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
    };
    await expect(
      followUpCursorCloudStage({ ...args, commandId: "follow-busy-1" }),
    ).rejects.toMatchObject({
      code: "agent_busy",
      message: "The Cursor agent is busy with another run.",
    });
    await expect(
      followUpCursorCloudStage({ ...args, commandId: "follow-busy-1" }),
    ).rejects.toMatchObject({
      code: "agent_busy",
      message: "The Cursor agent is busy with another run.",
    });
    expect(followUpPosts(requests)).toHaveLength(1);
    const recovered = await followUpCursorCloudStage({ ...args, commandId: "follow-busy-2" });
    expect(followUpPosts(requests)).toHaveLength(2);
    expect(recovered.cursorRunId).toBe(followUp.id);
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
      environmentId: identity.environmentId,
      projectId: identity.projectId,
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

const skipComplete = (inner: CursorCloudOutbox): CursorCloudOutbox => ({
  claim: (intent) => inner.claim(intent),
  complete: async () => {
    throw new Error("simulated crash before outbox.complete");
  },
  markIndeterminate: (intent) => inner.markIndeterminate(intent),
  markRejected: (intent, error) => inner.markRejected(intent, error),
});

const followUpIntent = (
  agentId: string,
  commandId: string,
  prompt: string,
  overrides: Partial<CursorCloudOperationIntent> = {},
): CursorCloudOperationIntent => ({
  commandId,
  kind: "follow-up",
  environmentId: identity.environmentId,
  projectId: identity.projectId,
  runId: identity.runId,
  stageId: identity.stageId,
  attempt: identity.attempt,
  cursorAgentId: agentId,
  requestFingerprint: cursorCloudRequestFingerprint({
    kind: "follow-up",
    cursorAgentId: agentId,
    prompt,
    previousRunId: "run-00000000-0000-0000-0000-000000000001",
  }),
  previousRunId: "run-00000000-0000-0000-0000-000000000001",
  claimedAt: at,
  ...overrides,
});

describe("Cursor Cloud operation identity", () => {
  it("does not use only cursor-create-${dispatchId} as the durable key", () => {
    const dispatchId = "dispatch-shared";
    const base = {
      commandId: `cursor-create-${dispatchId}`,
      kind: "create" as const,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: "run-one",
      stageId: identity.stageId,
      attempt: identity.attempt,
      cursorAgentId: "bc-agent",
      requestFingerprint: "fp",
      dispatchId,
    };
    const first = cursorCloudOperationKey(base);
    const second = cursorCloudOperationKey({ ...base, runId: "run-two" });
    expect(first).not.toBe(`cursor-create-${dispatchId}`);
    expect(first).toContain("create");
    expect(first).toContain(identity.projectId);
    expect(first).toContain("run-one");
    expect(first).not.toBe(second);
  });

  it("does not replay a binding when the same commandId is used on another workflow run", async () => {
    const agentId = agentFor("dispatch-follow-run").id;
    const firstRun = runBody(agentId, "run-00000000-0000-0000-0000-000000000002");
    const secondRun = runBody(agentId, "run-00000000-0000-0000-0000-000000000003");
    let followUps = 0;
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path.endsWith("/runs")) {
        followUps += 1;
        return jsonResponse(200, { run: followUps === 1 ? firstRun : secondRun });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const outbox = makeMemoryCursorCloudOutbox();
    const base = {
      adapter: adapterFor(transport),
      outbox,
      gate: allow,
      binding: finishedBinding(agentId),
      prompt: "Also add tests",
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "shared-cmd",
    };
    const first = await followUpCursorCloudStage({ ...base, runId: "run-one" });
    const second = await followUpCursorCloudStage({ ...base, runId: "run-two" });
    expect(followUpPosts(requests)).toHaveLength(2);
    expect(first.cursorRunId).toBe(firstRun.id);
    expect(second.cursorRunId).toBe(secondRun.id);
  });

  it("does not replay a binding when the same commandId is used on another stage or attempt", async () => {
    const agentId = agentFor("dispatch-follow-stage").id;
    const firstRun = runBody(agentId, "run-00000000-0000-0000-0000-000000000002");
    const secondRun = runBody(agentId, "run-00000000-0000-0000-0000-000000000003");
    let followUps = 0;
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path.endsWith("/runs")) {
        followUps += 1;
        return jsonResponse(200, { run: followUps === 1 ? firstRun : secondRun });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const outbox = makeMemoryCursorCloudOutbox();
    const base = {
      adapter: adapterFor(transport),
      outbox,
      gate: allow,
      binding: finishedBinding(agentId),
      prompt: "Also add tests",
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      commandId: "shared-cmd",
    };
    const first = await followUpCursorCloudStage({ ...base, stageId: "research", attempt: 1 });
    const second = await followUpCursorCloudStage({ ...base, stageId: "implement", attempt: 2 });
    expect(followUpPosts(requests)).toHaveLength(2);
    expect(first.cursorRunId).toBe(firstRun.id);
    expect(second.cursorRunId).toBe(secondRun.id);
  });

  it("does not reuse a follow-up binding when the same commandId is later used to cancel", async () => {
    const agentId = agentFor("dispatch-follow-cancel").id;
    const followUp = runBody(agentId, "run-00000000-0000-0000-0000-000000000002");
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path.endsWith("/runs")) {
        return jsonResponse(200, { run: followUp });
      }
      if (request.path.endsWith("/cancel")) {
        return jsonResponse(200, { id: followUp.id });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const outbox = makeMemoryCursorCloudOutbox();
    const followed = await followUpCursorCloudStage({
      adapter: adapterFor(transport),
      outbox,
      gate: allow,
      binding: finishedBinding(agentId),
      prompt: "Also add tests",
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "shared-cmd",
    });
    const cancelled = await cancelCursorCloudStage({
      adapter: adapterFor(transport),
      outbox,
      gate: allow,
      binding: {
        ...followed,
        cursorRunStatus: "RUNNING",
        status: "running",
      },
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "shared-cmd",
    });
    expect(followUpPosts(requests)).toHaveLength(1);
    expect(cancelPosts(requests)).toHaveLength(1);
    expect(followed.cursorRunId).toBe(followUp.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cursorRunStatus).toBe("CANCELLED");
  });

  it("rejects the same commandId when the prompt fingerprint differs", async () => {
    const agentId = agentFor("dispatch-follow-prompt").id;
    const followUp = runBody(agentId, "run-00000000-0000-0000-0000-000000000002");
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path.endsWith("/runs")) {
        return jsonResponse(200, { run: followUp });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const outbox = makeMemoryCursorCloudOutbox();
    const args = {
      adapter: adapterFor(transport),
      outbox,
      gate: allow,
      binding: finishedBinding(agentId),
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "shared-cmd",
    };
    const first = await followUpCursorCloudStage({ ...args, prompt: "Also add tests" });
    await expect(
      followUpCursorCloudStage({ ...args, prompt: "A different prompt" }),
    ).rejects.toMatchObject({ code: "command_conflict" });
    expect(followUpPosts(requests)).toHaveLength(1);
    expect(first.cursorRunId).toBe(followUp.id);
  });

  it("creates distinct agents when two workflow runs share a dispatchId", async () => {
    const firstAgent = agentFor("dispatch-shared");
    const secondAgent = cursorCloudAgentIdFromDispatch({
      runId: "run-two",
      stageId: identity.stageId,
      attempt: identity.attempt,
      dispatchId: "dispatch-shared",
    });
    const { transport, requests } = recordTransport((request) => {
      const body = request.body as { agentId?: string } | undefined;
      const agentId = body?.agentId ?? firstAgent.id;
      const agent = {
        ...firstAgent,
        id: agentId,
        url: `https://cursor.com/agents/${agentId}`,
      };
      return jsonResponse(200, { agent, run: runBody(agentId) });
    });
    const outbox = makeMemoryCursorCloudOutbox();
    const base = {
      adapter: adapterFor(transport),
      outbox,
      configured: true,
      gate: allow,
      routeBinding: route,
      target,
      prompt: "Add the adapter",
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      dispatchId: "dispatch-shared",
    };
    const first = await createCursorCloudStageBinding({ ...base, runId: "run-one" });
    const second = await createCursorCloudStageBinding({ ...base, runId: "run-two" });
    expect(createPosts(requests)).toHaveLength(2);
    expect(first.cursorAgentId).toBe(firstAgent.id);
    expect(second.cursorAgentId).toBe(secondAgent);
    expect(second.cursorAgentId).not.toBe(first.cursorAgentId);
  });

  it("never returns another operation's completed binding on a command conflict", async () => {
    const agentId = agentFor("dispatch-conflict-binding").id;
    const outbox = makeMemoryCursorCloudOutbox();
    const stored = followUpIntent(agentId, "shared-cmd", "Also add tests");
    await outbox.claim(stored);
    await outbox.complete(stored, finishedBinding(agentId));
    try {
      await outbox.claim(followUpIntent(agentId, "shared-cmd", "A different prompt"));
      throw new Error("expected command_conflict");
    } catch (error) {
      expect(isCursorCloudError(error)).toBe(true);
      if (isCursorCloudError(error)) {
        expect(error.code).toBe("command_conflict");
        expect(JSON.stringify(error)).not.toContain(agentId);
      }
    }
  });
});

describe("Cursor Cloud crash window before outbox.complete", () => {
  it("reconciles a follow-up after complete crashes without posting a second run", async () => {
    const agentId = agentFor("dispatch-follow-crash").id;
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const followUp = {
      ...runBody(agentId, "run-00000000-0000-0000-0000-000000000002"),
      createdAt: at,
    };
    const inner = makeMemoryCursorCloudOutbox();
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path.endsWith("/runs")) {
        return jsonResponse(200, { run: followUp });
      }
      if (request.method === "GET" && request.path.includes("/runs?")) {
        return jsonResponse(200, {
          items: [followUp, { ...runBody(agentId, previous), status: "FINISHED" }],
        });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const args = {
      adapter: adapterFor(transport),
      gate: allow,
      binding: finishedBinding(agentId),
      prompt: "Also add tests",
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "follow-crash-1",
    };
    await expect(
      followUpCursorCloudStage({ ...args, outbox: skipComplete(inner) }),
    ).rejects.toThrow(/simulated crash before outbox.complete/);
    const recovered = await followUpCursorCloudStage({ ...args, outbox: inner });
    expect(followUpPosts(requests)).toHaveLength(1);
    expect(listRunGets(requests)).toHaveLength(1);
    expect(recovered.cursorRunId).toBe(followUp.id);
  });

  it("marks follow-up indeterminate when multiple new runs match the pending operation", async () => {
    const agentId = agentFor("dispatch-follow-ambiguous").id;
    const previous = "run-00000000-0000-0000-0000-000000000001";
    const inner = makeMemoryCursorCloudOutbox();
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "GET" && request.path.includes("/runs?")) {
        return jsonResponse(200, {
          items: [
            { ...runBody(agentId, "run-00000000-0000-0000-0000-000000000003"), createdAt: at },
            { ...runBody(agentId, "run-00000000-0000-0000-0000-000000000002"), createdAt: at },
            { ...runBody(agentId, previous), status: "FINISHED" },
          ],
        });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    await inner.claim(followUpIntent(agentId, "follow-ambiguous-1", "Also add tests"));
    await expect(
      followUpCursorCloudStage({
        adapter: adapterFor(transport),
        outbox: inner,
        gate: allow,
        binding: finishedBinding(agentId),
        prompt: "Also add tests",
        at,
        environmentId: identity.environmentId,
        projectId: identity.projectId,
        runId: identity.runId,
        stageId: identity.stageId,
        attempt: identity.attempt,
        commandId: "follow-ambiguous-1",
      }),
    ).rejects.toMatchObject({ code: "indeterminate" });
    expect(followUpPosts(requests)).toHaveLength(0);
  });

  it("completes cancel from the observed CANCELLED run without a second cancel POST", async () => {
    const agentId = agentFor("dispatch-cancel-crash").id;
    const runId = "run-00000000-0000-0000-0000-000000000001";
    const inner = makeMemoryCursorCloudOutbox();
    const { transport, requests } = recordTransport((request) => {
      if (request.path.endsWith("/cancel")) {
        return jsonResponse(200, { id: runId });
      }
      if (request.method === "GET" && request.path.endsWith(`/runs/${runId}`)) {
        return jsonResponse(200, {
          ...runBody(agentId, runId),
          status: "CANCELLED",
        });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const args = {
      adapter: adapterFor(transport),
      gate: allow,
      binding: {
        ...finishedBinding(agentId),
        cursorRunStatus: "RUNNING" as const,
        status: "running" as const,
      },
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "cancel-crash-1",
    };
    await expect(cancelCursorCloudStage({ ...args, outbox: skipComplete(inner) })).rejects.toThrow(
      /simulated crash before outbox.complete/,
    );
    const recovered = await cancelCursorCloudStage({ ...args, outbox: inner });
    expect(cancelPosts(requests)).toHaveLength(1);
    expect(getRunGets(requests, runId)).toHaveLength(1);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.cursorRunStatus).toBe("CANCELLED");
  });

  it("persists another observed terminal cancel status without leaving the operation pending", async () => {
    const agentId = agentFor("dispatch-cancel-finished").id;
    const runId = "run-00000000-0000-0000-0000-000000000001";
    const inner = makeMemoryCursorCloudOutbox();
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "GET" && request.path.endsWith(`/runs/${runId}`)) {
        return jsonResponse(200, {
          ...runBody(agentId, runId),
          status: "FINISHED",
          result: "Already finished.",
        });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const intent: CursorCloudOperationIntent = {
      commandId: "cancel-finished-1",
      kind: "cancel",
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      cursorAgentId: agentId,
      requestFingerprint: cursorCloudRequestFingerprint({
        kind: "cancel",
        cursorAgentId: agentId,
        previousRunId: runId,
      }),
      previousRunId: runId,
      claimedAt: at,
    };
    await inner.claim(intent);
    const recovered = await cancelCursorCloudStage({
      adapter: adapterFor(transport),
      outbox: inner,
      gate: allow,
      binding: {
        ...finishedBinding(agentId),
        cursorRunStatus: "RUNNING",
        status: "running",
      },
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "cancel-finished-1",
    });
    expect(cancelPosts(requests)).toHaveLength(0);
    expect(getRunGets(requests, runId)).toHaveLength(1);
    expect(recovered.status).toBe("finished");
    expect(recovered.cursorRunStatus).toBe("FINISHED");
    const replay = await cancelCursorCloudStage({
      adapter: adapterFor(transport),
      outbox: inner,
      gate: allow,
      binding: {
        ...finishedBinding(agentId),
        cursorRunStatus: "RUNNING",
        status: "running",
      },
      at,
      environmentId: identity.environmentId,
      projectId: identity.projectId,
      runId: identity.runId,
      stageId: identity.stageId,
      attempt: identity.attempt,
      commandId: "cancel-finished-1",
    });
    expect(cancelPosts(requests)).toHaveLength(0);
    expect(replay.cursorRunStatus).toBe("FINISHED");
  });
});
