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
  id: "bc-00000000-0000-0000-0000-000000000001",
  name: "Add adapter",
  status: "ACTIVE",
  url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001",
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

describe("Cursor Cloud adapter", () => {
  it("sends a repository-target create payload with safe defaults and the exact SHA", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    const binding = await adapterFor(transport).createAgent({
      prompt: "Add the adapter",
      model: "composer-2",
      target: repositoryTarget,
      provider,
      at,
    });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/v1/agents");
    expect(requests[0]?.authorization).toBe(fakeToken);
    expect(requests[0]?.body).toEqual(
      cursorCloudCreateRequestFromTarget({
        prompt: "Add the adapter",
        model: "composer-2",
        target: repositoryTarget,
      }),
    );
    expect(requests[0]?.body).toMatchObject({
      repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
      workOnCurrentBranch: false,
      autoCreatePR: false,
    });
    expect(requests[0]?.body).not.toHaveProperty("env");
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.runnerKind).toBe("cursor-cloud");
    expect(binding.credentialRef).toEqual({ kind: "env", name: "CURSOR_API_KEY" });
    expect(JSON.stringify(binding)).not.toContain(fakeToken);
  });

  it("sends a named-environment create payload without repos", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    await adapterFor(transport).createAgent({
      prompt: "Use the named environment",
      target: namedTarget,
      provider,
      at,
    });
    expect(requests[0]?.body).toEqual({
      prompt: { text: "Use the named environment" },
      env: { type: "cloud", name: "t3-verify" },
      workOnCurrentBranch: false,
      autoCreatePR: false,
    });
    expect(requests[0]?.body).not.toHaveProperty("repos");
  });

  it("rejects env plus explicit repos before any HTTP call", async () => {
    const { transport, requests } = recordTransport(() => jsonResponse(200, { agent, run }));
    expect(() =>
      cursorCloudCreateRequestFromTarget({
        prompt: "mixed",
        target: repositoryTarget,
      }),
    ).not.toThrow();
    const mixed = {
      prompt: { text: "mixed" },
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
    const binding = await adapterFor(transport).createAgent({
      prompt: "Create",
      target: repositoryTarget,
      provider,
      at,
    });
    expect(binding.cursorAgentId).toBe(agent.id);
    expect(binding.cursorRunId).toBe(run.id);
    expect(binding.cursorAgentStatus).toBe("ACTIVE");
    expect(binding.cursorRunStatus).toBe("RUNNING");
    expect(binding.status).toBe("running");
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
      adapterFor(transport).createAgent({
        prompt: "Bad payload",
        target: repositoryTarget,
        provider,
        at,
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("redacts credential-shaped strings from errors and persisted bindings", async () => {
    expect(sanitizeCursorCloudText(`Authorization: Bearer ${fakeToken} crsr_abc123`)).toBe(
      "authorization=[redacted] [redacted]",
    );
    const { transport } = recordTransport(() =>
      jsonResponse(401, {
        message: `Invalid key Bearer ${fakeToken}`,
      }),
    );
    try {
      await adapterFor(transport).verifyIdentity();
      throw new Error("expected failure");
    } catch (error) {
      expect(isCursorCloudError(error)).toBe(true);
      if (isCursorCloudError(error)) {
        expect(error.message).not.toContain(fakeToken);
        expect(error.message).not.toMatch(/Bearer /);
      }
    }
  });

  it("never persists a secret value on the runner binding", async () => {
    const { transport } = recordTransport(() => jsonResponse(200, { agent, run }));
    const binding = await adapterFor(transport).createAgent({
      prompt: "Persist only a reference",
      target: namedTarget,
      provider,
      at,
    });
    expect(binding.credentialRef).toEqual({ kind: "env", name: "CURSOR_API_KEY" });
    expect(JSON.stringify(binding)).not.toContain(fakeToken);
    expect(JSON.stringify(binding)).not.toMatch(/crsr_/);
    expect("value" in binding.credentialRef).toBe(false);
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
});
