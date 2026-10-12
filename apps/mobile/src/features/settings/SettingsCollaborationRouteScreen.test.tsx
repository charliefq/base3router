import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { CollaborationSnapshot } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  navigate: vi.fn(),
  environments: [
    {
      environmentId: "environment-a",
      label: "Environment A",
      connection: { phase: "connected", generation: 1 },
    },
  ],
  projects: [{ id: "project-a", title: "Project A", environmentId: "environment-a" }],
  threads: [
    {
      id: "thread-a",
      environmentId: "environment-a",
      projectId: "project-a",
      archivedAt: null as string | null,
      modelSelection: { instanceId: "provider-a" },
    },
  ],
}));
vi.mock("react-native", () => ({ Pressable: "button", View: "div" }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: "main" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "section" }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
  useEnvironmentConnectionState: (id: string) => ({
    data: mocks.environments.find((entry) => entry.environmentId === id)?.connection,
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useThreadShells: () => mocks.threads,
}));
// The native runner and RegistryContext are real. Fake the query's network boundary.
vi.mock("../../state/collaboration", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const family = Atom.family((key: string) =>
    Atom.make(Effect.promise(() => mocks.read(JSON.parse(key)))),
  );
  return {
    collaborationEnvironment: { snapshot: (target: unknown) => family(JSON.stringify(target)) },
  };
});
import {
  SettingsCollaborationAgentsRouteScreen,
  SettingsCollaborationTasksRouteScreen,
} from "./SettingsCollaborationRouteScreen";

let renderer: ReactTestRenderer;
let registry: AtomRegistry.AtomRegistry;
let tasks = false;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const snapshot = (): CollaborationSnapshot => ({
  agents: [
    {
      id: "provider-a",
      displayName: "Provider A",
      origin: "internal",
      role: "provider",
      capabilities: [],
      connection: "NOT_CONNECTED",
      availability: "waiting",
      projectId: "project-a",
      threadId: "thread-a",
    },
  ],
  tasks: [
    {
      id: "task-a",
      title: "Task A",
      ownerAgentId: "principal-a",
      assigneeAgentId: "provider-a",
      projectId: "project-a",
      state: "blocked",
      waitReason: "Execution is denied",
      acceptance: "Read",
      threadId: "thread-a",
      correlationId: "thread:thread-a",
      revision: 1,
      pendingClarificationId: null,
      gateDecision: "DENY",
    },
  ],
  messages: [],
  realGrokbot: "NOT_CONNECTED",
  grokbotIntegration: [],
});
const page = () => (
  <RegistryContext.Provider value={registry}>
    {tasks ? <SettingsCollaborationTasksRouteScreen /> : <SettingsCollaborationAgentsRouteScreen />}
  </RegistryContext.Provider>
);
const buttons = () => renderer.root.findAllByType("button");
const button = (label: string) =>
  buttons().find(
    (node) =>
      node.props.accessibilityLabel === label ||
      node.findAllByType("span").some((span) => span.children.includes(label)),
  )!;
const text = () => JSON.stringify(renderer.toJSON());
const click = async (label: string) => {
  await act(async () => button(label).props.onPress());
};
const update = async () => {
  await act(async () => renderer.update(page()));
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  tasks = false;
  mocks.environments = [
    {
      environmentId: "environment-a",
      label: "Environment A",
      connection: { phase: "connected", generation: 1 },
    },
  ];
  mocks.projects = [{ id: "project-a", title: "Project A", environmentId: "environment-a" }];
  mocks.threads = [
    {
      id: "thread-a",
      environmentId: "environment-a",
      projectId: "project-a",
      archivedAt: null,
      modelSelection: { instanceId: "provider-a" },
    },
  ];
  mocks.read.mockReset().mockResolvedValue(snapshot());
  mocks.navigate.mockReset();
  await act(async () => {
    renderer = create(page());
  });
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    registry.dispose();
  });
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "reads the current project and opens only the known thread (tasks=%s)",
  async (mode) => {
    tasks = mode;
    await update();
    expect(mocks.read).not.toHaveBeenCalled();
    await click("Read / retry collaboration");
    expect(mocks.read).toHaveBeenCalledWith({
      environmentId: "environment-a",
      input: { environmentId: "environment-a", projectId: "project-a" },
    });
    await click(mode ? "Open Task A" : "Open Provider A");
    expect(mocks.navigate).toHaveBeenCalledWith("Thread", {
      environmentId: "environment-a",
      threadId: "thread-a",
    });
  },
);

it("requires explicit environment/project selection and does not show another project's records", async () => {
  mocks.environments.push({
    environmentId: "environment-b",
    label: "Environment B",
    connection: { phase: "connected", generation: 1 },
  });
  mocks.projects.push({ id: "project-b", title: "Project B", environmentId: "environment-a" });
  await update();
  expect(text()).toContain("Select a connected environment");
  expect(mocks.read).not.toHaveBeenCalled();
  await click("Environment A");
  expect(text()).toContain("Select a project");
  await click("Project B");
  await click("Read / retry collaboration");
  expect(text()).not.toContain("Provider A");
  expect(text()).toContain("No collaboration records");
});

it.each(["missing", "environment", "project", "provider", "archived", "binding"])(
  "disables a %s or mismatched binding",
  async (reason) => {
    if (reason === "missing") mocks.threads = [];
    if (reason === "environment") mocks.threads[0]!.environmentId = "environment-b";
    if (reason === "project") mocks.threads[0]!.projectId = "project-b";
    if (reason === "provider") mocks.threads[0]!.modelSelection.instanceId = "provider-b";
    if (reason === "archived") mocks.threads[0]!.archivedAt = "2026-01-01T00:00:00Z";
    if (reason === "binding")
      mocks.read.mockResolvedValue({
        ...snapshot(),
        agents: snapshot().agents.map((agent) => ({ ...agent, threadId: null })),
      });
    await click("Read / retry collaboration");
    expect(button("Open Provider A").props.disabled).toBe(true);
    await click("Open Provider A");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(text()).toContain("No matching active thread");
  },
);

it.each(["project", "environment", "connection"])(
  "ignores a delayed response and old navigation handler after %s changes",
  async (change) => {
    await click("Read / retry collaboration");
    const oldOpen = button("Open Provider A").props.onPress;
    const old = deferred<CollaborationSnapshot>();
    mocks.read.mockReturnValueOnce(old.promise);
    await click("Read / retry collaboration");
    expect(text()).toContain("Loading collaboration");
    if (change === "project")
      mocks.projects = [{ id: "project-b", title: "Project B", environmentId: "environment-a" }];
    if (change === "environment") {
      mocks.environments = [
        {
          environmentId: "environment-b",
          label: "Environment B",
          connection: { phase: "connected", generation: 1 },
        },
      ];
      mocks.projects = [{ id: "project-b", title: "Project B", environmentId: "environment-b" }];
    }
    if (change === "connection") mocks.environments[0]!.connection.generation++;
    await update();
    await act(async () => {
      old.resolve(snapshot());
      oldOpen();
    });
    expect(text()).not.toContain("Provider A");
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);

it("retries an error with a fresh request and deduplicates same-render clicks", async () => {
  mocks.read.mockRejectedValueOnce(new Error("Read denied"));
  await click("Read / retry collaboration");
  expect(text()).toContain("Read denied");
  const pending = deferred<CollaborationSnapshot>();
  mocks.read.mockReturnValueOnce(pending.promise);
  await act(async () => {
    const onPress = button("Read / retry collaboration").props.onPress;
    onPress();
    onPress();
  });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(snapshot()));
  expect(text()).not.toContain("Read denied");
  expect(text()).toContain("Provider A");
});

it("does not show an old environment error in the newly selected context", async () => {
  let reject!: (reason: Error) => void;
  mocks.read.mockReturnValueOnce(
    new Promise<CollaborationSnapshot>((_resolve, fail) => {
      reject = fail;
    }),
  );
  await click("Read / retry collaboration");
  mocks.environments = [
    {
      environmentId: "environment-b",
      label: "Environment B",
      connection: { phase: "connected", generation: 1 },
    },
  ];
  mocks.projects = [{ id: "project-b", title: "Project B", environmentId: "environment-b" }];
  await update();
  await act(async () => reject(new Error("Old context denied")));
  expect(text()).not.toContain("Old context denied");
  expect(text()).not.toContain("Provider A");
  expect(mocks.navigate).not.toHaveBeenCalled();
});
