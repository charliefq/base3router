import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ControlCenterModel } from "~/controlPlane/presentControlCenter";
import { ControlCenter } from "./ControlCenter";

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
  capabilities: { dispatcher: true, workflow: true, cursorCloud: true },
  projects: [],
  recentTasks: [],
  activeRuns: [],
  approvals: [],
  failedOrCancelled: [],
  empty: true,
  capabilityOff: false,
};

it("renders the empty Control Center", async () => {
  await act(async () => {
    renderer = create(<ControlCenter model={empty} />);
  });

  expect(renderedText()).toContain("Control Center");
  expect(renderedText()).toContain("Create a project");
});

it("renders capability-off, approvals, and terminal run states", async () => {
  await act(async () => {
    renderer = create(
      <ControlCenter
        model={{
          ...empty,
          empty: false,
          capabilityOff: true,
          projects: [
            { id: "project-1", environmentId: "environment-1", title: "Portfolio", taskCount: 3 },
          ],
          recentTasks: [
            {
              id: "thread-1",
              environmentId: "environment-1",
              title: "Active local task",
              projectTitle: "Portfolio",
              status: "active",
              routeLabel: "codex · gpt-5.4",
              runnerKind: "local",
            },
          ],
          activeRuns: [
            {
              id: "thread-2",
              environmentId: "environment-1",
              title: "Cloud workflow",
              projectTitle: "Portfolio",
              status: "active",
              routeLabel: "cursor · composer-2",
              runnerKind: "cursor-cloud",
            },
          ],
          approvals: [
            {
              id: "thread-3",
              environmentId: "environment-1",
              title: "Needs approval",
              projectTitle: "Portfolio",
              status: "approval",
              routeLabel: null,
              runnerKind: "unknown",
            },
          ],
          failedOrCancelled: [
            {
              id: "thread-4",
              environmentId: "environment-1",
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
