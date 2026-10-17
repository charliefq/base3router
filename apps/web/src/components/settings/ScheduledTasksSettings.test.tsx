// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot, type Root } from "react-dom/client";
import { makeThreadFixture } from "../../test-fixtures";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { ThreadRouteView } from "../ThreadRouteView";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  RunId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskOccurrence,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

interface TestEnvironment {
  environmentId: string;
  label: string;
  connection: { phase: string };
  serverConfig: { environment: { platform: { machine: string } } };
}
const state = vi.hoisted(() => ({
  environments: [] as TestEnvironment[],
  tasksByEnvironment: {} as Record<string, ScheduledTask[]>,
  threads: [] as ReturnType<typeof makeThreadFixture>[],
  bootstrap: true,
  create: vi.fn(),
  send: vi.fn(),
  upsert: vi.fn(),
  clearDrops: vi.fn(),
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
    scheduledTasksLive: ({ environmentId }: { environmentId: string }) => ({
      kind: "tasks",
      environmentId,
    }),
    launchThread: "create",
    dispatchCommand: "send",
    upsertScheduledTask: "upsert",
    setScheduledTaskEnabled: "toggle",
    runScheduledTaskNow: "run",
    deleteScheduledTask: "remove",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "toggle" | "run" | "remove" | "create" | "send" | "upsert") =>
    state[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; environmentId: string }) =>
    atom?.kind === "shell"
      ? { data: { snapshot: { _tag: state.bootstrap ? "Some" : "None" } }, error: null }
      : {
          data: { tasks: state.tasksByEnvironment[atom?.environmentId] ?? state.tasks },
          error: null,
        },
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: state.environments.map((env) => env.environmentId) },
    environments: [...state.environments],
    connectedEnvironments: [...state.environments],
    environment: state.environment,
  }),
}));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => state.environment }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadRefs: () =>
    state.threads.map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
  useEnvironmentThreadRefs: (environmentId: string | null) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId && thread.deletedAt === null)
      .map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    state.threads.find(
      (thread) => thread.environmentId === ref?.environmentId && thread.id === ref.threadId,
    ) ?? null,
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { stateAtom: (environmentId: string) => ({ kind: "shell", environmentId }) },
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      getDraftIdByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
  useBackgroundDraftSubmissionPending: () => false,
  markPromotedDraftThreadByRef: (...args: unknown[]) => state.create(...args),
  finalizePromotedDraftThreadByRef: (...args: unknown[]) => state.create(...args),
}));
vi.mock("../../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: {
    getState: () => ({ clearPendingFileDropsForThread: state.clearDrops }),
  },
}));
vi.mock("../ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => false,
}));
vi.mock("../ChatView", () => ({
  default: ({ environmentId, threadId }: { environmentId: string; threadId: string }) => (
    <div data-conversation={`${environmentId}/${threadId}`}>Conversation</div>
  ),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
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

function createTestRouter() {
  const rootRoute = createRootRoute();
  const settings = createRoute({ getParentRoute: () => rootRoute, path: "/settings" });
  const conversation = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => (
      <ThreadRouteView
        target={{ kind: "server", threadRef: resolveThreadRouteRef(conversation.useParams())! }}
      />
    ),
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-existing-home="">Home</div>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([settings, conversation, home]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
}
let router: ReturnType<typeof createTestRouter>;
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

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  state.environment.environmentId = "test-environment";
  state.environments = [state.environment];
  state.tasksByEnvironment = {};
  state.threads = [];
  state.bootstrap = true;
  state.create.mockClear();
  state.send.mockClear();
  state.upsert.mockClear();
  state.clearDrops.mockClear();
  state.toggle.mockClear();
  state.run.mockClear();
  state.remove.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  router = createTestRouter();
  await router.load();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(state.create).not.toHaveBeenCalled();
  expect(state.send).not.toHaveBeenCalled();
  expect(state.upsert).not.toHaveBeenCalled();
  expect(state.toggle).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
});

async function render(task: ScheduledTask) {
  state.tasks = [task];
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>
        <ScheduledTasksSettings />
      </RouterContextProvider>,
    ),
  );
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

it.each([
  ["succeeded", "completed", "Succeeded"],
  ["failed", "failed", "Failed"],
  ["cancelled", "cancelled", "Cancelled"],
] as const)(
  "updates durable queued → running → %s evidence without mutations",
  async (status, runStatus, label) => {
    const queued = task("running", null);
    const occurrence = {
      ...queued.lastOccurrence!,
      runId: RunId.make("run"),
      runStatus: "queued" as const,
    };
    await render({ ...queued, lastOccurrence: occurrence });
    expect(badge().textContent).toBe("Queued");
    await render({ ...queued, lastOccurrence: { ...occurrence, runStatus: "running" } });
    expect(badge().textContent).toBe("Running");
    await render({ ...queued, lastOccurrence: { ...occurrence, status, runStatus } });
    expect(badge().textContent).toBe(label);
    expect(badge().classList.contains("text-success-foreground")).toBe(status === "succeeded");
    expect(badge().classList.contains("text-destructive-foreground")).toBe(status === "failed");
  },
);

it("keeps restart UNKNOWN ahead of stale queued evidence and legacy records in progress", async () => {
  const unknown = task("unknown", "Server restarted");
  await render({
    ...unknown,
    lastOccurrence: { ...unknown.lastOccurrence!, runId: RunId.make("run"), runStatus: "queued" },
  });
  expect(badge().textContent).toBe("Outcome unknown");
  expect(container.textContent).toContain("Server restarted");
  const legacy = task("running", null);
  await render({
    ...legacy,
    lastOccurrence: { ...legacy.lastOccurrence!, runId: RunId.make("run") },
  });
  expect(badge().textContent).toBe("In progress");
});

it("does not turn accepted/no-run data into queued or active execution", async () => {
  const accepted = task("accepted", null);
  await render({
    ...accepted,
    lastOccurrence: { ...accepted.lastOccurrence!, runStatus: "queued" },
  });
  expect(badge().textContent).toBe("Accepted · execution unconfirmed");
});

const OPEN_LATEST = "Open latest run conversation";
async function openLatest(index = 0) {
  const triggers = container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label^="Actions for "]',
  );
  await act(async () => triggers[index]!.click());
  expect(
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).some((element) =>
      element.textContent?.includes("Edit"),
    ),
  ).toBe(true);
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (element) => element.textContent?.includes(OPEN_LATEST),
  );
  expect(item, "Latest run action must be reachable from the mounted row menu").toBeDefined();
  await act(async () => {
    item!.click();
    await router.load();
  });
}
it.each(["succeeded", "failed"] as const)(
  "opens the exact %s occurrence conversation without mutations",
  async (status) => {
    const scheduled = task(status, null);
    await render({
      ...scheduled,
      threadId: ThreadId.make("wrong-configured-thread"),
      lastOccurrence: {
        ...scheduled.lastOccurrence!,
        threadId: ThreadId.make("exact-occurrence-thread"),
      },
    });
    expect(badge().textContent).toBe(status === "succeeded" ? "Succeeded" : "Failed");
    await openLatest();
    expect(router.history.location.pathname).toBe("/test-environment/exact-occurrence-thread");
    state.threads = [
      makeThreadFixture({
        environmentId: EnvironmentId.make("test-environment"),
        id: ThreadId.make("exact-occurrence-thread"),
      }),
    ];
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(
      container.querySelector('[data-conversation="test-environment/exact-occurrence-thread"]'),
    ).not.toBeNull();
  },
);

function occurrenceTask(
  threadId: string,
  status: ScheduledTaskOccurrence["status"] = "succeeded",
): ScheduledTask {
  const scheduled = task(status, null);
  return {
    ...scheduled,
    lastOccurrence: {
      ...scheduled.lastOccurrence!,
      id: `occurrence-${threadId}`,
      commandId: CommandId.make(`command-${threadId}`),
      messageId: MessageId.make(`message-${threadId}`),
      threadId: ThreadId.make(threadId),
      runId: RunId.make(`run-${threadId}`),
    },
  };
}
it("opens a new-thread schedule's occurrence even with no available provider", async () => {
  const scheduled = occurrenceTask("new-conversation");
  expect(scheduled.threadId).toBeNull();
  await render(scheduled);
  await openLatest();
  expect(router.history.location.pathname).toBe("/test-environment/new-conversation");
});
it("isolates same-title rows and identical thread IDs across environments", async () => {
  const first = { ...state.environment, environmentId: "first-environment" };
  const second = { ...state.environment, environmentId: "second-environment" };
  state.environments = [first, second];
  state.tasksByEnvironment[first.environmentId] = [occurrenceTask("shared-id")];
  state.tasksByEnvironment[second.environmentId] = [occurrenceTask("shared-id", "failed")];
  await render(occurrenceTask("wrong-primary-fallback"));
  await openLatest(1);
  expect(router.history.location.pathname).toBe("/second-environment/shared-id");
  await act(async () => router.navigate({ to: "/settings" }));
  await openLatest(0);
  expect(router.history.location.pathname).toBe("/first-environment/shared-id");
});
it("keeps same-title schedules in one environment tied to their own occurrence", async () => {
  const one = occurrenceTask("one"),
    two = { ...occurrenceTask("two"), id: ScheduledTaskId.make("another-task") };
  state.tasksByEnvironment[state.environment.environmentId] = [one, two];
  await render(one);
  await openLatest(1);
  expect(router.history.location.pathname).toBe("/test-environment/two");
});
it("updates occurrence A to B without retaining a stale destination, including after remount", async () => {
  await render(occurrenceTask("conversation-a"));
  const originalTrigger = container.querySelector('button[aria-label^="Actions for "]');
  await openLatest();
  expect(router.history.location.pathname).toBe("/test-environment/conversation-a");
  await act(async () => router.navigate({ to: "/settings" }));
  await render(occurrenceTask("conversation-b"));
  expect(container.querySelector('button[aria-label^="Actions for "]')).toBe(originalTrigger);
  await openLatest();
  expect(router.history.location.pathname).toBe("/test-environment/conversation-b");
  await act(async () => root.unmount());
  root = createRoot(container);
  router = createTestRouter();
  await router.load();
  await render(occurrenceTask("conversation-b"));
  await openLatest();
  expect(router.history.location.pathname).toBe("/test-environment/conversation-b");
});
it.each(["legacy", "null occurrence", "null thread"])(
  "does not offer navigation for %s or fall back to configured thread",
  async (kind) => {
    const scheduled = task("succeeded", null);
    const { lastOccurrence, ...legacy } = scheduled;
    await render({
      ...legacy,
      threadId: ThreadId.make("never-fallback"),
      ...(kind === "legacy"
        ? {}
        : { lastOccurrence: kind === "null occurrence" ? null : lastOccurrence }),
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Actions for "]')!.click(),
    );
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).some((element) =>
        element.textContent?.includes(OPEN_LATEST),
      ),
    ).toBe(false);
    expect(router.history.location.pathname).toBe("/settings");
  },
);
it.each([
  { status: "running", runStatus: "queued", label: "Queued" },
  { status: "running", runStatus: "running", label: "Running" },
  { status: "unknown", runStatus: "queued", label: "Outcome unknown" },
] as const)(
  "allows inspection of $label without changing status wording",
  async ({ status, runStatus, label }) => {
    const scheduled = occurrenceTask("inspectable", status);
    await render({ ...scheduled, lastOccurrence: { ...scheduled.lastOccurrence!, runStatus } });
    expect(badge().textContent).toBe(label);
    await openLatest();
    expect(router.history.location.pathname).toBe("/test-environment/inspectable");
    expect(badge().textContent).toBe(label);
  },
);
it.each(["missing", "deleted"] as const)(
  "hands a %s target to existing missing-thread handling without replacement or dispatch",
  async (kind) => {
    const scheduled = occurrenceTask("gone");
    const environmentId = EnvironmentId.make(state.environment.environmentId);
    state.threads = [makeThreadFixture({ environmentId, id: ThreadId.make("other") })];
    if (kind === "deleted")
      state.threads.push(
        makeThreadFixture({
          environmentId,
          id: ThreadId.make("gone"),
          deletedAt: "2026-10-17T00:00:00Z",
        }),
      );
    await render(scheduled);
    await openLatest();
    expect(router.history.location.pathname).toBe("/test-environment/gone");
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    expect(state.clearDrops).toHaveBeenCalledWith({ environmentId, threadId: "gone" });
    expect(router.history.location.pathname).toBe("/");
    expect(container.querySelector("[data-conversation]")).toBeNull();
  },
);
it("keeps an absent target empty when the environment has no other threads", async () => {
  await render(occurrenceTask("absent"));
  await openLatest();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  expect(router.history.location.pathname).toBe("/test-environment/absent");
  expect(container.querySelector("[data-conversation]")).toBeNull();
});
