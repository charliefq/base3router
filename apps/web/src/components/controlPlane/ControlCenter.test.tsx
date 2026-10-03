import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import type { ControlCenterModel } from "~/controlPlane/presentControlCenter";
import { ControlCenter } from "./ControlCenter";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

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

const empty: ControlCenterModel = {
  selectedEnvironmentId: environmentId,
  surface: "ready",
  capabilities: { dispatcher: true, workflow: true, cursorCloud: true },
  projects: [],
  recentTasks: [],
  activeRuns: [],
  approvals: [],
  failedOrCancelled: [],
  empty: true,
  capabilityOff: false,
  environmentLabel: "Lab environment",
};

it("renders the empty Control Center", async () => {
  await act(async () => {
    renderer = create(<ControlCenter model={empty} />);
  });

  expect(renderedText()).toContain("Control Center");
  expect(renderedText()).toContain("Create a project");
  expect(renderedText()).toContain("Lab environment");
});

it("renders capability-off, approvals, and terminal run states", async () => {
  await act(async () => {
    renderer = create(
      <ControlCenter
        model={{
          ...empty,
          empty: false,
          capabilityOff: true,
          projects: [{ id: projectId, environmentId, title: "Portfolio", taskCount: 3 }],
          recentTasks: [
            {
              id: ThreadId.make("thread-1"),
              environmentId,
              projectId,
              title: "Active local task",
              projectTitle: "Portfolio",
              status: "active",
              routeLabel: "codex · gpt-5.4",
              runnerKind: "local",
            },
          ],
          activeRuns: [
            {
              id: ThreadId.make("thread-2"),
              environmentId,
              projectId,
              title: "Cloud workflow",
              projectTitle: "Portfolio",
              status: "active",
              routeLabel: "cursor · composer-2",
              runnerKind: "cursor-cloud",
            },
          ],
          approvals: [
            {
              id: ThreadId.make("thread-3"),
              environmentId,
              projectId,
              title: "Needs approval",
              projectTitle: "Portfolio",
              status: "approval",
              routeLabel: null,
              runnerKind: "unknown",
            },
          ],
          failedOrCancelled: [
            {
              id: ThreadId.make("thread-4"),
              environmentId,
              projectId,
              title: "Cancelled run",
              projectTitle: "Portfolio",
              status: "cancelled",
              routeLabel: null,
              runnerKind: "local",
            },
          ],
        }}
      />,
    );
  });

  expect(renderedText()).toContain("does not advertise");
  expect(renderedText()).toContain("Active local task");
  expect(renderedText()).toContain("cursor-cloud");
  expect(renderedText()).toContain("Needs approval");
  expect(renderedText()).toContain("Cancelled run");
  expect(renderedText()).not.toContain("sk-");
});

it("renders live Router Insights counts and hides mutations without operate access", async () => {
  await act(async () => {
    renderer = create(
      <ControlCenter
        model={{
          ...empty,
          empty: false,
          routerInsights: {
            observationCount: 12,
            activePolicy: "model-router.v0",
            candidatePolicy: "hybrid-router.v1.0.0",
            candidatePolicyState: "shadow",
            insufficientData: false,
            mixedProvenance: true,
            explicitFeedback: "1/2 (insufficient, n=2)",
            reworkProxies: "0/12 (insufficient, n=12)",
            verification: "unknown",
            coverage: "12/12 (reliable, n=12)",
            freshness: "fresh",
            latency: "140 ms (n=8, insufficient)",
            reportedCost: "0.02 usd (n=8, insufficient)",
            estimatedCost: "unknown",
            canOperate: false,
            confirmation: null,
          },
        }}
      />,
    );
  });

  expect(renderedText()).toContain("12 observations");
  expect(renderedText()).toContain("1/2");
  expect(renderedText()).toContain("labeled separately");
  expect(renderedText()).not.toContain("Confirm activate");
});

it("shows destructive confirmation copy for activate, rollback, and delete", async () => {
  await act(async () => {
    renderer = create(
      <ControlCenter
        model={{
          ...empty,
          empty: false,
          routerInsights: {
            observationCount: 24,
            activePolicy: "hybrid-router.v1.0.0",
            candidatePolicy: "model-router.v0",
            insufficientData: false,
            mixedProvenance: false,
            explicitFeedback: "none recorded",
            reworkProxies: "none recorded",
            confirmation: "activate",
          },
        }}
      />,
    );
  });

  expect(renderedText()).toContain("Activate candidate");
});
