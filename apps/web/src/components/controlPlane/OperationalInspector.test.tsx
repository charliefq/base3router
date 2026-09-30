import { ProviderDriverKind, type CursorCloudRunnerBinding } from "@t3tools/contracts";
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
    },
    runnerKind: "local",
    workflowName: null,
    workflowStatus: null,
    stages: [],
    cursorCloud: null,
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
  expect(renderedText()).toContain("ActionGate");
  expect(renderedText()).toContain("ALLOW");
  expect(renderedText()).toContain("local");
  expect(renderedText()).toContain("Auto Route");
  expect(renderedText()).toContain("model-router.v0");
  expect(renderedText()).toContain("Cost:");
  expect(renderedText()).toContain("unknown");
  expect(renderedText()).not.toContain("sk-");
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
  expect(renderedText()).toContain("Select a project or task");

  await act(async () => {
    renderer?.update(<OperationalInspector collapsed model={model()} onToggle={() => {}} />);
  });
  expect(renderedText()).toContain("inspector-collapsed");
  expect(renderedText()).not.toContain("Provisional route");
});
