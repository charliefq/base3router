import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  emptyOpenRouterObservation,
  type DispatcherRouteDecision,
  type DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { presentOperationalInspector } from "./presentOperationalInspector";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

const decision: DispatcherRouteDecision = {
  policyVersion: "dispatcher.phase-1a.v1",
  environmentId,
  actionKind: "workspace-write",
  projectResolution: {
    status: "resolved",
    source: "project-id",
    projectId,
    reasonCodes: [],
  },
  context: {
    threadId: null,
    messageId: null,
    hasPersistedMessage: false,
    attachmentCount: 0,
    composerContextKinds: [],
  },
  candidates: [
    {
      fallbackIndex: 0,
      target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      driver: ProviderDriverKind.make("codex"),
      modelFamily: "openai",
      source: "explicit",
      eligible: true,
      reasonCodes: [],
    },
    {
      fallbackIndex: 1,
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
      driver: ProviderDriverKind.make("claude"),
      modelFamily: "anthropic",
      source: "provider-default",
      eligible: true,
      reasonCodes: [],
    },
  ],
  selected: {
    fallbackIndex: 0,
    target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    driver: ProviderDriverKind.make("codex"),
    modelFamily: "openai",
    source: "explicit",
    eligible: true,
    reasonCodes: [],
  },
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};

const boundRoute: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
  driver: ProviderDriverKind.make("claude"),
  modelFamily: "anthropic",
  fallbackIndex: 0,
  source: "explicit",
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};

it("shows a provisional route before submission", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Draft the dispatcher note",
    gitBranch: "cursor/phase-7",
    sessionStatus: null,
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "success", decision },
    boundRoute: null,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.route.kind).toBe("provisional");
  expect(model.route.model).toBe("gpt-5.4");
  expect(model.route.fallbacks[0]?.model).toBe("claude-sonnet-4-6");
  expect(model.runnerKind).toBe("local");
  expect(model.route.gateDecision).toBe("ALLOW");
});

it("shows an immutable bound route after submission", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Draft the dispatcher note",
    gitBranch: "cursor/phase-7",
    sessionStatus: "running",
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "success", decision },
    boundRoute,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.route.kind).toBe("bound");
  expect(model.route.model).toBe("claude-sonnet-4-6");
  expect(model.route.reason).toContain("Persisted");
  expect(model.route.fallbacks).toEqual([]);
});

it("presents a bound Auto Route trace without secret-shaped values", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Draft the dispatcher note",
    gitBranch: "cursor/phase-8",
    sessionStatus: "running",
    sessionError: null,
    capabilities: { dispatcher: false, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute: {
      ...boundRoute,
      modelRoute: {
        policyVersion: "model-router.v0",
        mode: "auto",
        task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
        policy: {
          version: "model-router.v0",
          qualityWeight: 1,
          costWeight: 1,
          latencyWeight: 1,
        },
        selected: {
          fallbackIndex: 0,
          target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
          driver: ProviderDriverKind.make("claudeAgent"),
          capabilities: ["code", "tools"],
          eligible: true,
          reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
          preferredDefault: true,
          metrics: {
            quality: { status: "unknown" },
            costUsd: { status: "unknown" },
            latencyMs: { status: "unknown" },
          },
        },
        fallbacks: [],
        candidates: [],
        reasonCodes: ["SELECTED", "PREFERRED_DEFAULT", "METRICS_UNKNOWN"],
        explanation:
          "Auto Route selected claude · claude-sonnet-4-6 because it is the configured default.",
        estimatedCostUsd: { status: "unknown" },
        estimatedLatencyMs: { status: "unknown" },
        estimatedQuality: { status: "unknown" },
        executionStatus: "bound",
      },
    },
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.route.mode).toBe("auto");
  expect(model.route.policyVersion).toBe("model-router.v0");
  expect(model.route.reasonCodes).toContain("SELECTED");
  expect(model.route.estimatedCostUsd).toEqual({ status: "unknown" });
  expect(model.route.executionStatus).toBe("running");
  expect(model.route.attempts).toEqual([]);
  expect(JSON.stringify(model)).not.toContain("sk-");
  expect(JSON.stringify(model)).not.toContain("Bearer ");
});

it("presents sanitized Auto Route attempt history after failover", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Draft the dispatcher note",
    gitBranch: "cursor/phase-8",
    sessionStatus: "running",
    sessionError: null,
    capabilities: { dispatcher: false, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute: {
      ...boundRoute,
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
      modelRoute: {
        policyVersion: "model-router.v0",
        mode: "auto",
        task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
        policy: {
          version: "model-router.v0",
          qualityWeight: 1,
          costWeight: 1,
          latencyWeight: 1,
        },
        selected: {
          fallbackIndex: 0,
          target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
          driver: ProviderDriverKind.make("codex"),
          capabilities: ["code", "tools"],
          eligible: true,
          reasonCodes: ["SELECTED"],
          preferredDefault: false,
          metrics: {
            quality: { status: "unknown" },
            costUsd: { status: "unknown" },
            latencyMs: { status: "unknown" },
          },
        },
        fallbacks: [],
        candidates: [],
        reasonCodes: ["SELECTED", "FALLBACK_ATTEMPTED"],
        explanation: "Auto Route selected codex · gpt-5.5.",
        estimatedCostUsd: { status: "unknown" },
        estimatedLatencyMs: { status: "unknown" },
        estimatedQuality: { status: "unknown" },
        executionStatus: "running",
        attemptBudget: 3,
        executed: {
          fallbackIndex: 1,
          target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
          driver: ProviderDriverKind.make("claudeAgent"),
          capabilities: ["code", "tools"],
          eligible: true,
          reasonCodes: [],
          preferredDefault: false,
          metrics: {
            quality: { status: "unknown" },
            costUsd: { status: "unknown" },
            latencyMs: { status: "unknown" },
          },
        },
        attempts: [
          {
            attempt: 1,
            target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
            driver: ProviderDriverKind.make("codex"),
            outcome: "failed",
            failureCategory: "usage_quota_exhausted",
            failureScope: "provider_instance",
            fallbackAllowed: true,
            nextTarget: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-sonnet-4-6",
            },
            detail: "[redacted]",
          },
        ],
      },
    },
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.route.rerouted).toBe(true);
  expect(model.route.initialModel).toBe("gpt-5.5");
  expect(model.route.executedModel).toBe("claude-sonnet-4-6");
  expect(model.route.attemptBudget).toBe(3);
  expect(model.route.attempts[0]?.failureCategory).toBe("usage_quota_exhausted");
  expect(JSON.stringify(model)).not.toContain("sk-");
  expect(JSON.stringify(model)).not.toContain("Bearer ");
});

it("labels Cursor Cloud as a runner, not a provider", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Cloud workflow",
    gitBranch: null,
    sessionStatus: "running",
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: true },
    providers: [],
    preview: { status: "idle" },
    boundRoute,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: {
      runnerKind: "cursor-cloud",
      provider: ProviderDriverKind.make("cursor"),
      model: "composer-2",
      target: {
        mode: "repository",
        repositoryUrl: "https://github.com/charliefq/base3router",
        startingRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      status: "running",
      cursorAgentId: "bc-11111111-1111-5111-8111-111111111111",
      cursorRunId: "run-1",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  });

  expect(model.runnerKind).toBe("cursor-cloud");
  expect(model.cursorCloud?.agentId).toBe("bc-11111111-1111-5111-8111-111111111111");
  expect(JSON.stringify(model)).not.toContain("CURSOR_API_KEY=");
  expect(JSON.stringify(model)).not.toContain("sk-");
});

it("redacts secret-shaped session errors", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Investigate",
    gitBranch: null,
    sessionStatus: "error",
    sessionError: "Authorization: Bearer sk-secret-token",
    capabilities: { dispatcher: true, workflow: false, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.error).toBe("[redacted]");
});

it("keeps a usable capability-off empty state", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: null,
    gitBranch: null,
    sessionStatus: null,
    sessionError: null,
    capabilities: { dispatcher: false, workflow: false, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute: null,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.emptyReason).toBe("capability-off");
  expect(model.route.kind).toBe("unavailable");
  expect(model.runnerKind).toBe("unavailable");
});

it("shows no-selection when nothing is bound in the workspace", () => {
  const model = presentOperationalInspector({
    selected: false,
    projectTitle: null,
    taskObjective: null,
    gitBranch: null,
    sessionStatus: null,
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: true },
    providers: [],
    preview: { status: "idle" },
    boundRoute: null,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.emptyReason).toBe("no-selection");
});

it("presents sanitized OpenRouter Teacher observations without prompt text", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Draft the dispatcher note",
    gitBranch: "cursor/phase-7",
    sessionStatus: "running",
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute: {
      ...boundRoute,
      openRouter: {
        ...emptyOpenRouterObservation({
          guidanceMode: "teacher",
          status: "observed",
          allowedModels: ["anthropic/claude-sonnet-4.5"],
        }),
        openRouterSuggested: "anthropic/claude-sonnet-4.5",
        actualExecutionModel: "anthropic/claude-sonnet-4.5",
        requestedRouterTarget: "openrouter/auto",
        nestedFallbacks: [
          {
            origin: "openrouter_internal",
            provider: "Anthropic",
            model: "anthropic/claude-sonnet-4.5",
            status: 200,
          },
        ],
      },
    },
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
  });

  expect(model.openRouter?.mode).toBe("teacher");
  expect(model.openRouter?.actualModel).toBe("anthropic/claude-sonnet-4.5");
  expect(model.openRouter?.nestedFallbacks[0]).toContain("openrouter_internal");
  expect(JSON.stringify(model.openRouter)).not.toContain("sk-");
  expect(JSON.stringify(model.openRouter)).not.toContain("Draft the dispatcher note");
});

it("presents catalog freshness timestamps from runtime capability state", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Draft the dispatcher note",
    gitBranch: "cursor/phase-7",
    sessionStatus: "running",
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute: {
      ...boundRoute,
      openRouter: emptyOpenRouterObservation({
        guidanceMode: "shadow",
        status: "observed",
      }),
    },
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
    openRouterPriors: { freshness: "stale", asOf: "2026-06-17" },
  });

  expect(model.openRouter?.freshness).toBe("stale");
  expect(model.openRouter?.asOf).toBe("2026-06-17");
});

it("projects Skill Route, MCP Route, ActionGate, and approval independently of Route Gate", () => {
  const model = presentOperationalInspector({
    selected: true,
    projectTitle: "Portfolio",
    taskObjective: "Inspect a planned tool action",
    gitBranch: "cursor/phase-12",
    sessionStatus: "idle",
    sessionError: null,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    providers: [],
    preview: { status: "idle" },
    boundRoute: boundRoute,
    workflowRun: null,
    workflowTemplate: null,
    cursorCloudBinding: null,
    skillRoute: {
      policyVersion: "skill-router.v0",
      selected: null,
      mode: "auto",
      reasonCodes: ["NO_SKILLS_CONFIGURED"],
      filteredReasonCodes: [],
      eligibleCount: 0,
      explanation: "No skills are configured. Continuing without a skill.",
      tieBreak: "skillId lexicographic",
    },
    mcpRoute: {
      policyVersion: "mcp-router.v0",
      selected: "t3-preview/preview_status",
      server: "t3-preview",
      mode: "auto",
      reasonCodes: ["SELECTED"],
      filteredReasonCodes: ["PROMPT_INJECTION_SHAPED"],
      eligibleCount: 1,
      explanation: "Selected t3-preview/preview_status by mcp-router.v0 tie-break.",
      tieBreak: "toolId lexicographic",
    },
    executionPlan: {
      planId: "plan-1",
      actionCount: 1,
      policyVersions: "action-gate.v0",
      expiresAt: null,
    },
    actionGate: {
      decision: "ALLOW",
      riskClass: "read-only-local",
      reasonCodes: ["ACTION_ALLOWED"],
      fingerprint: "deadbeef",
    },
    approval: null,
    toolExecution: {
      status: "succeeded",
      retry: "none",
      circuit: "closed",
      fallback: "none",
    },
    outcome: {
      classification: "success",
      evidence: "Measured local preview_status.",
    },
  });

  expect(model.skillRoute?.selected).toBeNull();
  expect(model.mcpRoute?.selected).toBe("t3-preview/preview_status");
  expect(model.actionGate?.decision).toBe("ALLOW");
  expect(model.route.gateDecision).toBe("ALLOW");
  expect(model.outcome?.classification).toBe("success");
});
