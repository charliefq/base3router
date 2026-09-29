import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ProviderDriverKind } from "./providerInstance.ts";
import {
  CLOUD_RUNNER_KIND_CURSOR_CLOUD,
  CURSOR_CLOUD_CREDENTIAL_ENV_NAME,
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  CursorCloudCreateRequest,
  CursorCloudImmutableDispatchPayload,
  CursorCloudRunnerBinding,
  cursorCloudCreateRequestFromTarget,
  decodeCursorCloudCreateRequest,
  decodeCursorCloudExecutionTarget,
  decodeCursorCloudRunnerBinding,
  emptyCursorCloudBinding,
  isCursorCloudRunActive,
  isCursorCloudRunTerminal,
  mapCursorAgentStatus,
  mapCursorRunStatus,
  runnerBindingOmitsCredentialValue,
} from "./cloudRunner.ts";
import { ActionGateResult, DispatcherTaskRouteBinding } from "./dispatcher.ts";
import { WorkflowStageAttempt } from "./workflow.ts";

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const at = "2026-09-29T00:00:00.000Z";
const provider = ProviderDriverKind.make("cursor");

const repositoryTarget = {
  mode: "repository" as const,
  repositoryUrl: "https://github.com/charliefq/base3router",
  startingRef: sha,
  expectedEnvironmentName: "t3-verify",
  expectedBuildId: "build-123",
};

const namedEnvironmentTarget = {
  mode: "named-environment" as const,
  environmentName: "production-cloud",
};

const decodeCreate = Schema.decodeUnknownExit(CursorCloudCreateRequest);
const decodeBinding = Schema.decodeUnknownExit(CursorCloudRunnerBinding);
const decodeAttempt = Schema.decodeUnknownExit(WorkflowStageAttempt);
const decodeRouteBinding = Schema.decodeUnknownExit(DispatcherTaskRouteBinding);

describe("cursor-cloud runner contracts", () => {
  it("treats cursor-cloud as a first-class runner kind, not provider cursor", () => {
    expect(CLOUD_RUNNER_KIND_CURSOR_CLOUD).toBe("cursor-cloud");
    expect(CLOUD_RUNNER_KIND_CURSOR_CLOUD).not.toBe("cursor");
    expect(provider).toBe("cursor");
  });

  it("decodes a repository target and preserves the exact starting SHA", () => {
    const decoded = decodeCursorCloudExecutionTarget(repositoryTarget);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value).toEqual(repositoryTarget);
      expect(decoded.value.mode).toBe("repository");
      if (decoded.value.mode === "repository") {
        expect(decoded.value.startingRef).toBe(sha);
      }
    }
  });

  it("decodes a named-environment target without repository fields", () => {
    const decoded = decodeCursorCloudExecutionTarget(namedEnvironmentTarget);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value).toEqual(namedEnvironmentTarget);
      expect("repositoryUrl" in decoded.value).toBe(false);
    }
  });

  it("rejects branch names, main, and short refs as immutable starting refs", () => {
    expect(
      Exit.isFailure(
        decodeCursorCloudExecutionTarget({
          mode: "repository",
          repositoryUrl: "https://github.com/charliefq/base3router",
          startingRef: "main",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeCursorCloudExecutionTarget({
          mode: "repository",
          repositoryUrl: "https://github.com/charliefq/base3router",
          startingRef: sha.slice(0, 12),
        }),
      ),
    ).toBe(true);
  });

  it("builds a repository create payload with safe defaults, agentId, and no env", () => {
    const request = cursorCloudCreateRequestFromTarget({
      prompt: "Add the Cursor Cloud adapter",
      agentId: "bc-11111111-1111-5111-8111-111111111111",
      target: repositoryTarget,
    });
    const decoded = decodeCreate(request);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.agentId).toBe("bc-11111111-1111-5111-8111-111111111111");
      expect(decoded.value.repos).toEqual([
        { url: repositoryTarget.repositoryUrl, startingRef: sha },
      ]);
      expect(decoded.value.workOnCurrentBranch).toBe(false);
      expect(decoded.value.autoCreatePR).toBe(false);
      expect(decoded.value.env).toBeUndefined();
      expect(decoded.value.model).toBeUndefined();
      expect(decoded.value.repos?.[0]?.startingRef).toBe(sha);
    }
  });

  it("omits dispatcher model names from the Cursor create request", () => {
    const request = cursorCloudCreateRequestFromTarget({
      prompt: "Do not forward the dispatcher model",
      agentId: "bc-11111111-1111-5111-8111-111111111111",
      target: repositoryTarget,
    });
    expect(request).not.toHaveProperty("model");
    expect(JSON.stringify(request)).not.toContain("gpt-5.4");
    expect(JSON.stringify(request)).not.toContain("codex");
  });

  it("rejects a non-v5 client agent id on the create-request boundary", () => {
    expect(
      Exit.isFailure(
        decodeCreate({
          prompt: { text: "Invalid agent id" },
          agentId: "bc-00000000-0000-0000-0000-000000000001",
          repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
          workOnCurrentBranch: false,
          autoCreatePR: false,
        }),
      ),
    ).toBe(true);
  });

  it("builds a named-environment create payload without repos", () => {
    const request = cursorCloudCreateRequestFromTarget({
      prompt: "Continue in the named environment",
      agentId: "bc-11111111-1111-5111-8111-111111111111",
      target: namedEnvironmentTarget,
    });
    const decoded = decodeCreate(request);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.env).toEqual({ type: "cloud", name: "production-cloud" });
      expect(decoded.value.repos).toBeUndefined();
      expect(decoded.value.workOnCurrentBranch).toBe(false);
      expect(decoded.value.autoCreatePR).toBe(false);
    }
  });

  it("rejects env plus explicit repos on the create-request boundary", () => {
    const mixed = decodeCursorCloudCreateRequest({
      prompt: { text: "Do not mix targets" },
      agentId: "bc-11111111-1111-5111-8111-111111111111",
      env: { type: "cloud", name: "production-cloud" },
      repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
      workOnCurrentBranch: false,
      autoCreatePR: false,
    });
    expect(Exit.isFailure(mixed)).toBe(true);
  });

  it("rejects workOnCurrentBranch or autoCreatePR overrides", () => {
    expect(
      Exit.isFailure(
        decodeCreate({
          prompt: { text: "Unsafe branch" },
          agentId: "bc-11111111-1111-5111-8111-111111111111",
          repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
          workOnCurrentBranch: true,
          autoCreatePR: false,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeCreate({
          prompt: { text: "Unsafe PR" },
          agentId: "bc-11111111-1111-5111-8111-111111111111",
          repos: [{ url: repositoryTarget.repositoryUrl, startingRef: sha }],
          workOnCurrentBranch: false,
          autoCreatePR: true,
        }),
      ),
    ).toBe(true);
  });

  it("persists agent and run identities separately from provider and model", () => {
    const binding = emptyCursorCloudBinding({
      provider,
      model: "composer-2",
      target: repositoryTarget,
      at,
    });
    const persisted = {
      ...binding,
      cursorAgentId: "bc-00000000-0000-0000-0000-000000000001",
      cursorRunId: "run-00000000-0000-0000-0000-000000000001",
      cursorAgentUrl: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001",
      cursorAgentStatus: "ACTIVE",
      cursorRunStatus: "RUNNING",
      output: {
        repositoryUrl: "github.com/charliefq/base3router",
        branch: "cursor/phase-6-c98a",
        commitSha: sha,
        pullRequestUrl: "https://github.com/charliefq/base3router/pull/6",
      },
      status: "running",
    };
    const decoded = decodeCursorCloudRunnerBinding(persisted);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.provider).toBe("cursor");
      expect(decoded.value.runnerKind).toBe("cursor-cloud");
      expect(decoded.value.cursorAgentId).toBe("bc-00000000-0000-0000-0000-000000000001");
      expect(decoded.value.cursorRunId).toBe("run-00000000-0000-0000-0000-000000000001");
      expect(decoded.value.credentialRef).toEqual(CURSOR_CLOUD_CREDENTIAL_REFERENCE);
      expect(decoded.value.credentialRef.name).toBe(CURSOR_CLOUD_CREDENTIAL_ENV_NAME);
    }
  });

  it("maps durable agent status separately from per-run status", () => {
    expect(mapCursorAgentStatus("ACTIVE")).toBe("running");
    expect(mapCursorAgentStatus("IDLE")).toBe("idle");
    expect(mapCursorAgentStatus("ARCHIVED")).toBe("finished");
    expect(mapCursorRunStatus("CREATING")).toBe("creating");
    expect(mapCursorRunStatus("RUNNING")).toBe("running");
    expect(mapCursorRunStatus("FINISHED")).toBe("finished");
    expect(mapCursorRunStatus("ERROR")).toBe("error");
    expect(mapCursorRunStatus("CANCELLED")).toBe("cancelled");
    expect(mapCursorRunStatus("EXPIRED")).toBe("expired");
    expect(isCursorCloudRunActive("RUNNING")).toBe(true);
    expect(isCursorCloudRunActive("FINISHED")).toBe(false);
    expect(isCursorCloudRunTerminal("FINISHED")).toBe(true);
    expect(isCursorCloudRunTerminal("CANCELLED")).toBe(true);
    expect(isCursorCloudRunTerminal("RUNNING")).toBe(false);
  });

  it("rejects a credential value on the persisted binding", () => {
    const withValue = {
      ...emptyCursorCloudBinding({
        provider,
        model: "composer-2",
        target: namedEnvironmentTarget,
        at,
      }),
      credentialRef: {
        kind: "env",
        name: CURSOR_CLOUD_CREDENTIAL_ENV_NAME,
        value: "crsr_this_is_not_a_real_key",
      },
    };
    expect(runnerBindingOmitsCredentialValue(withValue)).toBe(false);
    expect(Exit.isFailure(decodeCursorCloudRunnerBinding(withValue))).toBe(true);
    expect(
      runnerBindingOmitsCredentialValue(
        emptyCursorCloudBinding({
          provider,
          model: "composer-2",
          target: namedEnvironmentTarget,
          at,
        }),
      ),
    ).toBe(true);
  });

  it("keeps the immutable dispatch payload free of secrets", () => {
    const payload = Schema.decodeSync(CursorCloudImmutableDispatchPayload)({
      runnerKind: "cursor-cloud",
      provider,
      model: "composer-2",
      target: repositoryTarget,
      workOnCurrentBranch: false,
      autoCreatePR: false,
      credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
    });
    expect(JSON.stringify(payload)).not.toMatch(/crsr_|Bearer [A-Za-z0-9_-]{8,}|sk-[a-z0-9]/i);
    expect(JSON.stringify(payload)).not.toContain('"value"');
    expect(payload.credentialRef).toEqual({ kind: "env", name: "CURSOR_API_KEY" });
  });

  it("decodes a Phase 5 attempt without a runner binding", () => {
    const attempt = decodeAttempt({
      stageId: "research",
      attempt: 1,
      profileId: "researcher",
      profileVersion: 1,
      sourceThreadId: null,
      sourceMessageId: null,
      sourceTurnId: null,
      destinationThreadId: null,
      destinationMessageId: null,
      destinationTurnId: null,
      routeBinding: null,
      status: "pending",
      createdAt: at,
    });
    expect(Exit.isSuccess(attempt)).toBe(true);
    if (Exit.isSuccess(attempt)) {
      expect(attempt.value.runnerBinding).toBeUndefined();
    }
  });

  it("leaves the compact Phase 5 route binding unchanged", () => {
    const binding = decodeRouteBinding({
      policyVersion: "dispatcher.phase-1a.v1",
      target: { instanceId: "codex_work", model: "gpt-5.4" },
      driver: "codex",
      modelFamily: "openai",
      fallbackIndex: 0,
      source: "explicit",
      gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] } satisfies ActionGateResult,
    });
    expect(Exit.isSuccess(binding)).toBe(true);
    if (Exit.isSuccess(binding)) {
      expect(Object.keys(binding.value).sort()).toEqual([
        "driver",
        "fallbackIndex",
        "gate",
        "modelFamily",
        "policyVersion",
        "source",
        "target",
      ]);
    }
  });

  it("rejects oversized or malformed runner identities", () => {
    expect(
      Exit.isFailure(
        decodeBinding({
          ...emptyCursorCloudBinding({
            provider,
            model: "composer-2",
            target: namedEnvironmentTarget,
            at,
          }),
          cursorAgentId: "bc " + "x".repeat(200),
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeCursorCloudExecutionTarget({ mode: "pool" }))).toBe(true);
  });
});
