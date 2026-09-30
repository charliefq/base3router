import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { presentControlCenter } from "./presentControlCenter";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

const project = {
  environmentId,
  id: projectId,
  title: "Portfolio",
  updatedAt: "2026-09-30T01:00:00.000Z",
} as EnvironmentProject;

function thread(
  overrides: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId,
    updatedAt: "2026-09-30T02:00:00.000Z",
    createdAt: "2026-09-30T00:00:00.000Z",
    hasPendingApprovals: false,
    settledAt: null,
    archivedAt: null,
    session: null,
    latestRoute: undefined,
    ...overrides,
  } as EnvironmentThreadShell;
}

it("builds an empty overview from real projections", () => {
  const model = presentControlCenter({
    capabilities: { dispatcher: true, workflow: true, cursorCloud: true },
    projects: [],
    threads: [],
  });

  expect(model.empty).toBe(true);
  expect(model.recentTasks).toEqual([]);
  expect(model.capabilityOff).toBe(false);
});

it("classifies active, approval, completed, failed, and cancelled tasks", () => {
  const model = presentControlCenter({
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    projects: [project],
    threads: [
      thread({
        id: ThreadId.make("active"),
        title: "Active local task",
        session: { status: "running" } as EnvironmentThreadShell["session"],
        latestRoute: {
          messageId: "message-1" as never,
          binding: {
            policyVersion: "dispatcher.phase-1a.v1",
            target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          },
        } as EnvironmentThreadShell["latestRoute"],
      }),
      thread({
        id: ThreadId.make("approval"),
        title: "Needs approval",
        hasPendingApprovals: true,
      }),
      thread({
        id: ThreadId.make("done"),
        title: "Completed task",
        settledAt: "2026-09-30T03:00:00.000Z",
      }),
      thread({
        id: ThreadId.make("failed"),
        title: "Failed run",
        session: { status: "error" } as EnvironmentThreadShell["session"],
      }),
      thread({
        id: ThreadId.make("cancelled"),
        title: "Cancelled run",
        session: { status: "stopped" } as EnvironmentThreadShell["session"],
      }),
    ],
  });

  expect(model.projects[0]?.taskCount).toBe(5);
  expect(model.activeRuns.map((entry) => entry.id)).toEqual(["active"]);
  expect(model.approvals.map((entry) => entry.id)).toEqual(["approval"]);
  expect(model.failedOrCancelled.map((entry) => entry.id)).toEqual(["failed", "cancelled"]);
  expect(model.recentTasks.find((entry) => entry.id === "done")?.status).toBe("completed");
  expect(model.activeRuns[0]?.runnerKind).toBe("local");
  expect(model.activeRuns[0]?.routeLabel).toContain("gpt-5.4");
});

it("marks capability-off servers without inventing runs", () => {
  const model = presentControlCenter({
    capabilities: { dispatcher: false, workflow: false, cursorCloud: false },
    projects: [project],
    threads: [],
  });

  expect(model.capabilityOff).toBe(true);
  expect(model.activeRuns).toEqual([]);
  expect(model.empty).toBe(false);
});

it("redacts secret-shaped titles before they reach the dashboard", () => {
  const model = presentControlCenter({
    capabilities: { dispatcher: true, workflow: false, cursorCloud: false },
    projects: [{ ...project, title: "Bearer sk-secret-project" }],
    threads: [thread({ id: ThreadId.make("secret"), title: "Bearer sk-secret-task" })],
  });

  expect(model.projects[0]?.title).toBe("[redacted]");
  expect(model.recentTasks[0]?.title).toBe("[redacted]");
});
