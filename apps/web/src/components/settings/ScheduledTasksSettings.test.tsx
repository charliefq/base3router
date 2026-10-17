// @vitest-environment jsdom

import { act, useSyncExternalStore, type ReactNode } from "react";
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
import { Route as ChatIndexRoute } from "../../routes/_chat.index";
import * as DateTime from "effect/DateTime";
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
  projects: [] as Array<{
    environmentId: EnvironmentId;
    id: ProjectId;
    title: string;
    createdAt: DateTime.Utc;
    updatedAt: DateTime.Utc;
  }>,
  revision: 0,
  listeners: new Set<() => void>(),
  newThread: vi.fn(),
  draftWrite: vi.fn(),
  expectedDraftStarts: 0,
  draftThread: null as object | null,
  threadStarted: false,
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

function useFixtureVersion() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    () => state.revision,
  );
}
async function publishFixture() {
  await act(async () => {
    state.revision += 1;
    for (const listener of state.listeners) listener();
  });
}
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));

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
  useEnvironmentQuery: (atom: { kind: string; environmentId: string }) => {
    useFixtureVersion();
    return atom?.kind === "shell"
      ? { data: { snapshot: { _tag: state.bootstrap ? "Some" : "None" } }, error: null }
      : {
          data: { tasks: state.tasksByEnvironment[atom?.environmentId] ?? state.tasks },
          error: null,
        };
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
vi.mock("../../state/environments", () => ({
  useEnvironment: () => state.environment,
  useEnvironments: () => ({ environments: state.environments, isReady: true }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShells: () => state.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
  useThreadRefs: () =>
    state.threads.map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
  useEnvironmentThreadRefs: (environmentId: string | null) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId && thread.deletedAt === null)
      .map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) => {
    useFixtureVersion();
    return (
      state.threads.find(
        (thread) => thread.environmentId === ref?.environmentId && thread.id === ref.threadId,
      ) ?? null
    );
  },
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { stateAtom: (environmentId: string) => ({ kind: "shell", environmentId }) },
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => state.draftThread,
      getDraftIdByRef: () => (state.draftThread ? "local-reservation" : null),
      hasDraftThreadsInEnvironment: () => state.draftThread !== null,
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
  threadHasStarted: () => state.threadStarted,
}));
vi.mock("../NoProjectsHero", () => ({ NoProjectsHero: () => <div>No projects</div> }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => children,
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

function createTestRouter(history = createMemoryHistory({ initialEntries: ["/settings"] })) {
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
    component: ChatIndexRoute.options.component!,
  });
  return createRouter({
    isServer: false,
    routeTree: rootRoute.addChildren([settings, conversation, home]),
    history,
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
  vi.spyOn(ChatIndexRoute, "useRouteContext").mockReturnValue({
    authGateState: { status: "hosted-static" },
  } as never);
  state.revision = 0;
  state.listeners.clear();
  state.expectedDraftStarts = 0;
  state.draftThread = null;
  state.threadStarted = false;
  state.newThread.mockClear();
  state.draftWrite.mockClear();
  state.newThread.mockImplementation((project) => {
    state.draftWrite(project);
    return Promise.resolve(null);
  });
  const now = DateTime.makeUnsafe("2026-10-17T00:00:00Z");
  state.projects = [
    {
      environmentId: EnvironmentId.make("other-environment"),
      id: ProjectId.make("recent-project"),
      title: "Recent project in another environment",
      createdAt: now,
      updatedAt: now,
    },
  ];
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
  expect(state.newThread).toHaveBeenCalledTimes(state.expectedDraftStarts);
  expect(state.draftWrite).toHaveBeenCalledTimes(state.expectedDraftStarts);
  expect(state.create).not.toHaveBeenCalled();
  expect(state.send).not.toHaveBeenCalled();
  expect(state.upsert).not.toHaveBeenCalled();
  expect(state.toggle).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
});

async function mountRoutedView() {
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => {
    await router.load();
  });
}

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
    await mountRoutedView();
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
  "shows a %s inspection target unavailable without entering the real index draft landing",
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
    await mountRoutedView();
    expect(state.clearDrops).not.toHaveBeenCalled();
    expect(router.history.location.pathname).toBe("/test-environment/gone");
    expect(container.textContent).toContain("Conversation unavailable");
    expect(container.querySelector("[data-conversation]")).toBeNull();
  },
);
it("keeps an absent target empty when the environment has no other threads", async () => {
  await render(occurrenceTask("absent"));
  await openLatest();
  await mountRoutedView();
  expect(router.history.location.pathname).toBe("/test-environment/absent");
  expect(container.querySelector("[data-conversation]")).toBeNull();
});

it.each([false, true])(
  "preserves ordinary missing-thread navigation with foreign inspection marker=%s and proves the real index trap",
  async (foreignMarker) => {
    state.expectedDraftStarts = 1;
    state.threads = [
      makeThreadFixture({
        environmentId: EnvironmentId.make("test-environment"),
        id: ThreadId.make("other"),
      }),
    ];
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test-environment", threadId: "ordinary-missing" },
      ...(foreignMarker
        ? {
            state: {
              scheduledTaskInspection: {
                environmentId: EnvironmentId.make("other-environment"),
                threadId: ThreadId.make("ordinary-missing"),
              },
            },
          }
        : {}),
    });
    await mountRoutedView();
    expect(router.history.location.pathname).toBe("/");
    expect(state.newThread).toHaveBeenCalledWith(
      { environmentId: "other-environment", projectId: "recent-project" },
      { replace: true },
    );
  },
);
it.each([
  { kind: "missing", bootstrap: false },
  { kind: "deleted", bootstrap: false },
  { kind: "missing", bootstrap: true },
  { kind: "deleted", bootstrap: true },
] as const)(
  "does not substitute a draft when target becomes $kind, initially bootstrapped=$bootstrap",
  async ({ kind, bootstrap }) => {
    const environmentId = EnvironmentId.make("test-environment");
    state.bootstrap = bootstrap;
    state.threads = [
      makeThreadFixture({ environmentId, id: ThreadId.make("disappearing") }),
      makeThreadFixture({ environmentId, id: ThreadId.make("other") }),
    ];
    await render(occurrenceTask("disappearing"));
    await openLatest();
    await mountRoutedView();
    expect(router.history.location.pathname).toBe("/test-environment/disappearing");
    state.threads =
      kind === "missing"
        ? state.threads.filter((thread) => thread.id !== "disappearing")
        : [
            makeThreadFixture({
              environmentId,
              id: ThreadId.make("disappearing"),
              deletedAt: "2026-10-17T00:00:00Z",
            }),
            state.threads[1]!,
          ];
    state.bootstrap = true;
    await publishFixture();
    await act(async () => {
      await router.load();
    });
    expect(router.history.location.pathname).toBe("/test-environment/disappearing");
    expect(container.textContent).toContain("Conversation unavailable");
    expect(container.querySelector("[data-conversation]")).toBeNull();
  },
);

it.each(["missing", "deleted"] as const)(
  "keeps inspection safe when the target becomes %s after the click before the route mounts",
  async (kind) => {
    const environmentId = EnvironmentId.make("test-environment");
    state.threads = [
      makeThreadFixture({ environmentId, id: ThreadId.make("late-target") }),
      makeThreadFixture({ environmentId, id: ThreadId.make("other") }),
    ];
    await render(occurrenceTask("late-target"));
    await openLatest();
    state.threads =
      kind === "missing"
        ? [state.threads[1]!]
        : [
            makeThreadFixture({
              environmentId,
              id: ThreadId.make("late-target"),
              deletedAt: "2026-10-17T00:00:00Z",
            }),
            state.threads[1]!,
          ];
    await mountRoutedView();
    expect(router.history.location.pathname).toBe("/test-environment/late-target");
    expect(container.textContent).toContain("Conversation unavailable");
  },
);
it.each([false, true])(
  "never substitutes or finalizes a same-ID local draft during inspection, server exists=%s",
  async (serverExists) => {
    state.draftThread = {};
    state.threadStarted = true;
    if (serverExists)
      state.threads = [
        makeThreadFixture({
          environmentId: EnvironmentId.make("test-environment"),
          id: ThreadId.make("reserved"),
        }),
      ];
    await render(occurrenceTask("reserved"));
    await openLatest();
    await mountRoutedView();
    expect(router.history.location.pathname).toBe("/test-environment/reserved");
    if (serverExists)
      expect(
        container.querySelector('[data-conversation="test-environment/reserved"]'),
      ).not.toBeNull();
    else {
      expect(container.textContent).toContain("Conversation unavailable");
      expect(container.querySelector("[data-conversation]")).toBeNull();
    }
  },
);

it("keeps a known deleted target unavailable before bootstrap completes", async () => {
  state.bootstrap = false;
  state.threads = [
    makeThreadFixture({
      environmentId: EnvironmentId.make("test-environment"),
      id: ThreadId.make("tombstone"),
      deletedAt: "2026-10-17T00:00:00Z",
    }),
  ];
  await render(occurrenceTask("tombstone"));
  await openLatest();
  await mountRoutedView();
  expect(container.textContent).toContain("Conversation unavailable");
  expect(container.querySelector("[data-conversation]")).toBeNull();
  state.bootstrap = true;
  await publishFixture();
  expect(router.history.location.pathname).toBe("/test-environment/tombstone");
});
it("retains scoped inspection protection across a history-state reload", async () => {
  await render(occurrenceTask("not-there"));
  await openLatest();
  const location = router.history.location;
  const savedState = structuredClone(location.state);
  await act(async () => root.unmount());
  const restoredHistory = createMemoryHistory({ initialEntries: [location.href] });
  restoredHistory.replace(location.href, savedState);
  router = createTestRouter(restoredHistory);
  await router.load();
  root = createRoot(container);
  await mountRoutedView();
  expect(router.history.location.pathname).toBe("/test-environment/not-there");
  expect(container.textContent).toContain("Conversation unavailable");
});
