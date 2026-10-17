// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskOccurrence,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  toggle: vi.fn(),
  run: vi.fn(),
  remove: vi.fn(),
  environment: {
    environmentId: "test-environment",
    label: "Computer",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: { machine: "linux" } } },
  },
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    scheduledTasksLive: () => "tasks",
    setScheduledTaskEnabled: "toggle",
    runScheduledTaskNow: "run",
    deleteScheduledTask: "remove",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "toggle" | "run" | "remove") => state[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: state.tasks }, error: null }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [state.environment.environmentId] },
    environments: [state.environment],
    connectedEnvironments: [state.environment],
    environment: state.environment,
  }),
}));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => state.environment }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../WorktreeBaseBranchPicker", () => ({ WorktreeBaseBranchPicker: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() }, stackedThreadToast: vi.fn() }));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  useRelativeTimeTick: () => 0,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    status: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      <div>{status}</div>
      {control}
    </div>
  ),
}));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

let root: Root;
let container: HTMLDivElement;

function task(status: ScheduledTaskOccurrence["status"], reason: string | null): ScheduledTask {
  return {
    id: ScheduledTaskId.make("task"),
    title: "Daily audit",
    prompt: "Review the work",
    enabled: false,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("fake"), model: "fake" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "running",
    lastRunError: "Stale legacy error",
    runCount: 1,
    lastOccurrence: {
      id: "occurrence",
      commandId: CommandId.make("command"),
      messageId: MessageId.make("message"),
      threadId: null,
      runId: null,
      status,
      blockedReason: reason,
      lastEventSequence: 0,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.toggle.mockClear();
  state.run.mockClear();
  state.remove.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  expect(state.toggle).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
});

async function render(task: ScheduledTask) {
  state.tasks = [task];
  await act(async () => root.render(<ScheduledTasksSettings />));
}

function badge() {
  const element = container.querySelector<HTMLElement>('[data-slot="badge"]');
  if (!element) throw new Error("Scheduled task badge was not mounted");
  return element;
}

it.each([
  ["dispatching", "Dispatching"],
  ["accepted", "Accepted · execution unconfirmed"],
  ["running", "In progress"],
  ["unknown", "Outcome unknown"],
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
] as const)("shows the precise %s badge and reason in the mounted row", async (status, label) => {
  await render(task(status, "Occurrence detail"));
  expect(badge().textContent).toBe(label);
  expect(container.textContent).toContain("Occurrence detail");
  expect(container.textContent).not.toContain("Stale legacy error");
  expect(badge().classList.contains("text-success-foreground")).toBe(status === "succeeded");
  expect(badge().classList.contains("text-warning-foreground")).toBe(status === "unknown");
  expect(badge().classList.contains("text-destructive-foreground")).toBe(status === "failed");
});

it.each([
  ["succeeded", "Succeeded", null],
  ["failed", "Failed", "Worker failed"],
  ["cancelled", "Cancelled", "Stopped by owner"],
] as const)(
  "updates accepted to %s from live data without issuing mutations",
  async (status, label, reason) => {
    await render(task("accepted", "Waiting for execution evidence"));
    expect(badge().textContent).toBe("Accepted · execution unconfirmed");
    await render(task(status, reason));
    expect(badge().textContent).toBe(label);
    expect(container.textContent).not.toContain("Waiting for execution evidence");
    expect(container.textContent).not.toContain("Stale legacy error");
    if (reason) expect(container.textContent).toContain(reason);
    expect(badge().classList.contains("text-success-foreground")).toBe(status === "succeeded");
  },
);
