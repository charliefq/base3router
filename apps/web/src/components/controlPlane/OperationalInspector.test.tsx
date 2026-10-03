import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CursorCloudRunnerBinding,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRendererJSON, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { OperationalInspectorModel } from "~/controlPlane/presentOperationalInspector";
import { OperationalInspector } from "./OperationalInspector";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON());
}

const capabilities = { dispatcher: true, workflow: true, cursorCloud: true };

function model(overrides: Partial<OperationalInspectorModel> = {}): OperationalInspectorModel {
  return {
    projectTitle: "Portfolio",
    taskObjective: "Ship the alpha shell",
    gitBranch: "cursor/phase-7",
    sessionStatus: "running",
    capabilities,
    route: {
      kind: "provisional",
      provider: "codex",
      model: "gpt-5.4",
      source: "explicit",
      reason: "Uses your selected provider and model.",
      fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6" }],
      gateDecision: "ALLOW",
      gateReasons: ["ACTION_ALLOWED"],
      policyVersion: "model-router.v0",
      mode: "auto",
      reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
      estimatedCostUsd: { status: "unknown" },
      estimatedLatencyMs: { status: "unknown" },
      estimatedQuality: { status: "unknown" },
      executionStatus: "not-started",
      attemptBudget: 3,
      initialProvider: "codex",
      initialModel: "gpt-5.4",
      executedProvider: "codex",
      executedModel: "gpt-5.4",
      rerouted: false,
      attempts: [],
      eligibleCount: 1,
      filteredCount: 0,
      filteredReasonCodes: [],
    },
    runnerKind: "local",
    workflowName: null,
    workflowStatus: null,
    stages: [],
    cursorCloud: null,
    openRouter: null,
    hybrid: null,
    skillRoute: null,
    mcpRoute: null,
    executionPlan: null,
    actionGate: null,
    approval: null,
    toolExecution: null,
    outcome: null,
    error: null,
    emptyReason: null,
    ...overrides,
  };
}

it("renders a provisional local route", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector collapsed={false} model={model()} onToggle={() => {}} />,
    );
  });

  expect(renderedText()).toContain("Provisional route");
  expect(renderedText()).toContain("gpt-5.4");
  expect(renderedText()).toContain("Route Gate");
  expect(renderedText()).toContain("ALLOW");
  expect(renderedText()).toContain("local");
  expect(renderedText()).toContain("Auto Route");
  expect(renderedText()).toContain("model-router.v0");
  expect(renderedText()).toContain("Metrics:");
  expect(renderedText()).toContain("unknown");
  expect(renderedText()).not.toContain("sk-");
});

it("renders independent Skill Route, MCP Route, ActionGate, and approval cards", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector
        collapsed={false}
        model={model({
          skillRoute: {
            policyVersion: "skill-router.v0",
            selected: "fake-lab:review",
            mode: "auto",
            reasonCodes: ["SELECTED"],
            filteredReasonCodes: ["REQUIRED_CAPABILITY_MISSING"],
            eligibleCount: 1,
            explanation: "Selected fake-lab:review by skill-router.v0 tie-break.",
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
            planId: "plan-lab",
            actionCount: 1,
            policyVersions: "skill-router.v0 · mcp-router.v0 · action-gate.v0",
            expiresAt: "2026-10-03T00:05:00.000Z",
          },
          actionGate: {
            decision: "ASK",
            riskClass: "destructive",
            reasonCodes: ["APPROVAL_REQUIRED"],
            fingerprint: "abcd1234efgh",
          },
          approval: {
            status: "pending",
            reuse: "one-time",
            expiresAt: "2026-10-03T00:05:00.000Z",
            oneTime: true,
            actionType: "preview_evaluate",
            destination: "t3-preview",
            argumentSummary: "token=[redacted]",
          },
          toolExecution: {
            status: "paused",
            retry: "none",
            circuit: "closed",
            fallback: "none",
          },
          outcome: {
            classification: "interrupted",
            evidence: "Waiting on one-time approval.",
          },
        })}
        onToggle={() => {}}
      />,
    );
  });

  expect(renderedText()).toContain("Skill Route");
  expect(renderedText()).toContain("fake-lab:review");
  expect(renderedText()).toContain("MCP Route");
  expect(renderedText()).toContain("t3-preview/preview_status");
  expect(renderedText()).toContain("ActionGate");
  expect(renderedText()).toContain("ASK");
  expect(renderedText()).toContain("One-time");
  expect(renderedText()).toContain("Changed arguments require a new approval");
  expect(renderedText()).toContain("Route Gate");
  expect(renderedText()).not.toContain("sk-");
  expect(renderedText()).not.toContain("Bearer");
});

it("renders a bound Cursor Cloud workflow and approval state", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector
        collapsed={false}
        model={model({
          route: {
            kind: "bound",
            provider: "claude",
            model: "claude-sonnet-4-6",
            source: "explicit",
            reason: "Persisted for this task.",
            fallbacks: [],
            gateDecision: "DENY",
            gateReasons: ["PROVIDER_UNAVAILABLE"],
            policyVersion: "model-router.v0",
            mode: "manual",
            reasonCodes: ["MANUAL_OVERRIDE"],
            estimatedCostUsd: { status: "unknown" },
            estimatedLatencyMs: { status: "unknown" },
            estimatedQuality: { status: "unknown" },
            executionStatus: "failed",
            attemptBudget: 3,
            initialProvider: "claude",
            initialModel: "claude-sonnet-4-6",
            executedProvider: "claude",
            executedModel: "claude-sonnet-4-6",
            rerouted: false,
            attempts: [],
            eligibleCount: 1,
            filteredCount: 0,
            filteredReasonCodes: [],
          },
          runnerKind: "cursor-cloud",
          workflowName: "Review",
          workflowStatus: "paused",
          stages: [
            { id: "draft", label: "Draft", status: "accepted", current: false },
            { id: "gate", label: "Approve", status: "proposed", current: true },
          ],
          cursorCloud: {
            status: "running",
            agentId: "bc-11111111-1111-5111-8111-111111111111",
            runId: "run-1",
            repository: "https://github.com/charliefq/base3router",
            startingRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            branch: "cursor/output",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            pullRequestUrl: "https://github.com/charliefq/base3router/pull/9",
            result: null,
            error: null,
            followUpEnabled: false,
            cancelEnabled: true,
            refreshEnabled: true,
          },
        })}
        onToggle={() => {}}
      />,
    );
  });

  expect(renderedText()).toContain("Bound route");
  expect(renderedText()).toContain("DENY");
  expect(renderedText()).toContain("cursor-cloud");
  expect(renderedText()).toContain("Approve");
  expect(renderedText()).toContain("bc-11111111-1111-5111-8111-111111111111");
  expect(renderedText()).toContain("cursor/output");
  expect(renderedText()).not.toContain("Follow up");
  expect(renderedText()).not.toContain("CURSOR_API_KEY=");
});

const followUpReadyBinding: CursorCloudRunnerBinding = {
  runnerKind: "cursor-cloud",
  provider: ProviderDriverKind.make("cursor"),
  model: "composer-2",
  target: {
    mode: "repository",
    repositoryUrl: "https://github.com/charliefq/base3router",
    startingRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
  status: "finished",
  cursorAgentId: "bc-11111111-1111-5111-8111-111111111111",
  cursorRunId: "run-1",
  cursorAgentStatus: "IDLE",
  cursorRunStatus: "FINISHED",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

function findControl(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null | undefined,
  name: string,
): ReactTestRendererJSON | null {
  if (node == null || typeof node === "string") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findControl(child, name);
      if (found) return found;
    }
    return null;
  }
  if (node.props?.["data-control-plane"] === name) return node;
  return findControl(node.children as ReactTestRendererJSON[] | undefined, name);
}

it("calls exactly one real handler from an enabled Follow up control", async () => {
  const onFollowUp = vi.fn();
  const onCancel = vi.fn();
  const onRefresh = vi.fn();
  await act(async () => {
    renderer = create(
      <OperationalInspector
        binding={followUpReadyBinding}
        collapsed={false}
        followUp="Continue the review"
        model={model({
          runnerKind: "cursor-cloud",
          cursorCloud: {
            status: "finished",
            agentId: "bc-11111111-1111-5111-8111-111111111111",
            runId: "run-1",
            repository: null,
            startingRef: null,
            branch: null,
            commit: null,
            pullRequestUrl: null,
            result: "Done",
            error: null,
            followUpEnabled: true,
            cancelEnabled: true,
            refreshEnabled: true,
          },
        })}
        onCancel={onCancel}
        onFollowUp={onFollowUp}
        onFollowUpChange={() => {}}
        onRefresh={onRefresh}
        onToggle={() => {}}
      />,
    );
  });

  const control = findControl(renderer?.toJSON(), "inspector-follow-up");
  expect(control?.props.disabled).toBe(false);
  await act(async () => {
    control?.props.onClick();
  });
  expect(onFollowUp).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
  expect(onRefresh).not.toHaveBeenCalled();
});

it("does not render an interactive mutation when the handler is missing", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector
        binding={followUpReadyBinding}
        collapsed={false}
        followUp="Continue the review"
        model={model({
          runnerKind: "cursor-cloud",
          cursorCloud: {
            status: "finished",
            agentId: "bc-11111111-1111-5111-8111-111111111111",
            runId: "run-1",
            repository: null,
            startingRef: null,
            branch: null,
            commit: null,
            pullRequestUrl: null,
            result: null,
            error: null,
            followUpEnabled: true,
            cancelEnabled: true,
            refreshEnabled: true,
          },
        })}
        onToggle={() => {}}
      />,
    );
  });

  expect(renderedText()).toContain("Read only");
  expect(findControl(renderer?.toJSON(), "inspector-follow-up")).toBeNull();
  expect(findControl(renderer?.toJSON(), "inspector-cancel")).toBeNull();
  expect(findControl(renderer?.toJSON(), "inspector-refresh")).toBeNull();
});

it("renders capability-off, unavailable, empty, and collapsed layouts", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector
        collapsed={false}
        model={model({ emptyReason: "capability-off" })}
        onToggle={() => {}}
      />,
    );
  });
  expect(renderedText()).toContain("does not advertise");

  await act(async () => {
    renderer?.update(
      <OperationalInspector
        collapsed={false}
        model={model({ emptyReason: "no-selection" })}
        onToggle={() => {}}
      />,
    );
  });
  expect(renderedText()).toContain("No project or task is selected");

  await act(async () => {
    renderer?.update(<OperationalInspector collapsed model={model()} onToggle={() => {}} />);
  });
  expect(renderedText()).toContain("inspector-collapsed");
  expect(renderedText()).not.toContain("Provisional route");
});

it("renders sanitized Auto Route attempt history after failover", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector
        collapsed={false}
        model={model({
          route: {
            kind: "bound",
            provider: "claude",
            model: "claude-sonnet-4-6",
            source: "provider-default",
            reason: "Auto Route selected claude after Codex usage limits.",
            fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6" }],
            gateDecision: "ALLOW",
            gateReasons: ["ACTION_ALLOWED"],
            policyVersion: "model-router.v0",
            mode: "auto",
            reasonCodes: ["SELECTED", "FALLBACK_ATTEMPTED"],
            estimatedCostUsd: { status: "unknown" },
            estimatedLatencyMs: { status: "unknown" },
            estimatedQuality: { status: "unknown" },
            executionStatus: "running",
            attemptBudget: 3,
            initialProvider: "codex",
            initialModel: "gpt-5.5",
            executedProvider: "claude",
            executedModel: "claude-sonnet-4-6",
            rerouted: true,
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
            eligibleCount: 1,
            filteredCount: 1,
            filteredReasonCodes: ["PROVIDER_USAGE_LIMIT"],
          },
        })}
        onToggle={() => {}}
      />,
    );
  });

  expect(renderedText()).toContain("Rerouted from");
  expect(renderedText()).toContain("Attempt ");
  expect(renderedText()).toContain("usage_quota_exhausted");
  expect(renderedText()).toContain("Attempt budget:");
  expect(renderedText()).not.toContain("sk-");
});

it("renders OpenRouter guidance observations without raw prompts or keys", async () => {
  await act(async () => {
    renderer = create(
      <OperationalInspector
        collapsed={false}
        model={model({
          openRouter: {
            mode: "teacher",
            status: "observed",
            connection: "connected",
            privacyPolicy: "zdr_deny_collection",
            taskTag: "code:debugging",
            taskSource: "openrouter_auto",
            base3Model: "gpt-5.4",
            openRouterModel: "anthropic/claude-sonnet-4.5",
            requestedRouterTarget: "openrouter/auto",
            actualModel: "anthropic/claude-sonnet-4.5",
            agreement: "disagreement",
            skipReason: null,
            errorCategory: null,
            nestedFallbacks: [
              "openrouter_internal · Anthropic · anthropic/claude-sonnet-4.5 · 200",
            ],
            freshness: "fresh",
            asOf: "2026-06-17",
          },
        })}
        onToggle={() => {}}
      />,
    );
  });

  expect(renderedText()).toContain("OpenRouter guidance");
  expect(renderedText()).toContain("teacher");
  expect(renderedText()).toContain("code:debugging");
  expect(renderedText()).toContain("openrouter_internal");
  expect(renderedText()).not.toContain("sk-or-");
  expect(renderedText()).not.toContain("OPENROUTER_API_KEY");
});

it("renders every remaining OpenRouter skip status", async () => {
  const skipReasons = [
    "guidance_off",
    "not_configured",
    "missing_api_key",
    "consent_required",
    "likely_credentials",
    "manual_selection",
    "timeout",
    "cancelled",
    "provider_error",
    "unresolved_mapping",
    "empty_allowlist",
  ] as const;
  for (const skipReason of skipReasons) {
    await act(async () => {
      renderer?.unmount();
      renderer = create(
        <OperationalInspector
          collapsed={false}
          model={model({
            openRouter: {
              mode: skipReason === "guidance_off" ? "off" : "shadow",
              status: "skipped",
              connection: "connected",
              privacyPolicy: "zdr_deny_collection",
              taskTag: null,
              taskSource: "unknown",
              base3Model: "gpt-5.4",
              openRouterModel: null,
              requestedRouterTarget: null,
              actualModel: null,
              agreement: "inapplicable",
              skipReason,
              errorCategory: null,
              nestedFallbacks: [],
              freshness: "unknown",
              asOf: null,
            },
          })}
          onToggle={() => {}}
        />,
      );
    });
    expect(renderedText()).toContain("data-openrouter-skip");
    expect(renderedText()).toContain(skipReason);
    expect(renderedText()).not.toContain("privacy_blocked");
    expect(renderedText()).not.toContain("sk-or-");
  }
});
