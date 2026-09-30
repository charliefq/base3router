import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
  expect(renderedText()).not.toContain("CURSOR_API_KEY=");
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
