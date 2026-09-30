import { ProviderDriverKind, cursorCloudCreateRequestFromTarget } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { makeCursorCloudAdapter } from "./CursorCloudAdapter.ts";
import { staticCursorCloudCredentialProvider } from "./CursorCloudCredentials.ts";
import { isCursorCloudError, sanitizeCursorCloudText } from "./CursorCloudErrors.ts";
import {
  makeFetchCursorCloudTransport,
  parseRetryAfterMs,
  type CursorCloudHttpRequest,
  type CursorCloudHttpResponse,
  type CursorCloudHttpTransport,
} from "./CursorCloudHttp.ts";

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const at = "2026-09-29T12:00:00.000Z";
const provider = ProviderDriverKind.make("cursor");
const fakeToken = "test-cursor-token";
const underscoreToken = "crsr_test_secret_value";
const hyphenToken = "crsr-live-secret-value";
const clientAgentId = "bc-11111111-1111-5111-8111-111111111111";
const repositoryTarget = {
  mode: "repository" as const,
  repositoryUrl: "https://github.com/charliefq/base3router",
  startingRef: sha,
};
const namedTarget = {
  mode: "named-environment" as const,
  environmentName: "t3-verify",
};

const agent = {
  id: clientAgentId,
  name: "Add adapter",
  status: "ACTIVE",
  url: `https://cursor.com/agents/${clientAgentId}`,
  createdAt: at,
  updatedAt: at,
  latestRunId: "run-00000000-0000-0000-0000-000000000001",
};
const run = {
  id: "run-00000000-0000-0000-0000-000000000001",
  agentId: agent.id,
  status: "CREATING",
  createdAt: at,
  updatedAt: at,
};

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): CursorCloudHttpResponse => ({
  status,
  headers,
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

const adapterFor = (transport: CursorCloudHttpTransport, token = fakeToken) =>
  makeCursorCloudAdapter({
    transport,
    credentials: staticCursorCloudCredentialProvider(token),
  });

const createInput = (
  overrides: Partial<Parameters<ReturnType<typeof adapterFor>["createAgent"]>[0]> = {},
) => ({
  prompt: "Add the adapter",
  agentId: clientAgentId,
  target: repositoryTarget,
  provider,
  dispatcherModel: "composer-2",
  at,
  ...overrides,
});

const createPosts = (requests: ReadonlyArray<CursorCloudHttpRequest>) =>
  requests.filter((request) => request.method === "POST" && request.path === "/v1/agents");

describe("Cursor Cloud adapter", () => {
  it("sends a repository-target create payload with safe defaults and the exact SHA", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    const binding = await adapterFor(transport).createAgent(createInput());
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/v1/agents");
    expect(requests[0]?.authorization).toBe(fakeToken);
    expect(requests[0]?.body).toEqual(
      cursorCloudCreateRequestFromTarget({
        prompt: "Add the adapter",
        agentId: clientAgentId,
        target: repositoryTarget,
      }),
    );
    expect(requests[0]?.body).toMatchObject({
      agentId: clientAgentId,
      repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
      workOnCurrentBranch: false,
      autoCreatePR: false,
    });
    expect(requests[0]?.body).not.toHaveProperty("env");
    expect(requests[0]?.body).not.toHaveProperty("model");
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.runnerKind).toBe("cursor-cloud");
    expect(binding.model).toBe("composer-2");
    expect(binding.credentialRef).toEqual({ kind: "env", name: "CURSOR_API_KEY" });
    expect(JSON.stringify(binding)).not.toContain(fakeToken);
  });

  it("omits dispatcher model names from the Cursor create body", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    const binding = await adapterFor(transport).createAgent(
      createInput({
        prompt: "Do not forward the dispatcher model",
        provider: ProviderDriverKind.make("codex"),
        dispatcherModel: "gpt-5.4",
      }),
    );
    expect(requests[0]?.body).not.toHaveProperty("model");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("gpt-5.4");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("codex");
    expect(binding.provider).toBe("codex");
    expect(binding.model).toBe("gpt-5.4");
  });

  it("sends a named-environment create payload without repos", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    await adapterFor(transport).createAgent(
      createInput({
        prompt: "Use the named environment",
        target: namedTarget,
      }),
    );
    expect(requests[0]?.body).toEqual({
      prompt: { text: "Use the named environment" },
      agentId: clientAgentId,
      env: { type: "cloud", name: "t3-verify" },
      workOnCurrentBranch: false,
      autoCreatePR: false,
    });
    expect(requests[0]?.body).not.toHaveProperty("repos");
    expect(requests[0]?.body).not.toHaveProperty("model");
  });

  it("rejects env plus explicit repos before any HTTP call", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    expect(() =>
      cursorCloudCreateRequestFromTarget({
        prompt: "mixed",
        agentId: clientAgentId,
        target: repositoryTarget,
      }),
    ).not.toThrow();
    const mixed = {
      prompt: { text: "mixed" },
      agentId: clientAgentId,
      env: { type: "cloud", name: "t3-verify" },
      repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
      workOnCurrentBranch: false,
      autoCreatePR: false,
    };
    const { decodeCursorCloudCreateRequest } = await import("@t3tools/contracts");
    expect(decodeCursorCloudCreateRequest(mixed)._tag).toBe("Failure");
    expect(requests).toHaveLength(0);
    void transport;
  });

  it("captures both agent ID and initial run ID from create", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse(200, {
        agent: { ...agent, latestRunId: run.id },
        run: { ...run, status: "RUNNING" },
      }),
    );
    const binding = await adapterFor(transport).createAgent(createInput({ prompt: "Create" }));
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.cursorAgentStatus).toBe("ACTIVE");
    expect(binding.cursorRunStatus).toBe("RUNNING");
    expect(binding.status).toBe("running");
  });

  it("reconciles the existing agent and latest run on 409 agent_id_conflict", async () => {
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "POST" && request.path === "/v1/agents") {
        return jsonResponse(409, { code: "agent_id_conflict", message: "agent_id_conflict" });
      }
      if (request.path === `/v1/agents/${clientAgentId}`) {
        return jsonResponse(200, { ...agent, latestRunId: run.id, status: "IDLE" });
      }
      if (request.path === `/v1/agents/${clientAgentId}/runs/${run.id}`) {
        return jsonResponse(200, { ...run, status: "FINISHED", result: "Already created." });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const binding = await adapterFor(transport).createAgent(createInput());
    expect(createPosts(requests)).toHaveLength(1);
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.cursorRunStatus).toBe("FINISHED");
    expect(binding.model).toBe("composer-2");
  });

  it("creates a follow-up run on the durable agent", async () => {
    const followUp = {
      id: "run-00000000-0000-0000-0000-000000000002",
      agentId: agent.id,
      status: "CREATING",
      createdAt: at,
      updatedAt: at,
    };
    const { transport, requests } = recordTransport((request) => {
      if (request.path.endsWith("/runs")) return jsonResponse(200, { run: followUp });
      return jsonResponse(500, { message: "unexpected" });
    });
    const created = await adapterFor(transport).createFollowUpRun({
      binding: {
        provider,
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: repositoryTarget,
        cursorAgentId: agent.id,
        cursorRunId: run.id,
        cursorAgentStatus: "IDLE",
        cursorRunStatus: "FINISHED",
        status: "finished",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      prompt: "Also add tests",
      at,
    });
    expect(requests[0]?.path).toBe(`/v1/agents/${agent.id}/runs`);
    expect(requests[0]?.body).toEqual({ prompt: { text: "Also add tests" } });
    expect(created.cursorRunId).toBe(followUp.id);
    expect(created.cursorAgentId).toBe(agent.id);
  });

  it("maps get-run status and git output", async () => {
    const finished = {
      ...run,
      status: "FINISHED",
      result: "Added the adapter.",
      git: {
        branches: [
          {
            repoUrl: "github.com/charliefq/base3router",
            branch: "cursor/phase-6-c98a",
            prUrl: "https://github.com/charliefq/base3router/pull/6",
          },
        ],
      },
    };
    const { transport } = recordTransport((request) => {
      if (request.path.endsWith(`/runs/${run.id}`)) return jsonResponse(200, finished);
      if (request.path.endsWith(`/agents/${agent.id}`))
        return jsonResponse(200, { ...agent, status: "IDLE", latestRunId: run.id });
      return jsonResponse(500, { message: "unexpected" });
    });
    const adapter = adapterFor(transport);
    const observed = await adapter.getRun(agent.id, run.id);
    const binding = await adapter.refreshBinding({
      binding: {
        provider,
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: repositoryTarget,
        cursorAgentId: agent.id,
        cursorRunId: run.id,
        status: "running",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      at,
    });
    expect(observed.status).toBe("FINISHED");
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.cursorAgentStatus).toBe("IDLE");
    expect(binding.cursorRunStatus).toBe("FINISHED");
    expect(binding.status).toBe("finished");
    expect(binding.output?.branch).toBe("cursor/phase-6-c98a");
    expect(binding.output?.pullRequestUrl).toBe("https://github.com/charliefq/base3router/pull/6");
    expect(binding.sanitizedResult).toBe("Added the adapter.");
  });

  it("surfaces 409 agent_busy without retrying", async () => {
    let calls = 0;
    const { transport } = recordTransport(() => {
      calls += 1;
      return jsonResponse(409, { code: "agent_busy", message: "agent_busy" });
    });
    await expect(
      adapterFor(transport).createFollowUpRun({
        binding: {
          provider,
          model: "composer-2",
          runnerKind: "cursor-cloud",
          target: namedTarget,
          cursorAgentId: agent.id,
          cursorAgentStatus: "IDLE",
          cursorRunStatus: "FINISHED",
          status: "finished",
          createdAt: at,
          updatedAt: at,
          credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
        },
        prompt: "Follow up",
        at,
      }),
    ).rejects.toMatchObject({ code: "agent_busy", httpStatus: 409 });
    expect(calls).toBe(1);
  });

  it("returns 429 retry metadata without an uncontrolled retry loop", async () => {
    let calls = 0;
    const { transport } = recordTransport(() => {
      calls += 1;
      return jsonResponse(429, { message: "Rate limit exceeded" }, { "retry-after": "2" });
    });
    await expect(adapterFor(transport).verifyIdentity()).rejects.toMatchObject({
      code: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 2_000,
    });
    expect(calls).toBe(1);
    expect(parseRetryAfterMs({ "retry-after": "2" })).toBe(2_000);
  });

  it("treats cancellation as terminal for that run", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { id: run.id }));
    const binding = await adapterFor(transport).cancelRun({
      binding: {
        provider,
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: repositoryTarget,
        cursorAgentId: agent.id,
        cursorRunId: run.id,
        cursorRunStatus: "RUNNING",
        status: "running",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      at,
    });
    expect(requests[0]?.path).toBe(`/v1/agents/${agent.id}/runs/${run.id}/cancel`);
    expect(binding.status).toBe("cancelled");
    expect(binding.cursorRunStatus).toBe("CANCELLED");
    expect(binding.cursorAgentId).toBe(agent.id);
  });

  it("maps transport abort to a timeout error", async () => {
    const transport = makeFetchCursorCloudTransport({
      baseUrl: "https://api.cursor.com",
      fetchImpl: (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    await expect(
      makeCursorCloudAdapter({
        transport,
        credentials: staticCursorCloudCredentialProvider(fakeToken),
        defaultTimeoutMs: 5,
      }).verifyIdentity(),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects a malformed create response", async () => {
    const { transport } = recordTransport(() => jsonResponse(200, { agent: { id: agent.id } }));
    await expect(
      adapterFor(transport).createAgent(createInput({ prompt: "Bad payload" })),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("redacts credential-shaped strings from errors, logs, and persisted bindings", async () => {
    expect(sanitizeCursorCloudText(`Authorization: Bearer ${underscoreToken}`)).not.toContain(
      "secret_value",
    );
    expect(sanitizeCursorCloudText(`log line token=${hyphenToken}`)).not.toContain("secret-value");
    expect(sanitizeCursorCloudText(underscoreToken)).not.toContain(underscoreToken);
    expect(sanitizeCursorCloudText(hyphenToken)).not.toContain(hyphenToken);
    const { transport } = recordTransport(() =>
      jsonResponse(401, {
        error: {
          message: `Invalid key Bearer ${underscoreToken}`,
          nested: { token: hyphenToken },
        },
      }),
    );
    try {
      await adapterFor(transport, underscoreToken).verifyIdentity();
      throw new Error("expected failure");
    } catch (error) {
      expect(isCursorCloudError(error)).toBe(true);
      if (isCursorCloudError(error)) {
        expect(error.message).not.toContain("secret_value");
        expect(error.message).not.toContain("secret-value");
        expect(error.message).not.toContain(underscoreToken);
        expect(error.message).not.toMatch(/Bearer /);
      }
    }
  });

  it("never persists a secret value on the runner binding", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse(200, {
        agent,
        run: {
          ...run,
          status: "FINISHED",
          result: `Done with ${underscoreToken} and ${hyphenToken}`,
        },
      }),
    );
    const binding = await adapterFor(transport, hyphenToken).createAgent(
      createInput({
        prompt: "Persist only a reference",
        target: namedTarget,
      }),
    );
    const persisted = JSON.stringify(binding);
    expect(binding.credentialRef).toEqual({ kind: "env", name: "CURSOR_API_KEY" });
    expect(persisted).not.toContain(hyphenToken);
    expect(persisted).not.toContain(underscoreToken);
    expect(persisted).not.toContain("secret_value");
    expect(persisted).not.toContain("secret-value");
    expect(persisted).not.toMatch(/crsr_/);
    expect("value" in binding.credentialRef).toBe(false);
    expect(binding.sanitizedResult).not.toContain("secret_value");
    expect(binding.sanitizedResult).not.toContain("secret-value");
  });

  it("refuses to follow up while the durable agent is ACTIVE after a terminal run", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { run }));
    await expect(
      adapterFor(transport).createFollowUpRun({
        binding: {
          provider,
          model: "composer-2",
          runnerKind: "cursor-cloud",
          target: repositoryTarget,
          cursorAgentId: agent.id,
          cursorRunId: run.id,
          cursorAgentStatus: "ACTIVE",
          cursorRunStatus: "FINISHED",
          status: "busy",
          createdAt: at,
          updatedAt: at,
          credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
        },
        prompt: "Too soon",
        at,
      }),
    ).rejects.toMatchObject({ code: "agent_busy" });
    expect(requests).toHaveLength(0);
  });

  it("maps a terminal run with an ACTIVE agent as busy without inferring IDLE", async () => {
    const { transport } = recordTransport((request) => {
      if (request.path.endsWith(`/runs/${run.id}`)) {
        return jsonResponse(200, { ...run, status: "FINISHED", result: "Run finished." });
      }
      if (request.path.endsWith(`/agents/${agent.id}`)) {
        return jsonResponse(200, { ...agent, status: "ACTIVE", latestRunId: run.id });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const binding = await adapterFor(transport).refreshBinding({
      binding: {
        provider,
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: repositoryTarget,
        cursorAgentId: agent.id,
        cursorRunId: run.id,
        status: "running",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      at,
    });
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.cursorAgentStatus).toBe("ACTIVE");
    expect(binding.cursorRunStatus).toBe("FINISHED");
    expect(binding.status).toBe("busy");
  });

  it("refuses to follow up while the current run is still active", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { run }));
    await expect(
      adapterFor(transport).createFollowUpRun({
        binding: {
          provider,
          model: "composer-2",
          runnerKind: "cursor-cloud",
          target: repositoryTarget,
          cursorAgentId: agent.id,
          cursorRunId: run.id,
          cursorRunStatus: "RUNNING",
          status: "running",
          createdAt: at,
          updatedAt: at,
          credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
        },
        prompt: "Too soon",
        at,
      }),
    ).rejects.toMatchObject({ code: "agent_busy" });
    expect(requests).toHaveLength(0);
  });

  it("lists runs newest-first from the durable agent", async () => {
    const newer = {
      ...run,
      id: "run-00000000-0000-0000-0000-000000000002",
      status: "RUNNING",
    };
    const { transport, requests } = recordTransport((request) => {
      if (request.method === "GET" && request.path === `/v1/agents/${agent.id}/runs?limit=20`) {
        return jsonResponse(200, { items: [newer, run] });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const items = await adapterFor(transport).listRuns(agent.id);
    expect(requests[0]?.path).toBe(`/v1/agents/${agent.id}/runs?limit=20`);
    expect(items.map((item) => item.id)).toEqual([newer.id, run.id]);
  });

  it("pages run lists until previousRunId before reconciling", async () => {
    const page1 = Array.from({ length: 20 }, (_, index) => ({
      ...run,
      id: `run-page1-${String(index).padStart(2, "0")}`,
      status: "FINISHED",
    }));
    const { transport, requests } = recordTransport((request) => {
      if (request.method !== "GET" || !request.path.includes("/runs?")) {
        return jsonResponse(500, { message: "unexpected" });
      }
      if (request.path.includes("cursor=page-2")) {
        return jsonResponse(200, { items: [run] });
      }
      return jsonResponse(200, { items: page1, nextCursor: "page-2" });
    });
    const scan = await adapterFor(transport).listRunsUntil(agent.id, {
      previousRunId: run.id,
      claimedAt: at,
    });
    expect(requests.map((request) => request.path)).toEqual([
      `/v1/agents/${agent.id}/runs?limit=20`,
      `/v1/agents/${agent.id}/runs?limit=20&cursor=page-2`,
    ]);
    expect(scan.reachedBoundary).toBe(true);
    expect(scan.items).toHaveLength(21);
    expect(scan.items.at(-1)?.id).toBe(run.id);
  });

  it("GETs the run after 409 run_not_cancellable and persists CANCELLED", async () => {
    const { transport, requests } = recordTransport((request) => {
      if (request.path.endsWith("/cancel")) {
        return jsonResponse(409, { code: "run_not_cancellable", message: "run_not_cancellable" });
      }
      if (request.method === "GET" && request.path.endsWith(`/runs/${run.id}`)) {
        return jsonResponse(200, { ...run, status: "CANCELLED" });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const binding = await adapterFor(transport).cancelRun({
      binding: {
        provider,
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: repositoryTarget,
        cursorAgentId: agent.id,
        cursorRunId: run.id,
        cursorRunStatus: "RUNNING",
        status: "running",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      at,
    });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST /v1/agents/${agent.id}/runs/${run.id}/cancel`,
      `GET /v1/agents/${agent.id}/runs/${run.id}`,
    ]);
    expect(binding.status).toBe("cancelled");
    expect(binding.cursorRunStatus).toBe("CANCELLED");
  });

  it("persists another observed terminal status after 409 run_not_cancellable", async () => {
    const { transport } = recordTransport((request) => {
      if (request.path.endsWith("/cancel")) {
        return jsonResponse(409, { code: "run_not_cancellable", message: "run_not_cancellable" });
      }
      if (request.method === "GET" && request.path.endsWith(`/runs/${run.id}`)) {
        return jsonResponse(200, { ...run, status: "FINISHED", result: "Already done." });
      }
      return jsonResponse(500, { message: "unexpected" });
    });
    const binding = await adapterFor(transport).cancelRun({
      binding: {
        provider,
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: repositoryTarget,
        cursorAgentId: agent.id,
        cursorRunId: run.id,
        cursorRunStatus: "RUNNING",
        status: "running",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      at,
    });
    expect(binding.status).toBe("finished");
    expect(binding.cursorRunStatus).toBe("FINISHED");
    expect(binding.sanitizedResult).toBe("Already done.");
  });
});
