import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { CollaborationCommand, CollaborationSnapshot } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "environment-a",
  projects: [{ id: "project-a", title: "A", environmentId: "environment-a" }],
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "fake-model", name: "Fake", isDefault: true }],
    },
  ],
  snapshot: {
    agents: [],
    tasks: [],
    messages: [],
    realGrokbot: "NOT_CONNECTED",
    grokbotIntegration: [],
  } as CollaborationSnapshot,
  load: vi.fn(),
  create: vi.fn(),
  bind: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "environment" ? state.environmentId : state.providers),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "environment" }));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: "providers" }));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../lib/utils", () => {
  let id = 0;
  return { newThreadId: () => `thread-${++id}`, randomUUID: () => `command-${++id}` };
});
vi.mock("../../lib/runtime", async () => {
  const Effect = await import("effect/Effect");
  return { runPrimaryHttp: Effect.runPromise };
});
vi.mock("../../environments/primary/httpClient", async () => {
  const Effect = await import("effect/Effect");
  return {
    PrimaryEnvironmentHttpClient: Effect.succeed({
      collaboration: {
        snapshot: () => Effect.promise(() => state.load()),
        command: ({ payload }: { payload: CollaborationCommand }) =>
          Effect.promise(() => state.bind(payload)),
      },
    }),
  };
});
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));

import { AgentsPage } from "./CollaborationPages";

let renderer: ReactTestRenderer;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const button = () =>
  renderer.root.findAllByType("button").find((node) => node.children.includes("Codex"))!;
const click = async () => {
  await act(async () => {
    button().props.onClick();
  });
};
const text = () => JSON.stringify(renderer.toJSON());
const bindResult = (command: CollaborationCommand) => {
  state.snapshot = {
    ...state.snapshot,
    agents: [
      {
        id: "codex",
        displayName: "Codex",
        origin: "internal",
        role: "provider",
        capabilities: [],
        connection: "NOT_CONNECTED",
        availability: "waiting",
        projectId: command.projectId!,
        threadId: command.threadId!,
      },
    ],
  };
  return { outcome: "applied", snapshot: state.snapshot, gateDecision: "DENY" };
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentId = "environment-a";
  state.projects = [{ id: "project-a", title: "A", environmentId: "environment-a" }];
  state.snapshot = {
    agents: [],
    tasks: [],
    messages: [],
    realGrokbot: "NOT_CONNECTED",
    grokbotIntegration: [],
  };
  state.load.mockReset().mockImplementation(async () => state.snapshot);
  state.create.mockReset().mockResolvedValue({ _tag: "Success" });
  state.bind.mockReset().mockImplementation(async (command) => bindResult(command));
  state.navigate.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => {
    renderer = create(<AgentsPage />);
  });
};
const select = async (value: string) => {
  await act(async () => renderer.root.findByType("select").props.onChange({ target: { value } }));
};

describe("Agents project thread interaction", () => {
  it("refuses a binding in another selected project before opening or creating a thread", async () => {
    bindResult({
      type: "thread.bind",
      commandId: "old",
      projectId: "project-b",
      threadId: "existing-b",
    });
    await mount();
    await click();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(text()).toContain("different project");
  });

  it("reuses a binding in the selected project without creating or binding again", async () => {
    bindResult({
      type: "thread.bind",
      commandId: "old",
      projectId: "project-a",
      threadId: "existing-a",
    });
    await mount();
    await click();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "environment-a", threadId: "existing-a" },
    });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
  });

  it("refuses a binding whose project is unknown", async () => {
    bindResult({ type: "thread.bind", commandId: "old", threadId: "unknown-project" });
    state.snapshot = {
      ...state.snapshot,
      agents: state.snapshot.agents.map((agent) => ({ ...agent, projectId: null })),
    };
    await mount();
    await click();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("admits one click through both deferred create and bind, including clicks before rerender", async () => {
    const creation = deferred<{ _tag: string }>();
    const binding = deferred<ReturnType<typeof bindResult>>();
    state.create.mockReturnValue(creation.promise);
    state.bind.mockReturnValue(binding.promise);
    await mount();
    await act(async () => {
      const onClick = button().props.onClick;
      onClick();
      onClick();
    });
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    await act(async () => creation.resolve({ _tag: "Success" }));
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.bind).toHaveBeenCalledTimes(1);
    await act(async () => binding.resolve(bindResult(state.bind.mock.calls[0]![0])));
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(false);
  });

  it("retries a failed binding using the created thread and the same bind command", async () => {
    state.bind.mockImplementationOnce(async (command) => {
      bindResult(command);
      throw new Error("lost bind response after commit");
    });
    await mount();
    await click();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.bind).toHaveBeenCalledTimes(2);
    expect(state.bind.mock.calls[1]![0]).toEqual(state.bind.mock.calls[0]![0]);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("retains a created thread after an explicit bind rejection and blocks a different project", async () => {
    state.projects.push({ id: "project-b", title: "B", environmentId: "environment-a" });
    state.bind.mockResolvedValueOnce({
      outcome: "rejected",
      detail: "Provider unavailable",
      snapshot: state.snapshot,
    });
    await mount();
    await select("project-a");
    await click();
    expect(state.navigate).not.toHaveBeenCalled();
    await select("project-b");
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(text()).toContain("different project");
    await select("project-a");
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.bind.mock.calls[1]![0]).toEqual(state.bind.mock.calls[0]![0]);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("does not create while the directory is unknown", async () => {
    const loaded = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(loaded.promise);
    await mount();
    await click();
    expect(button().props.disabled).toBe(true);
    expect(state.create).not.toHaveBeenCalled();
    await act(async () => loaded.resolve(state.snapshot));
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("releases pending after a thrown create error and retries the identical request", async () => {
    state.create.mockRejectedValueOnce(new Error("transport closed"));
    await mount();
    await click();
    expect(button().props.disabled).toBe(false);
    expect(state.bind).not.toHaveBeenCalled();
    await click();
    expect(state.create.mock.calls[1]![0]).toEqual(state.create.mock.calls[0]![0]);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("does not bind or navigate in a changed environment, and resumes the original creation on return", async () => {
    const creation = deferred<{ _tag: string }>();
    state.create.mockReturnValueOnce(creation.promise);
    await mount();
    await click();
    state.environmentId = "environment-b";
    state.projects = [{ id: "project-b", title: "B", environmentId: "environment-b" }];
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () => creation.resolve({ _tag: "Success" }));
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    state.environmentId = "environment-a";
    state.projects = [{ id: "project-a", title: "A", environmentId: "environment-a" }];
    await act(async () => renderer.update(<AgentsPage />));
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.bind.mock.calls[0]![0].threadId).toBe(
      state.create.mock.calls[0]![0].input.threadId,
    );
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("keeps creation identity across a failed create response", async () => {
    state.create.mockResolvedValueOnce({ _tag: "Failure" });
    await mount();
    await click();
    expect(state.bind).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
    await click();
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.create.mock.calls[1]![0]).toEqual(state.create.mock.calls[0]![0]);
    expect(state.create.mock.calls[0]![0].input.commandId).toBeTruthy();
    expect(state.bind).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when the selected project changes while binding", async () => {
    const binding = deferred<ReturnType<typeof bindResult>>();
    state.bind.mockReturnValueOnce(binding.promise);
    await mount();
    await click();
    state.projects = [{ id: "project-b", title: "B", environmentId: "environment-a" }];
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () => binding.resolve(bindResult(state.bind.mock.calls[0]![0])));
    expect(state.navigate).not.toHaveBeenCalled();
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.bind).toHaveBeenCalledTimes(1);
  });

  it("does not continue a create into binding after the page unmounts", async () => {
    const creation = deferred<{ _tag: string }>();
    state.create.mockReturnValueOnce(creation.promise);
    await mount();
    await click();
    await act(async () => renderer.unmount());
    await act(async () => creation.resolve({ _tag: "Success" }));
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("locks project selection while creating and never navigates after selection changes during await", async () => {
    state.projects.push({ id: "project-b", title: "B", environmentId: "environment-a" });
    const creation = deferred<{ _tag: string }>();
    state.create.mockReturnValue(creation.promise);
    await mount();
    await select("project-a");
    await click();
    expect(renderer.root.findByType("select").props.disabled).toBe(true);
    // Simulate a selection changed by an external update, beyond normal disabled UI interaction.
    state.projects = state.projects.filter((project) => project.id === "project-b");
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () => creation.resolve({ _tag: "Success" }));
    expect(state.bind.mock.calls[0]![0].projectId).toBe("project-a");
    expect(state.navigate).not.toHaveBeenCalled();
    await click();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(text()).toContain("different project");
  });
});
