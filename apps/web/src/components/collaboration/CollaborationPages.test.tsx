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
  recover: vi.fn(),
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
        openThread: ({ payload }: { payload: { projectId: string; providerId: string } }) =>
          Effect.promise(() => state.recover(payload)),
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
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "div" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/alert", () => ({ Alert: "div", AlertDescription: "p" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: ({ onValueChange, ...props }: { onValueChange: (value: string) => void }) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)} />
  ),
  SelectTrigger: "div",
  SelectValue: "span",
  SelectPopup: "div",
  SelectItem: "option",
}));

import { AgentsPage, TasksPage } from "./CollaborationPages";

let renderer: ReactTestRenderer;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const button = () =>
  renderer.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === "Open Codex conversation")!;
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
  state.recover.mockReset().mockImplementation(async (input) =>
    bindResult({
      type: "thread.bind",
      commandId: "server-only",
      projectId: input.projectId,
      threadId: `server-thread:${input.projectId}:${input.providerId}`,
    }),
  );
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

describe("Agents server conversation recovery", () => {
  it("sends only the selected project/provider and navigates to the authoritative recovered thread", async () => {
    await mount();
    await click();
    expect(state.recover).toHaveBeenCalledWith({ projectId: "project-a", providerId: "codex" });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "environment-a", threadId: "server-thread:project-a:codex" },
    });
  });
  it("validates even an already loaded binding with the server before navigating", async () => {
    bindResult({
      type: "thread.bind",
      commandId: "old",
      projectId: "project-a",
      threadId: "stale-thread",
    });
    state.recover.mockResolvedValueOnce({
      outcome: "rejected",
      detail: "Thread archived",
      snapshot: state.snapshot,
    });
    await mount();
    await click();
    expect(state.recover).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(text()).toContain("Thread archived");
  });
  it("does not confuse the same provider's binding in another project", async () => {
    bindResult({
      type: "thread.bind",
      commandId: "old",
      projectId: "project-b",
      threadId: "thread-b",
    });
    await mount();
    await click();
    expect(state.recover).toHaveBeenCalledWith({ projectId: "project-a", providerId: "codex" });
    expect(state.navigate.mock.calls[0]![0].params.threadId).toBe("server-thread:project-a:codex");
  });
  it("admits one same-render click and holds pending through the server response", async () => {
    const response = deferred<ReturnType<typeof bindResult>>();
    state.recover.mockReturnValueOnce(response.promise);
    await mount();
    await act(async () => {
      const action = button().props.onClick;
      action();
      action();
    });
    expect(state.recover).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    await act(async () =>
      response.resolve(
        bindResult({
          type: "thread.bind",
          commandId: "server",
          projectId: "project-a",
          threadId: "recovered",
        }),
      ),
    );
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(false);
  });
  it("retries a lost response after remount without retaining page-generated IDs", async () => {
    state.recover.mockImplementationOnce(async () => {
      throw new Error("lost after commit");
    });
    await mount();
    await click();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
    await mount();
    await click();
    expect(state.recover.mock.calls[1]![0]).toEqual(state.recover.mock.calls[0]![0]);
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();
  });
  it("does not navigate an old environment response after connection selection changes", async () => {
    const response = deferred<ReturnType<typeof bindResult>>();
    state.recover.mockReturnValueOnce(response.promise);
    await mount();
    await click();
    state.environmentId = "environment-b";
    state.projects = [{ id: "project-b", title: "B", environmentId: "environment-b" }];
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () =>
      response.resolve(
        bindResult({
          type: "thread.bind",
          commandId: "server",
          projectId: "project-a",
          threadId: "old",
        }),
      ),
    );
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("ignores callbacks retained from an earlier environment or project", async () => {
    state.projects.push({ id: "project-b", title: "B", environmentId: "environment-a" });
    await mount();
    await select("project-a");
    const oldProjectClick = button().props.onClick;
    await select("project-b");
    await act(async () => oldProjectClick());
    expect(state.recover).not.toHaveBeenCalled();
    const oldEnvironmentClick = button().props.onClick;
    state.environmentId = "environment-b";
    state.projects = [{ id: "project-b", title: "B", environmentId: "environment-b" }];
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () => oldEnvironmentClick());
    expect(state.recover).not.toHaveBeenCalled();
  });
  it("does not navigate a response after unmount", async () => {
    const response = deferred<ReturnType<typeof bindResult>>();
    state.recover.mockReturnValueOnce(response.promise);
    await mount();
    await click();
    await act(async () => renderer.unmount());
    await act(async () =>
      response.resolve(
        bindResult({
          type: "thread.bind",
          commandId: "server",
          projectId: "project-a",
          threadId: "old",
        }),
      ),
    );
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("requires a selected project and a known directory before sending", async () => {
    state.projects.push({ id: "project-b", title: "B", environmentId: "environment-a" });
    const loaded = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(loaded.promise);
    await mount();
    await click();
    expect(state.recover).not.toHaveBeenCalled();
    await act(async () => loaded.resolve(state.snapshot));
    await click();
    expect(state.recover).not.toHaveBeenCalled();
    await select("project-b");
    await click();
    expect(state.recover).toHaveBeenCalledWith({ projectId: "project-b", providerId: "codex" });
  });
});

describe("Tasks loading and conversation access", () => {
  it("keeps loading distinct from a confirmed empty task list", async () => {
    const reading = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(reading.promise);
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    expect(text()).toContain("Reading cross-agent tasks.");
    expect(text()).not.toContain("No cross-agent tasks yet.");
    await act(async () => reading.resolve(state.snapshot));
    expect(text()).toContain("No cross-agent tasks yet.");
    expect(text()).not.toContain("Reading cross-agent tasks.");
  });
  it("returns a blocked task to its conversation without a command or execution grant", async () => {
    state.snapshot = {
      ...state.snapshot,
      tasks: [
        {
          id: "blocked-task",
          title: "Inspect evidence",
          projectId: "project-a",
          threadId: "bound-thread",
          state: "blocked",
          ownerAgentId: "owner",
          assigneeAgentId: "codex",
          waitReason: "Permission denied",
          acceptance: "Inspect the result",
          gateDecision: "DENY",
          correlationId: "task-correlation",
          revision: 1,
          pendingClarificationId: null,
        },
      ],
    };
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    expect(text()).toContain("DENY");
    const open = renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Open conversation"))!;
    expect(open.props.disabled).toBe(false);
    await act(async () => open.props.onClick());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "environment-a", threadId: "bound-thread" },
    });
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
});
