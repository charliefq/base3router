import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import { routeHybridModel, emptyLocalEvidence } from "@t3tools/shared/hybridRouter";
import { routeModel } from "@t3tools/shared/modelRouter";
import * as EffectForFixture from "effect/Effect";
import * as SchemaForFixture from "effect/Schema";
import * as SqlClientForFixture from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteForFixture from "@t3tools/shared/nodeSqliteClient";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  ProviderInstanceId,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  ProviderDriverKind,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  CollaborationTask,
  CollaborationSnapshot,
  type CollaborationCommand,
} from "@t3tools/contracts";
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
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
const encodeEvidence = SchemaForFixture.encodeSync(
  SchemaForFixture.fromJsonString(SchemaForFixture.Unknown),
);
const validateNodeFixture = SchemaForFixture.decodeUnknownEffect(
  SchemaForFixture.fromJsonString(SchemaForFixture.toCodecJson(OrchestrationV2ExecutionNode)),
);
const validateItemFixture = SchemaForFixture.decodeUnknownEffect(
  SchemaForFixture.fromJsonString(SchemaForFixture.toCodecJson(OrchestrationV2TurnItem)),
);
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
const configuredProviders = state.providers;
beforeEach(() => {
  state.providers = [...configuredProviders];
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

const savedAgentFixture = (projectId = "project-a", displayName = "Saved Codex") => ({
  id: "codex",
  displayName,
  origin: "internal" as const,
  role: "provider",
  capabilities: ["fixture"],
  connection: "NOT_CONNECTED" as const,
  availability: "working" as const,
  projectId,
  threadId: `thread:${projectId}`,
});
const agentTaskFixture = (
  projectId = "project-a",
  taskState: "running" | "completed" = "running",
) =>
  SchemaForFixture.decodeSync(CollaborationTask)({
    id: `task:${projectId}:${taskState}`,
    title: `${projectId} ${taskState} evidence`,
    ownerAgentId: "owner",
    assigneeAgentId: "codex",
    projectId,
    state: taskState,
    waitReason: null,
    acceptance: "Owner inspects",
    threadId: `thread:${projectId}`,
    correlationId: "fixture-message",
    revision: 1,
    pendingClarificationId: null,
    gateDecision: "DENY",
  });
const agentAction = () =>
  renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        typeof node.props["aria-label"] === "string" &&
        node.props["aria-label"].startsWith("Open "),
    )!;

describe("Agents saved identity continuity", () => {
  it("keeps a removed provider's saved card and tasks, then restores one card without writes", async () => {
    state.snapshot = {
      ...state.snapshot,
      agents: [savedAgentFixture()],
      tasks: [
        agentTaskFixture(),
        agentTaskFixture("project-a", "completed"),
        agentTaskFixture("project-b"),
      ],
    };
    await mount();
    const priorAction = agentAction().props.onClick;
    state.providers = [];
    await act(async () => renderer.update(<AgentsPage />));
    expect(text()).toContain("Saved Codex");
    expect(text()).toContain("Provider configuration is missing");
    expect(text()).toContain("project-a running evidence");
    expect(text()).toContain("project-a completed evidence");
    expect(text()).not.toContain("project-b running evidence");
    expect(agentAction().props.disabled).toBe(true);
    // Both the unavailable button and an earlier ready callback must use current readiness.
    await act(async () => {
      agentAction().props.onClick();
      priorAction();
    });
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    state.providers = [...configuredProviders];
    await act(async () => renderer.update(<AgentsPage />));
    expect(renderer.root.findAllByProps({ "data-agent-id": "codex" })).toHaveLength(1);
    expect(text()).toContain("Saved Codex");
    expect(text()).toContain("Provider ready");
    expect(text()).not.toContain("Provider configuration is missing");
    expect(agentAction().props.disabled).toBe(false);
    expect(state.recover).not.toHaveBeenCalled();
  });

  it("does not navigate an in-flight recovery after the provider becomes unavailable", async () => {
    state.snapshot = {
      ...state.snapshot,
      agents: [savedAgentFixture()],
      tasks: [agentTaskFixture()],
    };
    const response = deferred<ReturnType<typeof bindResult>>();
    state.recover.mockReturnValueOnce(response.promise);
    await mount();
    await act(async () => agentAction().props.onClick());
    expect(state.recover).toHaveBeenCalledTimes(1);
    state.providers = [];
    await act(async () => renderer.update(<AgentsPage />));
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
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.recover).toHaveBeenCalledTimes(1);
    expect(agentAction().props.disabled).toBe(true);
    expect(text()).toContain("Provider configuration is missing");
  });

  it.each(["running", "completed"] as const)(
    "keeps unavailable readiness distinct from historical %s ledger",
    async (taskState) => {
      state.providers = configuredProviders.map((provider) => ({ ...provider, enabled: false }));
      state.snapshot = {
        ...state.snapshot,
        agents: [savedAgentFixture()],
        tasks: [agentTaskFixture("project-a", taskState)],
      };
      await mount();
      expect(text()).toContain("Provider unavailable");
      expect(text()).toContain("Saved ledger availability:");
      expect(text()).toContain(`project-a ${taskState} evidence`);
      expect(text()).toContain(
        "Ledger state does not confirm provider execution or owner acceptance.",
      );
      expect(agentAction().props.disabled).toBe(true);
      await act(async () => agentAction().props.onClick());
      expect(state.recover).not.toHaveBeenCalled();
      expect(state.bind).not.toHaveBeenCalled();
      expect(state.create).not.toHaveBeenCalled();
    },
  );

  it("changes project associations without retaining another project's saved identity", async () => {
    state.providers = [];
    state.projects.push({ id: "project-b", title: "B", environmentId: "environment-a" });
    state.snapshot = {
      ...state.snapshot,
      agents: [savedAgentFixture(), savedAgentFixture("project-b", "Project B Codex")],
      tasks: [agentTaskFixture(), agentTaskFixture("project-b")],
    };
    await mount();
    expect(text()).not.toContain("Saved Codex");
    await select("project-a");
    expect(text()).toContain("Saved Codex");
    expect(text()).toContain("project-a running evidence");
    expect(text()).not.toContain("Project B Codex");
    await select("project-b");
    expect(text()).toContain("Project B Codex");
    expect(text()).toContain("project-b running evidence");
    expect(text()).not.toContain("Saved Codex");
    expect(text()).not.toContain("project-a running evidence");
    expect(state.recover).not.toHaveBeenCalled();
  });

  it("clears old environment rows before a same-project/id replacement snapshot arrives", async () => {
    state.providers = [];
    state.snapshot = {
      ...state.snapshot,
      agents: [savedAgentFixture()],
      tasks: [agentTaskFixture()],
    };
    await mount();
    expect(text()).toContain("Saved Codex");
    const next = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(next.promise);
    state.environmentId = "environment-b";
    state.projects = [{ id: "project-a", title: "A elsewhere", environmentId: "environment-b" }];
    await act(async () => renderer.update(<AgentsPage />));
    expect(text()).not.toContain("Saved Codex");
    expect(text()).not.toContain("project-a running evidence");
    await act(async () =>
      next.resolve({
        ...state.snapshot,
        agents: [savedAgentFixture("project-a", "Environment B Codex")],
        tasks: [],
      }),
    );
    expect(text()).toContain("Environment B Codex");
    expect(text()).not.toContain("Saved Codex");
    expect(state.recover).not.toHaveBeenCalled();
  });

  it("keeps Grokbot external and NOT_CONNECTED even if provider configuration reuses its id", async () => {
    state.providers = [{ ...configuredProviders[0]!, instanceId: "grokbot" }];
    state.snapshot = {
      ...state.snapshot,
      agents: [
        {
          ...savedAgentFixture(),
          id: "grokbot",
          displayName: "Grokbot",
          origin: "external",
          projectId: null,
          threadId: null,
        },
      ],
      tasks: [],
    };
    await mount();
    expect(text()).toContain("NOT_CONNECTED");
    expect(renderer.root.findAllByProps({ "data-agent-id": "grokbot" })).toHaveLength(0);
    expect(renderer.root.findAllByType("button")).toHaveLength(1);
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
    expect(state.recover).not.toHaveBeenCalled();
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

describe("Tasks command-ledger provenance", () => {
  it.each(["running", "blocked", "review-ready", "completed"] as const)(
    "labels %s as a ledger record independently of contract phase and acceptance",
    async (ledgerState) => {
      state.snapshot = {
        ...state.snapshot,
        tasks: [
          {
            id: "ledger-task",
            title: "Recorded work",
            ownerAgentId: "owner",
            assigneeAgentId: "codex",
            projectId: "project-a",
            threadId: "linked-thread",
            state: ledgerState,
            waitReason: null,
            acceptance: "Task note",
            correlationId: "ledger",
            revision: 1,
            pendingClarificationId: null,
            gateDecision: "DENY",
            contractReadout: {
              status: "available",
              contract: {
                revision: 2,
                goal: "Persisted contract goal",
                redirect: "Owner decides scope",
                acceptance: "Review evidence",
                brake: { maxProviderStarts: 1, stopConditions: "Stop on missing input" },
              },
              phase: "redirected",
              acceptedRevision: 1,
            },
          },
        ],
      };
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      expect(renderer.root.findAllByType("span").map((node) => node.children.join(""))).toContain(
        `Command ledger: ${ledgerState}`,
      );
      expect(text()).toContain(
        "Provider activity and terminal outcomes, plus owner/reviewer acceptance, require separate evidence.",
      );
      expect(text()).toContain(
        "Contract phase and accepted revision are separate contract records.",
      );
      expect(
        renderer.root.findByProps({ "data-task-contract-phase": "redirected" }).children.join(""),
      ).toContain("Revision 2 · redirected · accepted 1");
      expect(text()).toContain("Gate ");
      expect(text()).toContain("DENY");
      await act(async () => {
        renderer.root
          .findAllByType("button")
          .find((node) => node.children.includes("Open conversation"))!
          .props.onClick();
      });
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "environment-a", threadId: "linked-thread" },
      });
      expect(state.bind).not.toHaveBeenCalled();
      expect(state.recover).not.toHaveBeenCalled();
      expect(state.create).not.toHaveBeenCalled();
    },
  );

  it("keeps a legacy completed snapshot explicitly ledger-recorded without claiming provider or owner completion", async () => {
    state.snapshot = {
      ...state.snapshot,
      tasks: [
        {
          id: "legacy-completed",
          title: "Legacy record",
          ownerAgentId: "owner",
          assigneeAgentId: "codex",
          projectId: "project-a",
          state: "completed",
          threadId: null,
          waitReason: null,
          acceptance: "Old note",
          correlationId: "legacy",
          revision: 1,
          pendingClarificationId: null,
          gateDecision: "DENY",
        },
      ],
    };
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    expect(renderer.root.findAllByType("span").map((node) => node.children.join(""))).toContain(
      "Command ledger: completed",
    );
    expect(text()).toContain("Persisted contract readout is unavailable in this snapshot.");
    expect(text()).toContain(
      "Provider activity and terminal outcomes, plus owner/reviewer acceptance, require separate evidence.",
    );
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
});

describe("Tasks read freshness", () => {
  const snapshot = (goal: string, revision: number): CollaborationSnapshot => ({
    ...state.snapshot,
    tasks: [
      {
        id: "freshness-task",
        title: "Persisted task",
        ownerAgentId: "owner",
        assigneeAgentId: "codex",
        projectId: "project-a",
        state: "blocked",
        waitReason: "Execution not granted",
        acceptance: "Task note",
        threadId: "linked-thread",
        correlationId: "freshness",
        revision: 1,
        pendingClarificationId: null,
        gateDecision: "DENY",
        contractReadout: {
          status: "available",
          contract: {
            revision,
            goal,
            redirect: "Ask the owner",
            acceptance: "Owner reviews evidence",
            brake: { maxProviderStarts: 1, stopConditions: "Stop on missing input" },
          },
          phase: "active",
          acceptedRevision: null,
        },
      },
    ],
  });
  const mountTasks = async () => {
    await act(async () => {
      renderer = create(<TasksPage />);
    });
  };
  const refreshTasks = async () => {
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Refresh tasks"))!
        .props.onClick();
    });
  };
  const switchEnvironment = async (environmentId: string) => {
    state.environmentId = environmentId;
    await act(async () => renderer.update(<TasksPage />));
  };

  it("keeps the newer refresh when the initial read returns last", async () => {
    const initial = deferred<CollaborationSnapshot>();
    const refresh = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
    await mountTasks();
    await refreshTasks();
    await act(async () => refresh.resolve(snapshot("New revision goal", 2)));
    expect(text()).toContain("New revision goal");
    await act(async () => initial.resolve(snapshot("Old revision goal", 1)));
    expect(text()).toContain("New revision goal");
    expect(text()).not.toContain("Old revision goal");
    expect(state.load).toHaveBeenCalledTimes(2);
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "rejects an earlier environment refresh %s after A to B to A",
    async (outcome) => {
      const oldRefresh = deferred<CollaborationSnapshot>();
      state.load
        .mockResolvedValueOnce(snapshot("First A goal", 1))
        .mockReturnValueOnce(oldRefresh.promise)
        .mockResolvedValueOnce(snapshot("B goal", 2))
        .mockResolvedValueOnce(snapshot("Current A goal", 3));
      await mountTasks();
      await refreshTasks();
      await switchEnvironment("environment-b");
      await switchEnvironment("environment-a");
      expect(text()).toContain("Current A goal");
      await act(async () => {
        if (outcome === "success") oldRefresh.resolve(snapshot("Obsolete A goal", 1));
        else oldRefresh.reject(new Error("Obsolete A failure"));
      });
      expect(text()).toContain("Current A goal");
      expect(text()).not.toContain("Obsolete A");
      expect(text()).not.toContain("Task data may be stale");
      expect(state.load).toHaveBeenCalledTimes(4);
    },
  );

  it("preserves the last successful data as stale after failure and clears it on recovery", async () => {
    const failed = deferred<CollaborationSnapshot>();
    state.load
      .mockResolvedValueOnce(snapshot("Last successful goal", 1))
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce(snapshot("Recovered goal", 2));
    await mountTasks();
    await refreshTasks();
    await act(async () => failed.reject(new Error("Snapshot request failed")));
    expect(text()).toContain("Last successful goal");
    expect(text()).toContain("Snapshot request failed");
    expect(text()).toContain("Task data may be stale");
    await refreshTasks();
    expect(text()).toContain("Recovered goal");
    expect(text()).not.toContain("Last successful goal");
    expect(text()).not.toContain("Snapshot request failed");
    expect(text()).not.toContain("Task data may be stale");
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "discards a refresh %s after unmount without updating the retired component",
    async (outcome) => {
      const refresh = deferred<CollaborationSnapshot>();
      state.load
        .mockResolvedValueOnce(snapshot("Visible goal", 1))
        .mockReturnValueOnce(refresh.promise);
      await mountTasks();
      await refreshTasks();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await act(async () => renderer.unmount());
        await act(async () => {
          if (outcome === "success") refresh.resolve(snapshot("Retired goal", 2));
          else refresh.reject(new Error("Retired failure"));
        });
        expect(renderer.toJSON()).toBeNull();
        expect(errors).not.toHaveBeenCalled();
        expect(state.bind).not.toHaveBeenCalled();
        expect(state.recover).not.toHaveBeenCalled();
        expect(state.create).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    },
  );
});

it("renders the persisted SQLite contract through the server snapshot and refreshes its latest revision without dispatch", async () => {
  const fixtureStore = (await import(
    /* @vite-ignore */ new URL("../../../../server/src/collaboration/store.ts", import.meta.url)
      .href
  )) as {
    readCollaborationSnapshot: (
      sql: SqlClientForFixture.SqlClient,
      principal: string,
    ) => EffectForFixture.Effect<unknown, SchemaForFixture.SchemaError | SqlError>;
    submitCollaborationCommand: (
      sql: SqlClientForFixture.SqlClient,
      command: CollaborationCommand,
      options: { allowNewBinding: boolean },
    ) => EffectForFixture.Effect<unknown, SchemaForFixture.SchemaError | SqlError>;
  };
  const fixtureSnapshot = (sql: SqlClientForFixture.SqlClient, principal: string) =>
    fixtureStore
      .readCollaborationSnapshot(sql, principal)
      .pipe(EffectForFixture.flatMap(SchemaForFixture.decodeUnknownEffect(CollaborationSnapshot)));
  const fixtureSubmit = fixtureStore.submitCollaborationCommand;
  await EffectForFixture.runPromise(
    EffectForFixture.scoped(
      EffectForFixture.gen(function* () {
        const sql = yield* SqlClientForFixture.SqlClient;
        yield* sql`CREATE TABLE collaboration_commands (command_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)`;
        yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT,provider_instance_id TEXT,archived_at TEXT,deleted_at TEXT,payload_json TEXT NOT NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('fixture-thread','project-a','codex',NULL,NULL,'{}')`;
        yield* fixtureSubmit(
          sql,
          {
            type: "thread.bind",
            commandId: "fixture-bind",
            projectId: "project-a",
            threadId: "fixture-thread",
            agentId: "codex",
            displayName: "Codex",
            origin: "internal",
            capabilities: [],
            admissionSource: "server",
            admittedBy: "fixture-owner",
          },
          { allowNewBinding: true },
        );
        const encode = SchemaForFixture.encodeEffect(
          SchemaForFixture.fromJsonString(SchemaForFixture.Unknown),
        );
        const contract = {
          revision: 1,
          goal: "SQLite persisted goal",
          redirect: "Ask before widening scope",
          acceptance: "Owner inspects persisted result",
          brake: {
            maxProviderStarts: 2,
            stopConditions: "Stop on missing input",
            maxTokens: 900,
            maxCostUsd: 0.1,
            deadlineAt: "2026-10-14T00:00:00Z",
          },
        };
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskGovernance: "required", taskContract: contract, taskContractPhase: "active", taskAcceptedRevision: null })}`;
        state.load.mockImplementation(() =>
          EffectForFixture.runPromise(fixtureSnapshot(sql, "fixture-owner")),
        );
        yield* EffectForFixture.promise(async () => {
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          expect(text()).toContain("SQLite persisted goal");
          expect(text()).toContain("Ask before widening scope");
          expect(text()).toContain("Owner inspects persisted result");
          expect(text()).toContain("Stop on missing input");
          expect(text()).toContain("900");
          expect(text()).toContain("0.1");
          expect(
            renderer.root.findAllByProps({ "data-task-contract-phase": "active" }),
          ).toHaveLength(1);
          const updated = { ...contract, revision: 2, goal: "Latest persisted goal" };
          await EffectForFixture.runPromise(
            sql`UPDATE orchestration_v2_projection_threads SET payload_json=${await EffectForFixture.runPromise(encode({ taskGovernance: "required", taskContract: updated, taskContractPhase: "redirected", taskAcceptedRevision: null }))}`,
          );
          await act(async () => {
            renderer.root
              .findAllByType("button")
              .find((node) => node.children.includes("Refresh tasks"))!
              .props.onClick();
          });
          expect(text()).toContain("Latest persisted goal");
          expect(text()).not.toContain("SQLite persisted goal");
          expect(
            renderer.root.findAllByProps({ "data-task-contract-phase": "redirected" }),
          ).toHaveLength(1);
          expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(0);
          expect(
            renderer.root.findAllByProps({ "data-task-contract-redirect-action": "" }),
          ).toHaveLength(0);
          await act(async () => {
            renderer.root
              .findAllByType("button")
              .find((node) => node.children.includes("Open conversation"))!
              .props.onClick();
          });
          expect(state.navigate).toHaveBeenCalledWith({
            to: "/$environmentId/$threadId",
            params: { environmentId: "environment-a", threadId: "fixture-thread" },
          });
          expect(state.bind).not.toHaveBeenCalled();
          expect(state.recover).not.toHaveBeenCalled();
          expect(state.create).not.toHaveBeenCalled();
          await act(async () => renderer.unmount());
        });
      }),
    ).pipe(EffectForFixture.provide(SqliteForFixture.layer({ filename: ":memory:" }))),
  );
});

it.each(["manual", "auto", "task-debugging"] as const)(
  "renders %s SQLite routing evidence and refreshes matching execution without dispatch",
  async (mode) => {
    const fixtureStore = (await import(
      /* @vite-ignore */ new URL("../../../../server/src/collaboration/store.ts", import.meta.url)
        .href
    )) as {
      readCollaborationSnapshot: (
        sql: SqlClientForFixture.SqlClient,
        principal: string,
      ) => EffectForFixture.Effect<unknown, SchemaForFixture.SchemaError | SqlError>;
      submitCollaborationCommand: (
        sql: SqlClientForFixture.SqlClient,
        command: CollaborationCommand,
        options: { allowNewBinding: boolean },
      ) => EffectForFixture.Effect<unknown, SchemaForFixture.SchemaError | SqlError>;
    };
    const fixtureSnapshot = (sql: SqlClientForFixture.SqlClient, principal: string) =>
      fixtureStore
        .readCollaborationSnapshot(sql, principal)
        .pipe(
          EffectForFixture.flatMap(SchemaForFixture.decodeUnknownEffect(CollaborationSnapshot)),
        );
    const fixtureSubmit = fixtureStore.submitCollaborationCommand;
    await EffectForFixture.runPromise(
      EffectForFixture.scoped(
        EffectForFixture.gen(function* () {
          const sql = yield* SqlClientForFixture.SqlClient;
          yield* sql`CREATE TABLE collaboration_commands (command_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT,provider_instance_id TEXT,archived_at TEXT,deleted_at TEXT,payload_json TEXT NOT NULL)`;
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('fixture-thread','project-a','codex',NULL,NULL,'{}')`;
          yield* fixtureSubmit(
            sql,
            {
              type: "thread.bind",
              commandId: "fixture-bind",
              projectId: "project-a",
              threadId: "fixture-thread",
              agentId: "codex",
              displayName: "Codex",
              origin: "internal",
              capabilities: [],
              admissionSource: "server",
              admittedBy: "fixture-owner",
            },
            { allowNewBinding: true },
          );
          const encode = SchemaForFixture.encodeEffect(
            SchemaForFixture.fromJsonString(SchemaForFixture.Unknown),
          );
          const contract = {
            revision: 1,
            goal: "SQLite persisted goal",
            redirect: "Ask before widening scope",
            acceptance: "Owner inspects persisted result",
            brake: {
              maxProviderStarts: 2,
              stopConditions: "Stop on missing input",
              maxTokens: 900,
              maxCostUsd: 0.1,
              deadlineAt: "2026-10-14T00:00:00Z",
            },
          };
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskGovernance: "required", taskContract: contract, taskContractPhase: "active", taskAcceptedRevision: null })}`;
          yield* sql`CREATE TABLE projection_dispatcher_task_routes (thread_id TEXT, message_id TEXT, binding_json TEXT, created_at TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, provider_instance_id TEXT, status TEXT, payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT, thread_id TEXT, run_id TEXT, provider_instance_id TEXT, payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, provider_instance_id TEXT, payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, provider_thread_id TEXT, run_attempt_id TEXT, node_id TEXT, status TEXT, started_at TEXT, payload_json TEXT)`;
          const target = { instanceId: ProviderInstanceId.make("codex"), model: "selected-A" };
          const baselineDecision = routeModel({
            mode: mode === "task-debugging" ? "auto" : mode,
            manualOverride: target,
            catalog: [
              {
                ...target,
                driver: ProviderDriverKind.make("codex"),
                isDefault: true,
                capabilities: ["code"],
                availabilityReasons: [],
              },
            ],
          });
          const localTaskProfile = classifyLocalTask("debug this exception");
          const taskRoute =
            mode === "task-debugging"
              ? routeHybridModel({
                  mode: "auto",
                  activePolicyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
                  localTaskProfile,
                  catalog: [
                    {
                      ...target,
                      driver: ProviderDriverKind.make("codex"),
                      isDefault: true,
                      capabilities: ["code"],
                      availabilityReasons: [],
                    },
                  ],
                  evidenceByTarget: new Map([
                    [
                      `${target.instanceId}\u0000${target.model}`,
                      { ...emptyLocalEvidence(), successTrials: 8, successCount: 8 },
                    ],
                  ]),
                })
              : null;
          const decision = taskRoute?.decision ?? baselineDecision;
          const binding = {
            policyVersion: "dispatcher.phase-1a.v1",
            target,
            driver: "codex",
            modelFamily: "gpt",
            fallbackIndex: 0,
            source: "explicit",
            gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
            modelRoute: { ...decision, executed: decision.selected, executionStatus: "bound" },
            ...(taskRoute === null ? {} : { hybrid: taskRoute.hybrid, localTaskProfile }),
          };
          const run = {
            id: "run-1",
            threadId: "fixture-thread",
            ordinal: 1,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "configured-B" },
            userMessageId: "message-1",
            activeAttemptId: "attempt-1",
            rootNodeId: "node-1",
            providerThreadId: "provider-thread-1",
            status: "running",
          };
          const attempt = {
            id: "attempt-1",
            runId: "run-1",
            rootNodeId: "node-1",
            providerInstanceId: "codex",
            providerThreadId: "provider-thread-1",
            providerTurnId: "turn-1",
          };
          const providerThread = {
            id: "provider-thread-1",
            appThreadId: "fixture-thread",
            providerInstanceId: "codex",
          };
          const turn = {
            id: "turn-1",
            providerThreadId: "provider-thread-1",
            nodeId: "node-1",
            runAttemptId: "attempt-1",
            status: "completed",
            startedAt: "2026-10-13T00:00:00Z",
          };
          yield* sql`INSERT INTO projection_dispatcher_task_routes VALUES ('fixture-thread','message-1',${encodeEvidence(binding)},'2026-10-13T00:00:00Z')`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('run-1','fixture-thread',1,'codex','running',${encodeEvidence(run)})`;
          yield* sql`INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt-1','fixture-thread','run-1','codex',${encodeEvidence(attempt)})`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('provider-thread-1','fixture-thread','codex',${encodeEvidence(providerThread)})`;
          state.load.mockImplementation(() =>
            EffectForFixture.runPromise(fixtureSnapshot(sql, "fixture-owner")),
          );
          yield* EffectForFixture.promise(async () => {
            await act(async () => {
              renderer = create(<TasksPage />);
            });
            expect(text()).toContain(mode === "manual" ? "Manual" : "Auto");
            if (mode === "task-debugging") expect(text()).toContain("Local task debugging");
            expect(text()).toContain("Selected model");
            expect(text()).toContain("selected-A (codex)");
            expect(text()).toContain("configured-B (codex)");
            expect(text()).toContain(decision.explanation);
            expect(text()).toContain("not provider-attested");
            expect(text()).toContain("Execution evidence:");
            expect(text()).toContain("No matching provider turn is recorded.");
            expect(text()).not.toContain("Provider-turn start recorded");
            await EffectForFixture.runPromise(
              sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('turn-1','fixture-thread','provider-thread-1','attempt-1','node-1','completed',${turn.startedAt},${encodeEvidence(turn)})`,
            );
            expect(text()).toContain("SQLite persisted goal");
            expect(text()).toContain("Ask before widening scope");
            expect(text()).toContain("Owner inspects persisted result");
            expect(text()).toContain("Stop on missing input");
            expect(text()).toContain("900");
            expect(text()).toContain("0.1");
            expect(
              renderer.root.findAllByProps({ "data-task-contract-phase": "active" }),
            ).toHaveLength(1);
            const updated = { ...contract, revision: 2, goal: "Latest persisted goal" };
            await EffectForFixture.runPromise(
              sql`UPDATE orchestration_v2_projection_threads SET payload_json=${await EffectForFixture.runPromise(encode({ taskGovernance: "required", taskContract: updated, taskContractPhase: "redirected", taskAcceptedRevision: null }))}`,
            );
            await act(async () => {
              renderer.root
                .findAllByType("button")
                .find((node) => node.children.includes("Refresh tasks"))!
                .props.onClick();
            });
            expect(text()).toContain("Provider-turn start recorded");
            expect(text()).toContain("turn-1");
            expect(text()).toContain("Terminal execution is not owner acceptance.");
            state.load.mockRejectedValueOnce(new Error("Fixture refresh failed"));
            await act(async () => {
              renderer.root
                .findAllByType("button")
                .find((node) => node.children.includes("Refresh tasks"))!
                .props.onClick();
            });
            expect(text()).toContain("Fixture refresh failed");
            expect(text()).toContain("Provider-turn start recorded");
            expect(text()).toContain("Latest persisted goal");
            expect(text()).not.toContain("SQLite persisted goal");
            expect(
              renderer.root.findAllByProps({ "data-task-contract-phase": "redirected" }),
            ).toHaveLength(1);
            expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(
              0,
            );
            expect(
              renderer.root.findAllByProps({ "data-task-contract-redirect-action": "" }),
            ).toHaveLength(0);
            await act(async () => {
              renderer.root
                .findAllByType("button")
                .find((node) => node.children.includes("Open conversation"))!
                .props.onClick();
            });
            expect(state.navigate).toHaveBeenCalledWith({
              to: "/$environmentId/$threadId",
              params: { environmentId: "environment-a", threadId: "fixture-thread" },
            });
            expect(state.bind).not.toHaveBeenCalled();
            expect(state.recover).not.toHaveBeenCalled();
            expect(state.create).not.toHaveBeenCalled();
            await act(async () => renderer.unmount());
          });
        }),
      ).pipe(EffectForFixture.provide(SqliteForFixture.layer({ filename: ":memory:" }))),
    );
  },
);

it.each([
  { kind: "output", driver: "codex" },
  { kind: "output", driver: "claude" },
  { kind: "failure", driver: "codex" },
] as const)(
  "renders $driver producer-shaped SQLite $kind evidence with bounded plain text and unchanged acceptance",
  async ({ kind, driver }) => {
    state.providers = state.providers.map((provider) => ({ ...provider, driver }));
    const mode = "manual" as const;
    const fixtureStore = (await import(
      /* @vite-ignore */ new URL("../../../../server/src/collaboration/store.ts", import.meta.url)
        .href
    )) as {
      readCollaborationSnapshot: (
        sql: SqlClientForFixture.SqlClient,
        principal: string,
      ) => EffectForFixture.Effect<unknown, SchemaForFixture.SchemaError | SqlError>;
      submitCollaborationCommand: (
        sql: SqlClientForFixture.SqlClient,
        command: CollaborationCommand,
        options: { allowNewBinding: boolean },
      ) => EffectForFixture.Effect<unknown, SchemaForFixture.SchemaError | SqlError>;
    };
    const fixtureSnapshot = (sql: SqlClientForFixture.SqlClient, principal: string) =>
      fixtureStore
        .readCollaborationSnapshot(sql, principal)
        .pipe(
          EffectForFixture.flatMap(SchemaForFixture.decodeUnknownEffect(CollaborationSnapshot)),
        );
    const fixtureSubmit = fixtureStore.submitCollaborationCommand;
    await EffectForFixture.runPromise(
      EffectForFixture.scoped(
        EffectForFixture.gen(function* () {
          const sql = yield* SqlClientForFixture.SqlClient;
          yield* sql`CREATE TABLE collaboration_commands (command_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT,provider_instance_id TEXT,archived_at TEXT,deleted_at TEXT,payload_json TEXT NOT NULL)`;
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('fixture-thread','project-a','codex',NULL,NULL,'{}')`;
          yield* fixtureSubmit(
            sql,
            {
              type: "thread.bind",
              commandId: "fixture-bind",
              projectId: "project-a",
              threadId: "fixture-thread",
              agentId: "codex",
              displayName: "Codex",
              origin: "internal",
              capabilities: [],
              admissionSource: "server",
              admittedBy: "fixture-owner",
            },
            { allowNewBinding: true },
          );
          const encode = SchemaForFixture.encodeEffect(
            SchemaForFixture.fromJsonString(SchemaForFixture.Unknown),
          );
          const contract = {
            revision: 1,
            goal: "SQLite persisted goal",
            redirect: "Ask before widening scope",
            acceptance: "Owner inspects persisted result",
            brake: {
              maxProviderStarts: 2,
              stopConditions: "Stop on missing input",
              maxTokens: 900,
              maxCostUsd: 0.1,
              deadlineAt: "2026-10-14T00:00:00Z",
            },
          };
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskGovernance: "required", taskContract: contract, taskContractPhase: "active", taskAcceptedRevision: null })}`;
          yield* sql`CREATE TABLE projection_dispatcher_task_routes (thread_id TEXT, message_id TEXT, binding_json TEXT, created_at TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, provider_instance_id TEXT, status TEXT, payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT, thread_id TEXT, run_id TEXT, provider_instance_id TEXT, payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, provider_instance_id TEXT, payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, provider_thread_id TEXT, run_attempt_id TEXT, node_id TEXT, status TEXT, started_at TEXT, payload_json TEXT)`;
          const target = { instanceId: ProviderInstanceId.make("codex"), model: "selected-A" };
          const decision = routeModel({
            mode,
            manualOverride: target,
            catalog: [
              {
                ...target,
                driver: ProviderDriverKind.make(driver),
                isDefault: true,
                capabilities: ["code"],
                availabilityReasons: [],
              },
            ],
          });
          const binding = {
            policyVersion: "dispatcher.phase-1a.v1",
            target,
            driver,
            modelFamily: "gpt",
            fallbackIndex: 0,
            source: "explicit",
            gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
            modelRoute: { ...decision, executed: decision.selected, executionStatus: "bound" },
          };
          const run = {
            id: "run-1",
            threadId: "fixture-thread",
            ordinal: 1,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "configured-B" },
            userMessageId: "message-1",
            activeAttemptId: "attempt-1",
            rootNodeId: "node-1",
            providerThreadId: "provider-thread-1",
            status: "running",
          };
          const attempt = {
            id: "attempt-1",
            runId: "run-1",
            rootNodeId: "node-1",
            providerInstanceId: "codex",
            providerThreadId: "provider-thread-1",
            providerTurnId: "turn-1",
          };
          const providerThread = {
            id: "provider-thread-1",
            appThreadId: "fixture-thread",
            providerInstanceId: "codex",
          };
          const turn = {
            id: "turn-1",
            providerThreadId: "provider-thread-1",
            nodeId: "node-1",
            runAttemptId: "attempt-1",
            status: "completed",
            startedAt: "2026-10-13T00:00:00Z",
          };
          yield* sql`INSERT INTO projection_dispatcher_task_routes VALUES ('fixture-thread','message-1',${encodeEvidence(binding)},'2026-10-13T00:00:00Z')`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('run-1','fixture-thread',1,'codex','running',${encodeEvidence(run)})`;
          yield* sql`INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt-1','fixture-thread','run-1','codex',${encodeEvidence(attempt)})`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('provider-thread-1','fixture-thread','codex',${encodeEvidence(providerThread)})`;
          yield* sql`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN root_node_id TEXT`;
          yield* sql`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN provider_thread_id TEXT`;
          yield* sql`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN provider_turn_id TEXT`;
          yield* sql`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN status TEXT`;
          yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN driver TEXT`;
          yield* sql`ALTER TABLE orchestration_v2_projection_provider_turns ADD COLUMN completed_at TEXT`;
          yield* sql`CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,provider_thread_id TEXT,provider_turn_id TEXT,parent_item_id TEXT,ordinal INTEGER,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,parent_node_id TEXT,root_node_id TEXT,kind TEXT,status TEXT,provider_thread_id TEXT,provider_turn_id TEXT,started_at TEXT,completed_at TEXT,payload_json TEXT)`;
          state.load.mockImplementation(() =>
            EffectForFixture.runPromise(fixtureSnapshot(sql, "fixture-owner")),
          );
          yield* EffectForFixture.promise(async () => {
            await act(async () => {
              renderer = create(<TasksPage />);
            });
            expect(text()).toContain("Result evidence");
            expect(text()).toContain("running");
            expect(text()).toContain(
              "No attributable completed output or terminal failure is confirmed.",
            );
            expect(text()).not.toContain("Latest persisted assistant output");
            expect(text()).toContain("Manual");
            expect(text()).toContain("Selected model");
            expect(text()).toContain("selected-A (codex)");
            expect(text()).toContain("configured-B (codex)");
            expect(text()).toContain(decision.explanation);
            expect(text()).toContain("not provider-attested");
            expect(text()).toContain("Execution evidence:");
            expect(text()).toContain("No matching provider turn is recorded.");
            expect(text()).not.toContain("Provider-turn start recorded");
            const status = kind === "output" ? "completed" : "failed";
            const completedAt = "2026-10-13T00:00:01Z";
            const previewText =
              "SQLite latest output <script>neverExecute()</script> " + "x".repeat(3000);
            const itemId =
              kind === "output"
                ? `turn-item:provider:${driver}:native-item:assistant-result-1`
                : "turn-item:provider:codex:native-item:terminal-failure%3Aturn-1";
            const nodeId =
              kind === "output"
                ? `node:provider:${driver}:native-item:assistant-result-1`
                : "node-1";
            const nativeItemRef = { driver, nativeId: "assistant-result-1", strength: "strong" };
            const rootNode = {
              id: "node-1",
              threadId: "fixture-thread",
              runId: "run-1",
              parentNodeId: null,
              rootNodeId: "node-1",
              kind: "root_turn",
              status,
              countsForRun: true,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt,
            };
            const messageNode = {
              ...rootNode,
              id: nodeId,
              parentNodeId: "node-1",
              kind: "assistant_message",
              countsForRun: false,
              providerThreadId: "provider-thread-1",
              providerTurnId: "turn-1",
              nativeItemRef,
            };
            const item = {
              id: itemId,
              threadId: "fixture-thread",
              runId: "run-1",
              nodeId,
              nativeItemRef: kind === "output" ? nativeItemRef : null,
              title: null,
              startedAt: turn.startedAt,
              providerThreadId: "provider-thread-1",
              providerTurnId: "turn-1",
              parentItemId: null,
              ordinal: 1,
              status,
              completedAt,
              updatedAt: completedAt,
              ...(kind === "output"
                ? {
                    type: "assistant_message",
                    messageId: `message:provider:${driver}:native-item:assistant-result-1`,
                    text: previewText,
                    streaming: false,
                  }
                : {
                    type: "error",
                    failure: {
                      class: "provider_error",
                      code: "FIXTURE_FAILURE",
                      message: "SQLite structured terminal failure",
                      retryable: false,
                    },
                  }),
            };
            await EffectForFixture.runPromise(
              EffectForFixture.gen(function* () {
                yield* sql`UPDATE orchestration_v2_projection_runs SET status=${status},payload_json=${encodeEvidence({ ...run, status })}`;
                yield* sql`UPDATE orchestration_v2_projection_run_attempts SET root_node_id='node-1',provider_thread_id='provider-thread-1',provider_turn_id='turn-1',status=${status},payload_json=${encodeEvidence({ ...attempt, status })}`;
                yield* sql`UPDATE orchestration_v2_projection_provider_threads SET driver=${driver},payload_json=${encodeEvidence({ ...providerThread, driver })}`;
                yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('turn-1','fixture-thread','provider-thread-1','attempt-1','node-1',${status},${turn.startedAt},${encodeEvidence({ ...turn, status, completedAt })},${completedAt})`;
                yield* validateNodeFixture(encodeEvidence(rootNode));
                yield* sql`INSERT INTO orchestration_v2_projection_nodes VALUES (${rootNode.id},'fixture-thread','run-1',NULL,'node-1','root_turn',${status},NULL,NULL,${rootNode.startedAt},${completedAt},${encodeEvidence(rootNode)})`;
                if (kind === "output") {
                  yield* validateNodeFixture(encodeEvidence(messageNode));
                  yield* validateItemFixture(encodeEvidence(item));
                  yield* sql`INSERT INTO orchestration_v2_projection_nodes VALUES (${nodeId},'fixture-thread','run-1','node-1','node-1','assistant_message','completed','provider-thread-1','turn-1',${turn.startedAt},${completedAt},${encodeEvidence(messageNode)})`;
                }
                yield* sql`INSERT INTO orchestration_v2_projection_turn_items VALUES (${itemId},'fixture-thread','run-1',${nodeId},'provider-thread-1','turn-1',NULL,1,${item.type},${status},${completedAt},${encodeEvidence(item)})`;
              }),
            );
            expect(text()).toContain("SQLite persisted goal");
            expect(text()).toContain("Ask before widening scope");
            expect(text()).toContain("Owner inspects persisted result");
            expect(text()).toContain("Stop on missing input");
            expect(text()).toContain("900");
            expect(text()).toContain("0.1");
            expect(
              renderer.root.findAllByProps({ "data-task-contract-phase": "active" }),
            ).toHaveLength(1);
            const updated = { ...contract, revision: 2, goal: "Latest persisted goal" };
            await EffectForFixture.runPromise(
              sql`UPDATE orchestration_v2_projection_threads SET payload_json=${await EffectForFixture.runPromise(encode({ taskGovernance: "required", taskContract: updated, taskContractPhase: "redirected", taskAcceptedRevision: null }))}`,
            );
            await act(async () => {
              renderer.root
                .findAllByType("button")
                .find((node) => node.children.includes("Refresh tasks"))!
                .props.onClick();
            });
            expect(text()).toContain(
              kind === "output"
                ? "Latest persisted assistant output"
                : "Persisted terminal failure",
            );
            expect(text()).toContain("run-1");
            expect(text()).toContain("attempt-1");
            expect(text()).toContain(itemId);
            expect(text()).toContain("do not establish a final answer or owner acceptance");
            if (kind === "output") {
              const output = renderer.root
                .findAllByType("pre")
                .find((node) => node.children.join("").startsWith("SQLite latest output"))!;
              expect(output.children.join("")).toBe(previewText.slice(0, 2048));
              expect(output.props.dangerouslySetInnerHTML).toBeUndefined();
              expect(renderer.root.findAllByType("script")).toHaveLength(0);
              expect(text()).toContain("Preview truncated");
            } else {
              expect(text()).toContain("SQLite structured terminal failure");
              expect(text()).toContain("FIXTURE_FAILURE");
              expect(text()).not.toContain("SQLite latest output");
            }
            const resultSnapshot = await EffectForFixture.runPromise(
              fixtureSnapshot(sql, "fixture-owner"),
            );
            expect(resultSnapshot.tasks[0]?.gateDecision).toBe("DENY");
            expect(resultSnapshot.tasks[0]?.state).toBe("blocked");
            expect(
              resultSnapshot.tasks[0]?.contractReadout?.status === "available" &&
                resultSnapshot.tasks[0]?.contractReadout.acceptedRevision,
            ).toBeNull();
            expect(text()).toContain("Provider-turn start recorded");
            expect(text()).toContain("turn-1");
            expect(text()).toContain("Terminal execution is not owner acceptance.");
            state.load.mockRejectedValueOnce(new Error("Fixture refresh failed"));
            await act(async () => {
              renderer.root
                .findAllByType("button")
                .find((node) => node.children.includes("Refresh tasks"))!
                .props.onClick();
            });
            expect(text()).toContain("Fixture refresh failed");
            expect(text()).toContain("Provider-turn start recorded");
            expect(text()).toContain("Latest persisted goal");
            expect(text()).not.toContain("SQLite persisted goal");
            expect(
              renderer.root.findAllByProps({ "data-task-contract-phase": "redirected" }),
            ).toHaveLength(1);
            expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(
              0,
            );
            expect(
              renderer.root.findAllByProps({ "data-task-contract-redirect-action": "" }),
            ).toHaveLength(0);
            await act(async () => {
              renderer.root
                .findAllByType("button")
                .find((node) => node.children.includes("Open conversation"))!
                .props.onClick();
            });
            expect(state.navigate).toHaveBeenCalledWith({
              to: "/$environmentId/$threadId",
              params: { environmentId: "environment-a", threadId: "fixture-thread" },
            });
            expect(state.bind).not.toHaveBeenCalled();
            expect(state.recover).not.toHaveBeenCalled();
            expect(state.create).not.toHaveBeenCalled();
            await act(async () => renderer.unmount());
          });
        }),
      ).pipe(EffectForFixture.provide(SqliteForFixture.layer({ filename: ":memory:" }))),
    );
  },
);

it.each([
  { reason: undefined, message: "Persisted contract readout is unavailable in this snapshot." },
  { reason: "ordinary_chat", message: "Ordinary chat has no persisted task contract." },
  {
    reason: "missing_contract",
    message: "The governed thread has no complete persisted contract.",
  },
  {
    reason: "invalid_contract",
    message: "The stored contract is incomplete or unreadable; its fields cannot be confirmed.",
  },
  {
    reason: "invalid_thread_link",
    message: "No valid linked conversation is available to read a persisted contract.",
  },
] as const)("does not fabricate contract fields for $reason", async ({ reason, message }) => {
  const task = {
    id: "legacy",
    title: "Title must not become Goal",
    ownerAgentId: "owner",
    assigneeAgentId: "codex",
    projectId: "project-a",
    state: "blocked" as const,
    waitReason: null,
    acceptance: "Legacy task note, not contract acceptance",
    threadId: reason === "invalid_thread_link" ? null : "linked",
    correlationId: "legacy",
    revision: 1,
    pendingClarificationId: null,
    gateDecision: "DENY" as const,
    ...(reason === undefined
      ? {}
      : { contractReadout: { status: "unavailable" as const, reason } }),
  };
  state.snapshot = SchemaForFixture.decodeSync(CollaborationSnapshot)({
    ...state.snapshot,
    tasks: [task],
  });
  const {
    contractReadout: _projection,
    routingReadout: _routing,
    resultReadout: _result,
    ...oldTaskFields
  } = CollaborationTask.fields;
  const oldCodec = SchemaForFixture.Struct({
    ...CollaborationSnapshot.fields,
    tasks: SchemaForFixture.Array(SchemaForFixture.Struct(oldTaskFields)),
  });
  const old = SchemaForFixture.decodeSync(oldCodec)(state.snapshot);
  expect("contractReadout" in old.tasks[0]!).toBe(false);
  expect("routingReadout" in old.tasks[0]!).toBe(false);
  expect("resultReadout" in old.tasks[0]!).toBe(false);

  await act(async () => {
    renderer = create(<TasksPage />);
  });
  expect(text()).toContain(message);
  expect(text()).toContain("Routing evidence is unavailable");
  expect(text()).toContain("No validated persisted result evidence");
  expect(text()).not.toContain("fake-model");
  expect(renderer.root.findAllByProps({ "data-task-contract-goal-text": "" })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ "data-task-contract-acceptance-text": "" })).toHaveLength(
    0,
  );
  expect(
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Open conversation"))!.props.disabled,
  ).toBe(reason === "invalid_thread_link");
  expect(state.bind).not.toHaveBeenCalled();
  expect(state.recover).not.toHaveBeenCalled();
});
