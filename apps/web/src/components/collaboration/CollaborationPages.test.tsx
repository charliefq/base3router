import {
  completed as completedForFullReview,
  continuation as prepareComparisonContinuation,
  send as sendComparisonContinuation,
} from "./testkit/resultContinuationJourney";
import { readAgentsCreationAttempt } from "./agentsTaskCreationAttempt";
import { TaskOutputHandoff } from "./TaskResultHandoff";
import { acceptedHandoffSource } from "./testkit/resultHandoffJourney";
import { resultHandoffInput } from "@t3tools/shared/taskResultHandoff";
import { sha256Hex } from "@t3tools/shared/actionCanonical";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
import { prepareTask as prepareReferenceTask } from "./testkit/taskReferenceFileFixture";
import {
  taskInstructionSkillModules,
  taskInstructionSkillRef,
  taskInstructionSkillText,
} from "@t3tools/shared/taskInstructionSkills";
import { TaskCapabilityStepControls } from "./TaskCapabilityStepControls";
import {
  withCapabilityReviewFixture,
  withIntentExecutionFixture,
} from "./testkit/capabilityReviewFixture";
import { TaskFirstInstructions } from "./TaskFirstInstructions";
import { TaskInboxDrafts } from "./TaskInboxDrafts";
import { withFirstLaunchFixture } from "./testkit/firstLaunchFixture";
import { firstLaunchStorageKey, readFirstLaunchAttempt } from "./taskFirstLaunchAttempt";
import { TaskCapabilityReadout } from "./TaskCapabilityReadout";
import { planTaskCapabilities } from "@t3tools/shared/taskCapabilityPlan";
import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import { routeHybridModel, emptyLocalEvidence } from "@t3tools/shared/hybridRouter";
import { routeModel } from "@t3tools/shared/modelRouter";
import * as Option from "effect/Option";
import * as EffectForFixture from "effect/Effect";
import * as SchemaForFixture from "effect/Schema";
import * as SqlClientForFixture from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteForFixture from "@t3tools/shared/nodeSqliteClient";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  RunAttemptId,
  RunId,
  CommandId,
  ProviderInstanceId,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  ProviderDriverKind,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  CollaborationTask,
  CollaborationSnapshot,
  type CollaborationCommand,
  OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type OrchestrationV2DispatchCommandResult,
  type CollaborationCommandResult,
  type TaskContractReviewInput,
  type TaskContractReviewState,
  type TaskAutoPreviewInput,
  type TaskAutoPreviewState,
} from "@t3tools/contracts";
import { withTaskRevisionRequestFixture } from "./testkit/taskRevisionRequestFixture";
import { useComposerDraftStore } from "../../composerDraftStore";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
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
  catalog: vi.fn(),
  configurationWrite: vi.fn(),
  configurationStatus: vi.fn(),
  operate: true,
  load: vi.fn(),
  create: vi.fn(),
  bind: vi.fn(),
  recover: vi.fn(),
  navigate: vi.fn(),
  createProject: vi.fn(),
  interrupt: vi.fn(),
  startStep: vi.fn(),
  firstLaunchRead: vi.fn(),
  continuationRead: vi.fn(),
  reviewRead: vi.fn(),
  fileReview: vi.fn(),
  fileUpload: vi.fn(),
  fileRelease: vi.fn(),
  fileUploadPromise: Promise.resolve(),
  fileUploads: {} as Record<string, unknown>,
  skillReview: vi.fn(),
  reviewDecide: vi.fn(),
  readProjection: vi.fn(),
  readCreationStatus: vi.fn(),
  autoPreview: vi.fn(),
  sessionIdentity: {} as object | null,
  shellThreads: [] as Array<{
    id: string;
    status: string;
    activeRunId: string | null;
    latestRunId: string | null;
    latestRunCompletedAt: null;
  }>,
  detailWatches: [] as Array<string | null>,
  streamLive: true,
  liveProjection: null as OrchestrationV2ThreadProjection | null,
  liveProjections: new Map<string, OrchestrationV2ThreadProjection>(),
  feedbackRead: vi.fn(),
  feedbackSubmit: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "environment"
      ? state.environmentId
      : atom === "file-config"
        ? {
            environment: {
              capabilities: {
                attachmentUploads: true,
                fileAttachments: { maxUploadBytes: 1024 * 1024 },
              },
            },
          }
        : state.providers,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => {
      const router = actual.useRouter({ warn: false });
      return router ? actual.useNavigate() : state.navigate;
    },
  };
});
vi.mock("../../state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "environment" }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: {
      authenticated: state.sessionIdentity !== null,
      scopes: state.operate
        ? ["orchestration:read", "orchestration:operate"]
        : ["orchestration:read"],
    },
    isPending: false,
    hasError: false,
  }),
  usePreparedConnection: () =>
    state.sessionIdentity === null ? Option.none() : Option.some(state.sessionIdentity),
}));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: "providers",
  serverEnvironment: { configValueAtom: () => "file-config" },
}));
vi.mock("../../hooks/useNewProject", () => ({ useNewProject: () => state.createProject }));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/workflow", () => ({
  workflowEnvironment: {
    configurationAction: "configuration-action",
    readCatalog: "configuration-catalog",
    configurationStatus: "configuration-status",
  },
}));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellState: () => ({
    status: state.streamLive ? "live" : "cached",
    snapshot: Option.some({ threads: state.shellThreads }),
    error: Option.none(),
  }),
}));
vi.mock("../../state/threads", () => ({
  useEnvironmentThread: (_environment: unknown, threadId: string | null) => {
    state.detailWatches.push(threadId);
    return {
      status: state.streamLive ? "live" : "cached",
      data: state.liveProjections.get(threadId ?? "")
        ? Option.some(state.liveProjections.get(threadId ?? "")!)
        : state.liveProjection
          ? Option.some(state.liveProjection)
          : Option.none(),
      error: Option.none(),
    };
  },
  threadEnvironment: {
    create: "create",
    startTurn: "capability-start",
    interruptTurn: "interrupt",
    readFirstLaunchStatus: "first-launch-status",
    readResultContinuationStatus: "continuation-status",
    readTaskReview: "review-read",
    readTaskInstructionSkillReview: "skill-review",
    readTaskReferenceFileReview: "file-review",
    decideTaskContract: "review-decide",
    readProjection: "read-projection",
    readCreationStatus: "read-creation-status",
    readAutoPreview: "auto-preview",
  },
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: (input: unknown) => state.fileUpload(input),
  releaseDraftAttachment: (file: unknown) => state.fileRelease(file),
  useAttachmentUploadStore: (select: (state: unknown) => unknown) =>
    select({ uploadsByImageId: state.fileUploads }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "continuation-status"
      ? state.continuationRead
      : command === "configuration-catalog"
        ? state.catalog
        : command === "configuration-status"
          ? state.configurationStatus
          : command === "configuration-action"
            ? state.configurationWrite
            : command === "file-review"
              ? state.fileReview
              : command === "skill-review"
                ? state.skillReview
                : command === "interrupt"
                  ? state.interrupt
                  : command === "first-launch-status"
                    ? state.firstLaunchRead
                    : command === "capability-start"
                      ? state.startStep
                      : command === "auto-preview"
                        ? state.autoPreview
                        : command === "read-creation-status"
                          ? state.readCreationStatus
                          : command === "review-read"
                            ? state.reviewRead
                            : command === "review-decide"
                              ? state.reviewDecide
                              : command === "read-projection"
                                ? state.readProjection
                                : state.create,
}));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    activeInstanceId: string;
    model: string;
    disabled?: boolean;
    modelOptionsByInstance: ReadonlyMap<
      string,
      ReadonlyArray<{ slug: string; isDefault?: boolean }>
    >;
    onInstanceModelChange: (i: string, m: string) => void;
  }) => (
    <div aria-label="Task model picker">
      <button
        disabled={props.disabled}
        onClick={() => {
          const models = props.modelOptionsByInstance.get(props.activeInstanceId) ?? [];
          const chosen = models.find((m) => m.isDefault) ?? models[0];
          if (chosen) props.onInstanceModelChange(props.activeInstanceId, chosen.slug);
        }}
      >
        Select fixture exact model
      </button>
      <button onClick={() => props.onInstanceModelChange(props.activeInstanceId, "manual-choice")}>
        Choose fixture Manual model
      </button>
      {(props.modelOptionsByInstance.get(props.activeInstanceId) ?? []).map((m) => (
        <button
          key={m.slug}
          disabled={props.disabled}
          onClick={() => props.onInstanceModelChange(props.activeInstanceId, m.slug)}
        >{`Select exact model: ${m.slug}`}</button>
      ))}
      <span>{props.model}</span>
    </div>
  ),
}));
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
      taskResultFeedback: {
        readTaskResultFeedback: ({
          payload,
        }: {
          payload: import("@t3tools/contracts").TaskResultFeedbackInput;
        }) => Effect.promise(() => state.feedbackRead(payload)),
        submitTaskResultFeedback: ({
          payload,
        }: {
          payload: import("@t3tools/contracts").TaskResultFeedbackSubmit;
        }) => Effect.promise(() => state.feedbackSubmit(payload)),
      },
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
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: import("react").ReactNode;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <dialog open data-review-dialog="" onClose={() => onOpenChange(false)}>
        {children}
      </dialog>
    ) : null,
  AlertDialogPopup: "div",
  AlertDialogHeader: "div",
  AlertDialogFooter: "div",
  AlertDialogTitle: "h2",
  AlertDialogDescription: ({ children }: { children: import("react").ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "div" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
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

import { CollaborationRoutePage } from "./CollaborationRoutePage";
import { SetupReturnAction } from "./SetupReturnAction";
import { validateCollaborationScope } from "./collaborationScope";
import {
  validateSettingsRouteSearch,
  retainSettingsScope,
} from "../settings/settingsScopeNavigation";
import { AgentsPage, TasksPage } from "./CollaborationPages";
import { AgentsTaskCreator } from "./AgentsTaskCreator";

let renderer: ReactTestRenderer;
// Existing detail journeys now explicitly enter the sole inbox row before using controls.
async function selectOnlyInboxTaskForDetailJourney(view = renderer) {
  let root: ReactTestRenderer["root"];
  try {
    root = view.root;
  } catch {
    return;
  }
  if (root.findAllByProps({ "aria-label": "Cross-agent tasks" }).length) return;
  const rows = root
    .findAllByType("button")
    .filter((node) => node.props["data-task-inbox-open"] !== undefined && !node.props.disabled);
  if (rows.length === 1) await act(async () => rows[0]!.props.onClick());
}
function creationScopeSelectValues() {
  return renderer.root
    .findAllByType("select")
    .filter(
      (n) =>
        !n.findAllByProps({ "aria-label": "Inbox project" }).length &&
        !n.findAllByProps({ "aria-label": "Inbox assignee" }).length,
    )
    .map((n) => n.props.value);
}
async function selectExactInboxTask(task: CollaborationTask, view = renderer) {
  await act(async () =>
    view.root
      .findByProps({ "aria-label": `View task ${task.id} in ${task.projectId}` })
      .props.onClick(),
  );
}

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
    .findByProps({ "data-agent-id": "codex" })
    .findAllByType("button")
    .find((node) => String(node.props["aria-label"]).endsWith(" conversation"))!;
const click = async () => {
  await act(async () => {
    button().props.onClick();
  });
};
const encodeEvidence = SchemaForFixture.encodeSync(
  SchemaForFixture.fromJsonString(SchemaForFixture.Unknown),
);
const decodeCreationReviewCommand = SchemaForFixture.decodeUnknownSync(OrchestrationV2Command);
const decodeCreationStorage = SchemaForFixture.decodeUnknownSync(
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
  const attempts = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => attempts.get(key) ?? null,
    setItem: (key: string, value: string) => attempts.set(key, value),
    removeItem: (key: string) => attempts.delete(key),
  });
  state.catalog.mockReset().mockResolvedValue({ _tag: "Success", value: { profiles: [] } });
  state.configurationWrite.mockReset();
  state.configurationStatus.mockReset();
  state.operate = true;
  state.firstLaunchRead.mockReset();
  state.continuationRead.mockReset();
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
  state.createProject.mockReset().mockResolvedValue(true);
  state.startStep.mockReset();
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  state.reviewRead.mockReset();
  state.fileReview.mockReset();
  state.fileUpload.mockReset();
  state.fileRelease.mockReset();
  state.fileUploads = {};
  state.fileUploadPromise = Promise.resolve();
  state.skillReview.mockReset();
  state.reviewDecide.mockReset();
  state.readProjection.mockReset();
  state.readCreationStatus.mockReset();
  state.feedbackRead
    .mockReset()
    .mockResolvedValue({ status: "unavailable", reason: "fixture-default" });
  state.feedbackSubmit.mockReset();
  state.autoPreview.mockReset();
  state.sessionIdentity = {};
  state.streamLive = true;
  state.detailWatches = [];
  state.shellThreads = [];
  state.liveProjection = null;
  state.liveProjections.clear();
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
  it("creates from the hero through canonical provider recovery and deduplicates repeated submit", async () => {
    const response = deferred<ReturnType<typeof bindResult>>();
    state.recover.mockReturnValueOnce(response.promise);
    await mount();
    const show = renderer.root.findByProps({ "aria-controls": "create-agent" });
    await act(async () => {
      show.props.onClick();
      show.props.onClick();
    });
    expect(renderer.root.findAllByProps({ id: "create-agent" })).toHaveLength(1);
    await act(async () =>
      renderer.root.findByType("select").props.onChange({ target: { value: "codex" } }),
    );
    const submit = renderer.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "Create agent conversation")!;
    expect(submit.props.disabled).toBe(false);
    await act(async () => {
      submit.props.onClick();
      submit.props.onClick();
    });
    expect(state.recover).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-a",
      providerId: "codex",
    });
    await act(async () =>
      response.resolve(
        bindResult({
          type: "thread.bind",
          commandId: "fixture-hero",
          projectId: "project-a",
          threadId: "hero-thread",
        }),
      ),
    );
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "environment-a", threadId: "hero-thread" },
    });
    expect(state.create).not.toHaveBeenCalled();
  });

  it("cancels hero creation without writes and connects through existing provider setup", async () => {
    state.providers = [];
    await mount();
    await act(async () =>
      renderer.root.findByProps({ "aria-controls": "create-agent" }).props.onClick(),
    );
    expect(
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.join("") === "Create agent conversation")!.props.disabled,
    ).toBe(true);
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.join("") === "Cancel")!
        .props.onClick(),
    );
    expect(renderer.root.findAllByProps({ id: "create-agent" })).toHaveLength(0);
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Connect your agent"))!
        .props.onClick(),
    );
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings/providers",
        search: expect.objectContaining({
          scopeEnvironmentId: "environment-a",
          scopeProjectId: "project-a",
        }),
      }),
    );
  });
  it("keeps the directory readable without a provider and links to setup", async () => {
    state.providers = [];
    await mount();
    expect(text()).toContain("Saved agent and task records remain readable");
    await creationClick("Set up a provider");
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings/providers",
        search: expect.objectContaining({
          scopeEnvironmentId: "environment-a",
          scopeProjectId: "project-a",
        }),
      }),
    );
    expect(state.create).not.toHaveBeenCalled();
  });

  it("keeps an unauthenticated provider visible with a setup action", async () => {
    state.providers = configuredProviders.map((provider) => ({
      ...provider,
      auth: { status: "unauthenticated" },
    }));
    await mount();
    expect(text()).toContain("No provider is ready for task execution");
    expect(text()).toContain("Codex");
    expect(creationButton("New task")!.props.disabled).toBe(true);
    await creationClick("Set up a provider");
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings/providers",
        search: expect.objectContaining({
          scopeEnvironmentId: "environment-a",
          scopeProjectId: "project-a",
        }),
      }),
    );
  });

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
        node.props["aria-label"].endsWith(" conversation"),
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
    expect(text()).toContain("Saved setup scope does not match");
    expect(text()).not.toContain("Environment B Codex");
    await creationClick("Choose current environment and scope");
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
    expect(creationButton("Open conversation")!.props.disabled).toBe(true);
    expect(creationButton("Refresh agent directory")).toBeDefined();
    expect(state.recover).not.toHaveBeenCalled();
  });
});

describe("Tasks loading and conversation access", () => {
  it("keeps saved tasks readable without a ready provider and offers setup", async () => {
    state.providers = [];
    state.snapshot = { ...state.snapshot, tasks: [agentTaskFixture()] };
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(text()).toContain("project-a running evidence");
    expect(text()).toContain("No executable provider is ready");
    expect(creationButton("Create governed task")!.props.disabled).toBe(true);
    await creationClick("Set up a provider");
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings/providers",
        search: expect.objectContaining({
          scopeEnvironmentId: "environment-a",
          scopeProjectId: "project-a",
        }),
      }),
    );
    expect(state.create).not.toHaveBeenCalled();
  });

  it("opens one governed creation draft from Tasks and cancel leaves no task", async () => {
    creationStorage();
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await creationClick("Create governed task", true);
    expect(creationButton("Review new task")).toBeDefined();
    expect(creationButton("Create governed task")!.props.disabled).toBe(true);
    await creationClick("Cancel new task");
    expect(creationButton("Review new task")).toBeUndefined();
    expect(creationButton("Create governed task")!.props.disabled).toBe(false);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
  });

  it("keeps loading distinct from a confirmed empty task list", async () => {
    const reading = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(reading.promise);
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
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
    await selectOnlyInboxTaskForDetailJourney(renderer);
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
      await selectOnlyInboxTaskForDetailJourney(renderer);
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
    await selectOnlyInboxTaskForDetailJourney(renderer);
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
    await selectOnlyInboxTaskForDetailJourney(renderer);
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
    await selectOnlyInboxTaskForDetailJourney(renderer);
  };

  it("keeps the newer refresh when the initial read returns last", async () => {
    const initial = deferred<CollaborationSnapshot>();
    const refresh = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
    await mountTasks();
    await refreshTasks();
    await act(async () => refresh.resolve(snapshot("New revision goal", 2)));
    await selectOnlyInboxTaskForDetailJourney(renderer);
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
          await selectOnlyInboxTaskForDetailJourney(renderer);
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
            await selectOnlyInboxTaskForDetailJourney(renderer);
            expect(text()).toContain(mode === "manual" ? "Manual" : "Auto");
            if (mode === "task-debugging") {
              expect(text()).toContain("Local task debugging");
              expect(text()).toContain(`Policy: ${HYBRID_TASK_ROUTER_POLICY_VERSION}.`);
              expect(text()).not.toContain("Policy: hybrid-router.v1.0.0.");
            }
            expect(text()).toContain("Selected model");
            expect(text()).toContain("selected-A (codex)");
            expect(text()).toContain("configured-B (codex)");
            expect(text()).toContain(decision.explanation);
            expect(text()).toContain("Detailed ranking basis");
            if (mode !== "task-debugging") {
              expect(text()).toContain(
                mode === "manual"
                  ? "Manual selection; automatic ranking did not decide the target."
                  : "Only one eligible candidate remained in the selectable ranking.",
              );
            }
            if (mode === "auto") {
              const known = (value: number) => ({ status: "known" as const, value });
              const winner = {
                ...baselineDecision.candidates[0]!,
                ...target,
                isDefault: true,
                availabilityReasons: [],
                metrics: { quality: known(20), costUsd: known(1), latencyMs: known(10) },
              };
              const other = {
                ...winner,
                instanceId: ProviderInstanceId.make("other"),
                model: "alternative",
                driver: ProviderDriverKind.make("claudeAgent"),
                metrics: { ...winner.metrics, quality: known(10) },
              };
              for (const incomplete of [false, true]) {
                const persisted = routeModel({
                  mode: "auto",
                  catalog: [
                    winner,
                    {
                      ...other,
                      metrics: {
                        ...other.metrics,
                        ...(incomplete ? { quality: { status: "unknown" as const } } : {}),
                      },
                    },
                  ],
                  preferredTargets: [target],
                  policy: {
                    version: "model-router.v0",
                    qualityWeight: 1,
                    costWeight: incomplete ? 0 : 1,
                    latencyWeight: 1,
                  },
                });
                await EffectForFixture.runPromise(
                  sql`UPDATE projection_dispatcher_task_routes SET binding_json=${encodeEvidence({ ...binding, modelRoute: { ...persisted, executionStatus: "bound" } })}`,
                );
                await creationClick("Refresh tasks");
                expect(text()).toContain(
                  incomplete
                    ? "Equal weighted scores (-10); tie-break stages used: preferred."
                    : "Higher weighted catalog-estimate score decided the selection (9 vs -1).",
                );
                expect(text()).toContain(
                  "Catalog estimates are not measured quality, verified spend, or a prediction of success.",
                );
              }
              expect(text()).toContain("incomplete eligible-candidate estimates");
              expect(text()).toContain("zero weight");
            }
            const legacyExplanation = "Original historical explanation retained verbatim.";
            await EffectForFixture.runPromise(
              sql`UPDATE projection_dispatcher_task_routes SET binding_json=json_set(json_remove(${encodeEvidence(binding)},'$.modelRoute.selectionBasis'),'$.modelRoute.explanation',${legacyExplanation})`,
            );
            await creationClick("Refresh tasks");
            expect(text()).toContain("Detailed ranking basis not recorded");
            expect(text()).toContain(legacyExplanation);

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
            await selectOnlyInboxTaskForDetailJourney(renderer);
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
  await selectOnlyInboxTaskForDetailJourney(renderer);
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

const loadAgentsCreationFixture = async () =>
  (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/agentsTaskCreationFixture.ts",
      import.meta.url,
    ).href
  )) as {
    agentsCreationProvider: ServerProvider;
    agentsCreationCommand: (
      id: string,
    ) => Extract<OrchestrationV2Command, { type: "thread.create" }>;
    withAgentsTaskCreationFixture: (
      check: (fixture: {
        sql: SqlClientForFixture.SqlClient;
        dispatch: (
          command: OrchestrationV2Command,
        ) => EffectForFixture.Effect<OrchestrationV2DispatchCommandResult, Error>;
        readStatus: (
          command: OrchestrationV2Command,
          actor?: {
            kind: "session";
            actorId: string;
            sessionId: string;
            scopes: Array<"orchestration:read" | "orchestration:operate">;
          },
        ) => EffectForFixture.Effect<
          { status: "committed" | "rejected" | "unknown" | "unavailable" },
          Error
        >;
        setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
        providerStarts: () => number;
        readSnapshot: () => EffectForFixture.Effect<CollaborationSnapshot, Error>;
        previewAuto: (
          input: TaskAutoPreviewInput,
        ) => EffectForFixture.Effect<TaskAutoPreviewState, Error>;
        readReview: (
          input: TaskContractReviewInput,
        ) => EffectForFixture.Effect<TaskContractReviewState, Error>;
        orchestrator: {
          getThreadProjection: (
            id: string,
          ) => EffectForFixture.Effect<OrchestrationV2ThreadProjection, Error>;
        };
        openCanonical: () => EffectForFixture.Effect<CollaborationCommandResult, Error>;
        noExecution: () => EffectForFixture.Effect<
          { runs: number; grants: number; outbox: number; messages: number },
          Error
        >;
      }) => EffectForFixture.Effect<void, Error>,
      options?: { dbPath?: string },
    ) => EffectForFixture.Effect<void, Error>;
  };
const creationStorage = () => {
  const records = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
    removeItem: (key: string) => records.delete(key),
  });
  return records;
};
const creationButton = (name: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.includes(name));
const creationClick = async (name: string, repeat = false) => {
  await act(async () => {
    const click = creationButton(name)!.props.onClick;
    click();
    if (repeat) click();
  });
};
const fillCreation = async (title = "Reviewed parser task", chooseModel = true) => {
  for (const [label, value] of Object.entries({
    "Task title": title,
    Goal: "Fix parser",
    Redirect: "Ask before expanding scope",
    Acceptance: "Parser regression passes",
    "Provider start limit": "2",
    "Stop conditions": "Scope changed",
    "Optional token cap": "900",
    "Optional reported cost cap (USD)": "0.1",
    "Optional UTC deadline": "2026-10-14T00:00:00Z",
  }))
    await act(async () =>
      renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
    );
  if (chooseModel && creationButton("Select fixture exact model"))
    await creationClick("Select fixture exact model");
};

it("creates two actual owned tasks from Agents, reloads exact enrollment and uses separate paused revision controls", async () => {
  creationStorage();
  const module = await loadAgentsCreationFixture();
  await EffectForFixture.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      EffectForFixture.promise(async () => {
        const canonical = await EffectForFixture.runPromise(f.openCanonical());
        const canonicalId = canonical.snapshot.agents.find((a) => a.id === "codex")!.threadId;
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.dispatch(input)),
        }));
        state.readProjection.mockImplementation(
          async ({ input }: { input: { threadId: string } }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(
              f.orchestrator.getThreadProjection(input.threadId),
            ),
          }),
        );
        await mount();
        const created: string[] = [];
        for (const title of ["Reviewed parser task", "Reviewed docs task"]) {
          await creationClick("New task", true);
          expect(creationButton("Open conversation")!.props.disabled).toBe(true);
          await fillCreation(title);
          await creationClick("Review new task", true);
          expect(text()).toContain("environment-a");
          expect(text()).toContain("fake-model");
          expect(text()).toContain("approval-required/default");
          await creationClick("Create task", true);
          expect(text()).toContain("durably recorded");
          const command = state.create.mock.calls.at(-1)![0].input as Extract<
            OrchestrationV2Command,
            { type: "thread.create" }
          >;
          created.push(command.threadId);
          expect(command.taskContract?.brake).toEqual({
            maxProviderStarts: 2,
            stopConditions: "Scope changed",
            maxTokens: 900,
            maxCostUsd: 0.1,
            deadlineAt: "2026-10-14T00:00:00Z",
          });
          await creationClick("Open created conversation");
          expect(state.navigate).toHaveBeenLastCalledWith({
            to: "/$environmentId/$threadId",
            params: { environmentId: "environment-a", threadId: command.threadId },
          });
        }
        expect(state.create).toHaveBeenCalledTimes(2);
        expect(new Set(created).size).toBe(2);
        const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
        expect(snapshot.tasks.filter((t) => created.includes(t.threadId!))).toHaveLength(2);
        expect(snapshot.agents.find((a) => a.id === "codex")?.threadId).toBe(canonicalId);
        state.reviewRead.mockImplementation(
          async ({ input }: { input: TaskContractReviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.readReview(input)),
          }),
        );
        state.reviewDecide.mockImplementation(
          async ({
            input,
          }: {
            input: {
              action: "set" | "redirect" | "resume";
              threadId: string;
              revision?: number;
              expectedRevision?: number;
              goal?: string;
              redirect?: string;
              acceptance?: string;
              brake?: unknown;
              reviewTask: unknown;
            };
          }) => {
            const command = decodeCreationReviewCommand({
              ...input,
              type: `thread.task-contract.${input.action}`,
              commandId: CommandId.make(`creation-review:${state.reviewDecide.mock.calls.length}`),
            });
            return {
              _tag: "Success",
              value: await EffectForFixture.runPromise(f.dispatch(command)),
            };
          },
        );
        await act(async () => renderer.unmount());
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        await selectExactInboxTask(
          (await EffectForFixture.runPromise(f.readSnapshot())).tasks.find(
            (t) => t.threadId === created[0],
          )!,
        );
        const card = () =>
          renderer.root
            .findAllByType("li")
            .find((node) =>
              node.findAllByType("h2").some((h) => h.children.includes("Reviewed parser task")),
            )!;
        await act(async () =>
          card().findByProps({ "data-task-contract-redirect-action": "" }).props.onClick(),
        );
        await creationClick("Confirm decision");
        await act(async () =>
          card()
            .findAllByType("button")
            .find((b) => b.children.includes("Revise paused instructions"))!
            .props.onClick(),
        );
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "goal instruction" })
            .props.onChange({ target: { value: "Reviewed revised parser" } }),
        );
        await creationClick("Preview instruction changes");
        await creationClick("Save new revision");
        expect(
          (await EffectForFixture.runPromise(f.orchestrator.getThreadProjection(created[0]!)))
            .thread.taskContractPhase,
        ).toBe("redirected");
        await act(async () =>
          card().findByProps({ "data-task-contract-resume": "" }).props.onClick(),
        );
        await creationClick("Confirm decision");
        const final = await EffectForFixture.runPromise(
          f.orchestrator.getThreadProjection(created[0]!),
        );
        expect(final.thread.taskContract).toMatchObject({
          revision: 2,
          goal: "Reviewed revised parser",
        });
        expect(final.thread.taskContractPhase).toBe("active");
        expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
      }),
    ),
  );
}, 60_000);

it("creates a persisted governed task from Tasks without starting provider work", async () => {
  creationStorage();
  const module = await loadAgentsCreationFixture();
  await EffectForFixture.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.dispatch(input)),
        }));
        state.readProjection.mockImplementation(
          async ({ input }: { input: { threadId: string } }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(
              f.orchestrator.getThreadProjection(input.threadId),
            ),
          }),
        );
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        await creationClick("Create governed task", true);
        await fillCreation("Task page fixture");
        await creationClick("Review new task");
        await creationClick("Create task", true);
        expect(state.create).toHaveBeenCalledTimes(1);
        const command = state.create.mock.calls[0]![0].input as Extract<
          OrchestrationV2Command,
          { type: "thread.create" }
        >;
        expect(command.modelSelection).toEqual({ instanceId: "codex", model: "fake-model" });
        const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
        expect(snapshot.tasks.find((task) => task.threadId === command.threadId)?.title).toBe(
          "Task page fixture",
        );
        expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
        await act(async () => renderer.update(<TasksPage />));
        await selectOnlyInboxTaskForDetailJourney(renderer);
        expect(text()).toContain("Task page fixture");
      }),
    ),
  );
});
it.each(["malformed-cache", "storage-read-throws", "absent-task"] as const)(
  "keeps Agents creation fail closed for %s recovery",
  async (mode) => {
    const records = creationStorage();
    const writes = vi.fn();
    if (mode === "malformed-cache") records.set("t3:agents-governed-creation:v1", "{not-json");
    if (mode === "storage-read-throws")
      vi.stubGlobal("sessionStorage", {
        getItem: () => {
          throw new Error("Fixture read failed");
        },
        setItem: writes,
      });
    const module = await loadAgentsCreationFixture();
    await EffectForFixture.runPromise(
      module.withAgentsTaskCreationFixture((f) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          state.readCreationStatus.mockImplementation(
            async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(f.readStatus(input.command)),
            }),
          );
          state.readProjection.mockImplementation(
            async ({ input }: { input: { threadId: string } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(
                f.orchestrator.getThreadProjection(input.threadId),
              ),
            }),
          );
          state.create.mockResolvedValue({
            _tag: "Failure",
            cause: "Fixture request lost before dispatch",
          });
          await mount();
          await creationClick("New task", true);
          if (mode !== "absent-task") {
            expect(text()).toMatch(/could not be read|storage is unavailable/);
            expect(creationButton("Review new task")).toBeUndefined();
            expect(state.create).not.toHaveBeenCalled();
            expect(state.readProjection).not.toHaveBeenCalled();
            expect(writes).not.toHaveBeenCalled();
            if (mode === "malformed-cache") expect([...records.values()]).toEqual(["{not-json"]);
          } else {
            await fillCreation();
            await creationClick("Review new task");
            await creationClick("Create task", true);
            const command = state.create.mock.calls[0]![0].input as Extract<
              OrchestrationV2Command,
              { type: "thread.create" }
            >;
            expect(
              await EffectForFixture.runPromise(
                f.sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id=${command.commandId}`,
              ),
            ).toHaveLength(0);
            for (let read = 0; read < 2; read++) {
              await creationClick("Recover task creation", true);
              expect(text()).toContain("uncertain");
              expect(creationButton("New task")!.props.disabled).toBe(true);
              expect(creationButton("Open created conversation")).toBeUndefined();
              expect(decodeCreationStorage([...records.values()][0]!)).toMatchObject({
                status: "uncertain",
                command: { commandId: command.commandId, threadId: command.threadId },
              });
            }
            expect(state.create).toHaveBeenCalledTimes(1);
            expect(state.readCreationStatus).toHaveBeenCalledTimes(2);
            expect(state.readProjection).not.toHaveBeenCalled();
          }
          expect((await EffectForFixture.runPromise(f.readSnapshot())).tasks).toHaveLength(0);
          expect(state.navigate).not.toHaveBeenCalled();
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
        }),
      ),
    );
  },
  60_000,
);

it.each([
  "lost-response",
  "lost-rejection",
  "reconcile-before-failure",
  "reconcile-before-rejection",
  "unmount",
  "environment-roundtrip",
  "project-roundtrip",
  "late-read-after-new-draft",
  "recover-read-environment",
  "recover-read-unmount",
  "confirmed-reload",
  "project-selector-reload",
] as const)(
  "recovers actual Agents creation identity without duplicate mutation across %s",
  async (mode) => {
    const storage = creationStorage();
    const module = await loadAgentsCreationFixture();
    await EffectForFixture.runPromise(
      module.withAgentsTaskCreationFixture((f) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          state.readCreationStatus.mockImplementation(
            async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(f.readStatus(input.command)),
            }),
          );
          state.readProjection.mockImplementation(
            async ({ input }: { input: { threadId: string } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(
                f.orchestrator.getThreadProjection(input.threadId),
              ),
            }),
          );
          const reply = deferred<void>();
          state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => {
            const value = await EffectForFixture.runPromise(f.dispatch(input));
            await reply.promise;
            return mode === "late-read-after-new-draft"
              ? { _tag: "Success", value }
              : { _tag: "Failure", cause: "Lost committed reply" };
          });
          if (mode === "project-selector-reload")
            state.projects = [
              { id: "project-a", title: "A", environmentId: "environment-a" },
              { id: "project-b", title: "B", environmentId: "environment-a" },
            ];
          await mount();
          if (mode === "project-selector-reload") await select("project-a");
          await creationClick("New task", true);
          await fillCreation();
          await creationClick("Review new task", true);
          await creationClick("Create task", true);
          expect(state.create).toHaveBeenCalledTimes(1);
          const command = state.create.mock.calls[0]![0].input as Extract<
            OrchestrationV2Command,
            { type: "thread.create" }
          >;
          expect(storage.size).toBe(1);
          expect(decodeCreationStorage([...storage.values()][0]!)).toMatchObject({
            command: { commandId: command.commandId },
          });
          expect(creationButton("New task")!.props.disabled).toBe(true);
          expect(state.navigate).not.toHaveBeenCalled();
          if (mode === "lost-response" || mode === "lost-rejection") {
            await act(async () => {
              if (mode === "lost-rejection") reply.reject(new Error("Lost response"));
              else reply.resolve();
            });
            expect(text()).toContain("uncertain");
          }
          if (mode === "unmount" || mode === "project-selector-reload") {
            await act(async () => renderer.unmount());
            await mount();
            expect(text()).toContain("uncertain");
            if (mode === "project-selector-reload") {
              expect(renderer.root.findByType("select").props.disabled).toBe(false);
              await select("project-a");
            }
          }
          if (mode === "environment-roundtrip") {
            state.environmentId = "environment-b";
            await act(async () => renderer.update(<AgentsPage />));
            expect(creationButton("Recover task creation")!.props.disabled).toBe(true);
            expect(text()).toContain("Return to the original environment");
            state.environmentId = "environment-a";
            await act(async () => renderer.update(<AgentsPage />));
          }
          if (mode === "project-roundtrip") {
            state.projects = [{ id: "project-b", title: "B", environmentId: "environment-a" }];
            await act(async () => renderer.update(<AgentsPage />));
            expect(creationButton("Recover task creation")!.props.disabled).toBe(true);
            state.projects = [{ id: "project-a", title: "A", environmentId: "environment-a" }];
            await act(async () => renderer.update(<AgentsPage />));
          }
          if (mode.startsWith("recover-read-")) {
            const pendingRead = deferred<{
              _tag: "Success";
              value: OrchestrationV2ThreadProjection;
            }>();
            state.readProjection.mockImplementationOnce(() => pendingRead.promise);
            await creationClick("Recover task creation", true);
            if (mode === "recover-read-unmount") {
              await act(async () => renderer.unmount());
              await mount();
            } else {
              state.environmentId = "environment-b";
              await act(async () => renderer.update(<AgentsPage />));
              state.environmentId = "environment-a";
              await act(async () => renderer.update(<AgentsPage />));
            }
            expect(creationButton("Recover task creation")!.props.disabled).toBe(false);
            await creationClick("Recover task creation");
            await act(async () =>
              pendingRead.resolve({
                _tag: "Success",
                value: await EffectForFixture.runPromise(
                  f.orchestrator.getThreadProjection(command.threadId),
                ),
              }),
            );
          } else await creationClick("Recover task creation", true);
          expect(text()).toContain("durably recorded");
          expect(decodeCreationStorage([...storage.values()][0]!)).toMatchObject({
            status: "confirmed",
          });
          if (mode === "confirmed-reload") {
            await act(async () => renderer.unmount());
            await mount();
            expect(creationButton("New task")!.props.disabled).toBe(true);
            expect(creationButton("Open created conversation")).toBeUndefined();
            await creationClick("Recover task creation");
            expect(text()).toContain("durably recorded");
          }
          expect(state.create).toHaveBeenCalledTimes(1);
          if (mode === "late-read-after-new-draft") {
            await creationClick("New task");
            await fillCreation("New independent draft");
          }
          if (!mode.startsWith("lost-")) {
            await act(async () => {
              if (mode === "reconcile-before-rejection") reply.reject(new Error("Late failure"));
              else reply.resolve();
            });
            expect(text()).not.toContain("outcome is uncertain");
            expect(state.create).toHaveBeenCalledTimes(1);
            if (mode === "late-read-after-new-draft") {
              expect(renderer.root.findByProps({ "aria-label": "Task title" }).props.value).toBe(
                "New independent draft",
              );
              expect(creationButton("Open conversation")!.props.disabled).toBe(true);
              await creationClick("Cancel new task");
            }
          }
          await creationClick("Open created conversation");
          expect(state.navigate).toHaveBeenCalledWith({
            to: "/$environmentId/$threadId",
            params: { environmentId: "environment-a", threadId: command.threadId },
          });
          expect(
            (await EffectForFixture.runPromise(f.readSnapshot())).tasks.filter(
              (t) => t.threadId === command.threadId,
            ),
          ).toHaveLength(1);
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
        }),
      ),
    );
  },
  60_000,
);

it.each([
  "cancel",
  "close",
  "invalid",
  "stale-provider",
  "stale-project",
  "storage-failure",
  "old-callback",
  "old-confirmation",
] as const)(
  "does not create an Agents task for %s",
  async (mode) => {
    creationStorage();
    const module = await loadAgentsCreationFixture();
    await EffectForFixture.runPromise(
      module.withAgentsTaskCreationFixture((f) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          state.readCreationStatus.mockImplementation(
            async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(f.readStatus(input.command)),
            }),
          );
          state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.dispatch(input)),
          }));
          await mount();
          const staleNew = creationButton("New task")!.props.onClick;
          await creationClick("New task", true);
          const oldCancel = creationButton("Cancel new task")!.props.onClick;
          if (mode === "invalid") {
            expect(creationButton("Review new task")!.props.disabled).toBe(true);
            await fillCreation();
            for (const [label, value] of [
              ["Provider start limit", "0"],
              ["Optional token cap", "2.5"],
              ["Optional reported cost cap (USD)", "-1"],
              ["Optional UTC deadline", "later"],
            ]) {
              await act(async () =>
                renderer.root
                  .findByProps({ "aria-label": label })
                  .props.onChange({ target: { value } }),
              );
              expect(creationButton("Review new task")!.props.disabled).toBe(true);
            }
            await creationClick("Cancel new task");
          } else if (mode === "old-callback") {
            await creationClick("Cancel new task");
            await creationClick("New task");
            await fillCreation("Preserve newer draft");
            await act(async () => oldCancel());
            expect(renderer.root.findByProps({ "aria-label": "Task title" }).props.value).toBe(
              "Preserve newer draft",
            );
            expect(creationButton("Open conversation")!.props.disabled).toBe(true);
            await creationClick("Cancel new task");
          } else {
            await fillCreation();
            await creationClick("Review new task");
            const oldConfirm = creationButton("Create task")!.props.onClick;
            if (mode === "old-confirmation") {
              const oldClose = renderer.root.findByProps({ "data-review-dialog": "" }).props
                .onClose;
              await creationClick("Back to task draft");
              await fillCreation("Updated explicitly reviewed draft");
              await creationClick("Review new task");
              await act(async () => {
                oldConfirm();
                oldClose();
              });
              expect(creationButton("Create task")).toBeDefined();
              expect(text()).toContain("Updated explicitly reviewed draft");
              await creationClick("Back to task draft");
              await creationClick("Cancel new task");
            }
            if (mode === "cancel") {
              await creationClick("Back to task draft");
              await creationClick("Cancel new task");
            }
            if (mode === "close") {
              await act(async () =>
                renderer.root.findByProps({ "data-review-dialog": "" }).props.onClose(),
              );
              expect(renderer.root.findByProps({ "aria-label": "Task title" }).props.value).toBe(
                "Reviewed parser task",
              );
              await creationClick("Cancel new task");
            }
            if (mode === "stale-provider") {
              state.providers = state.providers.map((p) => ({ ...p, enabled: false }));
              await act(async () => renderer.update(<AgentsPage />));
              await act(async () => oldConfirm());
            }
            if (mode === "stale-project") {
              state.projects = [{ id: "project-b", title: "B", environmentId: "environment-a" }];
              await act(async () => renderer.update(<AgentsPage />));
              await act(async () => {
                oldConfirm();
                staleNew();
              });
            }
            if (mode === "storage-failure") {
              vi.stubGlobal("sessionStorage", {
                getItem: () => null,
                setItem: () => {
                  throw new Error("Fixture storage failed");
                },
              });
              await creationClick("Create task");
              expect(text()).toContain("No task was sent");
              await creationClick("Cancel new task");
            }
          }
          expect(state.create).not.toHaveBeenCalled();
          expect((await EffectForFixture.runPromise(f.readSnapshot())).tasks).toHaveLength(0);
          expect(state.navigate).not.toHaveBeenCalled();
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
        }),
      ),
    );
  },
  60_000,
);

it("offers New task alongside canonical conversation on an actual governed Agents snapshot", async () => {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/governedEnrollmentFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withGovernedEnrollmentFixture: (
      check: (fixture: {
        readSnapshot: () => EffectForFixture.Effect<CollaborationSnapshot, Error>;
        noExecution: () => EffectForFixture.Effect<
          { runs: number; grants: number; outbox: number },
          Error
        >;
      }) => EffectForFixture.Effect<void, Error>,
    ) => EffectForFixture.Effect<void, Error>;
  };
  await EffectForFixture.runPromise(
    module.withGovernedEnrollmentFixture((fixture) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
        await act(async () => {
          renderer = create(<AgentsPage />);
        });
        const provider = renderer.root.findByProps({ "data-agent-id": "codex" });
        expect(
          provider
            .findAllByType("button")
            .some((button) => button.children.includes("Open conversation")),
        ).toBe(true);
        expect(
          provider.findAllByType("button").some((button) => button.children.includes("New task")),
        ).toBe(true);
        expect(state.create).not.toHaveBeenCalled();
        expect(await EffectForFixture.runPromise(fixture.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
        });
      }),
    ),
  );
});

it("renders two normal governed creations, refreshes/reopens and navigates each exact task without dispatch", async () => {
  const fixture = (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/governedEnrollmentFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withGovernedEnrollmentFixture: (
      check: (fixture: {
        readSnapshot: () => EffectForFixture.Effect<CollaborationSnapshot, Error>;
        noExecution: () => EffectForFixture.Effect<
          { runs: number; grants: number; outbox: number },
          Error
        >;
      }) => EffectForFixture.Effect<void, Error>,
    ) => EffectForFixture.Effect<void, Error>;
  };
  await EffectForFixture.runPromise(
    fixture.withGovernedEnrollmentFixture((fixture) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
        const snapshot = await EffectForFixture.runPromise(fixture.readSnapshot());
        expect(snapshot.agents.filter((agent) => agent.origin === "internal")).toEqual([]);
        let renderer!: ReactTestRenderer;
        for (let open = 0; open < 2; open++) {
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          const text = () => JSON.stringify(renderer.toJSON());
          await selectExactInboxTask(snapshot.tasks[0]!, renderer);
          expect(text()).toContain("Fix parser behavior");
          expect(snapshot.tasks).toHaveLength(2);
          expect(text()).toContain("Write parser documentation");
          expect(text()).toContain("Ask before expanding scope");
          expect(text()).toContain("Owner checks the result");
          expect(text()).toContain("Command ledger:");
          expect(text()).toContain("blocked");
          expect(text()).toContain("No validated persisted result evidence");
          await act(async () => {
            renderer.root
              .findAllByType("button")
              .find((node) => node.children.includes("Refresh tasks"))!
              .props.onClick();
          });
          for (const threadId of ["task-parser", "task-docs"]) {
            await selectExactInboxTask(
              snapshot.tasks.find((t) => t.threadId === threadId)!,
              renderer,
            );
            const buttons = renderer.root
              .findAllByType("button")
              .filter((node) => node.children.includes("Open conversation"));
            expect(buttons).toHaveLength(1);
            await act(async () => {
              buttons[0]!.props.onClick();
            });
            expect(state.navigate).toHaveBeenLastCalledWith({
              to: "/$environmentId/$threadId",
              params: { environmentId: "environment-a", threadId },
            });
          }
          await act(async () => renderer.unmount());
        }
        expect(state.create).not.toHaveBeenCalled();
        expect(state.bind).not.toHaveBeenCalled();
        expect(state.recover).not.toHaveBeenCalled();
        expect(await EffectForFixture.runPromise(fixture.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
        });
      }),
    ),
  );
}, 60_000);

it("renders ordinary roots before and after actual upgrade, refreshes/reopens and navigates each exact task without dispatch", async () => {
  const fixture = (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/ownedChatUpgradeFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withOwnedChatUpgradeFixture: (
      check: (fixture: {
        upgrade: () => EffectForFixture.Effect<void, Error>;
        readSnapshot: () => EffectForFixture.Effect<CollaborationSnapshot, Error>;
        noExecution: () => EffectForFixture.Effect<
          { runs: number; grants: number; outbox: number },
          Error
        >;
      }) => EffectForFixture.Effect<void, Error>,
    ) => EffectForFixture.Effect<void, Error>;
  };
  await EffectForFixture.runPromise(
    fixture.withOwnedChatUpgradeFixture((fixture) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
        expect((await EffectForFixture.runPromise(fixture.readSnapshot())).tasks).toHaveLength(0);
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        expect(text()).not.toContain("Fix parser behavior");
        expect(
          renderer.root
            .findAllByType("button")
            .filter((node) => node.children.includes("Open conversation")),
        ).toHaveLength(0);
        await act(async () => renderer.unmount());
        await EffectForFixture.runPromise(fixture.upgrade());
        const snapshot = await EffectForFixture.runPromise(fixture.readSnapshot());
        expect(snapshot.agents.filter((agent) => agent.origin === "internal")).toEqual([]);

        for (let open = 0; open < 2; open++) {
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          const text = () => JSON.stringify(renderer.toJSON());
          await selectExactInboxTask(snapshot.tasks[0]!, renderer);
          expect(text()).toContain("Fix parser behavior");
          expect(snapshot.tasks).toHaveLength(2);
          expect(text()).toContain("Write parser documentation");
          expect(text()).toContain("Ask before expanding scope");
          expect(text()).toContain("Owner checks the result");
          expect(text()).toContain("Command ledger:");
          expect(text()).toContain("blocked");
          expect(text()).toContain("No validated persisted result evidence");
          await act(async () => {
            renderer.root
              .findAllByType("button")
              .find((node) => node.children.includes("Refresh tasks"))!
              .props.onClick();
          });
          for (const threadId of ["task-parser", "task-docs"]) {
            await selectExactInboxTask(
              snapshot.tasks.find((t) => t.threadId === threadId)!,
              renderer,
            );
            const buttons = renderer.root
              .findAllByType("button")
              .filter((node) => node.children.includes("Open conversation"));
            expect(buttons).toHaveLength(1);
            await act(async () => {
              buttons[0]!.props.onClick();
            });
            expect(state.navigate).toHaveBeenLastCalledWith({
              to: "/$environmentId/$threadId",
              params: { environmentId: "environment-a", threadId },
            });
          }
          await act(async () => renderer.unmount());
        }
        expect(state.create).not.toHaveBeenCalled();
        expect(state.bind).not.toHaveBeenCalled();
        expect(state.recover).not.toHaveBeenCalled();
        expect(await EffectForFixture.runPromise(fixture.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
        });
      }),
    ),
  );
}, 60_000);

it("confirms three Tasks decisions against actual authoritative services and refreshes the same contract without execution", async () => {
  const fixture = await loadTaskReviewFixture();
  await EffectForFixture.runPromise(
    fixture.withTaskReviewFixture((fixture) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
        state.reviewRead.mockImplementation(
          async ({ input }: { input: import("@t3tools/contracts").TaskContractReviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(fixture.readReview(input)),
          }),
        );
        state.reviewDecide.mockImplementation(
          async ({ input }: { input: Parameters<typeof fixture.decide>[0] }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(fixture.decide(input)),
          }),
        );
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        expect(text()).toContain("Fix parser behavior");
        const actionButton = (action: string) =>
          renderer.root
            .findAllByType("button")
            .find((node) => node.props[`data-task-contract-${action}`] !== undefined)!;
        expect(actionButton("accept")).toBeDefined();
        const snapshotBefore = await EffectForFixture.runPromise(fixture.readSnapshot());
        const taskBefore = snapshotBefore.tasks[0]!;
        const reviewBefore = await EffectForFixture.runPromise(
          fixture.readReview({
            environmentId: "environment-a",
            taskId: taskBefore.id,
            projectId: taskBefore.projectId,
            threadId: taskBefore.threadId!,
            revision: 1,
          }),
        );
        expect(reviewBefore.status).toBe("available");
        for (const [action, attribute, expected] of [
          ["redirect", "redirect-action", "redirected"],
          ["resume", "resume", "active"],
          ["accept", "accept", "active"],
        ] as const) {
          await act(async () => {
            actionButton(attribute).props.onClick();
          });
          expect(text()).toContain("Task: ");
          expect(text()).toContain("Fix parser behavior");
          expect(text()).toContain("environment-a");
          expect(text()).toContain("Displayed revision:");
          expect(state.reviewDecide).toHaveBeenCalledTimes(
            action === "redirect" ? 0 : action === "resume" ? 1 : 2,
          );
          await act(async () => {
            renderer.root
              .findAllByType("button")
              .find((node) => node.children.includes("Confirm decision"))!
              .props.onClick();
          });
          const facts = await EffectForFixture.runPromise(fixture.facts());
          expect(facts).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            phase: expected,
            acceptedRevision: action === "accept" ? 1 : null,
          });
          expect(text()).toContain(expected);
          expect(text()).toContain("Command ledger:");
          expect(text()).toContain("blocked");
        }
        expect(text()).toContain("accepted 1");
        expect(state.create).not.toHaveBeenCalled();
        expect(state.bind).not.toHaveBeenCalled();
        expect(state.reviewDecide).toHaveBeenCalledTimes(3);
        expect(await EffectForFixture.runPromise(fixture.readSnapshot())).toMatchObject({
          environmentId: "environment-a",
          tasks: [
            {
              state: "blocked",
              gateDecision: "DENY",
              contractReadout: { status: "available", acceptedRevision: 1 },
            },
          ],
        });
      }),
    ),
  );
}, 60_000);

const loadTaskReviewFixture = async () =>
  (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/taskReviewFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withTaskReviewFixture: (
      check: (fixture: {
        readSnapshot: (
          canOperate?: boolean,
        ) => EffectForFixture.Effect<CollaborationSnapshot, Error>;
        saveInstructions: (
          input: Extract<
            import("@t3tools/contracts").OrchestrationV2Command,
            { type: "thread.task-contract.set" }
          >,
        ) => EffectForFixture.Effect<unknown, Error>;
        createAdditional: () => EffectForFixture.Effect<unknown, Error>;
        pauseUnbound: () => EffectForFixture.Effect<unknown, Error>;
        revise: () => EffectForFixture.Effect<unknown, Error>;
        readReview: (
          input: import("@t3tools/contracts").TaskContractReviewInput,
        ) => EffectForFixture.Effect<import("@t3tools/contracts").TaskContractReviewState, Error>;
        decide: (input: {
          threadId: string;
          action: "accept" | "redirect" | "resume";
          revision: number;
          reviewTask: import("@t3tools/contracts").TaskContractReviewReference;
        }) => EffectForFixture.Effect<unknown, Error>;
        facts: () => EffectForFixture.Effect<
          {
            runs: number;
            grants: number;
            outbox: number;
            acceptedRevision: number | null;
            phase: string | undefined;
          },
          Error
        >;
      }) => EffectForFixture.Effect<void, Error>,
      options?: { readonly brake?: import("@t3tools/contracts").TaskContractBrake },
    ) => EffectForFixture.Effect<void, Error>;
  };

it.each([
  "cancel",
  "close",
  "preflight-unmount",
  "preflight-environment",
  "preflight-refresh",
  "confirmation-refresh",
  "confirmation-unmount",
  "confirmation-environment",
  "lost-response",
  "decision-environment",
  "decision-navigation-race",
  "stale-preflight",
  "revision-at-confirm",
] as const)(
  "keeps actual review decisions safe across %s",
  async (mode) => {
    const module = await loadTaskReviewFixture();
    await EffectForFixture.runPromise(
      module.withTaskReviewFixture((fixture) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
          const bridgeRead = async ({
            input,
          }: {
            input: import("@t3tools/contracts").TaskContractReviewInput;
          }) => ({
            _tag: "Success" as const,
            value: await EffectForFixture.runPromise(fixture.readReview(input)),
          });
          const bridgeDecide = async ({
            input,
          }: {
            input: Parameters<typeof fixture.decide>[0];
          }) => ({
            _tag: "Success" as const,
            value: await EffectForFixture.runPromise(fixture.decide(input)),
          });
          state.reviewRead.mockImplementation(bridgeRead);
          state.reviewDecide.mockImplementation(bridgeDecide);
          const preflight = deferred<Awaited<ReturnType<typeof bridgeRead>>>();
          const mutation = deferred<Awaited<ReturnType<typeof bridgeDecide>>>();
          if (mode.startsWith("preflight-") || mode === "stale-preflight")
            state.reviewRead.mockImplementationOnce(() => preflight.promise);
          if (mode === "decision-environment")
            state.reviewDecide.mockImplementationOnce(() => mutation.promise);
          if (mode === "lost-response")
            state.reviewDecide.mockImplementationOnce(async (input) => {
              await bridgeDecide(input);
              return { _tag: "Failure", cause: "fixture lost reply after committed decision" };
            });
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          const button = (name: string) =>
            renderer.root.findAllByType("button").find((node) => node.children.includes(name));
          const action = () =>
            renderer.root
              .findAllByType("button")
              .find((node) => node.props["data-task-contract-accept"] !== undefined);
          const click = async (name: string) => {
            await act(async () => {
              button(name)!.props.onClick();
            });
          };
          const initial = (await EffectForFixture.runPromise(fixture.readSnapshot())).tasks[0]!;
          const target = {
            environmentId: "environment-a",
            taskId: initial.id,
            projectId: initial.projectId,
            threadId: initial.threadId!,
            revision: 1,
          };
          const retire = async () => {
            if (mode.endsWith("unmount")) await act(async () => renderer.unmount());
            else if (mode.endsWith("environment")) {
              state.environmentId = "environment-b";
              state.snapshot = {
                ...(await EffectForFixture.runPromise(fixture.readSnapshot())),
                environmentId: "environment-b",
              };
              state.load.mockResolvedValue(state.snapshot);
              await act(async () => renderer.update(<TasksPage />));
              await selectOnlyInboxTaskForDetailJourney(renderer);
            } else await click("Refresh tasks");
          };
          const originalAction = action()!;
          await act(async () => {
            originalAction.props.onClick();
            originalAction.props.onClick();
          });
          expect(state.reviewRead).toHaveBeenCalledTimes(1);
          expect(state.reviewDecide).not.toHaveBeenCalled();
          if (mode.startsWith("preflight-")) {
            await retire();
            await act(async () => preflight.resolve(await bridgeRead({ input: target })));
          } else if (mode === "stale-preflight") {
            const fresh = await bridgeRead({ input: target });
            if (fresh.value.status !== "available") throw new Error("fixture review unavailable");
            await EffectForFixture.runPromise(
              fixture.decide({
                threadId: target.threadId,
                action: "redirect",
                revision: 1,
                reviewTask: fresh.value.reference,
              }),
            );
            await act(async () => preflight.resolve(await bridgeRead({ input: target })));
            expect(text()).toContain("could not be confirmed");
          } else {
            expect(button("Confirm decision")).toBeDefined();
            if (mode === "cancel") await click("Cancel");
            else if (mode === "close")
              await act(async () =>
                renderer.root.findByProps({ "data-review-dialog": "" }).props.onClose(),
              );
            else if (mode.startsWith("confirmation-")) await retire();
            else {
              let staleRead: ReturnType<typeof deferred<CollaborationSnapshot>> | undefined;
              if (mode === "decision-navigation-race") {
                staleRead = deferred<CollaborationSnapshot>();
                state.load.mockReturnValueOnce(staleRead.promise);
              }
              if (mode === "revision-at-confirm")
                await EffectForFixture.runPromise(fixture.revise());
              const confirm = button("Confirm decision")!;
              await act(async () => {
                confirm.props.onClick();
                confirm.props.onClick();
              });
              expect(state.reviewDecide).toHaveBeenCalledTimes(1);
              if (mode === "decision-navigation-race") {
                state.environmentId = "environment-b";
                await act(async () => renderer.update(<TasksPage />));
                await selectOnlyInboxTaskForDetailJourney(renderer);
                state.environmentId = "environment-a";
                await act(async () => renderer.update(<TasksPage />));
                await selectOnlyInboxTaskForDetailJourney(renderer);
                await act(async () =>
                  staleRead!.resolve({
                    ...(await EffectForFixture.runPromise(fixture.readSnapshot())),
                    tasks: [initial],
                  }),
                );
                expect(text()).toContain("accepted 1");
              }
              if (mode === "decision-environment") {
                await retire();
                await act(async () =>
                  mutation.resolve({ _tag: "Success", value: { sequence: 1 } }),
                );
                expect(text()).not.toContain("Acceptance recorded");
              } else if (mode === "revision-at-confirm") {
                expect(text()).toContain("could not be confirmed");
                expect(action()).toBeUndefined();
                await click("Refresh tasks");
                expect(text()).toContain("Revised parser behavior");
                expect(action()).toBeDefined();
                expect(state.reviewDecide).toHaveBeenCalledTimes(1);
              } else if (mode === "lost-response") {
                expect(text()).toContain("outcome is uncertain");
                expect(action()).toBeUndefined();
                expect((await EffectForFixture.runPromise(fixture.facts())).acceptedRevision).toBe(
                  1,
                );
                await click("Refresh tasks");
                expect(text()).toContain("accepted 1");
                expect(text()).not.toContain("outcome is uncertain");
              } else {
                expect((await EffectForFixture.runPromise(fixture.facts())).acceptedRevision).toBe(
                  1,
                );
                expect(text()).toContain("accepted 1");
              }
            }
          }
          if (
            ![
              "lost-response",
              "decision-environment",
              "decision-navigation-race",
              "revision-at-confirm",
            ].includes(mode)
          )
            expect(state.reviewDecide).not.toHaveBeenCalled();
          const facts = await EffectForFixture.runPromise(fixture.facts());
          expect(facts.runs + facts.grants + facts.outbox).toBe(0);
          if (!["lost-response", "decision-navigation-race"].includes(mode))
            expect(facts.acceptedRevision).toBeNull();
          expect(state.create).not.toHaveBeenCalled();
          expect(state.bind).not.toHaveBeenCalled();
        }),
      ),
    );
  },
  60_000,
);

it.each(["readonly", "wrong-environment"] as const)(
  "does not expose review actions from actual %s snapshots",
  async (mode) => {
    const module = await loadTaskReviewFixture();
    await EffectForFixture.runPromise(
      module.withTaskReviewFixture((fixture) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(async () => ({
            ...(await EffectForFixture.runPromise(fixture.readSnapshot(mode !== "readonly"))),
            ...(mode === "wrong-environment" ? { environmentId: "environment-b" } : {}),
          }));
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          expect(
            renderer.root
              .findAllByType("button")
              .filter(
                (b) =>
                  b.props["data-task-contract-accept"] !== undefined ||
                  b.props["data-task-contract-redirect-action"] !== undefined,
              ),
          ).toHaveLength(0);
          expect(state.reviewRead).not.toHaveBeenCalled();
          expect(state.reviewDecide).not.toHaveBeenCalled();
          expect((await EffectForFixture.runPromise(fixture.facts())).acceptedRevision).toBeNull();
        }),
      ),
    );
  },
  60_000,
);

it("isolates explicitly confirmed decisions on two actual governed Tasks roots", async () => {
  const module = await loadTaskReviewFixture();
  await EffectForFixture.runPromise(
    module.withTaskReviewFixture((fixture) =>
      EffectForFixture.promise(async () => {
        await EffectForFixture.runPromise(fixture.createAdditional());
        state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
        state.reviewRead.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(fixture.readReview(input)),
        }));
        state.reviewDecide.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(fixture.decide(input)),
        }));
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        expect(
          renderer.root
            .findAllByType("button")
            .filter((b) => b.props["data-task-contract-accept"] !== undefined),
        ).toHaveLength(0);
        for (const root of ["task-parser", "task-second"]) {
          const selectedTask = (
            await EffectForFixture.runPromise(fixture.readSnapshot())
          ).tasks.find((t) => t.threadId === root)!;
          await selectExactInboxTask(selectedTask);
          const buttons = renderer.root
            .findAllByType("button")
            .filter((b) => b.props["data-task-contract-accept"] !== undefined);
          await act(async () => buttons[0]!.props.onClick());
          expect(state.reviewRead.mock.calls.at(-1)?.[0]).toMatchObject({
            environmentId: "environment-a",
            input: { threadId: root, environmentId: "environment-a" },
          });
          await act(async () =>
            renderer.root
              .findAllByType("button")
              .find((b) => b.children.includes("Confirm decision"))!
              .props.onClick(),
          );
          expect(state.reviewDecide.mock.calls.at(-1)?.[0]).toMatchObject({
            environmentId: "environment-a",
            input: { threadId: root, revision: 1 },
          });
          const snapshot = await EffectForFixture.runPromise(fixture.readSnapshot());
          expect(snapshot.tasks.find((t) => t.threadId === root)?.contractReadout).toMatchObject({
            acceptedRevision: 1,
          });
          if (root === "task-parser")
            expect(
              snapshot.tasks.find((t) => t.threadId === "task-second")?.contractReadout,
            ).toMatchObject({ acceptedRevision: null });
          expect(snapshot.tasks.every((t) => t.state === "blocked")).toBe(true);
        }
        expect(state.reviewDecide).toHaveBeenCalledTimes(2);
        expect((await EffectForFixture.runPromise(fixture.facts())).runs).toBe(0);
        expect((await EffectForFixture.runPromise(fixture.facts())).grants).toBe(0);
      }),
    ),
  );
}, 60_000);

it("opens an instruction editor only after an actual owned root is explicitly paused", async () => {
  const module = await loadTaskReviewFixture();
  await EffectForFixture.runPromise(
    module.withTaskReviewFixture((fixture) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
        state.reviewRead.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(fixture.readReview(input)),
        }));
        state.reviewDecide.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(fixture.decide(input)),
        }));
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        await act(async () =>
          renderer.root
            .findAllByType("button")
            .find((b) => b.props["data-task-contract-redirect-action"] !== undefined)!
            .props.onClick(),
        );
        await act(async () =>
          renderer.root
            .findAllByType("button")
            .find((b) => b.children.includes("Confirm decision"))!
            .props.onClick(),
        );
        expect((await EffectForFixture.runPromise(fixture.facts())).phase).toBe("redirected");
        expect(
          renderer.root
            .findAllByType("button")
            .find((b) => b.children.includes("Revise paused instructions")),
        ).toBeDefined();
      }),
    ),
  );
}, 60_000);

it("pauses, previews and saves new instructions still paused, then separately resumes through actual services with full Brake retention", async () => {
  const module = await loadTaskReviewFixture();
  const brake = {
    maxProviderStarts: 2,
    stopConditions: "Scope changed",
    maxTokens: 1000,
    maxCostUsd: 1,
    deadlineAt: "2030-01-01T00:00:00.000Z",
  };
  await EffectForFixture.runPromise(
    module.withTaskReviewFixture(
      (fixture) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
          state.reviewRead.mockImplementation(async ({ input }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(fixture.readReview(input)),
          }));
          state.reviewDecide.mockImplementation(async ({ input }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(
              input.action === "set"
                ? fixture.saveInstructions({
                    type: "thread.task-contract.set",
                    commandId: CommandId.make(
                      `instruction-ui-set:${state.reviewDecide.mock.calls.length}`,
                    ),
                    ...input,
                  })
                : fixture.decide(input),
            ),
          }));
          const button = (name: string) =>
            renderer.root.findAllByType("button").find((b) => b.children.includes(name));
          const click = async (name: string) => {
            await act(async () => button(name)!.props.onClick());
          };
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          expect(button("Revise paused instructions")).toBeUndefined();
          await act(async () =>
            renderer.root
              .findAllByType("button")
              .find((b) => b.props["data-task-contract-redirect-action"] !== undefined)!
              .props.onClick(),
          );
          await click("Confirm decision");
          await click("Revise paused instructions");
          expect(text()).toContain("Brake is read-only");
          expect(text()).toContain("2030-01-01");
          expect(button("Resume under this contract")).toBeUndefined();
          expect(button("Preview instruction changes")!.props.disabled).toBe(true);
          for (const [field, value] of [
            ["goal", "New parser goal"],
            ["redirect", "Ask before scope expansion"],
            ["acceptance", "Owner checks new evidence"],
          ] as const)
            await act(async () =>
              renderer.root
                .findByProps({ "aria-label": `${field} instruction` })
                .props.onChange({ target: { value } }),
            );
          await click("Preview instruction changes");
          expect(text()).toContain("Save revision 2?");
          expect(text()).toContain("Task remains paused");
          expect(text()).toContain("separate Resume");
          expect(text()).toContain("New parser goal");
          expect(state.reviewDecide).toHaveBeenCalledTimes(1);
          await click("Cancel");
          expect(renderer.root.findByProps({ "aria-label": "goal instruction" }).props.value).toBe(
            "New parser goal",
          );
          await click("Preview instruction changes");
          await click("Save new revision");
          const snapshot = await EffectForFixture.runPromise(fixture.readSnapshot());
          expect(snapshot.tasks[0]?.contractReadout).toMatchObject({
            status: "available",
            phase: "redirected",
            acceptedRevision: null,
            contract: {
              revision: 2,
              goal: "New parser goal",
              redirect: "Ask before scope expansion",
              acceptance: "Owner checks new evidence",
              brake,
            },
          });
          expect(snapshot.tasks[0]?.state).toBe("blocked");
          expect(text()).toContain("Task remains paused");
          expect(state.reviewDecide).toHaveBeenCalledTimes(2);
          await click("Resume under this contract");
          expect(state.reviewDecide).toHaveBeenCalledTimes(2);
          await click("Confirm decision");
          expect(state.reviewDecide).toHaveBeenCalledTimes(3);
          expect(await EffectForFixture.runPromise(fixture.facts())).toEqual({
            phase: "active",
            acceptedRevision: null,
            runs: 0,
            grants: 0,
            outbox: 0,
          });
          expect(state.create).not.toHaveBeenCalled();
          expect(state.bind).not.toHaveBeenCalled();
        }),
      { brake },
    ),
  );
}, 60_000);

it.each([
  "open-unmount",
  "open-environment",
  "open-refresh",
  "editor-cancel",
  "confirmation-close",
  "preview-cancel-late",
  "preview-unmount",
  "preview-environment",
  "preview-refresh",
  "stale-preview",
  "stale-confirmation",
  "commit-lost-response",
  "commit-refresh-late-failure",
  "commit-refresh-late-rejection",
  "commit-environment",
  "commit-refresh-navigation",
] as const)(
  "retires paused instruction edits safely across %s",
  async (mode) => {
    const module = await loadTaskReviewFixture();
    await EffectForFixture.runPromise(
      module.withTaskReviewFixture((fixture) =>
        EffectForFixture.promise(async () => {
          const task = (await EffectForFixture.runPromise(fixture.readSnapshot())).tasks[0]!;
          const target = {
            environmentId: "environment-a",
            taskId: task.id,
            projectId: task.projectId,
            threadId: task.threadId!,
            revision: 1,
          };
          const initial = await EffectForFixture.runPromise(fixture.readReview(target));
          if (initial.status !== "available") throw new Error("Fixture root unavailable");
          await EffectForFixture.runPromise(
            fixture.decide({
              threadId: target.threadId,
              action: "redirect",
              revision: 1,
              reviewTask: initial.reference,
            }),
          );
          state.load.mockImplementation(() => EffectForFixture.runPromise(fixture.readSnapshot()));
          const read = async ({
            input,
          }: {
            input: import("@t3tools/contracts").TaskContractReviewInput;
          }) => ({
            _tag: "Success" as const,
            value: await EffectForFixture.runPromise(fixture.readReview(input)),
          });
          const save = async ({
            input,
          }: {
            input: Parameters<typeof fixture.saveInstructions>[0];
          }) => ({
            _tag: "Success" as const,
            value: await EffectForFixture.runPromise(
              fixture.saveInstructions({
                ...input,
                type: "thread.task-contract.set",
                commandId: CommandId.make("instruction-race-save"),
              }),
            ),
          });
          state.reviewRead.mockImplementation(read);
          state.reviewDecide.mockImplementation(save);
          const preflight = deferred<Awaited<ReturnType<typeof read>>>();
          const receipt = deferred<Awaited<ReturnType<typeof save>>>();
          const refresh = deferred<CollaborationSnapshot>();
          if (mode.startsWith("open-"))
            state.reviewRead.mockImplementationOnce(() => preflight.promise);
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          const button = (name: string) =>
            renderer.root.findAllByType("button").find((b) => b.children.includes(name));
          const click = async (name: string) => {
            await act(async () => button(name)!.props.onClick());
          };
          const retire = async () => {
            if (mode.endsWith("unmount")) await act(async () => renderer.unmount());
            else if (mode.endsWith("environment")) {
              state.environmentId = "environment-b";
              await act(async () => renderer.update(<TasksPage />));
              await selectOnlyInboxTaskForDetailJourney(renderer);
            } else await click("Refresh tasks");
          };
          const edit = button("Revise paused instructions")!;
          await act(async () => {
            edit.props.onClick();
            edit.props.onClick();
          });
          expect(state.reviewRead).toHaveBeenCalledTimes(1);
          if (mode.startsWith("open-")) {
            await retire();
            await act(async () => preflight.resolve(await read({ input: target })));
          } else {
            expect(button("Resume under this contract")).toBeUndefined();
            await act(async () =>
              renderer.root
                .findByProps({ "aria-label": "goal instruction" })
                .props.onChange({ target: { value: "Race-edited parser goal" } }),
            );
            if (mode === "editor-cancel") {
              await click("Cancel editing");
              expect(button("Revise paused instructions")).toBeDefined();
            } else {
              if (mode.startsWith("preview-"))
                state.reviewRead.mockImplementationOnce(() => preflight.promise);
              if (mode === "stale-preview") await EffectForFixture.runPromise(fixture.revise());
              const preview = button("Preview instruction changes")!;
              await act(async () => {
                preview.props.onClick();
                preview.props.onClick();
              });
              expect(state.reviewRead).toHaveBeenCalledTimes(2);
              expect(state.reviewDecide).not.toHaveBeenCalled();
              if (mode === "stale-preview") {
                expect(text()).toContain("facts changed");
                expect(button("Save new revision")).toBeUndefined();
              } else if (mode === "preview-cancel-late") {
                await click("Cancel editing");
                await act(async () => preflight.resolve(await read({ input: target })));
                expect(button("Save new revision")).toBeUndefined();
                expect(button("Revise paused instructions")).toBeDefined();
              } else if (mode.startsWith("preview-")) {
                await retire();
                await act(async () => preflight.resolve(await read({ input: target })));
              } else if (mode === "confirmation-close") {
                await act(async () =>
                  renderer.root.findByProps({ "data-review-dialog": "" }).props.onClose(),
                );
                expect(
                  renderer.root.findByProps({ "aria-label": "goal instruction" }).props.value,
                ).toBe("Race-edited parser goal");
                await click("Cancel editing");
              } else {
                if (mode === "stale-confirmation")
                  await EffectForFixture.runPromise(fixture.revise());
                if (mode === "commit-lost-response")
                  state.reviewDecide.mockImplementationOnce(async (args) => {
                    await save(args);
                    return { _tag: "Failure", cause: "Lost committed reply" };
                  });
                if (mode === "commit-environment")
                  state.reviewDecide.mockImplementationOnce(async (args) => {
                    const result = await save(args);
                    await receipt.promise;
                    return result;
                  });
                if (mode.startsWith("commit-refresh-late-"))
                  state.reviewDecide.mockImplementationOnce(async (args) => {
                    await save(args);
                    await receipt.promise;
                    return { _tag: "Failure", cause: "Lost committed reply after refresh" };
                  });
                if (mode === "commit-refresh-navigation")
                  state.load.mockReturnValueOnce(refresh.promise);
                const confirm = button("Save new revision")!;
                await act(async () => {
                  confirm.props.onClick();
                  confirm.props.onClick();
                });
                expect(state.reviewDecide).toHaveBeenCalledTimes(1);
                if (mode.startsWith("commit-refresh-late-")) {
                  expect(button("Resume under this contract")).toBeUndefined();
                  await click("Refresh tasks");
                  expect(text()).toContain("Race-edited parser goal");
                  expect(
                    renderer.root
                      .findByProps({ "data-task-contract-phase": "redirected" })
                      .children.join(""),
                  ).toContain("Revision 2");
                  expect(button("Resume under this contract")).toBeUndefined();
                  await act(async () => {
                    if (mode === "commit-refresh-late-rejection")
                      receipt.reject(new Error("Lost committed reply after refresh"));
                    else receipt.resolve({ _tag: "Success", value: { sequence: 1 } });
                  });
                  expect(text()).toMatch(/uncertain|could not be confirmed/);
                  expect(text()).toMatch(/Refresh task facts/);
                  expect(text()).not.toContain("Revision 2 saved");
                  expect(button("Revise paused instructions")).toBeUndefined();
                  expect(button("Resume under this contract")).toBeUndefined();
                  expect(state.reviewDecide).toHaveBeenCalledTimes(1);
                  await click("Refresh tasks");
                  expect(button("Revise paused instructions")).toBeDefined();
                  expect(button("Resume under this contract")).toBeDefined();
                  expect(text()).not.toMatch(/uncertain|could not be confirmed/);
                  expect(state.reviewDecide).toHaveBeenCalledTimes(1);
                  const freshTask = (await EffectForFixture.runPromise(fixture.readSnapshot()))
                    .tasks[0]!;
                  expect(
                    freshTask.contractReadout?.status === "available" &&
                      freshTask.contractReadout.contract.revision,
                  ).toBe(2);
                }
                if (mode === "commit-environment") {
                  await retire();
                  await act(async () =>
                    receipt.resolve({ _tag: "Success", value: { sequence: 1 } }),
                  );
                  expect(text()).not.toContain("Revision 2 saved");
                }
                if (mode === "commit-refresh-navigation") {
                  state.environmentId = "environment-b";
                  await act(async () => renderer.update(<TasksPage />));
                  await selectOnlyInboxTaskForDetailJourney(renderer);
                  state.environmentId = "environment-a";
                  await act(async () => renderer.update(<TasksPage />));
                  await selectOnlyInboxTaskForDetailJourney(renderer);
                  await act(async () =>
                    refresh.resolve({
                      ...(await EffectForFixture.runPromise(fixture.readSnapshot())),
                      tasks: [task],
                    }),
                  );
                  expect(text()).toContain("Race-edited parser goal");
                  expect(text()).not.toContain("Revision 2 saved");
                }
                if (mode === "commit-lost-response" || mode === "stale-confirmation") {
                  expect(text()).toMatch(/uncertain|could not be confirmed/);
                  expect(button("Revise paused instructions")).toBeUndefined();
                  expect(button("Resume under this contract")).toBeUndefined();
                  await click("Refresh tasks");
                  expect(state.reviewDecide).toHaveBeenCalledTimes(1);
                  if (mode === "commit-lost-response") {
                    expect(button("Revise paused instructions")).toBeDefined();
                    expect(text()).toContain("Race-edited parser goal");
                  } else expect(button("Revise paused instructions")).toBeUndefined();
                }
              }
            }
          }
          const facts = await EffectForFixture.runPromise(fixture.facts());
          expect(facts.runs + facts.grants + facts.outbox).toBe(0);
          expect(facts.acceptedRevision).toBeNull();
          if (!mode.startsWith("commit-") && mode !== "stale-confirmation")
            expect(state.reviewDecide).not.toHaveBeenCalled();
          expect(state.create).not.toHaveBeenCalled();
          expect(state.bind).not.toHaveBeenCalled();
        }),
      ),
    );
  },
  60_000,
);

it.each(["active", "accepted", "accepted-paused", "paused-readonly"] as const)(
  "does not expose an instruction editor for actual %s roots",
  async (mode) => {
    const module = await loadTaskReviewFixture();
    await EffectForFixture.runPromise(
      module.withTaskReviewFixture((fixture) =>
        EffectForFixture.promise(async () => {
          const task = (await EffectForFixture.runPromise(fixture.readSnapshot())).tasks[0]!;
          const input = {
            environmentId: "environment-a",
            taskId: task.id,
            projectId: task.projectId,
            threadId: task.threadId!,
            revision: 1,
          };
          if (mode.startsWith("accepted")) {
            const facts = await EffectForFixture.runPromise(fixture.readReview(input));
            if (facts.status !== "available") throw new Error("Fixture unavailable");
            await EffectForFixture.runPromise(
              fixture.decide({
                threadId: task.threadId!,
                action: "accept",
                revision: 1,
                reviewTask: facts.reference,
              }),
            );
          }
          if (mode === "accepted-paused" || mode === "paused-readonly")
            await EffectForFixture.runPromise(fixture.pauseUnbound());
          state.load.mockImplementation(() =>
            EffectForFixture.runPromise(fixture.readSnapshot(mode !== "paused-readonly")),
          );
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          expect(
            renderer.root
              .findAllByType("button")
              .find((b) => b.children.includes("Revise paused instructions")),
          ).toBeUndefined();
          expect(state.reviewRead).not.toHaveBeenCalled();
          expect(state.reviewDecide).not.toHaveBeenCalled();
          expect((await EffectForFixture.runPromise(fixture.facts())).runs).toBe(0);
        }),
      ),
    );
  },
  60_000,
);

it.each([
  "lost-reject",
  "late-success",
  "late-failure",
  "reload",
  "context-roundtrip",
  "late-status",
  "principal-switch",
] as const)(
  "recovers proved rejected creation then separately reviews one new task across %s",
  async (mode) => {
    const storage = creationStorage();
    const module = await loadAgentsCreationFixture();
    await EffectForFixture.runPromise(
      module.withAgentsTaskCreationFixture((f) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          state.readCreationStatus.mockImplementation(
            async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(f.readStatus(input.command)),
            }),
          );
          state.readProjection.mockImplementation(
            async ({ input }: { input: { threadId: string } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(
                f.orchestrator.getThreadProjection(input.threadId),
              ),
            }),
          );
          const oldReply = deferred<void>();
          let calls = 0;
          state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => {
            calls++;
            if (calls === 1) {
              f.setProviders([]);
              const result = await EffectForFixture.runPromise(
                EffectForFixture.exit(f.dispatch(input)),
              );
              expect(result._tag).toBe("Failure");
              f.setProviders([module.agentsCreationProvider]);
              if (mode !== "lost-reject") await oldReply.promise;
              if (mode === "late-success") return { _tag: "Success", value: { sequence: 0 } };
              return { _tag: "Failure", cause: "Lost rejected response" };
            }
            return { _tag: "Success", value: await EffectForFixture.runPromise(f.dispatch(input)) };
          });
          await mount();
          await creationClick("New task");
          await fillCreation("Rejected old attempt");
          await creationClick("Review new task");
          await creationClick("Create task");
          const old = state.create.mock.calls[0]![0].input as OrchestrationV2Command;
          expect(creationButton("New task")!.props.disabled).toBe(true);
          if (mode === "reload") {
            await act(async () => renderer.unmount());
            await mount();
          }
          const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
          const originalSessionIdentity = state.sessionIdentity;
          const oldStatus = deferred<{ _tag: "Success"; value: { status: "rejected" } }>();
          if (mode === "late-status" || mode === "principal-switch") {
            state.readCreationStatus.mockImplementationOnce(() => oldStatus.promise);
            await creationClick("Recover task creation");
            expect(creationButton("New task")!.props.disabled).toBe(true);
            if (mode === "principal-switch") {
              state.sessionIdentity = {};
              await act(async () => renderer.update(<AgentsPage />));
              state.readCreationStatus.mockImplementation(
                async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
                  _tag: "Success",
                  value: await EffectForFixture.runPromise(
                    f.readStatus(input.command, {
                      kind: "session",
                      actorId: "foreign",
                      sessionId: "foreign-session",
                      scopes: ["orchestration:read", "orchestration:operate"],
                    }),
                  ),
                }),
              );
              await act(async () =>
                oldStatus.resolve({ _tag: "Success", value: { status: "rejected" } }),
              );
              expect(creationButton("New task")!.props.disabled).toBe(true);
              await creationClick("Recover task creation");
              expect(text()).toContain("uncertain");
              expect(creationButton("New task")!.props.disabled).toBe(true);
              state.sessionIdentity = originalSessionIdentity;
              await act(async () => renderer.update(<AgentsPage />));
              state.readCreationStatus.mockImplementation(
                async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
                  _tag: "Success",
                  value: await EffectForFixture.runPromise(f.readStatus(input.command)),
                }),
              );
            } else {
              state.environmentId = "environment-b";
              await act(async () => renderer.update(<AgentsPage />));
              state.environmentId = "environment-a";
              await act(async () => renderer.update(<AgentsPage />));
            }
          }
          await creationClick("Recover task creation", true);
          expect(text()).toContain("attempt was rejected");
          expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(
            before,
          );
          expect(creationButton("New task")!.props.disabled).toBe(false);
          expect(state.create).toHaveBeenCalledTimes(1);
          expect((await EffectForFixture.runPromise(f.readSnapshot())).tasks).toHaveLength(0);
          expect(state.navigate).not.toHaveBeenCalled();
          if (mode === "context-roundtrip") {
            state.environmentId = "environment-b";
            await act(async () => renderer.update(<AgentsPage />));
            state.environmentId = "environment-a";
            await act(async () => renderer.update(<AgentsPage />));
            expect(creationButton("New task")!.props.disabled).toBe(true);
            await creationClick("Recover task creation");
          }
          if (mode === "reload") {
            await act(async () => renderer.unmount());
            await mount();
            expect(creationButton("New task")!.props.disabled).toBe(true);
            expect(decodeCreationStorage([...storage.values()][0]!)).toMatchObject({
              status: "rejected",
            });
            await creationClick("Recover task creation");
          }
          await creationClick("New task");
          await fillCreation("Separate new task");
          await creationClick("Review new task");
          await act(async () => {
            oldReply.resolve();
            oldStatus.resolve({ _tag: "Success", value: { status: "rejected" } });
          });
          expect(text()).toContain("Separate new task");
          expect(state.create).toHaveBeenCalledTimes(1);
          await creationClick("Create task", true);
          expect(state.create).toHaveBeenCalledTimes(2);
          const next = state.create.mock.calls[1]![0].input as Extract<
            OrchestrationV2Command,
            { type: "thread.create" }
          >;
          expect(next.commandId).not.toBe(old.commandId);
          expect(next.threadId).not.toBe("threadId" in old ? old.threadId : undefined);
          expect(
            (await EffectForFixture.runPromise(f.readSnapshot())).tasks.map((t) => t.threadId),
          ).toEqual([next.threadId]);
          expect(decodeCreationStorage([...storage.values()][0]!)).toMatchObject({
            status: "confirmed",
            command: { commandId: next.commandId },
          });
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
          expect(state.bind).not.toHaveBeenCalled();
          expect(state.navigate).not.toHaveBeenCalled();
        }),
      ),
    );
  },
);

it("selection basis preview prepares reviewed first instructions for an actual owned empty root without starting it", async () => {
  const module = await loadAgentsCreationFixture();
  await EffectForFixture.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      EffectForFixture.promise(async () => {
        const command: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
          type: "thread.create",
          commandId: CommandId.make("first-instructions"),
          threadId: ThreadId.make("first-instructions-root"),
          projectId: "project-a" as Extract<
            OrchestrationV2Command,
            { type: "thread.create" }
          >["projectId"],
          title: "Initial parser task",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          taskGovernance: "required",
          taskContract: {
            goal: "Fix parser",
            redirect: "Ask before expanding",
            acceptance: "Parser tests pass",
            brake: {
              maxProviderStarts: 2,
              stopConditions: "Scope changed",
              maxTokens: 900,
              maxCostUsd: 0.1,
              deadlineAt: "2026-10-14T00:00:00Z",
            },
          },
          taskCreationReview: {
            environmentId: EnvironmentId.make("environment-a"),
            projectId: "project-a" as Extract<
              OrchestrationV2Command,
              { type: "thread.create" }
            >["projectId"],
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
          },
        };
        await EffectForFixture.runPromise(f.dispatch(command));
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        state.reviewRead.mockImplementation(
          async ({ input }: { input: TaskContractReviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.readReview(input)),
          }),
        );
        state.readProjection.mockImplementation(
          async ({ input }: { input: { threadId: string } }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(
              f.orchestrator.getThreadProjection(input.threadId),
            ),
          }),
        );
        state.autoPreview.mockImplementation(
          async ({ input }: { input: TaskAutoPreviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.previewAuto(input)),
          }),
        );
        const target = scopeThreadRef(EnvironmentId.make("environment-a"), command.threadId);
        useComposerDraftStore.setState({
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {},
          backgroundSubmissionThreadKeys: {},
          rewindingThreadKeys: new Set(),
        });
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
        expect(creationButton("Prepare first instructions")).toBeDefined();
        await creationClick("Prepare first instructions", true);
        expect(text()).toContain("Ask before expanding");
        expect(text()).toContain("Parser tests pass");
        expect(text()).toContain("900");
        expect(text()).toContain("0.1");
        expect(text()).toContain("2026-10-14T00:00:00Z");
        const editor = renderer.root.findByProps({ "aria-label": "Initial instructions" });
        expect(editor.props.value).toBe("Fix parser");
        await act(async () => editor.props.onChange({ target: { value: "Fix parser carefully" } }));
        expect(state.autoPreview).not.toHaveBeenCalled();
        expect(creationButton("Preview Auto")).toBeDefined();
        await creationClick("Preview Auto", true);
        expect(state.autoPreview).toHaveBeenCalledTimes(1);
        expect(text()).toContain("Deterministic local classification");
        expect(text()).toContain("Detailed ranking basis");
        expect(text()).toContain("Only one eligible candidate remained in the selectable ranking.");
        expect(text()).toContain("unknown");
        expect(text()).toContain("not permission");
        const estimatedCatalog = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            model: "estimate-a",
            isDefault: true,
            capabilities: ["code" as const],
            availabilityReasons: [],
            metrics: {
              quality: { status: "known" as const, value: 20 },
              costUsd: { status: "known" as const, value: 1 },
              latencyMs: { status: "known" as const, value: 10 },
            },
          },
          {
            instanceId: ProviderInstanceId.make("other"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "estimate-b",
            isDefault: false,
            capabilities: ["code" as const],
            availabilityReasons: [],
            metrics: {
              quality: { status: "known" as const, value: 10 },
              costUsd: { status: "known" as const, value: 1 },
              latencyMs: { status: "known" as const, value: 10 },
            },
          },
        ];
        const displayCases = [
          {
            decision: routeModel({
              mode: "auto",
              catalog: estimatedCatalog,
              preferredTargets: [estimatedCatalog[0]!],
            }),
            expected: "Higher weighted catalog-estimate score decided the selection (9 vs -1).",
          },
          {
            decision: routeModel({
              mode: "auto",
              catalog: [
                estimatedCatalog[0]!,
                {
                  ...estimatedCatalog[1]!,
                  metrics: { ...estimatedCatalog[1]!.metrics, quality: { status: "unknown" } },
                },
              ],
              policy: {
                version: "model-router.v0",
                qualityWeight: 1,
                costWeight: 0,
                latencyWeight: 1,
              },
            }),
            expected: "Equal weighted scores (-10); tie-break stages used: driver.",
          },
        ];
        for (const display of displayCases) {
          state.autoPreview.mockImplementation(
            async ({ input }: { input: TaskAutoPreviewInput }) => {
              const actual = await EffectForFixture.runPromise(f.previewAuto(input));
              return {
                _tag: "Success",
                value: { ...actual, decision: display.decision, hybrid: undefined },
              };
            },
          );
          await creationClick("Preview Auto", true);
          expect(text()).toContain(display.expected);
          expect(text()).toContain(
            "Catalog estimates are not measured quality, verified spend, or a prediction of success.",
          );
        }
        expect(text()).toContain("incomplete eligible-candidate estimates");
        expect(text()).toContain("zero weight");
        expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
        expect(state.navigate).not.toHaveBeenCalled();
        await creationClick("Fill empty draft and open", true);
        expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
          "Fix parser carefully",
        );
        expect(state.navigate).toHaveBeenCalledTimes(1);
        expect(state.navigate).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: { environmentId: "environment-a", threadId: command.threadId },
        });
        expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(
          before,
        );
        expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
        expect(state.create).not.toHaveBeenCalled();
        expect(state.reviewDecide).not.toHaveBeenCalled();
        expect(state.bind).not.toHaveBeenCalled();
      }),
    ),
  );
});

it.each([
  "typed-during-read",
  "attachment",
  "context",
  "queued-edit",
  "session",
  "environment",
  "project",
  "unmount",
  "reload",
  "cancel-new-review",
  "revision",
  "pause",
  "accept",
  "delete",
  "message",
  "run",
  "foreign",
  "review-failure",
  "projection-failure",
  "incoherent-review",
] as const)(
  "preserves drafts and retires first-instruction preparation across %s",
  async (mode) => {
    const module = await loadAgentsCreationFixture();
    await EffectForFixture.runPromise(
      module.withAgentsTaskCreationFixture((f) =>
        EffectForFixture.promise(async () => {
          const c: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
            type: "thread.create",
            commandId: CommandId.make(`prepare:${mode}`),
            threadId: ThreadId.make(`prepare-${mode}`),
            projectId: "project-a" as Extract<
              OrchestrationV2Command,
              { type: "thread.create" }
            >["projectId"],
            title: "Prepare this task",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
            taskGovernance: "required",
            taskContract: {
              goal: "Fix parser",
              redirect: "Ask",
              acceptance: "Owner checks",
              brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
            },
            taskCreationReview: {
              environmentId: EnvironmentId.make("environment-a"),
              projectId: "project-a" as Extract<
                OrchestrationV2Command,
                { type: "thread.create" }
              >["projectId"],
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
            },
          };
          await EffectForFixture.runPromise(f.dispatch(c));
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          const read = async ({ input }: { input: TaskContractReviewInput }) => ({
            _tag: "Success" as const,
            value: await EffectForFixture.runPromise(f.readReview(input)),
          });
          state.reviewRead.mockImplementation(read);
          state.readProjection.mockImplementation(
            async ({ input }: { input: { threadId: string } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(
                f.orchestrator.getThreadProjection(input.threadId),
              ),
            }),
          );
          const target = scopeThreadRef(EnvironmentId.make("environment-a"), c.threadId);
          const key = scopedThreadKey(target);
          useComposerDraftStore.setState({
            draftsByThreadKey: {},
            draftThreadsByThreadKey: {},
            backgroundSubmissionThreadKeys: {},
            rewindingThreadKeys: new Set(),
          });
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          await creationClick("Prepare first instructions");
          expect(creationButton("Fill empty draft and open")).toBeDefined();
          const gated = deferred<{ _tag: "Success"; value: TaskContractReviewState }>();
          state.reviewRead.mockImplementationOnce(() => gated.promise);
          const oldApply = creationButton("Fill empty draft and open")!.props.onClick;
          await act(async () => oldApply());
          if (mode === "typed-during-read")
            useComposerDraftStore.getState().setPrompt(target, "My own instructions");
          if (mode === "attachment" || mode === "context" || mode === "queued-edit") {
            useComposerDraftStore.getState().setPrompt(target, "Temporary seed");
            const base = {
              ...useComposerDraftStore.getState().getComposerDraft(target)!,
              prompt: "",
            };
            useComposerDraftStore.setState({ draftsByThreadKey: { [key]: base } });
            useComposerDraftStore.setState({
              draftsByThreadKey: {
                ...useComposerDraftStore.getState().draftsByThreadKey,
                [mode === "queued-edit" ? `queued-edit:${key}:existing-run` : key]: {
                  ...base,
                  ...(mode === "attachment"
                    ? { nonPersistedImageIds: ["pending-upload"] }
                    : mode === "context"
                      ? {
                          terminalContexts: [
                            {
                              id: "context",
                              threadId: c.threadId,
                              terminalId: "terminal",
                              terminalLabel: "Terminal",
                              lineStart: 1,
                              lineEnd: 2,
                              text: "Existing context",
                              createdAt: "2026-10-13T00:00:00Z",
                            },
                          ],
                        }
                      : { prompt: "Queued edit" }),
                },
              },
            });
          }
          if (mode === "session") {
            state.sessionIdentity = {};
            await act(async () => renderer.update(<TasksPage />));
            await selectOnlyInboxTaskForDetailJourney(renderer);
          }
          if (mode === "environment") {
            state.environmentId = "environment-b";
            await act(async () => renderer.update(<TasksPage />));
            await selectOnlyInboxTaskForDetailJourney(renderer);
          }
          if (mode === "project") {
            state.load.mockResolvedValue({
              ...(await EffectForFixture.runPromise(f.readSnapshot())),
              tasks: [],
            });
            await creationClick("Refresh tasks");
          }
          if (mode === "unmount" || mode === "reload") {
            await act(async () => renderer.unmount());
            if (mode === "reload")
              await act(async () => {
                renderer = create(<TasksPage />);
              });
            await selectOnlyInboxTaskForDetailJourney(renderer);
          }
          if (mode === "cancel-new-review") {
            await creationClick("Cancel preparation");
            await creationClick("Prepare first instructions");
            expect(creationButton("Fill empty draft and open")).toBeDefined();
          }
          if (["revision", "pause", "accept", "delete"].includes(mode)) {
            if (mode === "delete")
              await EffectForFixture.runPromise(
                f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-14T00:00:00Z' WHERE thread_id=${c.threadId}`,
              );
            else
              await EffectForFixture.runPromise(
                f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,${mode === "revision" ? "$.taskContract.revision" : mode === "pause" ? "$.taskContractPhase" : "$.taskAcceptedRevision"},${mode === "revision" ? 2 : mode === "pause" ? "redirected" : 1}) WHERE thread_id=${c.threadId}`,
              );
          }
          if (mode === "foreign")
            await EffectForFixture.runPromise(
              f.sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.admittedBy','foreign') WHERE command_id=${`task:enroll:${c.commandId}`}`,
            );
          if (mode === "message" || mode === "run")
            state.readProjection.mockImplementationOnce(async () => {
              const p = await EffectForFixture.runPromise(
                f.orchestrator.getThreadProjection(c.threadId),
              );
              return {
                _tag: "Success",
                value: { ...p, [mode === "message" ? "messages" : "runs"]: [{ id: "existing" }] },
              };
            });
          if (mode === "review-failure")
            state.reviewRead.mockRejectedValueOnce(new Error("Read failed"));
          if (mode === "projection-failure")
            state.readProjection.mockResolvedValueOnce({
              _tag: "Failure",
              cause: "Projection unavailable",
            });
          if (mode === "incoherent-review")
            state.reviewRead.mockImplementationOnce(async (input) => {
              const r = await read(input);
              return r.value.status === "available"
                ? {
                    _tag: "Success",
                    value: {
                      ...r.value,
                      reference: {
                        ...r.value.reference,
                        threadSequence: r.value.reference.threadSequence + 1,
                      },
                    },
                  }
                : r;
            });
          const retained = useComposerDraftStore.getState().draftsByThreadKey;
          await act(async () =>
            gated.resolve(
              await read({
                input: {
                  environmentId: "environment-a",
                  taskId: `task:governed:thread:${c.threadId}`,
                  projectId: c.projectId,
                  threadId: c.threadId,
                  revision: 1,
                },
              }),
            ),
          );
          expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual(retained);
          expect(state.navigate).not.toHaveBeenCalled();
          expect(state.create).not.toHaveBeenCalled();
          expect(state.reviewDecide).not.toHaveBeenCalled();
          expect(state.bind).not.toHaveBeenCalled();
          if (mode === "cancel-new-review") {
            expect(creationButton("Fill empty draft and open")!.props.disabled).toBe(false);
            await creationClick("Fill empty draft and open");
            expect(state.navigate).toHaveBeenCalledTimes(1);
            expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
              "Fix parser",
            );
          }
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
        }),
      ),
    );
  },
  60_000,
);

it.each([
  "text",
  "newer",
  "session",
  "environment",
  "target",
  "revision",
  "cancel",
  "unmount",
  "error",
  "mismatch",
  "apply-error",
] as const)("retires Auto preview across %s without draft or execution mutations", async (mode) => {
  const module = await loadAgentsCreationFixture();
  await EffectForFixture.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      EffectForFixture.promise(async () => {
        const command: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
          type: "thread.create",
          commandId: CommandId.make(`preview-race:${mode}`),
          threadId: ThreadId.make(`preview-race-${mode}`),
          projectId: "project-a" as Extract<
            OrchestrationV2Command,
            { type: "thread.create" }
          >["projectId"],
          title: "Initial parser task",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          taskGovernance: "required",
          taskContract: {
            goal: "Fix parser",
            redirect: "Ask before expanding",
            acceptance: "Parser tests pass",
            brake: {
              maxProviderStarts: 2,
              stopConditions: "Scope changed",
              maxTokens: 900,
              maxCostUsd: 0.1,
              deadlineAt: "2026-10-14T00:00:00Z",
            },
          },
          taskCreationReview: {
            environmentId: EnvironmentId.make("environment-a"),
            projectId: "project-a" as Extract<
              OrchestrationV2Command,
              { type: "thread.create" }
            >["projectId"],
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
          },
        };
        await EffectForFixture.runPromise(f.dispatch(command));
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        state.reviewRead.mockImplementation(
          async ({ input }: { input: TaskContractReviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.readReview(input)),
          }),
        );
        state.readProjection.mockImplementation(
          async ({ input }: { input: { threadId: string } }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(
              f.orchestrator.getThreadProjection(input.threadId),
            ),
          }),
        );
        state.autoPreview.mockImplementation(
          async ({ input }: { input: TaskAutoPreviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.previewAuto(input)),
          }),
        );
        const target = scopeThreadRef(EnvironmentId.make("environment-a"), command.threadId);
        useComposerDraftStore.setState({
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {},
          backgroundSubmissionThreadKeys: {},
          rewindingThreadKeys: new Set(),
        });
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
        expect(creationButton("Prepare first instructions")).toBeDefined();
        await creationClick("Prepare first instructions", true);
        expect(text()).toContain("Ask before expanding");
        expect(text()).toContain("Parser tests pass");
        expect(text()).toContain("900");
        expect(text()).toContain("0.1");
        expect(text()).toContain("2026-10-14T00:00:00Z");

        const request = state.autoPreview;
        const gated = deferred<{ _tag: "Success"; value: TaskAutoPreviewState }>();
        const real = request.getMockImplementation()!;
        request.mockImplementationOnce(() => gated.promise);
        await creationClick("Preview Auto");
        const args = request.mock.calls[0]![0];
        const result = (await real(args)) as { _tag: "Success"; value: TaskAutoPreviewState };
        if (mode === "text" || mode === "newer")
          await act(async () =>
            renderer.root
              .findByProps({ "aria-label": "Initial instructions" })
              .props.onChange({ target: { value: "New exact instructions" } }),
          );
        if (mode === "newer") {
          await creationClick("Preview Auto");
          expect(request).toHaveBeenCalledTimes(2);
          expect(text()).toContain("Deterministic local classification");
        }
        if (mode === "session") {
          state.sessionIdentity = {};
          await act(async () => renderer.update(<TasksPage />));
          await selectOnlyInboxTaskForDetailJourney(renderer);
        }
        if (mode === "environment") {
          state.environmentId = "environment-b";
          await act(async () => renderer.update(<TasksPage />));
          await selectOnlyInboxTaskForDetailJourney(renderer);
        }
        if (mode === "target" || mode === "revision") {
          const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
          state.load.mockResolvedValue({
            ...snapshot,
            tasks:
              mode === "target"
                ? []
                : snapshot.tasks.map((t) => ({
                    ...t,
                    contractReadout:
                      t.contractReadout?.status === "available"
                        ? {
                            ...t.contractReadout,
                            contract: { ...t.contractReadout.contract, revision: 2 },
                          }
                        : t.contractReadout,
                  })),
          });
          await creationClick("Refresh tasks");
        }
        if (mode === "cancel") await creationClick("Cancel preparation");
        if (mode === "unmount") await act(async () => renderer.unmount());
        if (mode === "apply-error") {
          await creationClick("Fill empty draft and open");
          expect(text()).toContain("Prepared a local draft only");
        }
        if (mode === "error" || mode === "apply-error")
          gated.reject(new Error("controlled preview failure"));
        else {
          const value = result.value;
          gated.resolve({
            _tag: "Success",
            value:
              mode === "mismatch" && value.status === "available"
                ? { ...value, request: { ...value.request, text: "foreign response text" } }
                : value,
          });
        }
        await act(async () => {
          await Promise.resolve();
        });
        if (mode !== "unmount") {
          if (mode === "newer") expect(text()).toContain("Deterministic local classification");
          else expect(text()).not.toContain("Deterministic local classification");
          if (mode === "error" || mode === "mismatch")
            expect(text()).toContain("No draft or model was changed");
        }
        if (mode === "apply-error") {
          expect(text()).toContain("Prepared a local draft only");
          expect(text()).not.toContain("Auto preview failed");
          expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
            "Fix parser",
          );
          expect(state.navigate).toHaveBeenCalledTimes(1);
        } else {
          expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
          expect(state.navigate).not.toHaveBeenCalled();
        }
        expect(state.create).not.toHaveBeenCalled();
        expect(state.reviewDecide).not.toHaveBeenCalled();
        expect(state.bind).not.toHaveBeenCalled();
        expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(
          before,
        );
        expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
      }),
    ),
  );
});

it("prepares a requested revision for a validated completed owned output without execution", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const task = f.snapshot.tasks[0]!;
    expect(task.resultReadout).toMatchObject({
      status: "available",
      runStatus: "completed",
      providerTurnStatus: "completed",
      content: { status: "output", truncated: true },
    });
    state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
    state.reviewRead.mockImplementation(async ({ input }: { input: TaskContractReviewInput }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.readReview(input)),
    }));
    state.readProjection.mockImplementation(async () => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(
        f.orchestrator.getThreadProjection(f.command.threadId),
      ),
    }));
    const target = scopeThreadRef(EnvironmentId.make("environment-a"), f.command.threadId);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      backgroundSubmissionThreadKeys: {},
      rewindingThreadKeys: new Set(),
    });
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
    const effects = await EffectForFixture.runPromise(f.noExecution());
    expect(creationButton("Prepare revision request")).toBeDefined();
    await creationClick("Prepare revision request", true);
    expect(text()).toContain("Fix parser");
    expect(text()).toContain(f.command.taskContract!.acceptance);
    expect(text()).toContain("Attributed parser output");
    const persisted = f.projection.turnItems.find((item) => item.type === "assistant_message");
    if (persisted?.type !== "assistant_message") throw new Error("Missing full fixture output");
    expect(
      renderer.root.findAllByType("pre").some((n) => n.children.join("") === persisted.text),
    ).toBe(true);
    const editor = renderer.root.findByProps({ "aria-label": "Requested changes" });
    expect(editor.props.value).toBe("");
    expect(creationButton("Fill empty draft and open")!.props.disabled).toBe(true);
    await act(async () =>
      editor.props.onChange({ target: { value: "Add the missing parser regression" } }),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    await creationClick("Fill empty draft and open", true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "Add the missing parser regression",
    );
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(before);
    expect(await EffectForFixture.runPromise(f.noExecution())).toEqual(effects);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.autoPreview).not.toHaveBeenCalled();
  });
});

it.each([
  "typed",
  "file",
  "image",
  "upload-marker",
  "context",
  "queued",
  "background",
  "rewind",
  "changes-edit",
  "session",
  "environment",
  "navigation",
  "unmount",
  "cancel",
  "pause",
  "accept",
  "delete",
  "revision",
  "foreign",
  "new-output",
  "same-item-tail",
  "newer-run",
  "projection-failure",
  "late-failure",
  "late-response",
] as const)("retires revision preparation and preserves local content across %s", async (mode) => {
  await withTaskRevisionRequestFixture(async (f) => {
    const task = f.snapshot.tasks[0]!;
    state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
    const read = async ({ input }: { input: TaskContractReviewInput }) => ({
      _tag: "Success" as const,
      value: await EffectForFixture.runPromise(f.readReview(input)),
    });
    state.reviewRead.mockImplementation(read);
    state.readProjection.mockImplementation(async () => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(
        f.orchestrator.getThreadProjection(f.command.threadId),
      ),
    }));
    const target = scopeThreadRef(EnvironmentId.make("environment-a"), f.command.threadId),
      key = scopedThreadKey(target);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      backgroundSubmissionThreadKeys: {},
      rewindingThreadKeys: new Set(),
    });
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await creationClick("Prepare revision request");
    const edit = () => renderer.root.findByProps({ "aria-label": "Requested changes" });
    await act(async () =>
      edit().props.onChange({ target: { value: "Requested parser revision" } }),
    );
    const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`),
      effects = await EffectForFixture.runPromise(f.noExecution());
    const gated = deferred<{ _tag: "Success"; value: TaskContractReviewState }>();
    const old = await read({
      input: {
        environmentId: "environment-a",
        taskId: task.id,
        projectId: task.projectId,
        threadId: f.command.threadId,
        revision: 1,
      },
    });
    state.reviewRead.mockImplementationOnce(() => gated.promise);
    await creationClick("Fill empty draft and open", true);
    if (mode === "typed") useComposerDraftStore.getState().setPrompt(target, "My own draft");
    if (["file", "image", "upload-marker", "context", "queued"].includes(mode)) {
      useComposerDraftStore.getState().setPrompt(target, "Temporary seed");
      const base = { ...useComposerDraftStore.getState().getComposerDraft(target)!, prompt: "" };
      useComposerDraftStore.setState({
        draftsByThreadKey: {
          [mode === "queued" ? `queued-edit:${key}:existing-run` : key]: {
            ...base,
            ...(mode === "file"
              ? {
                  files: [
                    {
                      type: "file" as const,
                      id: "kept-file",
                      name: "notes.txt",
                      mimeType: "text/plain",
                      sizeBytes: 3,
                      file: null,
                      uploadedAttachmentId: "kept-upload",
                      uploadEnvironmentId: target.environmentId,
                    },
                  ],
                }
              : mode === "image"
                ? {
                    images: [
                      {
                        type: "image" as const,
                        id: "kept-image",
                        name: "x.png",
                        mimeType: "image/png",
                        sizeBytes: 3,
                        previewUrl: "blob:kept",
                        file: new File(["png"], "x.png"),
                      },
                    ],
                  }
                : mode === "upload-marker"
                  ? { nonPersistedImageIds: ["pending-image"] }
                  : mode === "context"
                    ? {
                        terminalContexts: [
                          {
                            id: "kept-context",
                            threadId: f.command.threadId,
                            terminalId: "term",
                            terminalLabel: "Terminal",
                            lineStart: 1,
                            lineEnd: 2,
                            text: "Existing context",
                            createdAt: "2026-10-14T00:00:00Z",
                          },
                        ],
                      }
                    : { prompt: "Queued instructions" }),
          },
        },
      });
    }
    if (mode === "background")
      useComposerDraftStore.setState({ backgroundSubmissionThreadKeys: { [key]: true } });
    if (mode === "rewind") useComposerDraftStore.setState({ rewindingThreadKeys: new Set([key]) });
    if (mode === "changes-edit")
      await act(async () => edit().props.onChange({ target: { value: "New user changes" } }));
    if (mode === "session") {
      state.sessionIdentity = {};
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
    }
    if (mode === "environment") {
      state.environmentId = "environment-b";
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
    }
    if (mode === "navigation") await creationClick("Open conversation for full context");
    if (mode === "cancel") await creationClick("Cancel revision preparation");
    if (mode === "unmount") await act(async () => renderer.unmount());
    if (["pause", "accept", "revision"].includes(mode))
      await EffectForFixture.runPromise(
        f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,${mode === "pause" ? "$.taskContractPhase" : mode === "accept" ? "$.taskAcceptedRevision" : "$.taskContract.revision"},${mode === "pause" ? "redirected" : mode === "accept" ? 1 : 2}) WHERE thread_id=${f.command.threadId}`,
      );
    if (mode === "delete")
      await EffectForFixture.runPromise(
        f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-14T01:00:00Z' WHERE thread_id=${f.command.threadId}`,
      );
    if (mode === "foreign")
      await EffectForFixture.runPromise(
        f.sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.admittedBy','foreign') WHERE command_id=${`task:enroll:${f.command.commandId}`}`,
      );
    if (mode === "new-output")
      await EffectForFixture.runPromise(
        f.sql`UPDATE orchestration_v2_projection_turn_items SET turn_item_id='new-output',ordinal=2,payload_json=json_set(payload_json,'$.id','new-output','$.ordinal',2) WHERE turn_item_id='revision-output'`,
      );
    if (mode === "same-item-tail")
      await EffectForFixture.runPromise(
        f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.text',json_extract(payload_json,'$.text') || 'new suffix') WHERE turn_item_id='revision-output'`,
      );
    if (mode === "newer-run")
      await EffectForFixture.runPromise(
        f.sql`UPDATE orchestration_v2_projection_runs SET ordinal=2,status='queued',payload_json=json_set(payload_json,'$.ordinal',2,'$.status','queued') WHERE thread_id=${f.command.threadId}`,
      );
    if (mode === "projection-failure")
      state.readProjection.mockResolvedValueOnce({
        _tag: "Failure",
        cause: "projection unavailable",
      });
    if (mode === "late-failure" || mode === "late-response") {
      await creationClick("Cancel revision preparation");
      await creationClick("Prepare revision request");
      await act(async () =>
        edit().props.onChange({ target: { value: "Current requested changes" } }),
      );
      await creationClick("Fill empty draft and open");
      expect(text()).toContain("Prepared a local revision draft only");
    }
    const marker = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`),
      retained = useComposerDraftStore.getState().draftsByThreadKey;
    await act(async () => {
      if (mode === "late-failure") gated.reject(new Error("obsolete result failure"));
      else gated.resolve(old);
    });
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual(retained);
    if (mode === "late-failure" || mode === "late-response") {
      expect(text()).toContain("Prepared a local revision draft only");
      expect(text()).not.toContain("Fresh result reads failed");
      expect(state.navigate).toHaveBeenCalledTimes(1);
    } else if (mode === "navigation") expect(state.navigate).toHaveBeenCalledTimes(1);
    else expect(state.navigate).not.toHaveBeenCalled();
    if (mode === "changes-edit") expect(edit().props.value).toBe("New user changes");
    expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(marker);
    if (
      ![
        "pause",
        "accept",
        "revision",
        "delete",
        "foreign",
        "new-output",
        "same-item-tail",
        "newer-run",
      ].includes(mode)
    )
      expect(marker).toEqual(before);
    expect(await EffectForFixture.runPromise(f.noExecution())).toEqual(effects);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.autoPreview).not.toHaveBeenCalled();
  });
});

type FeedbackFixture = {
  sql: SqlClientForFixture.SqlClient;
  input: import("@t3tools/contracts").TaskResultFeedbackInput;
  read: (
    input?: import("@t3tools/contracts").TaskResultFeedbackInput,
  ) => Promise<import("@t3tools/contracts").TaskResultFeedbackState>;
  submit: (
    input: import("@t3tools/contracts").TaskResultFeedbackSubmit,
  ) => Promise<import("@t3tools/contracts").TaskResultFeedbackState>;
  snapshot: () => Promise<CollaborationSnapshot>;
  baseline: () => Promise<unknown>;
  readHttp: (
    input?: import("@t3tools/contracts").TaskResultFeedbackInput,
  ) => Promise<import("@t3tools/contracts").TaskResultFeedbackState>;
  submitHttp: (
    input: import("@t3tools/contracts").TaskResultFeedbackSubmit,
  ) => Promise<import("@t3tools/contracts").TaskResultFeedbackState>;
};
async function feedbackFixture(check: (f: FeedbackFixture) => Promise<void>) {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/taskResultFeedbackFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withTaskResultFeedbackFixture: (check: (f: FeedbackFixture) => Promise<void>) => Promise<void>;
  };
  await module.withTaskResultFeedbackFixture(async (f) => {
    state.snapshot = await f.snapshot();
    state.feedbackRead.mockImplementation(f.readHttp);
    state.feedbackSubmit.mockImplementation(f.submitHttp);
    await check(f);
  });
}
const feedbackButton = (label: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.join("") === label);
const clickFeedback = async (label: string, wait = true) => {
  await act(async () => {
    const receipt = feedbackButton(label)!.props.onClick();
    if (wait) await receipt;
  });
};
it("shows mounted Tasks result feedback through the authenticated SQLite service and persists after remount", async () => {
  await feedbackFixture(async (f) => {
    const before = await f.baseline();
    const changes = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(feedbackButton("Helpful")).toBeDefined();
    expect(feedbackButton("Not helpful")).toBeDefined();
    expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(changes);
    await clickFeedback("Helpful");
    expect(text()).toContain("does not accept");
    expect(text()).toContain("environment-a");
    expect(text()).toContain("fake-model");
    await clickFeedback("Cancel feedback");
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(changes);
    await clickFeedback("Helpful");
    await clickFeedback("Confirm feedback");
    expect(text()).toContain("Recorded: Helpful");
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(text()).toContain("Recorded: Helpful");
    expect(feedbackButton("Helpful")).toBeUndefined();
    expect(await f.baseline()).toEqual(before);
  });
});

it("records Not helpful only after explicit confirmation", async () => {
  await feedbackFixture(async (f) => {
    const before = await f.baseline();
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await clickFeedback("Not helpful");
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    await clickFeedback("Confirm feedback");
    expect(text()).toContain("Recorded: Not helpful");
    expect(state.feedbackSubmit).toHaveBeenCalledTimes(1);
    expect(await f.baseline()).toEqual(before);
  });
});
it("guards same-render double clicks and recovers a committed lost response through authenticated refresh", async () => {
  await feedbackFixture(async (f) => {
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await clickFeedback("Helpful");
    state.feedbackSubmit.mockImplementationOnce(async (input) => {
      await f.submit(input);
      throw new Error("fixture-response-lost");
    });
    const confirm = feedbackButton("Confirm feedback")!.props.onClick;
    await act(async () => {
      await Promise.all([confirm(), confirm()]);
    });
    expect(state.feedbackSubmit).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Recording outcome unknown");
    expect(text()).not.toContain("Recorded: Helpful");
    expect(feedbackButton("Helpful")).toBeUndefined();
    await clickFeedback("Refresh feedback");
    expect(text()).toContain("Recorded: Helpful");
    expect(state.feedbackSubmit).toHaveBeenCalledTimes(1);
  });
});
it.each(["environment", "session", "result", "deletion"])(
  "retires feedback confirmation when %s changes",
  async (scenario) => {
    await feedbackFixture(async (f) => {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await clickFeedback("Helpful");
      const retainedConfirm = feedbackButton("Confirm feedback")!.props.onClick;
      if (scenario === "environment") {
        state.environmentId = "environment-b";
        state.snapshot = { ...state.snapshot, environmentId: "environment-b", tasks: [] };
        await act(async () => renderer.update(<TasksPage />));
        await selectOnlyInboxTaskForDetailJourney(renderer);
      }
      if (scenario === "session") {
        state.sessionIdentity = {};
        await act(async () => renderer.update(<TasksPage />));
        await selectOnlyInboxTaskForDetailJourney(renderer);
      }
      if (scenario === "result") {
        await EffectForFixture.runPromise(
          f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.text',json_extract(payload_json,'$.text') || 'changed beyond preview') WHERE type='assistant_message'`,
        );
        state.snapshot = await f.snapshot();
        await clickFeedback("Refresh tasks");
      }
      if (scenario === "deletion") {
        await EffectForFixture.runPromise(
          f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-14T00:00:03Z',payload_json=json_set(payload_json,'$.deletedAt','2026-10-14T00:00:03Z')`,
        );
        state.snapshot = await f.snapshot();
        await clickFeedback("Refresh tasks");
      }
      await act(async () => retainedConfirm());
      expect(feedbackButton("Confirm feedback")).toBeUndefined();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
    });
  },
);
it.each(["success", "failure"])("ignores late feedback %s after navigation", async (outcome) => {
  await feedbackFixture(async (f) => {
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await clickFeedback("Helpful");
    const reply = deferred<import("@t3tools/contracts").TaskResultFeedbackState>(),
      entered = deferred<void>();
    let saved: import("@t3tools/contracts").TaskResultFeedbackState | undefined;
    state.feedbackSubmit.mockImplementationOnce(async (input) => {
      saved = await f.submit(input);
      entered.resolve();
      return reply.promise;
    });
    await clickFeedback("Confirm feedback", false);
    await entered.promise;
    state.environmentId = "environment-b";
    state.snapshot = { ...state.snapshot, environmentId: "environment-b", tasks: [] };
    await act(async () => renderer.update(<TasksPage />));
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await act(async () => {
      if (outcome === "success") reply.resolve(saved!);
      else reply.reject(new Error("late old request"));
    });
    expect(text()).not.toContain("Recorded: Helpful");
    expect(text()).not.toContain("Recording outcome unknown");
    expect(state.feedbackSubmit).toHaveBeenCalledTimes(1);
  });
});
it("ignores a deferred old-session feedback preview and never opens its confirmation", async () => {
  await feedbackFixture(async (f) => {
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    const preview = deferred<import("@t3tools/contracts").TaskResultFeedbackState>();
    state.feedbackRead.mockReturnValueOnce(preview.promise);
    const choose = feedbackButton("Helpful")!.props.onClick;
    const reads = state.feedbackRead.mock.calls.length;
    await act(async () => {
      choose();
      choose();
    });
    expect(state.feedbackRead.mock.calls.length).toBe(reads + 1);
    state.sessionIdentity = {};
    await act(async () => renderer.update(<TasksPage />));
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await act(async () => preview.resolve(await f.read()));
    expect(feedbackButton("Confirm feedback")).toBeUndefined();
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
  });
});

it("keeps persistent feedback read failures stable until explicit refresh and recovers successfully", async () => {
  await feedbackFixture(async (f) => {
    const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
    const unexpectedRetry = deferred<import("@t3tools/contracts").TaskResultFeedbackState>();
    // Bound a broken automatic retry loop without sleeps or an endless rejected-promise chain.
    state.feedbackRead.mockImplementation(() =>
      state.feedbackRead.mock.calls.length <= 2
        ? Promise.reject(new Error("persistent read failure"))
        : unexpectedRetry.promise,
    );
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(state.feedbackRead).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Feedback could not be read");
    expect(feedbackButton("Helpful")).toBeUndefined();
    await act(async () => renderer.update(<TasksPage />));
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(state.feedbackRead).toHaveBeenCalledTimes(1);
    await clickFeedback("Refresh feedback");
    expect(state.feedbackRead).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Feedback could not be read");
    state.feedbackRead.mockImplementation(f.readHttp);
    await clickFeedback("Refresh feedback");
    expect(state.feedbackRead).toHaveBeenCalledTimes(3);
    expect(feedbackButton("Helpful")).toBeDefined();
    expect(text()).not.toContain("Feedback could not be read");
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(before);
  });
});

it.each(["success", "failure"] as const)(
  "retires a late %s from an old context while a new context read failure stays stable",
  async (outcome) => {
    await feedbackFixture(async (f) => {
      const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
      const oldReply = deferred<import("@t3tools/contracts").TaskResultFeedbackState>();
      const oldFacts = await f.readHttp();
      const unexpectedRetry = deferred<import("@t3tools/contracts").TaskResultFeedbackState>();
      state.feedbackRead
        .mockReturnValueOnce(oldReply.promise)
        .mockRejectedValueOnce(new Error("new context read failure"))
        .mockReturnValue(unexpectedRetry.promise);
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await selectOnlyInboxTaskForDetailJourney(renderer);
      expect(state.feedbackRead).toHaveBeenCalledTimes(1);
      state.sessionIdentity = {};
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await act(async () => {
        if (outcome === "success") oldReply.resolve(oldFacts);
        else oldReply.reject(new Error("obsolete read failure"));
      });
      expect(state.feedbackRead).toHaveBeenCalledTimes(2);
      expect(feedbackButton("Helpful")).toBeUndefined();
      expect(text()).toContain("Feedback could not be read");
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
      expect(state.feedbackRead).toHaveBeenCalledTimes(2);
      state.feedbackRead.mockImplementation(f.readHttp);
      await clickFeedback("Refresh feedback");
      expect(state.feedbackRead).toHaveBeenCalledTimes(3);
      expect(feedbackButton("Helpful")).toBeDefined();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
      expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(before);
    });
  },
);

describe("Agents directory recovery frozen behavior", () => {
  const retry = () =>
    renderer.root
      .findAllByType("button")
      .find(
        (b) =>
          b.children.includes("Retry agent directory") ||
          b.children.includes("Refresh agent directory"),
      );
  const reread = async () => {
    await act(async () => {
      const cb = retry()!.props.onClick;
      cb();
      cb();
    });
  };
  it("recovers a failed first read explicitly without opening or creating", async () => {
    const next = deferred<CollaborationSnapshot>();
    state.load
      .mockRejectedValueOnce(new Error("Directory denied"))
      .mockReturnValueOnce(next.promise);
    await mount();
    expect(text()).toContain("Directory denied");
    expect(text()).not.toContain("No recorded tasks.");
    expect(retry()).toBeDefined();
    await reread();
    expect(state.load).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(state.snapshot));
    expect(button().props.disabled).toBe(false);
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
  });
  it("rejects saved Open and New callbacks while refreshing and stale", async () => {
    bindResult({
      type: "thread.bind",
      commandId: "seed",
      projectId: "project-a",
      threadId: "saved-thread",
    });
    await mount();
    const oldOpen = button().props.onClick;
    const oldNew = renderer.root.findByProps({ "aria-label": "New Codex task" }).props.onClick;
    const failed = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(failed.promise);
    // Exercise the existing creation workflow's real directory reread as well as the new Retry UI.
    await act(async () => {
      void renderer.root.findByType(AgentsTaskCreator).props.refresh();
    });
    await act(async () => {
      oldOpen();
      oldNew();
    });
    expect(state.recover).not.toHaveBeenCalled();
    expect(creationButton("Review new task")).toBeUndefined();
    await act(async () => failed.reject(new Error("Read failed")));
    expect(text()).toContain("Agent directory may be stale");
    expect(button().props.disabled).toBe(true);
    await act(async () => {
      oldOpen();
      oldNew();
    });
    expect(state.recover).not.toHaveBeenCalled();
    expect(creationButton("Review new task")).toBeUndefined();
  });
  it.each(["success", "failure"] as const)(
    "isolates an old-session canonical open %s and its finally from the new operation",
    async (outcome) => {
      await mount();
      const old = deferred<CollaborationCommandResult>();
      const current = deferred<CollaborationCommandResult>();
      state.recover.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      await click();
      state.sessionIdentity = {};
      await act(async () => renderer.update(<AgentsPage />));
      await click();
      expect(state.recover).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === "success")
          old.resolve({
            outcome: "applied",
            code: null,
            detail: "Fixture receipt",
            idempotent: true,
            gateDecision: "DENY",
            snapshot: {
              ...state.snapshot,
              agents: [
                {
                  id: "codex",
                  displayName: "Retired session",
                  origin: "internal",
                  role: "provider",
                  capabilities: [],
                  connection: "NOT_CONNECTED",
                  availability: "waiting",
                  projectId: "project-a",
                  threadId: "retired-thread",
                },
              ],
            },
          });
        else old.reject(new Error("Retired failure"));
      });
      expect(state.navigate).not.toHaveBeenCalled();
      expect(text()).not.toContain("Retired");
      expect(button().props.disabled).toBe(true);
      await click();
      expect(state.recover).toHaveBeenCalledTimes(2);
      await act(async () =>
        current.resolve(
          bindResult({
            type: "thread.bind",
            commandId: "current",
            projectId: "project-a",
            threadId: "current-thread",
          }) as CollaborationCommandResult,
        ),
      );
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "environment-a", threadId: "current-thread" },
      });
    },
  );
  it("never navigates a canonical receipt from a retired prepared session", async () => {
    await mount();
    const old = deferred<CollaborationCommandResult>();
    state.recover.mockReturnValueOnce(old.promise);
    await click();
    state.sessionIdentity = {};
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () =>
      old.resolve({
        outcome: "applied",
        code: null,
        detail: "Committed in old session",
        idempotent: true,
        gateDecision: "DENY",
        snapshot: bindResult({
          type: "thread.bind",
          commandId: "old-session",
          projectId: "project-a",
          threadId: "retired-thread",
        }).snapshot,
      }),
    );
    expect(state.navigate).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
  });
});

describe("Agents directory recovery context and fixture", () => {
  const readButton = () =>
    creationButton("Retry agent directory") ?? creationButton("Refresh agent directory");
  const reread = async () => {
    await act(async () => readButton()!.props.onClick());
  };
  const marked = (name: string): CollaborationSnapshot => ({
    ...state.snapshot,
    agents: [
      {
        id: "codex",
        displayName: name,
        origin: "internal",
        role: "provider",
        capabilities: [],
        connection: "NOT_CONNECTED",
        availability: "waiting",
        projectId: "project-a",
        threadId: name,
      },
    ],
  });
  it.each(
    (["environment", "session", "disconnect", "unmount"] as const).flatMap((mode) =>
      (["success", "failure"] as const).map((outcome) => ({ mode, outcome })),
    ),
  )("rejects late GET $outcome after $mode invalidation", async ({ mode, outcome }) => {
    const retired = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(retired.promise);
    await mount();
    const oldOpen = button().props.onClick;
    if (mode === "environment") {
      state.environmentId = "environment-b";
      await act(async () => renderer.update(<AgentsPage />));
      state.environmentId = "environment-a";
    } else if (mode === "session") state.sessionIdentity = {};
    else if (mode === "disconnect") {
      state.sessionIdentity = null;
      await act(async () => renderer.update(<AgentsPage />));
      expect(readButton()!.props.disabled).toBe(true);
      expect(state.load).toHaveBeenCalledTimes(1);
      state.sessionIdentity = {};
    } else await act(async () => renderer.unmount());
    state.load.mockResolvedValueOnce(marked("Current persisted identity"));
    if (mode !== "unmount") await act(async () => renderer.update(<AgentsPage />));
    await act(async () => {
      if (outcome === "success") retired.resolve(marked("Retired directory"));
      else retired.reject(new Error("Retired directory failure"));
      oldOpen();
    });
    expect(text()).not.toContain("Retired directory");
    if (mode !== "unmount") expect(text()).toContain("Current persisted identity");
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("keeps the latest explicit read when both initial GET and earlier Open return last", async () => {
    const initial = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(marked("New GET"));
    await mount();
    await reread();
    await act(async () => initial.resolve(marked("Initial old GET")));
    expect(text()).toContain("New GET");
    expect(text()).not.toContain("Initial old GET");
    const opened = deferred<CollaborationCommandResult>();
    state.recover.mockReturnValueOnce(opened.promise);
    await click();
    state.load.mockResolvedValueOnce(marked("Newest GET"));
    await reread();
    await act(async () =>
      opened.resolve({
        outcome: "applied",
        code: null,
        detail: "Fixture receipt",
        idempotent: true,
        gateDecision: "DENY",
        snapshot: marked("Old Open"),
      }),
    );
    expect(text()).toContain("Newest GET");
    expect(text()).not.toContain("Old Open");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("repeated denial and wrong-environment reads stay stale until explicit valid recovery", async () => {
    state.load.mockRejectedValueOnce(new Error("Read scope denied"));
    await mount();
    state.load.mockRejectedValueOnce(new Error("Read scope denied"));
    await reread();
    expect(state.load).toHaveBeenCalledTimes(2);
    state.load.mockResolvedValueOnce({
      ...marked("Foreign ledger"),
      environmentId: "environment-b",
    });
    await reread();
    expect(text()).not.toContain("Foreign ledger");
    expect(button().props.disabled).toBe(true);
    state.load.mockResolvedValueOnce(marked("Verified directory"));
    await reread();
    expect(button().props.disabled).toBe(false);
    expect(state.recover).not.toHaveBeenCalled();
  });
  it("recovers persisted directory through actual disposable SQLite with zero read-phase writes, then explicit Open and reviewed New", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "b3r-directory-"));
    creationStorage();
    const module = await loadAgentsCreationFixture();
    try {
      await EffectForFixture.runPromise(
        module.withAgentsTaskCreationFixture(
          (f) =>
            EffectForFixture.promise(async () => {
              const seeded = await EffectForFixture.runPromise(f.openCanonical());
              const canonicalId = seeded.snapshot.agents.find((a) => a.id === "codex")!.threadId;
              const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
              const receipts = await EffectForFixture.runPromise(
                f.sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
              );
              const effects = await EffectForFixture.runPromise(f.noExecution());
              // Fault injection is fixture setup, never a UI operation. The real snapshot service fails its SQL read.
              await EffectForFixture.runPromise(
                f.sql`ALTER TABLE collaboration_commands RENAME TO directory_fault_commands`,
              );
              state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
              state.recover.mockImplementation(() =>
                EffectForFixture.runPromise(f.openCanonical()),
              );
              state.create.mockImplementation(
                async ({ input }: { input: OrchestrationV2Command }) => ({
                  _tag: "Success",
                  value: await EffectForFixture.runPromise(f.dispatch(input)),
                }),
              );
              state.readProjection.mockImplementation(
                async ({ input }: { input: { threadId: string } }) => ({
                  _tag: "Success",
                  value: await EffectForFixture.runPromise(
                    f.orchestrator.getThreadProjection(input.threadId),
                  ),
                }),
              );
              await mount();
              expect(creationButton("Retry agent directory")).toBeDefined();
              expect(button().props.disabled).toBe(true);
              await EffectForFixture.runPromise(
                f.sql`ALTER TABLE directory_fault_commands RENAME TO collaboration_commands`,
              );
              await reread();
              expect(state.load).toHaveBeenCalledTimes(2);
              expect(text()).toContain("codex");
              expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(
                before,
              );
              expect(
                await EffectForFixture.runPromise(
                  f.sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
                ),
              ).toEqual(receipts);
              expect(await EffectForFixture.runPromise(f.noExecution())).toEqual(effects);
              expect(state.create).not.toHaveBeenCalled();
              expect(state.bind).not.toHaveBeenCalled();
              expect(state.recover).not.toHaveBeenCalled();
              expect(state.navigate).not.toHaveBeenCalled();
              await click();
              expect(state.navigate.mock.calls[0]![0].params.threadId).toBe(canonicalId);
              await creationClick("New task");
              await fillCreation();
              expect(state.create).not.toHaveBeenCalled();
              await creationClick("Review new task");
              expect(state.create).not.toHaveBeenCalled();
              await creationClick("Create task");
              expect(state.create).toHaveBeenCalledTimes(1);
              expect(await EffectForFixture.runPromise(f.noExecution())).toEqual(effects);
              await act(async () => renderer.unmount());
            }),
          { dbPath: path.join(dir, "state.sqlite") },
        ),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

it("directory Retry preserves pending and uncertain creation identity and never reads a receipt or resends", async () => {
  const records = creationStorage();
  const creating = deferred<{ _tag: "Failure"; cause: string }>();
  state.create.mockReturnValueOnce(creating.promise);
  await mount();
  await creationClick("New task");
  await fillCreation();
  await creationClick("Review new task");
  await creationClick("Create task");
  const original = [...records.values()][0]!;
  expect(decodeCreationStorage(original)).toMatchObject({ status: "pending" });
  const refresh = async () => {
    await act(async () =>
      (creationButton("Retry agent directory") ??
        creationButton("Refresh agent directory"))!.props.onClick(),
    );
  };
  state.load.mockRejectedValueOnce(new Error("Read lost during creation"));
  await refresh();
  await refresh();
  expect([...records.values()][0]).toBe(original);
  expect(creationButton("New task")!.props.disabled).toBe(true);
  await act(async () => creating.resolve({ _tag: "Failure", cause: "Lost receipt" }));
  const uncertain = [...records.values()][0]!;
  expect(decodeCreationStorage(uncertain)).toMatchObject({
    status: "uncertain",
    command: (decodeCreationStorage(original) as { command: unknown }).command,
  });
  await refresh();
  expect([...records.values()][0]).toBe(uncertain);
  expect(creationButton("New task")!.props.disabled).toBe(true);
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.readCreationStatus).not.toHaveBeenCalled();
  expect(state.readProjection).not.toHaveBeenCalled();
  expect(state.recover).not.toHaveBeenCalled();
});

it.each(["success", "failure"] as const)(
  "retires an Open %s after provider removal and restoration",
  async (outcome) => {
    await mount();
    const old = deferred<CollaborationCommandResult>();
    state.recover.mockReturnValueOnce(old.promise);
    await click();
    state.providers = [];
    await act(async () => renderer.update(<AgentsPage />));
    state.providers = [...configuredProviders];
    await act(async () => renderer.update(<AgentsPage />));
    await act(async () => {
      if (outcome === "success")
        old.resolve({
          outcome: "applied",
          code: null,
          detail: "Fixture receipt",
          idempotent: true,
          gateDecision: "DENY",
          snapshot: { ...state.snapshot, grokbotIntegration: ["Retired provider result"] },
        });
      else old.reject(new Error("Retired provider failure"));
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(text()).not.toContain("Retired provider");
    expect(button().props.disabled).toBe(false);
  },
);

const taskNavigationSnapshot = (): CollaborationSnapshot => ({
  ...state.snapshot,
  environmentId: EnvironmentId.make("environment-a"),
  agents: [{ ...savedAgentFixture(), threadId: "canonical-thread" }],
  tasks: ["one", "two"].map((id) => ({
    ...agentTaskFixture(),
    id: `task-${id}`,
    title: `Task ${id}`,
    threadId: `thread-${id}`,
  })),
});
const taskNavigationAction = (id = "one") =>
  renderer.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === `Open task: Task ${id}`);
const openTaskForProof = async (id = "one") => {
  await act(async () => {
    // On the frozen base exercise the existing action, exposing its wrong canonical target.
    (taskNavigationAction(id) ?? button()).props.onClick();
  });
};
describe("Agents task navigation frozen behavior", () => {
  it("opens each task's own thread instead of the provider canonical conversation", async () => {
    state.snapshot = taskNavigationSnapshot();
    state.recover.mockResolvedValue({ outcome: "applied", snapshot: state.snapshot });
    await mount();
    await openTaskForProof("one");
    await openTaskForProof("two");
    expect(state.navigate.mock.calls.map(([input]) => input.params.threadId)).toEqual([
      "thread-one",
      "thread-two",
    ]);
    expect(state.load).toHaveBeenCalledTimes(3);
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.snapshot.agents[0]!.threadId).toBe("canonical-thread");
  });
  it.each(["disabled", "uninstalled", "unauthenticated", "missing"])(
    "reads valid task history with a %s provider without opening or creating",
    async (mode) => {
      state.snapshot = taskNavigationSnapshot();
      state.providers =
        mode === "missing"
          ? []
          : state.providers.map((p) => ({
              ...p,
              enabled: mode !== "disabled",
              installed: mode !== "uninstalled",
              auth: { status: mode === "unauthenticated" ? "unauthenticated" : "authenticated" },
            }));
      await mount();
      await openTaskForProof();
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "environment-a", threadId: "thread-one" },
      });
      expect(button().props.disabled).toBe(true);
      expect(creationButton("New task")!.props.disabled).toBe(true);
      expect(state.recover).not.toHaveBeenCalled();
      expect(state.create).not.toHaveBeenCalled();
      expect(state.bind).not.toHaveBeenCalled();
    },
  );
});

const taskNavigationRefresh = async () => {
  await act(async () =>
    (creationButton("Refresh agent directory") ??
      creationButton("Retry agent directory") ??
      creationButton("Reading agent directory…"))!.props.onClick(),
  );
};
describe("Agents task navigation validation and ownership", () => {
  beforeEach(() => {
    state.snapshot = taskNavigationSnapshot();
  });
  it.each([
    "rebound",
    "deleted",
    "project",
    "assignee",
    "owner",
    "environment",
    "null",
    "duplicate",
    "missing-environment",
  ])("rejects a fresh %s identity without a substitute", async (mode) => {
    await mount();
    const original = state.snapshot.tasks[0]!;
    const changed = {
      ...original,
      threadId:
        mode === "rebound" ? "canonical-thread" : mode === "null" ? null : original.threadId,
      projectId: mode === "project" ? "project-b" : original.projectId,
      assigneeAgentId: mode === "assignee" ? "other" : original.assigneeAgentId,
      ownerAgentId: mode === "owner" ? "foreign" : original.ownerAgentId,
    };
    state.load.mockResolvedValueOnce({
      ...state.snapshot,
      environmentId:
        mode === "environment"
          ? EnvironmentId.make("environment-b")
          : mode === "missing-environment"
            ? undefined
            : state.snapshot.environmentId,
      tasks: mode === "deleted" ? [] : mode === "duplicate" ? [changed, changed] : [changed],
    });
    await openTaskForProof();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.load).toHaveBeenCalledTimes(2);
    expect(text()).toMatch(/changed|another environment/);
    expect(state.recover).not.toHaveBeenCalled();
  });
  it("explains a null link and rejects a saved handler with no GET", async () => {
    state.snapshot = {
      ...state.snapshot,
      tasks: [{ ...state.snapshot.tasks[0]!, threadId: null }],
    };
    await mount();
    expect(taskNavigationAction()!.props.disabled).toBe(true);
    expect(text()).toContain("no valid conversation link");
    await openTaskForProof();
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("admits one same-render GET and at most one navigation", async () => {
    await mount();
    const result = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(result.promise);
    await act(async () => {
      const action = taskNavigationAction()!.props.onClick;
      action();
      action();
    });
    expect(state.load).toHaveBeenCalledTimes(2);
    expect(taskNavigationAction()!.props.disabled).toBe(true);
    expect(button().props.disabled).toBe(true);
    await act(async () => result.resolve(state.snapshot));
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(taskNavigationAction()!.props.disabled).toBe(false);
  });
  it("rejects saved callbacks during refresh, after failure and after a newer valid read", async () => {
    await mount();
    const saved = taskNavigationAction()!.props.onClick;
    const failed = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(failed.promise);
    await taskNavigationRefresh();
    await act(async () => saved());
    await act(async () => failed.reject(new Error("Controlled GET failure")));
    await act(async () => saved());
    expect(state.load).toHaveBeenCalledTimes(2);
    await taskNavigationRefresh();
    await act(async () => saved());
    expect(state.load).toHaveBeenCalledTimes(3);
    expect(state.navigate).not.toHaveBeenCalled();
    await openTaskForProof();
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "failure"] as const)(
    "coalesces refresh with a pending task-open %s without an automatic retry",
    async (outcome) => {
      await mount();
      const old = deferred<CollaborationSnapshot>();
      state.load.mockReturnValueOnce(old.promise);
      await openTaskForProof();
      await taskNavigationRefresh();
      await act(async () => {
        void renderer.root.findByType(AgentsTaskCreator).props.refresh();
      });
      expect(state.load).toHaveBeenCalledTimes(2);
      await act(async () =>
        outcome === "success"
          ? old.resolve(state.snapshot)
          : old.reject(new Error("Controlled failure")),
      );
      expect(state.navigate).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(state.load).toHaveBeenCalledTimes(2);
      if (outcome === "failure") {
        await openTaskForProof();
        expect(state.load).toHaveBeenCalledTimes(2);
        await taskNavigationRefresh();
        expect(state.navigate).not.toHaveBeenCalled();
        await openTaskForProof();
        expect(state.navigate).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("keeps historical task access independent of provider readiness changes during its read", async () => {
    await mount();
    const current = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(current.promise);
    await openTaskForProof();
    state.providers = [];
    await act(async () => renderer.update(<AgentsPage />));
    expect(taskNavigationAction()!.props.disabled).toBe(true);
    await act(async () => current.resolve(state.snapshot));
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    expect(state.recover).not.toHaveBeenCalled();
  });
  it.each(
    ["session", "environment", "project", "disconnect", "unmount"].flatMap((mode) =>
      ["success", "failure"].map((outcome) => [mode, outcome]),
    ),
  )("retires saved callbacks and in-flight %s / %s with its finally", async (mode, outcome) => {
    state.projects.push({ id: "project-b", title: "B", environmentId: "environment-a" });
    await mount();
    await select("project-a");
    const saved = taskNavigationAction()!.props.onClick;
    const old = deferred<CollaborationSnapshot>();
    state.load.mockReturnValueOnce(old.promise);
    await openTaskForProof();
    if (mode === "session") {
      state.sessionIdentity = {};
      await act(async () => renderer.update(<AgentsPage />));
    }
    if (mode === "environment") {
      state.environmentId = "environment-b";
      await act(async () => renderer.update(<AgentsPage />));
      state.environmentId = "environment-a";
      await act(async () => renderer.update(<AgentsPage />));
    }
    if (mode === "project") {
      await select("project-b");
      await select("project-a");
      await taskNavigationRefresh();
    }
    if (mode === "disconnect") {
      state.sessionIdentity = null;
      await act(async () => renderer.update(<AgentsPage />));
    }
    if (mode === "unmount") await act(async () => renderer.unmount());
    const count = state.load.mock.calls.length;
    await act(async () => saved());
    expect(state.load).toHaveBeenCalledTimes(count);
    const current = deferred<CollaborationSnapshot>();
    if (mode !== "disconnect" && mode !== "unmount") {
      state.load.mockReturnValueOnce(current.promise);
      await openTaskForProof();
    }
    await act(async () =>
      outcome === "success"
        ? old.resolve({
            ...state.snapshot,
            agents: [{ ...savedAgentFixture(), displayName: "Retired success" }],
          })
        : old.reject(new Error("Retired failure")),
    );
    expect(state.navigate).not.toHaveBeenCalled();
    if (mode !== "unmount") expect(text()).not.toContain("Retired");
    if (mode !== "disconnect" && mode !== "unmount") {
      expect(taskNavigationAction()!.props.disabled).toBe(true);
      await act(async () => current.resolve(state.snapshot));
      expect(state.navigate).toHaveBeenCalledTimes(1);
    }
  });
  it.each(["success", "failure"] as const)(
    "retired task-open %s cannot release a new operation",
    async (outcome) => {
      await mount();
      const old = deferred<CollaborationSnapshot>(),
        current = deferred<CollaborationSnapshot>();
      state.load.mockReturnValueOnce(old.promise);
      await openTaskForProof();
      state.sessionIdentity = {};
      await act(async () => renderer.update(<AgentsPage />));
      state.load.mockReturnValueOnce(current.promise);
      await openTaskForProof();
      await act(async () =>
        outcome === "success"
          ? old.resolve(state.snapshot)
          : old.reject(new Error("Retired failure")),
      );
      expect(state.navigate).not.toHaveBeenCalled();
      expect(taskNavigationAction()!.props.disabled).toBe(true);
      const count = state.load.mock.calls.length;
      await openTaskForProof();
      expect(state.load).toHaveBeenCalledTimes(count);
      await act(async () => current.resolve(state.snapshot));
      expect(state.navigate).toHaveBeenCalledTimes(1);
    },
  );
  it("respects canonical-open ownership even after a concurrent refresh", async () => {
    await mount();
    const canonical = deferred<CollaborationCommandResult>();
    state.recover.mockReturnValueOnce(canonical.promise);
    await click();
    await taskNavigationRefresh();
    const count = state.load.mock.calls.length;
    await openTaskForProof();
    expect(state.load).toHaveBeenCalledTimes(count);
    await act(async () =>
      canonical.resolve({
        outcome: "applied",
        code: null,
        detail: "Fixture",
        idempotent: true,
        gateDecision: "DENY",
        snapshot: state.snapshot,
      }),
    );
    expect(state.navigate).not.toHaveBeenCalled();
    await openTaskForProof();
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
  it("keeps pending/uncertain creation cache bytes and recovery locks while task callbacks are invoked", async () => {
    const records = creationStorage();
    await mount();
    const saved = taskNavigationAction()!.props.onClick;
    const creating = deferred<{ _tag: "Failure"; cause: string }>();
    state.create.mockReturnValueOnce(creating.promise);
    await creationClick("New task");
    await fillCreation();
    await creationClick("Review new task");
    await creationClick("Create task");
    const original = [...records.values()][0]!;
    const count = state.load.mock.calls.length;
    await act(async () => saved());
    expect([...records.values()][0]).toBe(original);
    expect(taskNavigationAction()!.props.disabled).toBe(true);
    expect(state.load).toHaveBeenCalledTimes(count);
    await act(async () => creating.resolve({ _tag: "Failure", cause: "Lost receipt" }));
    const uncertain = [...records.values()][0]!;
    expect(decodeCreationStorage(uncertain)).toMatchObject({ status: "uncertain" });
    await act(async () => taskNavigationAction()!.props.onClick());
    expect([...records.values()][0]).toBe(uncertain);
    expect(state.readCreationStatus).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.recover).not.toHaveBeenCalled();
  });
});

it("Agents task navigation uses actual governed tasks on disposable disk SQLite without read-phase writes or provider starts", async () => {
  const fs = await import("node:fs/promises"),
    os = await import("node:os"),
    path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "b3r-task-navigation-"));
  const module = await loadAgentsCreationFixture();
  try {
    await EffectForFixture.runPromise(
      module.withAgentsTaskCreationFixture(
        (f) =>
          EffectForFixture.promise(async () => {
            // SETUP: real service mutations create the canonical conversation and two governed roots.
            const canonical = await EffectForFixture.runPromise(f.openCanonical());
            const canonicalId = canonical.snapshot.agents.find((a) => a.id === "codex")!.threadId;
            for (const id of ["one", "two"])
              await EffectForFixture.runPromise(f.dispatch(module.agentsCreationCommand(id)));
            f.setProviders([{ ...module.agentsCreationProvider, enabled: false }]);
            state.providers = state.providers.map((p) => ({ ...p, enabled: false }));
            state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
            const rows = () =>
              EffectForFixture.runPromise(
                f.sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
              );
            const changes = () => EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
            const effects = { runs: 0, grants: 0, outbox: 0, messages: 0 };
            const receipts = await rows(),
              before = await changes();
            await mount();
            const openTask = async (id: string) => {
              await act(async () =>
                renderer.root
                  .findByProps({ "aria-label": `Open task: Task ${id}` })
                  .props.onClick(),
              );
            };
            await openTask("one");
            await openTask("two");
            expect(state.navigate.mock.calls.map(([input]) => input.params.threadId)).toEqual([
              "one",
              "two",
            ]);
            expect(state.load).toHaveBeenCalledTimes(3);
            expect(
              (await EffectForFixture.runPromise(f.readSnapshot())).agents.find(
                (a) => a.id === "codex",
              )!.threadId,
            ).toBe(canonicalId);
            expect(await changes()).toEqual(before);
            expect(await rows()).toEqual(receipts);
            expect(await EffectForFixture.runPromise(f.noExecution())).toEqual(effects);
            expect(f.providerStarts()).toBe(0);
            // Each setup UPDATE below deliberately writes. Take a new marker only AFTER setup.
            for (const mode of ["archived", "deleted", "foreign", "missing"] as const) {
              if (mode === "archived")
                await EffectForFixture.runPromise(
                  f.sql`UPDATE orchestration_v2_projection_threads SET archived_at='2026-10-14T00:00:00Z' WHERE thread_id='one'`,
                );
              if (mode === "deleted")
                await EffectForFixture.runPromise(
                  f.sql`UPDATE orchestration_v2_projection_threads SET archived_at=NULL, deleted_at='2026-10-14T00:00:00Z' WHERE thread_id='one'`,
                );
              if (mode === "foreign")
                await EffectForFixture.runPromise(
                  f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at=NULL, project_id='project-b' WHERE thread_id='one'`,
                );
              if (mode === "missing")
                await EffectForFixture.runPromise(
                  f.sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id='one'`,
                );
              const marker = await changes(),
                savedReceipts = await rows(),
                navigationCount = state.navigate.mock.calls.length;
              if (mode === "archived") await openTask("one");
              else await taskNavigationRefresh();
              const projected = await EffectForFixture.runPromise(f.readSnapshot());
              expect(
                projected.tasks.find((t) => t.id === "task:governed:thread:one")!.threadId,
              ).toBeNull();
              expect(
                renderer.root.findByProps({ "aria-label": "Open task: Task one" }).props.disabled,
              ).toBe(true);
              await openTask("one");
              expect(state.navigate).toHaveBeenCalledTimes(navigationCount);
              expect(await changes()).toEqual(marker);
              expect(await rows()).toEqual(savedReceipts);
              expect(projected.agents.find((a) => a.id === "codex")!.threadId).toBe(canonicalId);
            }
            // Fault injection/repair are fixture DDL setup, never navigation or application writes.
            await EffectForFixture.runPromise(
              f.sql`ALTER TABLE collaboration_commands RENAME TO navigation_fault_commands`,
            );
            const failedMarker = await changes();
            await openTask("two");
            expect(text()).toContain("could not be confirmed");
            expect(await changes()).toEqual(failedMarker);
            await EffectForFixture.runPromise(
              f.sql`ALTER TABLE navigation_fault_commands RENAME TO collaboration_commands`,
            );
            const repairedMarker = await changes();
            await taskNavigationRefresh();
            expect(await changes()).toEqual(repairedMarker);
            expect(await rows()).toEqual(receipts);
            expect(await EffectForFixture.runPromise(f.noExecution())).toEqual(effects);
            expect(f.providerStarts()).toBe(0);
            expect(state.recover).not.toHaveBeenCalled();
            expect(state.create).not.toHaveBeenCalled();
            expect(state.bind).not.toHaveBeenCalled();
            await act(async () => renderer.unmount());
          }),
        { dbPath: path.join(dir, "state.sqlite") },
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("Agents task navigation retires the callback saved from a refreshing disabled render after that same read finishes", async () => {
  state.snapshot = taskNavigationSnapshot();
  await mount();
  const read = deferred<CollaborationSnapshot>();
  state.load.mockReturnValueOnce(read.promise);
  await taskNavigationRefresh();
  expect(taskNavigationAction()!.props.disabled).toBe(true);
  const disabledCallback = taskNavigationAction()!.props.onClick;
  await act(async () => read.resolve(state.snapshot));
  expect(taskNavigationAction()!.props.disabled).toBe(false);
  await act(async () => disabledCallback());
  expect(state.load).toHaveBeenCalledTimes(2);
  expect(state.navigate).not.toHaveBeenCalled();
  await openTaskForProof();
  expect(state.load).toHaveBeenCalledTimes(3);
  expect(state.navigate).toHaveBeenCalledTimes(1);
});

const budgetText = () =>
  renderer.root
    .findAll((n) => ["p", "dd", "dt", "h3"].includes(String(n.type)))
    .map((n) => n.children.join(""))
    .join("\n");

it("Tasks budget frozen behavior preserves partial and frozen evidence on failed refresh without execution", async () => {
  state.snapshot = {
    ...state.snapshot,
    tasks: [
      {
        id: "budget-task",
        title: "Read budget",
        projectId: "project-a",
        threadId: "budget-root",
        ownerAgentId: "owner",
        assigneeAgentId: "codex",
        state: "blocked",
        waitReason: null,
        acceptance: "Inspect evidence",
        gateDecision: "DENY",
        correlationId: "budget",
        revision: 1,
        pendingClarificationId: null,
        budgetReadout: {
          status: "available",
          taskId: "budget-task",
          threadId: "budget-root",
          rootThreadId: "budget-root",
          environmentId: "environment-a",
          contractRevision: 3,
          observedAt: "2026-10-14T20:00:00.000Z",
          reservedStarts: 4,
          declaredStarts: 2,
          remainingStarts: 0,
          declared: { tokens: null, costUsd: null, deadline: null },
          frozen: {
            tokens: 100,
            costUsd: 5,
            deadline: "2026-10-15T00:00:00.000Z",
            frozenAt: "2026-10-14T00:00:00.000Z",
          },
          usage: {
            status: "partial",
            attempts: 4,
            reportedTokens: 150,
            reportedCostUsd: null,
            priceStatus: "unverified",
            remainingTokens: null,
            verifiedRemainingCostUsd: null,
          },
          issues: [
            "start_exhausted",
            "usage_incomplete",
            "unverified_price",
            "unsettled_reservation",
          ],
        },
      },
    ],
  };
  await act(async () => {
    renderer = create(<TasksPage />);
  });
  await selectOnlyInboxTaskForDetailJourney(renderer);
  expect(budgetText()).toContain("Task tree budget evidence");
  expect(budgetText()).toContain("Reserved provider starts / declared limit / remaining");
  expect(budgetText()).toContain("4 / 2 / 0");
  expect(budgetText()).toContain("Not declared / Not declared / Not declared");
  expect(budgetText()).toContain("100 / 5 / 2026-10-15");
  expect(budgetText()).toContain("Reported tree usage (partial; 4 attempts)");
  expect(budgetText()).toContain("150 tokens / Unknown USD");
  expect(budgetText()).toContain("Unknown / Unknown");
  expect(budgetText()).toContain("unsettled_reservation");
  expect(budgetText()).toContain("Reservations are not confirmed execution");
  expect(budgetText()).toContain("a turn may exceed a remaining consumption cap");
  state.load.mockRejectedValueOnce(new Error("Budget refresh failed"));
  await act(async () => {
    renderer.root
      .findAllByType("button")
      .find((n) => n.children.includes("Refresh tasks"))!
      .props.onClick();
  });
  expect(budgetText()).toContain("Stale budget evidence");
  expect(budgetText()).toContain("150 tokens / Unknown USD");
  expect(state.bind).not.toHaveBeenCalled();
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it.each(["ordinary_chat", "budget_read_failed", "inconsistent_tree_accounting"])(
  "Tasks budget unknown %s does not fabricate zero usage",
  async (reason) => {
    state.snapshot = {
      ...state.snapshot,
      tasks: [
        {
          id: "unknown-budget",
          title: "Read unknown",
          projectId: "project-a",
          threadId: "unknown-root",
          ownerAgentId: "owner",
          assigneeAgentId: "codex",
          state: "blocked",
          waitReason: null,
          acceptance: "Inspect",
          gateDecision: "DENY",
          correlationId: "unknown",
          revision: 1,
          pendingClarificationId: null,
          budgetReadout: { status: "unavailable", reason },
        },
      ],
    };
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(budgetText()).toContain(`Budget evidence unknown: ${reason}`);
    expect(budgetText()).not.toContain("0 tokens");
    expect(budgetText()).not.toContain("None observed in this snapshot");
  },
);

it("eligible cap mounted real preview and persisted route refresh preserve read-only preparation", async () => {
  const module = await loadAgentsCreationFixture();
  await EffectForFixture.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      EffectForFixture.promise(async () => {
        const ready = module.agentsCreationProvider;
        f.setProviders([
          {
            ...ready,
            instanceId: ProviderInstanceId.make("aaa-disabled"),
            enabled: false,
            status: "disabled",
            models: Array.from({ length: 33 }, (_, i) => ({
              ...ready.models[0]!,
              slug: `blocked-${i}`,
            })),
          },
          ready,
        ]);
        const c = {
          ...module.agentsCreationCommand("eligible-cap-mounted"),
          taskContract: {
            goal: "Inspect the eligible cap fixture",
            redirect: "Keep fixture scope",
            acceptance: "Owner checks fixture",
            brake: { maxProviderStarts: 3, stopConditions: "Scope changed" },
          },
        };
        await EffectForFixture.runPromise(f.dispatch(c));
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        state.reviewRead.mockImplementation(
          async ({ input }: { input: TaskContractReviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.readReview(input)),
          }),
        );
        state.readProjection.mockImplementation(
          async ({ input }: { input: { threadId: string } }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(
              f.orchestrator.getThreadProjection(input.threadId),
            ),
          }),
        );
        state.autoPreview.mockImplementation(
          async ({ input }: { input: TaskAutoPreviewInput }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.previewAuto(input)),
          }),
        );
        useComposerDraftStore.setState({
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {},
          backgroundSubmissionThreadKeys: {},
          rewindingThreadKeys: new Set(),
        });
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        const before = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
        await creationClick("Prepare first instructions");
        await creationClick("Preview Auto", true);
        expect(text()).toContain("codex / fake-model");
        expect(text()).toContain("Only one eligible candidate remained in the selectable ranking.");
        expect(text()).toContain(
          "Selectable eligible candidates: 1 of 1. Excluded candidates: 33.",
        );
        expect(text()).toContain("not permission");
        expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(
          before,
        );
        expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
        const send: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
          type: "message.dispatch",
          commandId: CommandId.make("eligible-cap-mounted-send"),
          threadId: c.threadId,
          messageId: "eligible-cap-mounted-message" as Extract<
            OrchestrationV2Command,
            { type: "message.dispatch" }
          >["messageId"],
          text: "Inspect the eligible cap fixture",
          attachments: [],
          routingMode: "auto",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        };
        const receipt = await EffectForFixture.runPromise(f.dispatch(send));
        await creationClick("Refresh tasks");
        expect(text()).toContain("Selected model");
        expect(text()).toContain("fake-model (codex)");
        expect(text()).toContain(
          "Selectable eligible candidates: 1 of 1. Excluded candidates: 33.",
        );
        expect(text()).not.toContain("Provider-turn start recorded");
        const writes = await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`);
        await creationClick("Refresh tasks");
        expect(await EffectForFixture.runPromise(f.sql`SELECT total_changes() AS n`)).toEqual(
          writes,
        );
        expect((await EffectForFixture.runPromise(f.dispatch(send))).sequence).toBe(
          receipt.sequence,
        );
        expect(f.providerStarts()).toBe(0);
        expect(state.bind).not.toHaveBeenCalled();
        expect(state.navigate).not.toHaveBeenCalled();
      }),
    ),
  );
});

it.each([undefined, "openrouter/auto", "fixture/text-model"])(
  "result linkage mounted Tasks refresh and remount render actual persisted output without accepting it (%s)",
  async (fixtureOpenRouterModel) => {
    const module = (await import(
      /* @vite-ignore */ new URL(
        "../../../../server/src/collaboration/testkit/taskResultLinkageFixture.ts",
        import.meta.url,
      ).href
    )) as {
      withTaskResultLinkageFixture: (
        check: (fixture: {
          sql: SqlClientForFixture.SqlClient;
          createTask: (
            key: string,
          ) => EffectForFixture.Effect<
            Extract<OrchestrationV2Command, { type: "thread.create" }>,
            Error
          >;
          execute: (
            creation: Extract<OrchestrationV2Command, { type: "thread.create" }>,
            key: string,
            options?: { fixtureOpenRouterModel?: string },
          ) => EffectForFixture.Effect<void, Error>;
          readSnapshot: () => EffectForFixture.Effect<CollaborationSnapshot, Error>;
        }) => EffectForFixture.Effect<void, Error>,
        options?: { fixtureOpenRouterModel?: string },
      ) => EffectForFixture.Effect<void, Error>;
    };
    await EffectForFixture.runPromise(
      module.withTaskResultLinkageFixture(
        (f) =>
          EffectForFixture.gen(function* () {
            const c = yield* f.createTask("linkage-mounted");
            state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
            yield* EffectForFixture.promise(async () => {
              await act(async () => {
                renderer = create(<TasksPage />);
              });
              await selectOnlyInboxTaskForDetailJourney(renderer);
              expect(text()).not.toContain("Linked task output");
            });
            yield* f.execute(c, "linkage-mounted-message");
            const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
            const result = task.resultReadout;
            expect(result?.status).toBe("available");
            if (result?.status !== "available" || result.content.status !== "output")
              return yield* EffectForFixture.die("Real result output missing");
            const before = yield* f.sql`SELECT total_changes() AS n`;
            yield* EffectForFixture.promise(async () => {
              await creationClick("Refresh tasks");
              expect(text()).toContain(
                result.content.status === "output" ? result.content.preview : "missing",
              );
              expect(text()).not.toContain("missing_provider_turn");
              if (fixtureOpenRouterModel) {
                const identity = renderer.root
                  .findAllByType("p")
                  .find((p) => p.children.includes("Requested model: "));
                expect(identity?.children.join("")).toContain(
                  `Requested model: ${fixtureOpenRouterModel}; resolved model: fixture/resolved-model`,
                );
              }
              await act(async () => {
                renderer.unmount();
                renderer = create(<TasksPage />);
              });
              await selectOnlyInboxTaskForDetailJourney(renderer);
              expect(text()).toContain(
                result.content.status === "output" ? result.content.preview : "missing",
              );
            });
            expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(before);
            const after = (yield* f.readSnapshot()).tasks.find((t) => t.id === task.id)!;
            expect(
              after.contractReadout?.status === "available" &&
                after.contractReadout.acceptedRevision,
            ).toBe(null);
            expect(after.resultReadout).toEqual(result);
            expect(state.bind).not.toHaveBeenCalled();
            expect(state.navigate).not.toHaveBeenCalled();
          }),
        fixtureOpenRouterModel === undefined ? {} : { fixtureOpenRouterModel },
      ),
    );
  },
);

it("Manual target cap mounted Tasks refresh and remount show persisted explanation and basis", async () => {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../server/src/collaboration/testkit/taskResultLinkageFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withTaskResultLinkageFixture: (
      check: (fixture: {
        sql: SqlClientForFixture.SqlClient;
        setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
        createTask: (
          key: string,
        ) => EffectForFixture.Effect<
          Extract<OrchestrationV2Command, { type: "thread.create" }>,
          Error
        >;
        execute: (
          creation: Extract<OrchestrationV2Command, { type: "thread.create" }>,
          key: string,
          routing: {
            routingMode: "manual";
            modelSelection: { instanceId: ProviderInstanceId; model: string };
          },
          afterDispatch: () => EffectForFixture.Effect<void>,
        ) => EffectForFixture.Effect<void, Error>;
        readSnapshot: () => EffectForFixture.Effect<CollaborationSnapshot, Error>;
      }) => EffectForFixture.Effect<void, Error>,
    ) => EffectForFixture.Effect<void, Error>;
  };
  const fixtures = await loadAgentsCreationFixture();
  await EffectForFixture.runPromise(
    module.withTaskResultLinkageFixture((f) =>
      EffectForFixture.gen(function* () {
        const provider = fixtures.agentsCreationProvider;
        f.setProviders([
          {
            ...provider,
            models: [
              ...Array.from({ length: 74 }, (_, i) => ({
                ...provider.models[0]!,
                slug: `aaa-${i}`,
                isDefault: false,
              })),
              { ...provider.models[0]!, isDefault: false },
            ],
          },
        ]);
        const creation = yield* f.createTask("manual-cap-mounted");
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        yield* EffectForFixture.promise(async () => {
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
        });
        yield* f.execute(
          creation,
          "manual-cap-mounted-message",
          {
            routingMode: "manual",
            modelSelection: { instanceId: provider.instanceId, model: "fake-model" },
          },
          () =>
            EffectForFixture.gen(function* () {
              const persisted = (yield* f.readSnapshot()).tasks.find(
                (t) => t.threadId === creation.threadId,
              )?.routingReadout;
              expect(persisted?.status === "available" && persisted.mode).toBe("manual");
            }).pipe(EffectForFixture.orDie),
        );
        const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === creation.threadId)!;
        const route = task.routingReadout;
        expect(route?.status).toBe("available");
        if (route?.status !== "available")
          return yield* EffectForFixture.die("Persisted route missing");
        expect(route.mode).toBe("manual");
        expect(route.selectionBasis?.outcome).toBe("manual-accepted");
        const writes = yield* f.sql`SELECT total_changes() AS n`;
        yield* EffectForFixture.promise(async () => {
          await creationClick("Refresh tasks");
          expect(text()).toContain(route.explanation!);
          expect(text()).toContain("Manual");
          expect(text()).not.toContain("Mode not recorded");
          expect(text()).toContain(
            "Manual selection; automatic ranking did not decide the target.",
          );
          await act(async () => {
            renderer.unmount();
            renderer = create(<TasksPage />);
          });
          await selectOnlyInboxTaskForDetailJourney(renderer);
          expect(text()).toContain(route.explanation!);
          expect(text()).toContain(
            "Manual selection; automatic ranking did not decide the target.",
          );
        });
        expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(writes);
        expect(state.bind).not.toHaveBeenCalled();
        expect(state.navigate).not.toHaveBeenCalled();
      }),
    ),
  );
});

const retainedTaskFields = {
  "Task title": "Keep this unsent task",
  Goal: "Fix parser",
  Redirect: "Ask before expanding scope",
  Acceptance: "Parser regression passes",
  "Provider start limit": "2",
  "Stop conditions": "Scope changed",
  "Optional token cap": "900",
  "Optional reported cost cap (USD)": "0.1",
  "Optional UTC deadline": "2026-10-14T00:00:00Z",
};
const assertRetainedTaskText = () => {
  for (const [label, value] of Object.entries(retainedTaskFields)) {
    const input = renderer.root.findAllByProps({ "aria-label": label })[0];
    expect(input, `Unsent ${label} remains mounted`).toBeDefined();
    expect(input!.props.value).toBe(value);
  }
};
it.each(
  (["Agents", "Tasks"] as const).flatMap((page) =>
    (["readiness", "model-add", "model-remove", "model-order", "provider-order"] as const).flatMap(
      (change) => (["draft", "review"] as const).map((phase) => ({ page, change, phase })),
    ),
  ),
)(
  "retains unsent $page task $phase text across unrelated $change",
  async ({ page, change, phase }) => {
    const storage = creationStorage();
    const other = {
      ...configuredProviders[0]!,
      instanceId: "other-provider",
      enabled: false,
      models: [
        { slug: "other-one", name: "Other one", isDefault: true },
        { slug: "other-two", name: "Other two", isDefault: false },
      ],
    };
    state.providers = [configuredProviders[0]!, other];
    const view = () => (page === "Agents" ? <AgentsPage /> : <TasksPage />);
    await act(async () => {
      renderer = create(view());
    });
    await creationClick(page === "Agents" ? "New task" : "Create governed task");
    await fillCreation(retainedTaskFields["Task title"]);
    if (phase === "review") await creationClick("Review new task");
    const changed =
      change === "readiness"
        ? { ...other, enabled: true }
        : change === "model-add"
          ? {
              ...other,
              models: [
                ...other.models,
                { slug: "other-three", name: "Other three", isDefault: false },
              ],
            }
          : change === "model-remove"
            ? { ...other, models: other.models.slice(0, 1) }
            : { ...other, models: other.models.toReversed() };
    state.providers =
      change === "provider-order" ? state.providers.toReversed() : [state.providers[0]!, changed];
    await act(async () => renderer.update(view()));
    assertRetainedTaskText();
    expect(creationButton("Cancel new task")).toBeDefined();
    if (phase === "review") expect(creationButton("Create task")).toBeDefined();
    expect(storage.size).toBe(0);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.readCreationStatus).not.toHaveBeenCalled();
  },
);

it.each(
  (["Agents", "Tasks"] as const).flatMap((page) =>
    (["unavailable", "model", "removed", "default"] as const).map((change) => ({ page, change })),
  ),
)(
  "retains unsent $page text but retires selected-provider $change confirmation",
  async ({ page, change }) => {
    const storage = creationStorage();
    const view = () => (page === "Agents" ? <AgentsPage /> : <TasksPage />);
    await act(async () => {
      renderer = create(view());
    });
    await creationClick(page === "Agents" ? "New task" : "Create governed task");
    await fillCreation(retainedTaskFields["Task title"]);
    await creationClick("Review new task");
    const oldConfirm = creationButton("Create task")!.props.onClick;
    state.providers =
      change === "removed"
        ? []
        : [
            {
              ...configuredProviders[0]!,
              ...(change === "unavailable"
                ? { enabled: false }
                : {
                    models:
                      change === "default"
                        ? [
                            { ...configuredProviders[0]!.models[0]!, isDefault: false },
                            { slug: "new-model", name: "New", isDefault: true },
                          ]
                        : [{ slug: "new-model", name: "New", isDefault: true }],
                  }),
            },
          ];
    await act(async () => renderer.update(view()));
    assertRetainedTaskText();
    expect(creationButton("Create task")).toBeUndefined();
    await act(async () => oldConfirm());
    expect(state.create).not.toHaveBeenCalled();
    if (change === "unavailable" || change === "removed")
      expect(creationButton("Review new task")!.props.disabled).toBe(true);
    state.providers = [
      { ...configuredProviders[0]!, models: [{ slug: "new-model", name: "New", isDefault: true }] },
    ];
    await act(async () => renderer.update(view()));
    assertRetainedTaskText();
    expect(creationButton("Review new task")!.props.disabled).toBe(true);
    await creationClick("Select fixture exact model");
    await creationClick("Review new task");
    expect(text()).toContain("new-model");
    await act(async () => oldConfirm());
    expect(state.create).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
    await creationClick("Back to task draft");
    await creationClick("Cancel new task");
    await creationClick(page === "Agents" ? "New task" : "Create governed task");
    expect(renderer.root.findByProps({ "aria-label": "Task title" }).props.value).toBe("");
  },
);

it.each(
  (["Agents", "Tasks"] as const).flatMap((page) =>
    (["environment", "project", "session", "driver"] as const).map((scope) => ({ page, scope })),
  ),
)(
  "isolates unsent $page text and saved confirmation across $scope changes",
  async ({ page, scope }) => {
    creationStorage();
    const view = () => (page === "Agents" ? <AgentsPage /> : <TasksPage />);
    await act(async () => {
      renderer = create(view());
    });
    await creationClick(page === "Agents" ? "New task" : "Create governed task");
    await fillCreation(retainedTaskFields["Task title"]);
    await creationClick("Review new task");
    const oldConfirm = creationButton("Create task")!.props.onClick;
    if (scope === "environment") state.environmentId = "environment-b";
    else if (scope === "project")
      state.projects = [{ id: "project-b", title: "B", environmentId: "environment-a" }];
    else if (scope === "session") state.sessionIdentity = {};
    else state.providers = [{ ...configuredProviders[0]!, driver: "claudeAgent" }];
    await act(async () => renderer.update(view()));
    expect(creationButton("Create task")).toBeUndefined();
    await act(async () => oldConfirm());
    expect(state.create).not.toHaveBeenCalled();
    state.environmentId = "environment-a";
    state.projects = [{ id: "project-a", title: "A", environmentId: "environment-a" }];
    state.providers = [...configuredProviders];
    await act(async () => renderer.update(view()));
    await creationClick(page === "Agents" ? "New task" : "Create governed task");
    for (const label of Object.keys(retainedTaskFields))
      expect(renderer.root.findByProps({ "aria-label": label }).props.value).toBe("");
  },
);
it.each(["Agents", "Tasks"] as const)(
  "keeps the original pending $0 creation identity after unrelated churn without retry",
  async (page) => {
    const storage = creationStorage();
    const reply = deferred<{ _tag: "Failure" }>();
    state.create.mockReturnValueOnce(reply.promise);
    state.readCreationStatus.mockResolvedValue({ _tag: "Success", value: { status: "rejected" } });
    const view = () => (page === "Agents" ? <AgentsPage /> : <TasksPage />);
    await act(async () => {
      renderer = create(view());
    });
    await creationClick(page === "Agents" ? "New task" : "Create governed task");
    await fillCreation();
    await creationClick("Review new task");
    await creationClick("Create task", true);
    const command = state.create.mock.calls[0]![0].input;
    state.providers = [
      ...state.providers,
      { ...configuredProviders[0]!, instanceId: "unrelated", enabled: false },
    ];
    await act(async () => renderer.update(view()));
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(
      (decodeCreationStorage([...storage.values()][0]!) as { command: unknown }).command,
    ).toEqual(command);
    expect(
      creationButton(page === "Agents" ? "New task" : "Create governed task")!.props.disabled,
    ).toBe(true);
    await act(async () => reply.resolve({ _tag: "Failure" }));
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.readCreationStatus).not.toHaveBeenCalled();
    await creationClick("Recover task creation");
    expect(state.readCreationStatus).toHaveBeenCalledTimes(1);
    expect(state.readCreationStatus.mock.calls[0]![0].input.command).toEqual(command);
    expect(state.create).toHaveBeenCalledTimes(1);
  },
);

it.each(["Agents", "Tasks"] as const)(
  "confirms the retained $0 draft once after unrelated churn with no execution",
  async (page) => {
    creationStorage();
    const fixture = await loadAgentsCreationFixture();
    await EffectForFixture.runPromise(
      fixture.withAgentsTaskCreationFixture((f) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.dispatch(input)),
          }));
          state.readProjection.mockImplementation(
            async ({ input }: { input: { threadId: string } }) => ({
              _tag: "Success",
              value: await EffectForFixture.runPromise(
                f.orchestrator.getThreadProjection(input.threadId),
              ),
            }),
          );
          const view = () => (page === "Agents" ? <AgentsPage /> : <TasksPage />);
          await act(async () => {
            renderer = create(view());
          });
          await creationClick(page === "Agents" ? "New task" : "Create governed task");
          await fillCreation(retainedTaskFields["Task title"]);
          await creationClick("Review new task");
          state.providers = [
            { ...configuredProviders[0]!, instanceId: "other-provider", enabled: false },
            ...state.providers,
          ];
          await act(async () => renderer.update(view()));
          assertRetainedTaskText();
          expect(state.create).not.toHaveBeenCalled();
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
          await creationClick("Create task", true);
          expect(state.create).toHaveBeenCalledTimes(1);
          expect(text()).toContain("durably recorded");
          const command = state.create.mock.calls[0]![0].input;
          const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
          expect(snapshot.tasks.filter((task) => task.threadId === command.threadId)).toHaveLength(
            1,
          );
          expect(command.title).toBe(retainedTaskFields["Task title"]);
          expect(command.taskContract.goal).toBe(retainedTaskFields.Goal);
          expect(f.providerStarts()).toBe(0);
          expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
            runs: 0,
            grants: 0,
            outbox: 0,
            messages: 0,
          });
        }),
      ),
    );
  },
  60_000,
);

it("reviews scoped capability recommendations, invalidates catalog edits and restores manual no-match fallback", async () => {
  creationStorage();
  Object.assign(state.projects[0]!, { workspaceRoot: "/fixture/capability" });
  const skill = {
    name: "parser-tests",
    description: "Parser regression tests",
    path: "/fixture/skills/parser/SKILL.md",
    enabled: true,
  };
  const provider = {
    ...configuredProviders[0]!,
    skills: [skill],
    workspaceSnapshots: [
      {
        cwd: "/fixture/capability",
        checkedAt: "2026-10-18T00:00:00Z",
        skills: [skill],
        slashCommands: [],
      },
    ],
  };
  state.providers = [provider];
  await mount();
  await creationClick("New task");
  await fillCreation();
  await creationClick("Review new task");
  expect(text()).toContain("Capability plan — review only");
  expect(text()).toContain("Recommended");
  expect(text()).toContain("parser-tests");
  expect(text()).toContain("setup-required");
  expect(text()).toContain("No automatic skill invocation");
  expect(state.create).not.toHaveBeenCalled();
  const disabledProvider = {
    ...provider,
    workspaceSnapshots: [
      { ...provider.workspaceSnapshots[0]!, skills: [{ ...skill, enabled: false }] },
    ],
  };
  state.providers = [disabledProvider];
  await act(async () => renderer.update(<AgentsPage />));
  expect(creationButton("Create task")).toBeUndefined();
  await creationClick("Review new task");
  expect(text()).toContain("No eligible task-specific match");
  expect(text()).toContain("Disabled in the native catalog");
  await creationClick("Back to task draft");
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Goal" })
      .props.onChange({ target: { value: "Paint landscape" } }),
  );
  await creationClick("Review new task");
  expect(text()).toContain("manual capability choice");
  expect(state.create).not.toHaveBeenCalled();
});

it("labels persisted capability validation at dispatch and never presents stale recommendations as current", async () => {
  const skill = {
    name: "parser-tests",
    description: "Parser regression tests",
    path: "/fixture/parser/SKILL.md",
    enabled: true,
  };
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T00:00:00Z",
    version: null,
    skills: [skill],
    slashCommands: [],
    models: [{ slug: "fake-model", name: "Fake", isCustom: false, capabilities: null }],
    workspaceSnapshots: [
      { cwd: "/fixture", checkedAt: "2026-10-18T00:00:00Z", skills: [skill], slashCommands: [] },
    ],
  };
  const plan = planTaskCapabilities({
    environmentId: "environment-a",
    projectId: "project-a",
    workspace: "/fixture",
    modelSelection: { instanceId: provider.instanceId, model: "fake-model" },
    contract: {
      goal: "Fix parser",
      redirect: "Ask first",
      acceptance: "Parser tests pass",
      brake: { maxProviderStarts: 1, stopConditions: "Scope changed" },
    },
    provider,
  });
  await act(async () => {
    renderer = create(
      <TaskCapabilityReadout
        historical
        evidence={{
          mode: "review-only",
          status: "current",
          reason: "Snapshot at dispatch",
          reviewed: plan,
        }}
      />,
    );
  });
  expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(
    "At dispatch: current",
  );
  expect(text()).toContain("Recommended");
  await act(async () =>
    renderer.update(
      <TaskCapabilityReadout
        historical
        evidence={{
          mode: "review-only",
          status: "stale",
          reason: "Catalog changed",
          reviewed: plan,
        }}
      />,
    ),
  );
  expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(
    "At dispatch: stale",
  );
  expect(text()).not.toContain("Recommended");
  expect(text()).toContain("invalidated");
  await act(async () =>
    renderer.update(
      <TaskCapabilityReadout
        historical
        evidence={{
          mode: "review-only",
          observation: "provider-start",
          status: "stale",
          reason: "Fresh start observation",
          reviewed: plan,
        }}
      />,
    ),
  );
  expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Before provider start: stale",
  );
});

it("mounts real server-owned task review, admits only after explicit confirmation and invalidates changed prompt or connection", async () => {
  await withCapabilityReviewFixture(async (f) => {
    const prose = () =>
      renderer.root
        .findAllByType("p")
        .map((p) => p.children.filter((c) => typeof c === "string").join(""))
        .join("\n");
    const props = {
      task: f.task,
      environmentId: EnvironmentId.make("environment-a"),
      stale: false,
      readVersion: 1,
    };
    state.reviewRead.mockImplementation(async ({ input }: { input: TaskContractReviewInput }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.readReview(input)),
    }));
    state.startStep.mockImplementation(
      async ({
        input,
      }: {
        input: {
          commandId: string;
          threadId: string;
          message: { messageId: string; text: string };
          modelSelection: import("@t3tools/contracts").ModelSelection;
          capabilityStep: import("@t3tools/contracts").TaskCapabilityStep;
        };
      }) => ({
        _tag: "Success",
        value: await EffectForFixture.runPromise(
          f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(input.commandId),
            threadId: ThreadId.make(input.threadId),
            messageId: MessageId.make(input.message.messageId),
            text: input.message.text,
            attachments: [],
            modelSelection: input.modelSelection,
            routingMode: "manual",
            dispatchMode: { type: "queue_after_active" },
            capabilityStep: input.capabilityStep,
            createdBy: "user",
            creationSource: "web",
          }),
        ),
      }),
    );
    await act(async () => {
      renderer = create(<TaskCapabilityStepControls {...props} />);
    });
    expect(prose()).toContain("Native");
    expect(creationButton("Run reviewed saved PR step")).toBeUndefined();
    await creationClick("Review saved PR read");
    expect(prose()).toContain("t3-pull-requests/list_thread_pull_requests");
    expect(prose()).toContain("maximum 1 call");
    expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
      runs: 0,
      grants: 0,
      outbox: 0,
      messages: 0,
    });
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Saved PR answer instructions" })
        .props.onChange({ target: { value: "Different saved PR question" } }),
    );
    expect(creationButton("Run reviewed saved PR step")).toBeUndefined();
    await creationClick("Review saved PR read");
    state.sessionIdentity = {};
    await act(async () => renderer.update(<TaskCapabilityStepControls {...props} />));
    expect(creationButton("Run reviewed saved PR step")).toBeUndefined();
    await creationClick("Review saved PR read");
    await creationClick("Run reviewed saved PR step");
    expect(state.startStep).toHaveBeenCalledTimes(1);
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    expect(prose()).toContain("Admission is not operation or model completion");
    expect((await EffectForFixture.runPromise(f.noExecution())).runs).toBe(1);
    await creationClick("Read step status");
    expect(prose()).toContain("Operation: admitted");
    expect(prose()).toContain("No proven result");
  });
}, 30_000);

it("one mounted instruction draft suggests, reviews, confirms and reaches exactly the reviewed model with the saved PR result", async () => {
  await withIntentExecutionFixture(async (f) => {
    state.reviewRead.mockImplementation(async ({ input }: { input: TaskContractReviewInput }) => ({
      _tag: "Success",
      value: await f.readReview(input),
    }));
    state.readProjection.mockImplementation(async () => ({
      _tag: "Success",
      value: await f.projection(),
    }));
    state.startStep.mockImplementation(
      async ({ input }: { input: Parameters<typeof f.start>[0] }) => ({
        _tag: "Success",
        value: await f.start(input),
      }),
    );
    const onOpen = vi.fn();
    await act(async () => {
      renderer = create(
        <TaskFirstInstructions
          task={f.task}
          environmentId={EnvironmentId.make("environment-a")}
          stale={false}
          readVersion={1}
          onOpen={onOpen}
        />,
      );
    });
    await creationClick("Prepare first instructions", true);
    const instructions = "Summarize the saved pull requests linked to this task.";
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Initial instructions" })
        .props.onChange({ target: { value: instructions } }),
    );
    expect(
      renderer.root.findAllByProps({ "aria-label": "Saved PR answer instructions" }),
    ).toHaveLength(0);
    expect(creationButton("Suggest and review saved PR answer")).toBeDefined();
    await creationClick("Suggest and review saved PR answer");
    await act(async () => {
      await state.reviewRead.mock.results.at(-1)!.value;
    });
    expect(text()).toContain("aaa-reviewed");
    expect(text()).toContain("Suggested by the existing Auto router");
    const before = await f.inspect();
    expect(before.reads).toBe(0);
    expect(before.starts).toHaveLength(0);
    expect(before.projection.runs).toHaveLength(0);
    expect(state.autoPreview).not.toHaveBeenCalled();
    // Editing invalidates the proposal; the same draft feeds the next real review.
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Initial instructions" })
        .props.onChange({ target: { value: "Fix parser" } }),
    );
    expect(creationButton("Run reviewed saved PR step")).toBeUndefined();
    await creationClick("Suggest and review saved PR answer");
    await act(async () => {
      await state.reviewRead.mock.results.at(-1)!.value;
    });
    expect(text()).toContain("not a supported saved PR question");
    expect(creationButton("Run reviewed saved PR step")).toBeUndefined();
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Initial instructions" })
        .props.onChange({ target: { value: instructions } }),
    );
    await creationClick("Suggest and review saved PR answer");
    await act(async () => {
      await state.reviewRead.mock.results.at(-1)!.value;
    });
    const confirm = creationButton("Run reviewed saved PR step")!;
    await act(async () => {
      confirm.props.onClick();
      confirm.props.onClick();
    });
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    expect(state.startStep).toHaveBeenCalledTimes(1);
    expect(state.startStep.mock.calls[0]![0].input.message.text).toBe(instructions);
    expect(text()).toContain("Admission is not operation or model completion");
    await f.drain();
    const after = await f.inspect();
    expect(after.reads).toBe(1);
    expect(after.starts).toEqual([{ instanceId: "codex", model: "aaa-reviewed" }]);
    expect(after.projection.thread.modelSelection.model).toBe("fake-model");
    expect(after.projection.runs[0]!.status).toBe("completed");
    expect(
      after.projection.turnItems.some(
        (i) =>
          i.type === "assistant_message" && i.text.includes("Reviewed model answer: saved PR #42"),
      ),
    ).toBe(true);
    await creationClick("Read step status");
    await act(async () => {
      await state.reviewRead.mock.results.at(-1)!.value;
    });
    expect(
      renderer.root
        .findAllByType("p")
        .map((p) => p.children.filter((c) => typeof c === "string").join(""))
        .join("\n"),
    ).toContain("Operation: succeeded");
    expect(text()).toContain("does not mean the model completed");
    await creationClick("Open conversation and results");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
}, 30_000);

it.each([
  {
    question: "open",
    instructions: "Which saved PRs are open?",
    label: "Which saved PRs are open",
    answer: "Saved open: #1, #2",
  },
  {
    question: "draft",
    instructions: "Which saved PRs are drafts?",
    label: "Which saved PRs are drafts",
    answer: "Saved draft: #1, #5",
  },
])(
  "one draft reviews and answers saved $question facts without treating unknown as false",
  async ({ question, instructions, label, answer }) => {
    await withIntentExecutionFixture(
      async (f) => {
        state.reviewRead.mockImplementation(
          async ({ input }: { input: TaskContractReviewInput }) => ({
            _tag: "Success",
            value: await f.readReview(input),
          }),
        );
        state.readProjection.mockImplementation(async () => ({
          _tag: "Success",
          value: await f.projection(),
        }));
        state.startStep.mockImplementation(
          async ({ input }: { input: Parameters<typeof f.start>[0] }) => ({
            _tag: "Success",
            value: await f.start(input),
          }),
        );
        const prose = () =>
          renderer.root
            .findAllByType("p")
            .map((p) => p.children.filter((c) => typeof c === "string").join(""))
            .join("\n");
        await act(async () => {
          renderer = create(
            <TaskFirstInstructions
              task={f.task}
              environmentId={EnvironmentId.make("environment-a")}
              stale={false}
              readVersion={1}
              onOpen={vi.fn()}
            />,
          );
        });
        await creationClick("Prepare first instructions");
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "Initial instructions" })
            .props.onChange({ target: { value: instructions } }),
        );
        expect(
          renderer.root.findAllByProps({ "aria-label": "Saved PR answer instructions" }),
        ).toHaveLength(0);
        await creationClick("Suggest and review saved PR answer");
        await act(async () => {
          await state.reviewRead.mock.results.at(-1)!.value;
        });
        expect(prose()).toContain(`Interpreted question: ${label}`);
        expect(prose()).toContain("Saved status has not been refreshed from GitHub");
        expect(prose()).toContain("missing values remain unknown");
        expect(prose()).toContain("does not establish merge readiness");
        expect((await f.inspect()).reads).toBe(0);
        expect((await f.inspect()).starts).toHaveLength(0);
        const prepared = state.reviewRead.mock.results.at(-1)!;
        const proposal = (await prepared.value).value.capabilityStep;
        expect(proposal.reviewedIntent.question).toBe(question);
        expect(proposal.reviewedIntent.text).toBe(instructions);
        await creationClick("Run reviewed saved PR step", true);
        await act(async () => {
          await state.startStep.mock.results[0]!.value;
        });
        expect(state.startStep).toHaveBeenCalledTimes(1);
        expect(state.startStep.mock.calls[0]![0].input.message.text).toBe(instructions);
        await f.drain();
        const after = await f.inspect();
        expect(after.reads).toBe(1);
        expect(after.starts).toEqual([proposal.modelSelection]);
        expect(after.projection.thread.modelSelection.model).toBe("fake-model");
        expect(after.projection.runs[0]!.id).toBe(proposal.runId);
        expect(after.projection.runs[0]!.status).toBe("completed");
        const modelAnswer = after.projection.turnItems.find((i) => i.type === "assistant_message");
        expect(modelAnswer?.type === "assistant_message" && modelAnswer.text).toContain(answer);
        expect(modelAnswer?.type === "assistant_message" && modelAnswer.text).toContain(
          "unknown: #6",
        );
        expect(modelAnswer?.type === "assistant_message" && modelAnswer.text).toContain(
          "No CI, approval, mergeability or merge-readiness conclusion is supported",
        );
        await creationClick("Read step status");
        await act(async () => {
          await state.reviewRead.mock.results.at(-1)!.value;
        });
        expect(prose()).toContain("Operation: succeeded");
        expect(prose()).toContain("does not mean the model completed");
      },
      { statusQuestions: true },
    );
  },
  30000,
);

type GenericFixture = Parameters<Parameters<typeof withFirstLaunchFixture>[0]>[0];
const wireGenericLaunch = (f: GenericFixture) => {
  state.skillReview.mockImplementation(
    async ({ input }: { input: Parameters<typeof f.reviewInstructionSkill>[0] }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.reviewInstructionSkill(input)),
    }),
  );
  state.providers = f.providers.map((p) => ({
    ...p,
    displayName: p.displayName ?? p.driver,
    models: p.models.map((m) => ({ ...m, isDefault: false })),
  }));
  state.reviewRead.mockImplementation(async ({ input }: { input: TaskContractReviewInput }) => ({
    _tag: "Success",
    value: await EffectForFixture.runPromise(f.readReview(input)),
  }));
  state.readProjection.mockImplementation(async ({ input }: { input: { threadId: ThreadId } }) => ({
    _tag: "Success",
    value: await EffectForFixture.runPromise(f.projection(input.threadId)),
  }));
  state.firstLaunchRead.mockImplementation(
    async ({
      input,
    }: {
      input: { command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> };
    }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.readStatus(input.command)),
    }),
  );
  state.startStep.mockImplementation(
    async ({ input }: { input: Parameters<typeof f.start>[0] }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.start(input)),
    }),
  );
  state.autoPreview.mockImplementation(async ({ input }: { input: TaskAutoPreviewInput }) => ({
    _tag: "Success",
    value: await EffectForFixture.runPromise(f.preview(input)),
  }));
};
const genericProps = (f: GenericFixture, onOpen = vi.fn()) => ({
  task: f.task,
  environmentId: EnvironmentId.make("environment-a"),
  stale: false,
  readVersion: 1,
  onOpen,
});
const prepareGeneric = async (instructions: string, mode: "manual" | "auto") => {
  await creationClick("Prepare first instructions");
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Initial instructions" })
      .props.onChange({ target: { value: instructions } }),
  );
  await creationClick(mode === "manual" ? "Choose Manual" : "Choose Auto");
};
it.each(["Retain these unsaved first instructions.", ""])(
  "retains first instructions %j across focused task return and retires old editor callbacks",
  async (draft) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      const view = (selected: "a" | "b") => (
        <TaskInboxDrafts>
          {selected === "a" ? <TaskFirstInstructions key="a" {...props} /> : <p>Task B</p>}
        </TaskInboxDrafts>
      );
      await act(async () => {
        renderer = create(view("a"));
      });
      await creationClick("Prepare first instructions");
      const editor = () => renderer.root.findByProps({ "aria-label": "Initial instructions" });
      expect(editor().props.value).toBe(
        f.task.contractReadout?.status === "available" ? f.task.contractReadout.contract.goal : "",
      );
      const retiredEdit = editor().props.onChange;
      const retiredPreview = creationButton("Preview Auto")!.props.onClick;
      await act(async () => editor().props.onChange({ target: { value: draft } }));
      await act(async () =>
        renderer.root.findByProps({ "data-review-dialog": "" }).props.onClose(),
      );
      await act(async () => renderer.update(view("b")));
      await act(async () => {
        retiredEdit({ target: { value: "Retired editor must not overwrite retained text" } });
        retiredPreview();
      });
      await act(async () => renderer.update(view("a")));
      expect(renderer.root.findAllByProps({ "aria-label": "Initial instructions" })).toHaveLength(
        0,
      );
      const readsBefore = state.reviewRead.mock.calls.length;
      await creationClick("Prepare first instructions");
      expect(state.reviewRead.mock.calls.length).toBe(readsBefore + 2);
      expect(editor().props.value).toBe(draft);
      expect(state.autoPreview).not.toHaveBeenCalled();
      if (draft) {
        await creationClick("Preview Auto");
        await act(async () => {
          await state.autoPreview.mock.results.at(-1)!.value;
        });
        expect(state.autoPreview.mock.calls.at(-1)![0].input.text).toBe(draft);
      } else {
        expect(creationButton("Preview Auto")!.props.disabled).toBe(true);
      }
      expect(state.startStep).not.toHaveBeenCalled();
      expect(props.onOpen).not.toHaveBeenCalled();
      expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    });
  },
);

it.each(["manual", "auto"] as const)(
  "generic %s Tasks launch reaches actual input/output and recovers the same identity after remount",
  async (mode) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      const instructions = "Implement the parser fix with focused tests.";
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await prepareGeneric(instructions, "manual");
      await creationClick("Choose fixture Manual model");
      if (mode === "auto") {
        await creationClick("Choose Auto");
        await creationClick("Choose Manual");
        expect(
          renderer.root.findByProps({ "aria-label": "Task model picker" }).findByType("span")
            .children,
        ).toContain("manual-choice");
        await creationClick("Choose Auto");
        await creationClick("Preview Auto");
        await act(async () => {
          await state.autoPreview.mock.results[0]!.value;
        });
        expect(
          (await state.autoPreview.mock.results[0]!.value).value.decision.selected.target.model,
        ).toBe("bbb-preview");
      }
      await creationClick("Review ordinary task launch");
      expect(text()).toContain(instructions);
      expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
      if (mode === "auto") f.changeAutoCandidate();
      await creationClick("Start reviewed ordinary task", true);
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
      });
      await act(async () => {
        await state.firstLaunchRead.mock.results.at(-1)!.value;
      });
      expect(state.startStep).toHaveBeenCalledTimes(1);
      expect(props.onOpen).not.toHaveBeenCalled();
      await EffectForFixture.runPromise(f.drain());
      const before = await EffectForFixture.runPromise(f.inspect());
      expect(before.starts).toEqual([
        { instanceId: "codex", model: mode === "auto" ? "aaa-after-review" : "manual-choice" },
      ]);
      expect(before.executions[0]!.message.text).toBe(instructions);
      const key = firstLaunchStorageKey("environment-a", f.task.threadId!);
      const saved = readFirstLaunchAttempt(key).attempt!;
      const originalId = saved.command.commandId;
      expect(saved.command.taskFirstLaunch!.routingMode).toBe(mode);
      await act(async () => {
        renderer.unmount();
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      expect(creationButton("Prepare first instructions")!.props.disabled).toBe(true);
      await creationClick("Read original launch status");
      await act(async () => {
        await state.firstLaunchRead.mock.results.at(-1)!.value;
      });
      const paragraphs = renderer.root
        .findAllByType("p")
        .map((p) => p.children.filter((c) => typeof c === "string").join(""))
        .join("\n");
      expect(paragraphs).toContain("run status completed");
      expect(paragraphs).toContain(`Actual generic answer: ${instructions}`);
      expect(state.startStep).toHaveBeenCalledTimes(1);
      expect(readFirstLaunchAttempt(key).attempt!.command.commandId).toBe(originalId);
      const projection = await EffectForFixture.runPromise(f.projection());
      expect(projection.runs).toHaveLength(1);
      expect(projection.messages[0]!.taskFirstLaunch!.commandId).toBe(originalId);
      expect(projection.messages[0]!.capabilityStep).toBeUndefined();
    });
  },
  30000,
);

it.each(["lost reply", "late reply after remount", "disconnect", "no receipt"] as const)(
  "%s keeps original launch identity UNKNOWN without resending",
  async (outcome) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      const reply = deferred<void>();
      const dispatched = deferred<void>();
      state.startStep.mockImplementation(
        async ({ input }: { input: Parameters<typeof f.start>[0] }) => {
          if (outcome !== "no receipt") await EffectForFixture.runPromise(f.start(input));
          dispatched.resolve();
          if (outcome === "lost reply" || outcome === "no receipt")
            throw new Error("Synthetic lost reply");
          await reply.promise;
          return { _tag: "Success", value: undefined };
        },
      );
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await prepareGeneric("Review this implementation for correctness.", "manual");
      await creationClick("Review ordinary task launch");
      await creationClick("Start reviewed ordinary task", true);
      await act(async () => {
        await dispatched.promise;
      });
      if (outcome === "lost reply" || outcome === "no receipt")
        await act(async () => {
          await state.startStep.mock.results[0]!.value.catch(() => {});
        });
      const key = firstLaunchStorageKey("environment-a", f.task.threadId!);
      const original = readFirstLaunchAttempt(key).attempt!.command;
      if (outcome === "disconnect") {
        state.sessionIdentity = {};
        await act(async () => renderer.update(<TaskFirstInstructions {...props} />));
      }
      await act(async () => {
        renderer.unmount();
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await creationClick("Read original launch status");
      await act(async () => {
        await state.firstLaunchRead.mock.results.at(-1)!.value;
      });
      if (outcome === "late reply after remount" || outcome === "disconnect")
        await act(async () => {
          reply.resolve();
          await state.startStep.mock.results[0]!.value;
        });
      expect(state.startStep).toHaveBeenCalledTimes(1);
      expect(props.onOpen).not.toHaveBeenCalled();
      expect(readFirstLaunchAttempt(key).attempt!.command).toEqual(original);
      expect(creationButton("Prepare first instructions")!.props.disabled).toBe(true);
      if (outcome === "no receipt") {
        expect(readFirstLaunchAttempt(key).attempt!.status).toBe("unknown");
        expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
      } else {
        await EffectForFixture.runPromise(f.drain());
        expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(1);
        await creationClick("Read original launch status");
        await act(async () => {
          await state.firstLaunchRead.mock.results.at(-1)!.value;
        });
        expect(readFirstLaunchAttempt(key).attempt!.status).toBe("admitted");
      }
    });
  },
  30000,
);

it("storage failure blocks first launch before dispatch", async () => {
  await withFirstLaunchFixture(async (f) => {
    wireGenericLaunch(f);
    const props = genericProps(f);
    await act(async () => {
      renderer = create(<TaskFirstInstructions {...props} />);
    });
    await prepareGeneric("Implement a regression fix.", "manual");
    await creationClick("Review ordinary task launch");
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("Synthetic storage failure");
      },
    });
    await creationClick("Start reviewed ordinary task");
    expect(state.startStep).not.toHaveBeenCalled();
    expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    expect(text()).toContain("Nothing was sent");
  });
}, 30000);

it("creation confirmation offers review/start for its exact task and does not start during creation", async () => {
  await withFirstLaunchFixture(async (f) => {
    wireGenericLaunch(f);
    state.load.mockImplementation(() => EffectForFixture.runPromise(f.snapshot()));
    state.create.mockImplementation(async ({ input }: { input: OrchestrationV2Command }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.create(input)),
    }));
    state.readCreationStatus.mockImplementation(
      async ({ input }: { input: { command: OrchestrationV2Command } }) => ({
        _tag: "Success",
        value: await EffectForFixture.runPromise(f.readCreationStatus(input.command)),
      }),
    );
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await creationClick("Create governed task");
    await fillCreation("Creation then generic launch");
    for (const label of [
      "Optional token cap",
      "Optional reported cost cap (USD)",
      "Optional UTC deadline",
    ])
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": label })
          .props.onChange({ target: { value: "" } }),
      );
    await creationClick("Review new task");
    await creationClick("Create task", true);
    await act(async () => {
      await state.create.mock.results[0]!.value;
      await state.readProjection.mock.results.at(-1)!.value;
    });
    expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    const created = state.create.mock.calls[0]![0].input;
    await creationClick("Prepare created task for review/start");
    expect(renderer.root.findByProps({ "aria-label": "Initial instructions" }).props.value).toBe(
      "Fix parser",
    );
    await creationClick("Choose Manual");
    await creationClick("Review ordinary task launch");
    await creationClick("Start reviewed ordinary task");
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
      await state.firstLaunchRead.mock.results.at(-1)!.value;
    });
    await EffectForFixture.runPromise(f.drain());
    expect(state.startStep.mock.calls[0]![0].input.threadId).toBe(created.threadId);
    expect((await EffectForFixture.runPromise(f.inspect())).executions[0]!.threadId).toBe(
      created.threadId,
    );
    expect((await EffectForFixture.runPromise(f.inspect())).executions[0]!.message.text).toBe(
      "Fix parser",
    );
    expect((await EffectForFixture.runPromise(f.projection(created.threadId))).runs).toHaveLength(
      1,
    );
  });
}, 30000);

it("governed creation requires explicit exact model and never falls back after withdrawal", async () => {
  creationStorage();
  state.providers = [
    {
      ...configuredProviders[0]!,
      models: [
        ...configuredProviders[0]!.models,
        { slug: "exact-second", name: "Second", isDefault: false },
      ],
    },
  ];
  await act(async () => {
    renderer = create(<TasksPage />);
  });
  await selectOnlyInboxTaskForDetailJourney(renderer);
  await creationClick("Create governed task");
  await fillCreation("Explicit selection", false);
  expect(creationButton("Review new task")!.props.disabled).toBe(true);
  await creationClick("Select exact model: exact-second");
  await creationClick("Review new task");
  expect(text()).toContain("exact-second");
  expect(state.create).not.toHaveBeenCalled();
  const staleConfirm = creationButton("Create task")!.props.onClick;
  state.providers = [configuredProviders[0]!];
  await act(async () => renderer.update(<TasksPage />));
  await selectOnlyInboxTaskForDetailJourney(renderer);
  expect(creationButton("Create task")).toBeUndefined();
  expect(creationButton("Review new task")!.props.disabled).toBe(true);
  expect(text()).toContain("exact-second");
  expect(text()).toContain("Unavailable");
  await act(async () => staleConfirm());
  expect(state.create).not.toHaveBeenCalled();
  await creationClick("Select exact model: fake-model");
  await creationClick("Review new task");
  expect(text()).toContain("fake-model");
  expect(state.create).not.toHaveBeenCalled();
});

describe("mounted setup return scope", () => {
  it("restores the selected second project after leaving Agents for setup and returning", async () => {
    const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } =
      await import("@tanstack/react-router");
    state.projects = [
      { id: "project-a", title: "A", environmentId: "environment-a" },
      { id: "project-b", title: "B", environmentId: "environment-a" },
    ];
    const root = createRootRoute();
    const agents = createRoute({
      getParentRoute: () => root,
      path: "agents",
      validateSearch: validateCollaborationScope,
      component: () => <CollaborationRoutePage page="agents" />,
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "settings/providers",
      validateSearch: validateSettingsRouteSearch,
      search: { middlewares: [retainSettingsScope] },
      component: () => (
        <div>
          Provider setup
          <SetupReturnAction search={router.state.location.search} />
        </div>
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([agents, settings]),
      history: createMemoryHistory({ initialEntries: ["/agents"] }),
    });
    await act(async () => {
      await router.load();
      renderer = create(<RouterProvider router={router} />);
    });
    await act(async () =>
      renderer.root.findAllByType("select")[0]!.props.onChange({ target: { value: "project-b" } }),
    );
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Connect your agent"))!
        .props.onClick(),
    );
    expect(router.state.location.pathname).toBe("/settings/providers");
    await act(async () => {
      renderer.unmount();
      renderer = create(<RouterProvider router={router} />);
    });
    expect(text()).toContain("Provider setup");
    await act(async () => {
      await renderer.root
        .findAllByType("button")
        .find((node) => node.children.join("") === "Return to Agents")!
        .props.onClick();
      await router.load();
      renderer.unmount();
      renderer = create(<RouterProvider router={router} />);
    });
    expect(renderer.root.findAllByType("select")[0]!.props.value).toBe("project-b");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
  });
});

describe("validated setup detours mounted with memory history", () => {
  async function journey(page: "agents" | "tasks", href = `/${page}`) {
    const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } =
      await import("@tanstack/react-router");
    const root = createRootRoute();
    const agents = createRoute({
      getParentRoute: () => root,
      path: "agents",
      validateSearch: validateCollaborationScope,
      component: () => <CollaborationRoutePage page="agents" />,
    });
    const tasks = createRoute({
      getParentRoute: () => root,
      path: "tasks",
      validateSearch: validateCollaborationScope,
      component: () => <CollaborationRoutePage page="tasks" />,
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "settings",
      validateSearch: validateSettingsRouteSearch,
      search: { middlewares: [retainSettingsScope] },
    });
    const providers = createRoute({
      getParentRoute: () => settings,
      path: "providers",
      component: () => (
        <div>
          Provider setup
          <SetupReturnAction search={router.state.location.search} />
        </div>
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([agents, tasks, settings.addChildren([providers])]),
      history: createMemoryHistory({ initialEntries: [href] }),
    });
    const remount = async () =>
      act(async () => {
        renderer?.unmount();
        renderer = create(<RouterProvider router={router} />);
      });
    await router.load();
    if (router.state.redirect) await router.navigate(router.state.redirect.options);
    await remount();
    const press = async (label: string, twice = false) =>
      act(async () => {
        const node = renderer.root
          .findAllByType("button")
          .find((n) => n.children.filter((child) => typeof child === "string").join("") === label)!;
        expect(node).toBeDefined();
        const result = node.props.onClick();
        if (twice) node.props.onClick();
        await result;
      });
    const choose = async (index: number, value: string) =>
      act(async () => {
        renderer.root.findAllByType("select")[index]!.props.onChange({ target: { value } });
      });
    return { router, remount, press, choose };
  }
  function twoScopes() {
    state.projects = [
      { id: "project-a", title: "A", environmentId: "environment-a" },
      { id: "project-b", title: "B", environmentId: "environment-a" },
    ];
    state.providers = [
      ...configuredProviders,
      { ...configuredProviders[0]!, instanceId: "second", displayName: "Second" },
    ];
  }
  const noProviderWork = () => {
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
  };
  it("returns Tasks to the second project/provider, survives reload and keeps setup repeat clicks side-effect free", async () => {
    twoScopes();
    const flow = await journey("tasks");
    await flow.choose(0, "project-b");
    await flow.choose(1, "second");
    await flow.press("Provider setup", true);
    await flow.router.load();
    await flow.remount();
    expect(flow.router.state.location.search).toMatchObject({
      machine: "environment-a",
      returnPage: "tasks",
      scopeProjectId: "project-b",
      scopeProviderId: "second",
    });
    await flow.press("Return to Tasks", true);
    await flow.router.load();
    await flow.remount();
    expect(creationScopeSelectValues()).toEqual(["project-b", "second"]);
    const href = flow.router.state.location.href;
    await act(async () => renderer.unmount());
    await journey("tasks", href);
    expect(creationScopeSelectValues()).toEqual(["project-b", "second"]);
    noProviderWork();
  });
  it("restores the exact Agents project/provider selection without creating a conversation", async () => {
    twoScopes();
    const flow = await journey("agents");
    await flow.choose(0, "project-b");
    await flow.press("Create agent");
    await flow.choose(0, "second");
    await flow.press("Connect your agent");
    await flow.router.load();
    await flow.remount();
    await flow.press("Return to Agents");
    await flow.router.load();
    await flow.remount();
    await flow.press("Create agent");
    expect(creationScopeSelectValues()).toEqual(["second", "project-b"]);
    noProviderWork();
  });
  it("blocks malformed retained scope until an explicit current-scope selection", async () => {
    const flow = await journey("tasks", "/tasks?scopeEnvironmentId=environment-a&scopeProjectId=7");
    expect(text()).toContain("Saved setup scope does not match");
    expect(creationButton("Create governed task")!.props.disabled).toBe(true);
    await flow.press("Choose current environment and scope");
    expect(creationButton("Create governed task")!.props.disabled).toBe(false);
    noProviderWork();
  });
  it.each(["project", "provider", "environment"] as const)(
    "fails closed when the retained %s is removed or changed",
    async (kind) => {
      twoScopes();
      const flow = await journey("tasks");
      await flow.choose(0, "project-b");
      await flow.choose(1, "second");
      await flow.press("Provider setup");
      await flow.router.load();
      await flow.remount();
      if (kind === "project") state.projects = state.projects.filter((p) => p.id !== "project-b");
      if (kind === "provider")
        state.providers = state.providers.filter((p) => p.instanceId !== "second");
      if (kind === "environment") {
        state.environmentId = "environment-b";
        state.projects = [
          { id: "project-b", title: "Same ID on B", environmentId: "environment-b" },
        ];
      }
      await flow.press("Return to Tasks");
      await flow.router.load();
      await flow.remount();
      expect(text()).toContain(
        kind === "project"
          ? "selected project is no longer available"
          : kind === "provider"
            ? "selected provider is no longer ready"
            : "Saved setup scope does not match",
      );
      expect(creationButton("Create governed task")!.props.disabled).toBe(true);
      noProviderWork();
    },
  );
  it("keeps an unready retained provider selected as unavailable instead of substituting the only ready one", async () => {
    twoScopes();
    const flow = await journey("tasks");
    await flow.choose(0, "project-b");
    await flow.choose(1, "second");
    await flow.press("Provider setup");
    await flow.router.load();
    await flow.remount();
    state.providers = state.providers.map((p) =>
      p.instanceId === "second" ? { ...p, enabled: false } : p,
    );
    await flow.press("Return to Tasks");
    await flow.router.load();
    await flow.remount();
    expect(text()).toContain("selected provider is no longer ready");
    expect(creationButton("Create governed task")!.props.disabled).toBe(true);
    noProviderWork();
  });
  it("uses URL history for Back/Forward and does not overwrite a newer navigation", async () => {
    twoScopes();
    const flow = await journey("tasks");
    await flow.choose(0, "project-b");
    await flow.choose(1, "second");
    await flow.router.load();
    await flow.remount();
    await flow.press("Provider setup");
    await flow.router.load();
    await flow.remount();
    await act(async () => {
      flow.router.history.back();
      await flow.router.load();
    });
    await flow.remount();
    expect(flow.router.state.location.pathname).toBe("/tasks");
    expect(creationScopeSelectValues()).toEqual(["project-b", "second"]);
    await act(async () => {
      flow.router.history.forward();
      await flow.router.load();
    });
    await flow.remount();
    expect(flow.router.state.location.pathname).toBe("/settings/providers");
    await flow.press("Return to Tasks");
    await act(async () => {
      await flow.router.navigate({ to: "/agents", search: {} });
    });
    await flow.remount();
    expect(flow.router.state.location.pathname).toBe("/agents");
    noProviderWork();
  });
  it.each(["agents", "tasks"] as const)(
    "offers existing local project creation and cancellation on empty %s",
    async (page) => {
      state.projects = [];
      const flow = await journey(page);
      expect(creationButton("Create a project")!.props.disabled).toBe(false);
      await flow.press("Create a project");
      await flow.press("Cancel project setup");
      expect(state.createProject).not.toHaveBeenCalled();
      await flow.press("Create a project");
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "New project name" })
          .props.onChange({ target: { value: "Local fixture" } }),
      );
      const pending = deferred<boolean>();
      state.createProject.mockReturnValue(pending.promise);
      await act(async () => {
        const submit = renderer.root.findByType("form").props.onSubmit;
        submit({ preventDefault() {} });
        submit({ preventDefault() {} });
      });
      expect(state.createProject).toHaveBeenCalledTimes(1);
      expect(state.createProject).toHaveBeenCalledWith({
        environmentId: "environment-a",
        name: "Local fixture",
        github: null,
        openDraft: false,
      });
      await act(async () => {
        await flow.router.navigate({ to: page === "tasks" ? "/agents" : "/tasks" });
      });
      await flow.remount();
      await act(async () => pending.resolve(true));
      expect(flow.router.state.location.pathname).toBe(page === "tasks" ? "/agents" : "/tasks");
      noProviderWork();
    },
  );
  it("does not offer an executable create action on a disconnected empty environment", async () => {
    state.projects = [];
    state.sessionIdentity = null;
    await journey("tasks");
    expect(creationButton("Create a project")!.props.disabled).toBe(true);
    expect(state.createProject).not.toHaveBeenCalled();
    noProviderWork();
  });
  it("drops unrelated search data on a valid return and ignores a stale return callback", async () => {
    twoScopes();
    const flow = await journey(
      "tasks",
      "/settings/providers?returnPage=tasks&scopeEnvironmentId=environment-a&scopeProjectId=project-b&scopeProviderId=second&taskText=private&token=secret&returnUrl=https%3A%2F%2Fevil.invalid",
    );
    const staleReturn = renderer.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "Return to Tasks")!.props.onClick;
    await flow.press("Return to Tasks");
    await flow.router.load();
    await flow.remount();
    expect(flow.router.state.location.search).toEqual({
      scopeEnvironmentId: "environment-a",
      scopeProjectId: "project-b",
      scopeProviderId: "second",
    });
    await act(async () => flow.router.navigate({ to: "/agents", search: {} }));
    await flow.remount();
    await act(async () => staleReturn());
    expect(flow.router.state.location.pathname).toBe("/agents");
    noProviderWork();
  });
  it("isolates project setup from an environment change and late completion", async () => {
    state.projects = [];
    const flow = await journey("tasks", "/tasks?scopeEnvironmentId=environment-a");
    await flow.press("Create a project");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "New project name" })
        .props.onChange({ target: { value: "On A" } }),
    );
    const pending = deferred<boolean>();
    state.createProject.mockReturnValue(pending.promise);
    const staleSubmit = renderer.root.findByType("form").props.onSubmit;
    await act(async () => staleSubmit({ preventDefault() {} }));
    state.environmentId = "environment-b";
    await flow.remount();
    await act(async () => {
      staleSubmit({ preventDefault() {} });
      pending.resolve(true);
    });
    expect(state.createProject).toHaveBeenCalledTimes(1);
    expect(state.createProject.mock.calls[0]![0].environmentId).toBe("environment-a");
    expect(text()).toContain("Saved setup scope does not match");
    expect(creationButton("Create a project")!.props.disabled).toBe(true);
    expect(flow.router.state.location.pathname).toBe("/tasks");
    noProviderWork();
  });
  it("reports an unconfirmed project command without retrying or starting work", async () => {
    state.projects = [];
    const flow = await journey("tasks");
    await flow.press("Create a project");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "New project name" })
        .props.onChange({ target: { value: "Local" } }),
    );
    state.createProject.mockRejectedValue(new Error("Synthetic disconnect"));
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
      await state.createProject.mock.results[0]!.value.catch(() => {});
    });
    expect(text()).toContain("Project creation could not be confirmed");
    expect(state.createProject).toHaveBeenCalledTimes(1);
    noProviderWork();
  });
  it("ignores arbitrary return URLs and does not persist task text or credentials", async () => {
    const flow = await journey(
      "tasks",
      "/settings/providers?returnPage=https%3A%2F%2Fevil.invalid&taskText=private&token=secret",
    );
    expect(validateSettingsRouteSearch(flow.router.state.location.search)).toEqual({});
    expect(creationButton("Return to Tasks")).toBeUndefined();
    noProviderWork();
  });
});

it("explicitly selects and reviews recorded workspace, starts nothing until confirmation, and retires a stale Start after choice changes", async () => {
  await withCapabilityReviewFixture(async (f) => {
    state.reviewRead.mockImplementation(async ({ input }: { input: TaskContractReviewInput }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.readReview(input)),
    }));
    state.startStep.mockImplementation(
      async ({
        input,
      }: {
        input: {
          commandId: string;
          threadId: string;
          message: { messageId: string; text: string };
          modelSelection: import("@t3tools/contracts").ModelSelection;
          capabilityStep: import("@t3tools/contracts").TaskCapabilityStep;
        };
      }) => ({
        _tag: "Success",
        value: await EffectForFixture.runPromise(
          f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(input.commandId),
            threadId: ThreadId.make(input.threadId),
            messageId: MessageId.make(input.message.messageId),
            text: input.message.text,
            attachments: [],
            modelSelection: input.modelSelection,
            routingMode: "manual",
            dispatchMode: { type: "queue_after_active" },
            capabilityStep: input.capabilityStep,
            createdBy: "user",
            creationSource: "web",
          }),
        ),
      }),
    );
    const props = {
      task: f.task,
      environmentId: EnvironmentId.make("environment-a"),
      stale: false,
      readVersion: 1,
    };
    await act(async () => {
      renderer = create(<TaskCapabilityStepControls {...props} />);
    });
    await creationClick("Explain this task’s recorded workspace and branch");
    expect(state.reviewRead).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
    await creationClick("Review recorded workspace read");
    expect(state.reviewRead.mock.calls[0]![0].input.capabilityStep.capability).toBe(
      "recorded-workspace",
    );
    expect(text()).toContain("t3-code/t3_worktree_status");
    expect(text()).toContain("No filesystem, Git or network read");
    expect(await EffectForFixture.runPromise(f.noExecution())).toEqual({
      runs: 0,
      grants: 0,
      outbox: 0,
      messages: 0,
    });
    const staleStart = creationButton("Start reviewed workspace read")!.props.onClick;
    await creationClick("Choose saved PR read");
    await act(async () => staleStart());
    expect(state.startStep).not.toHaveBeenCalled();
    await creationClick("Explain this task’s recorded workspace and branch");
    await creationClick("Review recorded workspace read");
    await creationClick("Start reviewed workspace read");
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    expect(state.startStep).toHaveBeenCalledTimes(1);
    expect((await EffectForFixture.runPromise(f.noExecution())).runs).toBe(1);
    await creationClick("Read step status");
    expect(text()).toContain("recorded-thread-project-settings");
    expect(text()).toContain("Operation: ");
  });
}, 30000);

it("refreshes late attributed output from the linked native stream without manual Refresh or chat navigation", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const completed = await EffectForFixture.runPromise(f.readSnapshot());
    const task = completed.tasks[0]!;
    if (
      task.resultReadout?.status !== "available" ||
      task.resultReadout.content.status !== "output"
    )
      throw new Error("Missing fixture output");
    const output = task.resultReadout.content.preview;
    const projection = await EffectForFixture.runPromise(
      f.orchestrator.getThreadProjection(f.command.threadId),
    );
    state.snapshot = {
      ...completed,
      tasks: [
        {
          ...task,
          resultReadout: {
            ...task.resultReadout,
            runStatus: "running",
            content: { status: "unknown", reason: "no_completed_result" },
          },
        },
      ],
    };
    state.liveProjection = {
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    };
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(text()).not.toContain(output);
    const reads = state.load.mock.calls.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      state.snapshot = completed;
      state.liveProjection = projection;
      await act(async () => {
        renderer.update(<TasksPage />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(state.load.mock.calls.length).toBeGreaterThan(reads);
      expect(text()).toContain(output);
      expect(state.navigate).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Mounted controls consume the same attributed projection as the result fixture.
const mountRunningSupervision = async (
  f: Parameters<Parameters<typeof withTaskRevisionRequestFixture>[0]>[0],
) => {
  const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
  const projection = await EffectForFixture.runPromise(
    f.orchestrator.getThreadProjection(f.command.threadId),
  );
  const records = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
  });
  state.liveProjection = {
    ...projection,
    runs: projection.runs.map((run) => ({ ...run, status: "running", completedAt: null })),
    providerTurns: projection.providerTurns.map((turn) => ({
      ...turn,
      status: "running",
      completedAt: null,
    })),
  };
  const { TaskRunSupervision } = await import("./TaskRunSupervision");
  const props = {
    task: snapshot.tasks[0]!,
    environmentId: EnvironmentId.make("environment-a"),
    enabled: true,
    live: true,
    stale: false,
    changed: vi.fn(),
    observe: vi.fn(),
  };
  const render = async (changes: Partial<typeof props> = {}) => {
    await act(async () => {
      renderer.update(<TaskRunSupervision {...props} {...changes} />);
    });
  };
  await act(async () => {
    renderer = create(<TaskRunSupervision {...props} />);
  });
  return { props, render, projection, records, TaskRunSupervision };
};
it("retains one original Stop before submission, survives lost reply/remount/reconnect and only reads recovery", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const fixture = await mountRunningSupervision(f);
    const pending = deferred<{ _tag: "Success" }>();
    state.interrupt.mockReturnValueOnce(pending.promise);
    expect(creationButton("Stop task run")!.props.disabled).toBe(false);
    await creationClick("Stop task run", true);
    expect(state.interrupt).toHaveBeenCalledTimes(1);
    const original = state.interrupt.mock.calls[0]![0].input;
    expect(original.runId).toBe(fixture.projection.runs.at(-1)!.id);
    expect(original.expectedAttemptId).toBe(fixture.projection.runs.at(-1)!.activeAttemptId);
    expect([...fixture.records.values()][0]).toContain(original.commandId);
    const { TaskRunSupervision, props } = fixture;
    await act(async () => {
      renderer.unmount();
      renderer = create(<TaskRunSupervision {...props} />);
    });
    expect(text()).toContain("UNKNOWN");
    expect(creationButton("Stop task run")!.props.disabled).toBe(true);
    await fixture.render({ live: false });
    expect(creationButton("Reconcile original Stop")!.props.disabled).toBe(true);
    state.sessionIdentity = {};
    await fixture.render();
    state.readProjection.mockResolvedValue({ _tag: "Success", value: fixture.projection });
    await creationClick("Reconcile original Stop");
    expect(text()).toContain("Completion won");
    await act(async () => pending.resolve({ _tag: "Success" }));
    expect(text()).not.toContain("Matching target interruption confirmed");
    expect(state.interrupt).toHaveBeenCalledTimes(1);
    expect(state.startStep).not.toHaveBeenCalled();
  });
});
it.each(["readonly", "legacy-server", "disconnect", "stale", "session", "A-B-A"] as const)(
  "rejects a retained Stop callback after %s scope changes",
  async (change) => {
    await withTaskRevisionRequestFixture(async (f) => {
      const fixture = await mountRunningSupervision(f);
      const callback = creationButton("Stop task run")!.props.onClick;
      if (change === "readonly") {
        const { review: _review, ...readonlyTask } = fixture.props.task;
        await fixture.render({ task: readonlyTask });
      }
      if (change === "legacy-server") {
        const { supportsExpectedRunInterrupt: _support, ...review } = fixture.props.task.review!;
        await fixture.render({ task: { ...fixture.props.task, review } });
        expect(creationButton("Stop task run")!.props.disabled).toBe(true);
      }
      if (change === "disconnect") await fixture.render({ live: false });
      if (change === "stale") await fixture.render({ stale: true });
      if (change === "session") {
        state.sessionIdentity = {};
        await fixture.render();
      }
      if (change === "A-B-A") {
        await fixture.render({ environmentId: EnvironmentId.make("environment-b") });
        await fixture.render();
      }
      await act(async () => callback());
      expect(state.interrupt).not.toHaveBeenCalled();
    });
  },
);
it.each(["interrupted", "unconfirmed", "completed", "failed", "newer-attempt"] as const)(
  "attributes %s after Stop to its original run and attempt",
  async (outcome) => {
    await withTaskRevisionRequestFixture(async (f) => {
      const fixture = await mountRunningSupervision(f);
      await creationClick("Stop task run");
      expect(text()).toContain("Stop requested");
      expect(text()).toContain("not confirmed");
      const base = fixture.projection;
      state.liveProjection = {
        ...base,
        runs: base.runs.map((run) => ({
          ...run,
          status:
            outcome === "newer-attempt"
              ? "running"
              : outcome === "unconfirmed"
                ? "interrupted"
                : outcome,
          ...(outcome === "newer-attempt"
            ? { activeAttemptId: RunAttemptId.make("newer-attempt") }
            : {}),
        })),
        attempts:
          outcome === "newer-attempt"
            ? [
                ...base.attempts,
                {
                  ...base.attempts.at(-1)!,
                  id: RunAttemptId.make("newer-attempt"),
                  attemptOrdinal: 2,
                },
              ]
            : base.attempts,
        providerTurns: base.providerTurns.map((turn) => ({
          ...turn,
          status:
            outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "interrupted",
          terminationConfirmed: outcome !== "unconfirmed",
        })),
      };
      await fixture.render();
      expect(text()).toContain(
        outcome === "interrupted"
          ? "Matching target interruption confirmed"
          : outcome === "unconfirmed"
            ? "native termination remains UNKNOWN"
            : outcome === "completed"
              ? "Completion won"
              : outcome === "failed"
                ? "Target run failed"
                : "superseded",
      );
      expect(state.interrupt).toHaveBeenCalledTimes(1);
      expect(state.reviewDecide).not.toHaveBeenCalled();
    });
  },
);

it("coalesces linked lifecycle changes and ignores streamed token updates", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    state.snapshot = await EffectForFixture.runPromise(f.readSnapshot());
    state.liveProjection = await EffectForFixture.runPromise(
      f.orchestrator.getThreadProjection(f.command.threadId),
    );
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reads = state.load.mock.calls.length;
      const base = state.liveProjection;
      for (let i = 0; i < 20; i++) {
        state.liveProjection = {
          ...base,
          messages: base.messages.map((m) =>
            m.role === "assistant" ? { ...m, streaming: true, text: `token ${i}` } : m,
          ),
        };
        await act(async () => renderer.update(<TasksPage />));
        await selectOnlyInboxTaskForDetailJourney(renderer);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      // Initial transition to streaming removes a completed-message signature once; token chunks add no reads.
      expect(state.load.mock.calls.length - reads).toBeLessThanOrEqual(1);
      const after = state.load.mock.calls.length;
      for (let i = 0; i < 10; i++) {
        state.liveProjection = {
          ...state.liveProjection!,
          runs: base.runs.map((r) => ({ ...r, status: i % 2 ? "running" : "starting" })),
        };
        await act(async () => renderer.update(<TasksPage />));
        await selectOnlyInboxTaskForDetailJourney(renderer);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(state.load.mock.calls.length - after).toBe(1);
      state.streamLive = false;
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
      expect(text()).toContain("UNKNOWN");
      state.streamLive = true;
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(state.load.mock.calls.length - after).toBe(2);
      expect(state.interrupt).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("keeps a governed Start in Tasks and observes its attributed result without manual refresh", async () => {
  await withFirstLaunchFixture(async (f) => {
    wireGenericLaunch(f);
    state.load.mockImplementation(() => EffectForFixture.runPromise(f.snapshot()));
    state.liveProjection = await EffectForFixture.runPromise(f.projection());
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await prepareGeneric("Stay in Tasks for this implementation.", "manual");
    await creationClick("Choose fixture Manual model");
    await creationClick("Review ordinary task launch");
    await creationClick("Start reviewed ordinary task");
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    state.liveProjection = await EffectForFixture.runPromise(f.projection());
    await act(async () => renderer.update(<TasksPage />));
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(text()).toContain("Observed run:");
    expect(state.navigate).not.toHaveBeenCalled();
    await EffectForFixture.runPromise(f.drain());
    state.liveProjection = await EffectForFixture.runPromise(f.projection());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      const snapshot = await EffectForFixture.runPromise(f.snapshot());
      const result = snapshot.tasks.find(
        (task) => task.threadId === f.task.threadId,
      )!.resultReadout;
      if (result?.status !== "available" || result.content.status !== "output")
        throw new Error("No attributed native output");
      expect(text()).toContain(result.content.preview);
      expect(state.startStep).toHaveBeenCalledTimes(1);
      expect(state.navigate).not.toHaveBeenCalled();
      expect(state.reviewDecide).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
}, 30000);

it("retains draft instructions through unrelated refresh and invalidates old executable review on authoritative change", async () => {
  const module = await loadTaskReviewFixture();
  await EffectForFixture.runPromise(
    module.withTaskReviewFixture((f) =>
      EffectForFixture.promise(async () => {
        state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
        state.reviewRead.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.readReview(input)),
        }));
        state.reviewDecide.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.decide(input)),
        }));
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        await act(async () =>
          renderer.root
            .findAllByType("button")
            .find((b) => b.props["data-task-contract-redirect-action"] !== undefined)!
            .props.onClick(),
        );
        await creationClick("Confirm decision");
        await creationClick("Revise paused instructions");
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "goal instruction" })
            .props.onChange({ target: { value: "Do not erase my unsaved goal" } }),
        );
        await creationClick("Preview instruction changes");
        const oldSave = creationButton("Save new revision")!.props.onClick;
        await creationClick("Refresh tasks");
        expect(renderer.root.findByProps({ "aria-label": "goal instruction" }).props.value).toBe(
          "Do not erase my unsaved goal",
        );
        expect(creationButton("Save new revision")).toBeUndefined();
        await EffectForFixture.runPromise(f.revise());
        await creationClick("Refresh tasks");
        expect(renderer.root.findByProps({ "aria-label": "goal instruction" }).props.value).toBe(
          "Do not erase my unsaved goal",
        );
        const writes = state.reviewDecide.mock.calls.length;
        await act(async () => oldSave());
        expect(state.reviewDecide).toHaveBeenCalledTimes(writes);
        expect(text()).toContain("Fresh authoritative facts");
        expect((await EffectForFixture.runPromise(f.facts())).runs).toBe(0);
      }),
    ),
  );
}, 30000);

it("mounts no hidden detail subscriptions and watches only an explicitly focused row beyond the first eight", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const original = await EffectForFixture.runPromise(f.readSnapshot());
    const task = original.tasks[0]!;
    state.snapshot = {
      ...original,
      tasks: Array.from({ length: 24 }, (_, index) => ({
        ...task,
        id: `task-${index}`,
        threadId: `thread-${index}`,
      })),
    };
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(state.detailWatches.filter((id) => id !== null)).toHaveLength(0);
    const target = renderer.root.findByProps({
      "aria-label": `View task task-23 in ${task.projectId}`,
    });
    await act(async () => target.props.onClick());
    const watches = state.detailWatches.filter((id) => id !== null);
    expect([...new Set(watches)]).toEqual(["thread-23"]);
    expect(state.interrupt).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
  });
});
it("recovers the original Stop after remount even when a newer run is displayed", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const fixture = await mountRunningSupervision(f);
    state.interrupt.mockResolvedValueOnce({ _tag: "Failure", cause: "lost reply" });
    await creationClick("Stop task run");
    const originalId = state.interrupt.mock.calls[0]![0].input.commandId;
    const base = fixture.projection;
    const run = base.runs.at(-1)!;
    const attempt = base.attempts.at(-1)!;
    state.liveProjection = {
      ...base,
      runs: [
        ...base.runs,
        {
          ...run,
          id: RunId.make("newer-run"),
          ordinal: run.ordinal + 1,
          status: "running",
          activeAttemptId: RunAttemptId.make("newer-run-attempt"),
        },
      ],
      attempts: [
        ...base.attempts,
        {
          ...attempt,
          id: RunAttemptId.make("newer-run-attempt"),
          runId: RunId.make("newer-run"),
          status: "running",
        },
      ],
    };
    const { TaskRunSupervision, props } = fixture;
    await act(async () => {
      renderer.unmount();
      renderer = create(<TaskRunSupervision {...props} />);
    });
    expect(text()).toContain(originalId);
    expect(text()).toContain("Completion won");
    expect(state.interrupt).toHaveBeenCalledTimes(1);
  });
});

it.each(["unavailable", "corrupt", "discarded writes"] as const)(
  "submits no Stop when original identity storage is %s",
  async (failure) => {
    await withTaskRevisionRequestFixture(async (f) => {
      const fixture = await mountRunningSupervision(f);
      if (failure === "unavailable") vi.stubGlobal("localStorage", undefined);
      else if (failure === "corrupt")
        for (const key of [
          `task-stop-v1:${JSON.stringify([fixture.props.environmentId, fixture.props.task.projectId, fixture.props.task.id, fixture.props.task.threadId])}:${fixture.projection.runs.at(-1)!.id}:${fixture.projection.runs.at(-1)!.activeAttemptId}`,
        ])
          fixture.records.set(key, "unreadable");
      else vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
      state.sessionIdentity = {};
      await fixture.render();
      if (failure === "discarded writes") await creationClick("Stop task run");
      else expect(creationButton("Stop task run")!.props.disabled).toBe(true);
      expect(state.interrupt).not.toHaveBeenCalled();
    });
  },
);

it.each(["late response", "retained notice"] as const)(
  "keeps Stop reconciliation UNKNOWN across disconnect with %s",
  async (timing) => {
    await withTaskRevisionRequestFixture(async (f) => {
      const fixture = await mountRunningSupervision(f);
      await creationClick("Stop task run");
      const terminal = {
        ...fixture.projection,
        runs: fixture.projection.runs.map((run) => ({ ...run, status: "interrupted" as const })),
        providerTurns: fixture.projection.providerTurns.map((turn) => ({
          ...turn,
          status: "interrupted" as const,
          terminationConfirmed: true,
        })),
      };
      const read = deferred<{ _tag: "Success"; value: OrchestrationV2ThreadProjection }>();
      state.readProjection.mockReturnValueOnce(read.promise);
      await creationClick("Reconcile original Stop");
      if (timing === "late response") await fixture.render({ live: false });
      await act(async () => read.resolve({ _tag: "Success", value: terminal }));
      if (timing === "retained notice") {
        expect(text()).toContain("Matching target interruption confirmed");
        await fixture.render({ live: false });
      }
      expect(text()).toContain("UNKNOWN");
      expect(text()).not.toContain("Matching target interruption confirmed");
      expect(state.interrupt).toHaveBeenCalledTimes(1);
    });
  },
);
it.each(["unrelated refresh", "authoritative contract change"] as const)(
  "retains requested result changes across %s without retaining execution authority",
  async (change) => {
    await withTaskRevisionRequestFixture(async (f) => {
      state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
      state.reviewRead.mockImplementation(async ({ input }) => ({
        _tag: "Success",
        value: await EffectForFixture.runPromise(f.readReview(input)),
      }));
      state.readProjection.mockImplementation(async () => ({
        _tag: "Success",
        value: await EffectForFixture.runPromise(
          f.orchestrator.getThreadProjection(f.command.threadId),
        ),
      }));
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await creationClick("Prepare revision request");
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Requested changes" })
          .props.onChange({ target: { value: "Keep my unsaved result revision" } }),
      );
      const oldApply = creationButton("Fill empty draft and open")!.props.onClick;
      if (change === "authoritative contract change")
        await EffectForFixture.runPromise(
          f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskContract.goal','New owner goal','$.taskContract.revision',2) WHERE thread_id=${f.command.threadId}`,
        );
      await creationClick("Refresh tasks");
      await act(async () => oldApply());
      expect(state.navigate).not.toHaveBeenCalled();
      await creationClick("Prepare revision request");
      expect(renderer.root.findByProps({ "aria-label": "Requested changes" }).props.value).toBe(
        "Keep my unsaved result revision",
      );
      expect(state.startStep).not.toHaveBeenCalled();
    });
  },
);
it.each(["contract", "phase", "acceptance"] as const)(
  "streamed idle %s changes refresh authoritative facts and retire an executable review",
  async (change) => {
    await withTaskRevisionRequestFixture(async (f) => {
      state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
      state.reviewRead.mockImplementation(async ({ input }) => ({
        _tag: "Success",
        value: await EffectForFixture.runPromise(f.readReview(input)),
      }));
      state.liveProjection = await EffectForFixture.runPromise(
        f.orchestrator.getThreadProjection(f.command.threadId),
      );
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await act(async () =>
        renderer.root
          .findAllByType("button")
          .find((button) => button.props["data-task-contract-accept"] !== undefined)!
          .props.onClick(),
      );
      expect(creationButton("Confirm decision")).toBeDefined();
      const reads = state.load.mock.calls.length;
      if (change === "contract")
        await EffectForFixture.runPromise(
          f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskContract.goal','Streamed new owner goal','$.taskContract.revision',2) WHERE thread_id=${f.command.threadId}`,
        );
      if (change === "phase")
        await EffectForFixture.runPromise(
          f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskContractPhase','redirected') WHERE thread_id=${f.command.threadId}`,
        );
      if (change === "acceptance")
        await EffectForFixture.runPromise(
          f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskAcceptedRevision',1) WHERE thread_id=${f.command.threadId}`,
        );
      state.liveProjection = await EffectForFixture.runPromise(
        f.orchestrator.getThreadProjection(f.command.threadId),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => renderer.update(<TasksPage />));
        await selectOnlyInboxTaskForDetailJourney(renderer);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(150);
        });
        expect(state.load.mock.calls.length).toBeGreaterThan(reads);
        expect(creationButton("Confirm decision")).toBeUndefined();
        if (change === "contract") expect(text()).toContain("Streamed new owner goal");
        expect(state.reviewDecide).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  },
);

it("retains task A's requested changes when task B's stream refreshes the catalog", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    const b = {
      ...f.command,
      threadId: ThreadId.make("unrelated-live-task"),
      commandId: CommandId.make("create-unrelated-live-task"),
      title: "Unrelated live task",
    };
    await EffectForFixture.runPromise(f.dispatch(b));
    state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
    state.reviewRead.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.readReview(input)),
    }));
    state.readProjection.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.orchestrator.getThreadProjection(input.threadId)),
    }));
    state.liveProjections.set(
      f.command.threadId,
      await EffectForFixture.runPromise(f.orchestrator.getThreadProjection(f.command.threadId)),
    );
    state.liveProjections.set(
      b.threadId,
      await EffectForFixture.runPromise(f.orchestrator.getThreadProjection(b.threadId)),
    );
    state.shellThreads = [
      {
        id: b.threadId,
        status: "idle",
        activeRunId: null,
        latestRunId: null,
        latestRunCompletedAt: null,
      },
    ];
    await act(async () => {
      renderer = create(<TasksPage />);
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    await selectExactInboxTask(
      (await EffectForFixture.runPromise(f.readSnapshot())).tasks.find(
        (t) => t.threadId === f.command.threadId,
      )!,
    );
    await creationClick("Prepare revision request");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Requested changes" })
        .props.onChange({ target: { value: "Task A unsaved result changes" } }),
    );
    const reads = state.load.mock.calls.length;
    await EffectForFixture.runPromise(
      f.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("unrelated-task-start"),
        threadId: b.threadId,
        messageId: MessageId.make("unrelated-task-input"),
        text: "Disposable setup work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    state.liveProjections.set(
      b.threadId,
      await EffectForFixture.runPromise(f.orchestrator.getThreadProjection(b.threadId)),
    );
    state.shellThreads = [
      {
        id: b.threadId,
        status: "working",
        activeRunId: "unrelated-run",
        latestRunId: "unrelated-run",
        latestRunCompletedAt: null,
      },
    ];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => renderer.update(<TasksPage />));
      await selectOnlyInboxTaskForDetailJourney(renderer);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(state.load.mock.calls.length).toBeGreaterThan(reads);
      expect(text()).toContain("Requested changes draft retained");
      await creationClick("Prepare revision request");
      expect(renderer.root.findByProps({ "aria-label": "Requested changes" }).props.value).toBe(
        "Task A unsaved result changes",
      );
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.interrupt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
it("isolates retained result drafts across environment A-B-A without restoring old review authority", async () => {
  await withTaskRevisionRequestFixture(async (f) => {
    state.reviewRead.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: await EffectForFixture.runPromise(f.readReview(input)),
    }));
    state.readProjection.mockImplementation(async () => ({ _tag: "Success", value: f.projection }));
    const { TaskRevisionRequest } = await import("./TaskRevisionRequest");
    const props = {
      task: f.snapshot.tasks[0]!,
      environmentId: EnvironmentId.make("environment-a"),
      stale: false,
      readVersion: 1,
      readCollaboration: () => EffectForFixture.runPromise(f.readSnapshot()),
      onOpen: vi.fn(),
    };
    await act(async () => {
      renderer = create(<TaskRevisionRequest {...props} />);
    });
    await creationClick("Prepare revision request");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Requested changes" })
        .props.onChange({ target: { value: "Environment A private draft" } }),
    );
    const oldApply = creationButton("Fill empty draft and open")!.props.onClick;
    await act(async () =>
      renderer.update(
        <TaskRevisionRequest {...props} environmentId={EnvironmentId.make("environment-b")} />,
      ),
    );
    expect(text()).not.toContain("Environment A private draft");
    await act(async () => renderer.update(<TaskRevisionRequest {...props} />));
    await act(async () => oldApply());
    expect(props.onOpen).not.toHaveBeenCalled();
    await creationClick("Prepare revision request");
    expect(renderer.root.findByProps({ "aria-label": "Requested changes" }).props.value).toBe(
      "Environment A private draft",
    );
  });
});

const chooseInstructionModule = async (id: string) => {
  const selection = renderer.root.findByProps({
    "aria-label": "First-party instruction module selection",
  });
  await act(async () => selection.findByType("select").props.onChange({ target: { value: id } }));
};
it("mounted Auto instruction skill reviews without starting and delivers exact bytes to the changed actual target once", async () => {
  await withFirstLaunchFixture(async (f) => {
    wireGenericLaunch(f);
    const module = taskInstructionSkillModules()[0]!;
    const props = genericProps(f);
    await act(async () => {
      renderer = create(<TaskFirstInstructions {...props} />);
    });
    await prepareGeneric("Summarize the supplied evidence and mark unknowns.", "manual");
    await chooseInstructionModule(module.id);
    expect(creationButton("Choose Auto")!.props.disabled).toBe(false);
    await creationClick("Choose Auto");
    await creationClick("Preview Auto");
    await act(async () => {
      await state.autoPreview.mock.results.at(-1)!.value;
    });
    const preview = (await state.autoPreview.mock.results.at(-1)!.value).value;
    expect(preview.status).toBe("available");
    await creationClick("Review ordinary task launch");
    await act(async () => {
      await state.skillReview.mock.results.at(-1)!.value;
    });
    expect(
      renderer.root
        .findByProps({ "aria-label": "Reviewed ordinary task launch" })
        .findAllByType("p")
        .map((p) => p.children.filter((c) => typeof c === "string").join(""))
        .join("\n"),
    ).toContain("Mode: auto");
    expect(text()).toContain("Auto recalculates its authoritative route at dispatch");
    expect(text()).toContain("Advisory local Auto intent:");
    expect(text()).toContain("local-task.heuristic.v2.0.0");
    expect(text()).toContain("summarization");
    expect(text()).toContain(taskInstructionSkillRef(module).contentSha256);
    expect(
      renderer.root
        .findByProps({ "aria-label": "Exact reviewed instruction module" })
        .findByType("pre").children,
    ).toEqual([module.body]);
    expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    f.changeAutoCandidate();
    const start = creationButton("Start reviewed ordinary task")!.props.onClick;
    await act(async () => {
      start();
      start();
    });
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    await EffectForFixture.runPromise(f.drain());
    expect(state.startStep).toHaveBeenCalledTimes(1);
    const actual = await EffectForFixture.runPromise(f.inspect());
    expect(actual.starts).toEqual([{ instanceId: "codex", model: "aaa-after-review" }]);
    expect(actual.starts[0]).not.toEqual(preview.decision.selected.target);
    expect(actual.executions[0]!.message.text).toBe(
      "Summarize the supplied evidence and mark unknowns." + taskInstructionSkillText(module),
    );
    await act(async () => {
      renderer.unmount();
      renderer = create(<TaskFirstInstructions {...props} />);
    });
    await creationClick("Read original launch status");
    await act(async () => {
      await state.firstLaunchRead.mock.results.at(-1)!.value;
    });
    expect(text()).toContain("adapter-accepted");
    expect(text()).toContain("aaa-after-review");
    expect(
      renderer.root
        .findAllByType("p")
        .map((p) => p.children.filter((c) => typeof c === "string").join(""))
        .join("\n"),
    ).toContain("run status completed");
    expect(state.startStep).toHaveBeenCalledTimes(1);
  });
}, 30000);

it.each(taskInstructionSkillModules())(
  "mounted explicit $id review shows exact body and delivers once through ordinary Start",
  async (module) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await prepareGeneric("Use supplied evidence only.", "manual");
      expect(state.skillReview).not.toHaveBeenCalled();
      await chooseInstructionModule(module.id);
      expect(state.skillReview).not.toHaveBeenCalled();
      expect(creationButton("Choose Auto")!.props.disabled).toBe(false);
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.skillReview.mock.results.at(-1)!.value;
      });
      const body = renderer.root.findByProps({ "aria-label": "Exact reviewed instruction module" });
      expect(body.findByType("pre").children).toEqual([module.body]);
      expect(text()).toContain(taskInstructionSkillRef(module).contentSha256);
      expect(text()).toContain("Goal:");
      expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
      await creationClick("Start reviewed ordinary task", true);
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
        await state.firstLaunchRead.mock.results.at(-1)!.value;
      });
      await EffectForFixture.runPromise(f.drain());
      const actual = await EffectForFixture.runPromise(f.inspect());
      expect(actual.starts).toHaveLength(1);
      expect(actual.executions[0]!.message.text).toBe(
        "Use supplied evidence only." + taskInstructionSkillText(module),
      );
      await act(async () => {
        renderer.unmount();
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await creationClick("Read original launch status");
      await act(async () => {
        await state.firstLaunchRead.mock.results.at(-1)!.value;
      });
      expect(text()).toContain("adapter-accepted");
      expect(text()).toContain("Selected instruction module:");
      expect(state.startStep).toHaveBeenCalledTimes(1);
    });
  },
  30000,
);
it.each(
  (["manual", "auto"] as const).flatMap((mode) =>
    (["selection", "text", "model", "session", "scope", "contract", "mode"] as const).map(
      (change) => ({ mode, change }),
    ),
  ),
)(
  "mounted $mode $change A-B-A retires instruction review and stale Start callback",
  async ({ mode, change }) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await prepareGeneric("Original supplied evidence.", mode);
      await chooseInstructionModule("evidence-summary");
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.skillReview.mock.results.at(-1)!.value;
      });
      const staleStart = creationButton("Start reviewed ordinary task")!.props.onClick;
      if (change === "mode") {
        await creationClick(mode === "auto" ? "Choose Manual" : "Choose Auto");
        await creationClick(mode === "auto" ? "Choose Auto" : "Choose Manual");
      }
      if (change === "selection") {
        await chooseInstructionModule("structured-comparison");
        await chooseInstructionModule("evidence-summary");
      }
      if (change === "text")
        for (const value of ["Changed evidence.", "Original supplied evidence."])
          await act(async () =>
            renderer.root
              .findByProps({ "aria-label": "Initial instructions" })
              .props.onChange({ target: { value } }),
          );
      if (change === "model") {
        await creationClick("Choose fixture Manual model");
        await creationClick("Select fixture exact model");
      }
      if (change === "session") {
        const original = state.sessionIdentity;
        for (const identity of [{}, original])
          await act(async () => {
            state.sessionIdentity = identity;
            renderer.update(<TaskFirstInstructions {...props} />);
          });
      }
      if (change === "contract")
        for (const readVersion of [2, 1])
          await act(async () =>
            renderer.update(<TaskFirstInstructions {...props} readVersion={readVersion} />),
          );
      if (change === "scope")
        for (const environmentId of [EnvironmentId.make("environment-b"), props.environmentId])
          await act(async () =>
            renderer.update(<TaskFirstInstructions {...props} environmentId={environmentId} />),
          );
      expect(creationButton("Start reviewed ordinary task")).toBeUndefined();
      await act(async () => {
        await staleStart();
      });
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    });
  },
  30000,
);
it.each(["manual", "auto"] as const)(
  "mounted %s expired instruction review removes Start and rejects its retained callback",
  async (mode) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await prepareGeneric("Supplied evidence.", mode);
      await chooseInstructionModule("evidence-summary");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        await creationClick("Review ordinary task launch");
        await act(async () => {
          await state.skillReview.mock.results.at(-1)!.value;
        });
        const staleStart = creationButton("Start reviewed ordinary task")!.props.onClick;
        await act(async () => {
          vi.advanceTimersByTime(300001);
        });
        expect(creationButton("Start reviewed ordinary task")).toBeUndefined();
        expect(text()).toContain("Instruction module review expired");
        await act(async () => {
          await staleStart();
        });
        expect(state.startStep).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    });
  },
  30000,
);

it.each(["manual", "auto"] as const)(
  "pending %s module review from an old session cannot revive after session A-B-A",
  async (mode) => {
    await withFirstLaunchFixture(async (f) => {
      wireGenericLaunch(f);
      const props = genericProps(f);
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await prepareGeneric("Supplied evidence.", mode);
      await chooseInstructionModule("evidence-summary");
      const reply = deferred<unknown>();
      const ready = deferred<void>();
      let reviewed: unknown;
      state.skillReview.mockImplementation(
        async ({ input }: { input: Parameters<typeof f.reviewInstructionSkill>[0] }) => {
          reviewed = {
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.reviewInstructionSkill(input)),
          };
          ready.resolve();
          return reply.promise;
        },
      );
      await creationClick("Review ordinary task launch");
      await ready.promise;
      const original = state.sessionIdentity;
      for (const identity of [{}, original])
        await act(async () => {
          state.sessionIdentity = identity;
          renderer.update(<TaskFirstInstructions {...props} />);
        });
      await act(async () => {
        reply.resolve(reviewed);
        await state.skillReview.mock.results.at(-1)!.value;
      });
      expect(creationButton("Start reviewed ordinary task")).toBeUndefined();
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await EffectForFixture.runPromise(f.inspect())).starts).toHaveLength(0);
    });
  },
  30000,
);

it("Task inbox list/filter/focus/return/reload reads never mutate tasks or start providers", async () => {
  const a = agentTaskFixture("project-a");
  const b = { ...agentTaskFixture("historical-project"), assigneeAgentId: "unavailable-provider" };
  state.snapshot = { ...state.snapshot, tasks: [a, b] };
  await act(async () => {
    renderer = create(<TasksPage />);
  });
  expect(renderer.root.findAllByProps({ "aria-label": "Cross-agent tasks" })).toHaveLength(0);
  expect(state.detailWatches.filter((id) => id !== null)).toHaveLength(0);
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Inbox search" })
      .props.onChange({ target: { value: "historical" } }),
  );
  const project = renderer.root
    .findAllByType("select")
    .find((n) => n.findAllByProps({ "aria-label": "Inbox project" }).length)!;
  await act(async () => project.props.onChange({ target: { value: JSON.stringify(b.projectId) } }));
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": `View task ${b.id} in ${b.projectId}` })
      .props.onClick(),
  );
  expect(text()).toContain(b.title);
  await creationClick("Back to task inbox");
  expect(renderer.root.findByProps({ "aria-label": "Inbox search" }).props.value).toBe(
    "historical",
  );
  await creationClick("Refresh tasks");
  expect(renderer.root.findByProps({ "aria-label": "Inbox search" }).props.value).toBe(
    "historical",
  );
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<TasksPage />);
  });
  expect(renderer.root.findAllByProps({ "aria-label": "Cross-agent tasks" })).toHaveLength(0);
  expect(state.create).not.toHaveBeenCalled();
  expect(state.startStep).not.toHaveBeenCalled();
  expect(state.reviewDecide).not.toHaveBeenCalled();
  expect(state.interrupt).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});
it("Task inbox A→B→A focus retires an actual executable review callback", async () => {
  const module = await loadTaskReviewFixture();
  await EffectForFixture.runPromise(
    module.withTaskReviewFixture((f) =>
      EffectForFixture.promise(async () => {
        const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
        const a = snapshot.tasks[0]!;
        const { review: _hint, ...otherBase } = a;
        const b = {
          ...otherBase,
          id: "inbox-other-task",
          title: "Other task",
          threadId: null,
          projectId: "historical-project",
        };
        state.load.mockResolvedValue({ ...snapshot, tasks: [a, b] });
        state.reviewRead.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.readReview(input)),
        }));
        state.reviewDecide.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.decide(input)),
        }));
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        const view = async (t: typeof a) =>
          act(async () =>
            renderer.root
              .findByProps({ "aria-label": `View task ${t.id} in ${t.projectId}` })
              .props.onClick(),
          );
        await view(a);
        const action = renderer.root
          .findAllByType("button")
          .find((n) => n.props["data-task-contract-accept"] !== undefined)!;
        await act(async () => action.props.onClick());
        const old = creationButton("Confirm decision")!.props.onClick;
        await creationClick("Back to task inbox");
        await view(b);
        await view(a);
        expect(creationButton("Confirm decision")).toBeUndefined();
        await act(async () => old());
        expect(state.reviewDecide).not.toHaveBeenCalled();
        expect((await EffectForFixture.runPromise(f.facts())).acceptedRevision).toBeNull();
        expect(state.startStep).not.toHaveBeenCalled();
      }),
    ),
  );
});
it("Task inbox preserves unsaved paused instructions but no executable save through focus changes", async () => {
  const module = await loadTaskReviewFixture();
  await EffectForFixture.runPromise(
    module.withTaskReviewFixture((f) =>
      EffectForFixture.promise(async () => {
        const snapshot = await EffectForFixture.runPromise(f.readSnapshot());
        const a = snapshot.tasks[0]!;
        const { review: _hint, ...otherBase } = a;
        const b = { ...otherBase, id: "inbox-draft-other", title: "Other task", threadId: null };
        state.load.mockImplementation(async () => ({
          ...(await EffectForFixture.runPromise(f.readSnapshot())),
          tasks: [(await EffectForFixture.runPromise(f.readSnapshot())).tasks[0]!, b],
        }));
        state.reviewRead.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.readReview(input)),
        }));
        state.reviewDecide.mockImplementation(async ({ input }) => ({
          _tag: "Success",
          value: await EffectForFixture.runPromise(f.decide(input)),
        }));
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        const view = async (t: typeof a) =>
          act(async () =>
            renderer.root
              .findByProps({ "aria-label": `View task ${t.id} in ${t.projectId}` })
              .props.onClick(),
          );
        await view(a);
        await act(async () =>
          renderer.root
            .findAllByType("button")
            .find((n) => n.props["data-task-contract-redirect-action"] !== undefined)!
            .props.onClick(),
        );
        await creationClick("Confirm decision");
        await creationClick("Revise paused instructions");
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "goal instruction" })
            .props.onChange({ target: { value: "Retain this unsaved inbox goal" } }),
        );
        await creationClick("Preview instruction changes");
        const old = creationButton("Save new revision")!.props.onClick;
        await creationClick("Back to task inbox");
        await view(b);
        await view(a);
        expect(renderer.root.findByProps({ "aria-label": "goal instruction" }).props.value).toBe(
          "Retain this unsaved inbox goal",
        );
        expect(creationButton("Save new revision")).toBeUndefined();
        await act(async () => old());
        expect(state.reviewDecide).toHaveBeenCalledTimes(1);
        expect(
          (await EffectForFixture.runPromise(f.readSnapshot())).tasks.find((t) => t.id === a.id)
            ?.contractReadout,
        ).toMatchObject({ contract: { revision: 1 } });
      }),
    ),
  );
});
it.each(["session", "stale", "environment"] as const)(
  "Task inbox retires current confirmation after %s changes without replacing focus",
  async (change) => {
    const module = await loadTaskReviewFixture();
    await EffectForFixture.runPromise(
      module.withTaskReviewFixture((f) =>
        EffectForFixture.promise(async () => {
          state.load.mockImplementation(() => EffectForFixture.runPromise(f.readSnapshot()));
          state.reviewRead.mockImplementation(async ({ input }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.readReview(input)),
          }));
          state.reviewDecide.mockImplementation(async ({ input }) => ({
            _tag: "Success",
            value: await EffectForFixture.runPromise(f.decide(input)),
          }));
          await act(async () => {
            renderer = create(<TasksPage />);
          });
          const task = (await EffectForFixture.runPromise(f.readSnapshot())).tasks[0]!;
          await selectExactInboxTask(task);
          await act(async () =>
            renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
          );
          const old = creationButton("Confirm decision")!.props.onClick;
          if (change === "session") state.sessionIdentity = {};
          if (change === "stale") state.streamLive = false;
          if (change === "environment") state.environmentId = "environment-b";
          await act(async () => renderer.update(<TasksPage />));
          await act(async () => old());
          expect(state.reviewDecide).not.toHaveBeenCalled();
          expect(state.startStep).not.toHaveBeenCalled();
          expect((await EffectForFixture.runPromise(f.facts())).acceptedRevision).toBeNull();
          if (change === "stale") expect(text()).toContain("Stale inbox facts");
          if (change === "environment")
            expect(
              renderer.root.findAllByProps({ "aria-label": "Cross-agent tasks" }),
            ).toHaveLength(0);
        }),
      ),
    );
  },
);

it.each([
  ...[
    { mode: "manual" as const, transition: "start" },
    { mode: "auto" as const, transition: "start" },
    { mode: "manual" as const, transition: "remove" },
    { mode: "auto" as const, transition: "session" },
    { mode: "manual" as const, transition: "stale" },
  ].map((c) => ({ ...c, joint: false, order: "file-first" as const })),
  ...(["manual", "auto"] as const).flatMap((mode) =>
    (["file-first", "skill-first"] as const).map((order) => ({
      mode,
      transition: "start",
      joint: true,
      order,
    })),
  ),
])(
  "mounted $mode reference file joint=$joint order=$order uploads/reviews with $transition transition",
  async ({ mode, transition, joint, order }) => {
    await withTaskTransportFixture(async (f) => {
      const p = await prepareReferenceTask(f, `ui-file-${mode}`, mode);
      state.providers = f.providers.map((provider) => ({
        ...provider,
        displayName: provider.displayName ?? provider.driver,
        models: provider.models.map((m) => ({ ...m, isDefault: false })),
      }));
      state.reviewRead.mockImplementation(({ input }) => f.review(input));
      state.readProjection.mockImplementation(({ input }) => f.projection(input));
      state.fileReview.mockImplementation(({ input }) => f.reviewReferenceFile(input));
      state.startStep.mockImplementation(({ input }) => f.start(input));
      state.firstLaunchRead.mockImplementation(({ input }) => f.launchStatus(input));
      state.fileUpload.mockImplementation(({ image, environmentId }) => {
        state.fileUploadPromise = (async () => {
          const uploaded = await f.uploadFile(image.name, await image.file.text());
          state.fileUploads[image.id] = {
            status: "ready",
            environmentId,
            attachmentId: uploaded.id,
          };
        })();
      });
      const props = {
        task: p.task,
        environmentId: EnvironmentId.make("environment-a"),
        stale: false,
        readVersion: 1,
        onOpen: vi.fn(),
      };
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await creationClick("Prepare first instructions");
      await act(async () => {
        await state.reviewRead.mock.results[0]!.value;
      });
      await act(async () => {
        await state.readProjection.mock.results[0]!.value;
      });
      await act(async () => {
        await state.reviewRead.mock.results[1]!.value;
      });
      await act(async () => {
        renderer.root
          .findByProps({ "aria-label": "Initial instructions" })
          .props.onChange({ target: { value: "Summarize the supplied notes." } });
      });
      await creationClick(mode === "auto" ? "Choose Auto" : "Choose Manual");
      expect(text()).toContain(
        "Review the file and optional instruction skill together before Start.",
      );
      expect(text()).not.toContain("Remove the file to choose an instruction skill");
      const module = taskInstructionSkillModules()[0]!;
      if (joint && order === "skill-first") await chooseInstructionModule(module.id);
      const file = new File(["Exact café reference bytes\n"], "notes.txt", { type: "text/plain" });
      await act(async () => {
        renderer.root
          .findByProps({ "aria-label": "Choose task reference file" })
          .props.onChange({ currentTarget: { files: [file], value: "" } });
        await file.arrayBuffer();
      });
      await act(async () => {
        await state.fileUploadPromise;
        renderer.update(<TaskFirstInstructions {...props} />);
      });
      if (joint && order === "file-first") await chooseInstructionModule(module.id);
      expect((await f.inspect()).starts).toHaveLength(0);
      expect(state.fileUpload).toHaveBeenCalledTimes(1);
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.fileReview.mock.results[0]!.value;
      });
      expect(text()).toContain("Reviewed task reference file");
      if (joint) {
        expect(text()).toContain("Exact reviewed instruction module");
        expect(text()).toContain(module.body);
        expect(state.fileReview.mock.calls[0]![0].input.module).toEqual(
          taskInstructionSkillRef(module),
        );
      }
      expect(text()).toContain("notes.txt");
      expect((await f.inspect()).starts).toHaveLength(0);
      const start = creationButton("Start reviewed ordinary task")!.props.onClick;
      if (transition !== "start") {
        if (transition === "remove") await creationClick("Remove reference file");
        if (transition === "session") {
          const session = state.sessionIdentity;
          for (const value of [{}, session])
            await act(async () => {
              state.sessionIdentity = value;
              renderer.update(<TaskFirstInstructions {...props} />);
            });
        }
        if (transition === "stale")
          await act(async () => {
            renderer.update(<TaskFirstInstructions {...props} stale />);
          });
        await act(async () => {
          await start();
        });
        expect(state.startStep).not.toHaveBeenCalled();
        expect((await f.inspect()).starts).toHaveLength(0);
        expect(state.fileRelease).toHaveBeenCalledTimes(1);
        return;
      }
      await act(async () => {
        start();
        start();
      });
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
      });
      const original = state.startStep.mock.calls[0]![0].input;
      await f.settle(original.message.messageId);
      const observed = await f.inspect();
      expect(observed.starts).toHaveLength(1);
      if (joint)
        expect(observed.inputs[0]).toBe(original.message.text + taskInstructionSkillText(module));
      expect(observed.attachments[0]).toEqual([original.taskFirstLaunch.referenceFile.attachment]);
      expect(await f.attachmentBytes(original.taskFirstLaunch.referenceFile.attachment)).toBe(
        await file.text(),
      );
      await act(async () => {
        renderer.unmount();
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await creationClick("Read original launch status");
      await act(async () => {
        await state.firstLaunchRead.mock.results.at(-1)!.value;
      });
      expect(text()).toContain("Reference file provenance");
      expect(text()).toContain("adapter-accepted");
      if (joint) expect(text()).toContain("Instruction module provenance");
      expect(state.startStep).toHaveBeenCalledTimes(1);
      expect(state.fileUpload).toHaveBeenCalledTimes(1);
      expect(state.fileRelease).not.toHaveBeenCalled();
    });
  },
  30000,
);

it.each([
  ...(["adapter-accepted", "unknown", "mismatched"] as const).flatMap((outcome) =>
    [false, true].map((joint) => ({ outcome, joint })),
  ),
  ...(["partial-file", "partial-skill", "mismatched-skill"] as const).map((outcome) => ({
    outcome,
    joint: true,
  })),
])(
  "persisted reference file result shows $outcome, joint=$joint, attribution without local launch recovery",
  async ({ outcome, joint }) => {
    await withTaskTransportFixture(async (f) => {
      const p = await prepareReferenceTask(f, `result-file-${outcome}`);
      const bytes = "Persisted file evidence: café\n";
      const module = taskInstructionSkillModules()[0]!;
      const attachment = await f.uploadFile("persisted-notes.txt", bytes);
      const reviewed = await f.reviewReferenceFile({
        launch: p.launch,
        attachment,
        contentSha256: sha256Hex(bytes),
        ...(joint ? { module: taskInstructionSkillRef(module) } : {}),
      });
      if (reviewed._tag !== "Success" || reviewed.value.status !== "available")
        throw new Error("File review unavailable");
      const proof = reviewed.value.review;
      const marker = {
        ...p.launch,
        referenceFile: proof,
        ...(reviewed.value.instructionSkill
          ? { instructionSkill: reviewed.value.instructionSkill }
          : {}),
      };
      if (outcome === "unknown")
        f.holdInput(marker.text + (joint ? taskInstructionSkillText(module) : ""));
      if (outcome === "partial-file") f.failJointEvidence("accepted-file");
      if (outcome === "partial-skill") f.failJointEvidence("accepted-skill");
      try {
        const started = await f.dispatch({
          type: "message.dispatch",
          commandId: marker.commandId,
          messageId: marker.messageId,
          threadId: marker.threadId,
          text: marker.text,
          attachments: [proof.source],
          routingMode: marker.routingMode,
          modelSelection: marker.modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
          taskFirstLaunch: marker,
        });
        expect(started._tag).toBe("Success");
        if (outcome === "unknown") await f.awaitHeldStart();
        else await f.settle(marker.messageId);
        if (outcome === "mismatched") await f.corruptFileDelivery(marker.threadId);
        if (outcome === "mismatched-skill") await f.corruptJointSkillDelivery(marker.threadId);
        state.snapshot = await f.snapshot();
        const task = state.snapshot.tasks.find((t) => t.threadId === marker.threadId)!;
        const result = task.resultReadout;
        if (result?.status !== "available") throw new Error("No persisted result evidence");
        expect(result.referenceFileSelection).toEqual(proof);
        const fileStatus =
          outcome === "mismatched"
            ? undefined
            : outcome === "unknown" || outcome === "partial-file"
              ? "unknown"
              : "adapter-accepted";
        expect(result.referenceFileDelivery?.status).toBe(fileStatus);
        if (joint)
          expect(result.instructionSkillDelivery?.status).toBe(
            outcome === "mismatched-skill"
              ? undefined
              : outcome === "unknown" || outcome === "partial-skill"
                ? "unknown"
                : "adapter-accepted",
          );
        vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
        expect(
          readFirstLaunchAttempt(firstLaunchStorageKey("environment-a", marker.threadId)).attempt,
        ).toBeNull();
        vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
        state.load.mockImplementation(() => f.snapshot());
        const before = await f.executionCounts();
        await act(async () => {
          renderer = create(<TasksPage />);
        });
        await act(async () => {
          await state.load.mock.results[0]!.value;
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        expect(text()).toContain("Reference file provenance");
        expect(text()).toContain("persisted-notes.txt");
        expect(text()).toContain(proof.source.id);
        expect(text()).toContain(proof.attachment.id);
        expect(text()).toContain(proof.contentSha256);
        expect(text()).toContain("does not establish successful completion or owner acceptance");
        const section = renderer.root.findByProps({ "aria-label": "Reference file provenance" });
        const evidence = section
          .findAllByType("p")
          .map((p) => [p.props.children].flat(Infinity).join(""))
          .join("\n");
        const paragraphs = renderer.root
          .findAllByType("p")
          .map((p) => [p.props.children].flat(Infinity).join(""))
          .join("\n");
        if (outcome === "mismatched") {
          expect(text()).toContain("Unknown / no matching delivery evidence");
          expect(evidence).not.toContain("adapter-accepted");
        } else {
          expect(evidence).toContain(`File input delivery: ${fileStatus}`);
          expect(evidence).toContain(result.runId);
          expect(evidence).toContain(result.attemptId);
          expect(evidence).toContain(result.messageId);
          expect(evidence).toContain(result.referenceFileDelivery!.modelSelection.instanceId);
          expect(evidence).toContain(result.referenceFileDelivery!.modelSelection.model);
        }
        if (joint) {
          expect(text()).toContain("Instruction module provenance");
          expect(paragraphs).toContain(
            `Joint input delivery: ${outcome === "adapter-accepted" ? "adapter-accepted" : "Unknown / partial or unconfirmed delivery"}`,
          );
        }
        if (outcome === "unknown") {
          expect(paragraphs).toContain("Latest persisted run status: running");
          expect(text()).not.toContain("Latest persisted assistant output");
        }
        expect(await f.executionCounts()).toEqual(before);
        expect((await f.inspect()).starts).toHaveLength(1);
        expect(state.startStep).not.toHaveBeenCalled();
        expect(state.fileUpload).not.toHaveBeenCalled();
        expect(state.firstLaunchRead).not.toHaveBeenCalled();
      } finally {
        if (outcome === "unknown") {
          f.releaseHeldStart();
          await f.settle(marker.messageId);
        }
      }
    });
  },
);

type JointTransportFixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
function wireJointTransportUi(f: JointTransportFixture) {
  state.providers = f.providers.map((provider) => ({
    ...provider,
    displayName: provider.displayName ?? provider.driver,
    models: provider.models.map((m) => ({ ...m, isDefault: false })),
  }));
  state.reviewRead.mockImplementation(({ input }) => f.review(input));
  state.readProjection.mockImplementation(({ input }) => f.projection(input));
  state.fileReview.mockImplementation(({ input }) => f.reviewReferenceFile(input));
  state.skillReview.mockImplementation(({ input }) => f.reviewInstructionSkill(input));
  state.startStep.mockImplementation(({ input }) => f.start(input));
  state.firstLaunchRead.mockImplementation(({ input }) => f.launchStatus(input));
  state.fileUpload.mockImplementation(({ image, environmentId }) => {
    state.fileUploadPromise = (async () => {
      const uploaded = await f.uploadFile(image.name, await image.file.text());
      state.fileUploads[image.id] = { status: "ready", environmentId, attachmentId: uploaded.id };
    })();
  });
}
async function openJointInstructions(
  textValue = "Summarize the reference within the current task.",
) {
  const reviews = state.reviewRead.mock.calls.length;
  const projections = state.readProjection.mock.calls.length;
  await creationClick("Prepare first instructions");
  await act(async () => {
    await state.reviewRead.mock.results[reviews]!.value;
  });
  await act(async () => {
    await state.readProjection.mock.results[projections]!.value;
  });
  await act(async () => {
    await state.reviewRead.mock.results[reviews + 1]!.value;
  });
  await act(async () => {
    renderer.root
      .findByProps({ "aria-label": "Initial instructions" })
      .props.onChange({ target: { value: textValue } });
  });
  await creationClick("Choose Auto");
}
async function pickJointFile(
  props: React.ComponentProps<typeof TaskFirstInstructions>,
  file = new File(["Joint supplied evidence: café\n"], "joint-notes.txt", { type: "text/plain" }),
) {
  await act(async () => {
    renderer.root
      .findByProps({ "aria-label": "Choose task reference file" })
      .props.onChange({ currentTarget: { files: [file], value: "" } });
    await file.arrayBuffer();
  });
  await act(async () => {
    await state.fileUploadPromise;
    renderer.update(<TaskFirstInstructions {...props} />);
  });
}
async function mountedJointDraft(f: JointTransportFixture, key: string) {
  const p = await prepareReferenceTask(f, key, "auto");
  wireJointTransportUi(f);
  const props = {
    task: p.task,
    environmentId: EnvironmentId.make("environment-a"),
    stale: false,
    readVersion: 1,
    onOpen: vi.fn(),
  };
  await act(async () => {
    renderer = create(<TaskFirstInstructions {...props} />);
  });
  await openJointInstructions();
  await chooseInstructionModule(taskInstructionSkillModules()[0]!.id);
  await pickJointFile(props);
  return props;
}
it.each(["module", "routing", "instructions", "remove-file", "remove-skill"] as const)(
  "joint executable review never resurrects through %s A-to-B-to-A or removal",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      const props = await mountedJointDraft(f, `joint-ui-retire-${change}`);
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.fileReview.mock.results[0]!.value;
      });
      const oldStart = creationButton("Start reviewed ordinary task")!.props.onClick;
      if (change === "module") {
        await chooseInstructionModule(taskInstructionSkillModules()[1]!.id);
        await chooseInstructionModule(taskInstructionSkillModules()[0]!.id);
      }
      if (change === "routing") {
        await creationClick("Choose Manual");
        await creationClick("Choose Auto");
      }
      if (change === "instructions")
        for (const value of [
          "Changed instructions",
          "Summarize the reference within the current task.",
        ])
          await act(async () => {
            renderer.root
              .findByProps({ "aria-label": "Initial instructions" })
              .props.onChange({ target: { value } });
          });
      if (change === "remove-file") await creationClick("Remove reference file");
      if (change === "remove-skill") await chooseInstructionModule("none");
      expect(creationButton("Start reviewed ordinary task")).toBeUndefined();
      await act(async () => {
        await oldStart();
      });
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
      expect(state.fileReview).toHaveBeenCalledTimes(1);
      if (change !== "remove-file" && change !== "remove-skill") {
        await creationClick("Review ordinary task launch");
        await act(async () => {
          await state.fileReview.mock.results[1]!.value;
        });
        await act(async () => {
          await oldStart();
        });
        expect(state.startStep).not.toHaveBeenCalled();
        expect(creationButton("Start reviewed ordinary task")!.props.disabled).toBe(false);
      }
      expect(state.fileUpload).toHaveBeenCalledTimes(1);
      expect(props.task.threadId).not.toBeNull();
    });
  },
);
it.each(["session", "environment", "contract"] as const)(
  "late joint review cannot overwrite a newer review after %s A-to-B-to-A",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      const props = await mountedJointDraft(f, `joint-late-${change}`);
      const first = deferred<Awaited<ReturnType<typeof f.reviewReferenceFile>>>();
      state.fileReview.mockImplementationOnce(() => first.promise);
      const oldReview = creationButton("Review ordinary task launch")!.props.onClick;
      await creationClick("Review ordinary task launch");
      const original = await f.reviewReferenceFile(state.fileReview.mock.calls[0]![0].input);
      if (original._tag !== "Success" || original.value.status !== "available")
        throw new Error("No original joint proof");
      if (change === "session") {
        const session = state.sessionIdentity;
        for (const identity of [{}, session])
          await act(async () => {
            state.sessionIdentity = identity;
            renderer.update(<TaskFirstInstructions {...props} />);
          });
      } else if (change === "environment") {
        for (const environmentId of [EnvironmentId.make("environment-b"), props.environmentId])
          await act(async () => {
            renderer.update(<TaskFirstInstructions {...props} environmentId={environmentId} />);
          });
      } else {
        const readout = props.task.contractReadout;
        if (readout?.status !== "available") throw new Error("No contract");
        const changed = {
          ...props.task,
          contractReadout: {
            ...readout,
            contract: { ...readout.contract, goal: "Different context" },
          },
        };
        for (const task of [changed, props.task])
          await act(async () => {
            renderer.update(<TaskFirstInstructions {...props} task={task} />);
          });
      }
      await openJointInstructions();
      await chooseInstructionModule(taskInstructionSkillModules()[0]!.id);
      await pickJointFile(props);
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.fileReview.mock.results[1]!.value;
      });
      const latest = await state.fileReview.mock.results[1]!.value;
      if (latest._tag !== "Success" || latest.value.status !== "available")
        throw new Error("No latest proof");
      await act(async () => {
        first.resolve(original);
        await first.promise;
      });
      expect(text()).toContain(latest.value.review.reviewId);
      expect(text()).not.toContain(original.value.review.reviewId);
      await act(async () => {
        await oldReview();
      });
      expect(state.fileReview).toHaveBeenCalledTimes(2);
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.fileUpload).toHaveBeenCalledTimes(2);
      expect((await f.inspect()).starts).toHaveLength(0);
      await creationClick("Start reviewed ordinary task");
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
      });
      const started = state.startStep.mock.calls[0]![0].input;
      expect(started.taskFirstLaunch.referenceFile.reviewId).toBe(latest.value.review.reviewId);
      await f.settle(started.message.messageId);
      expect((await f.inspect()).starts).toHaveLength(1);
      expect(state.fileUpload).toHaveBeenCalledTimes(2);
    });
  },
);
it.each(["session", "environment"] as const)(
  "late reference byte read cannot upload after joint context %s A-to-B-to-A",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      const p = await prepareReferenceTask(f, `joint-upload-late-${change}`);
      wireJointTransportUi(f);
      const props = {
        task: p.task,
        environmentId: EnvironmentId.make("environment-a"),
        stale: false,
        readVersion: 1,
        onOpen: vi.fn(),
      };
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await openJointInstructions();
      await chooseInstructionModule(taskInstructionSkillModules()[0]!.id);
      const read = deferred<ArrayBuffer>();
      const file = new File(["Deferred evidence"], "deferred.txt", { type: "text/plain" });
      Object.defineProperty(file, "arrayBuffer", { value: () => read.promise });
      await act(async () => {
        renderer.root
          .findByProps({ "aria-label": "Choose task reference file" })
          .props.onChange({ currentTarget: { files: [file], value: "" } });
      });
      if (change === "session") {
        const session = state.sessionIdentity;
        for (const identity of [{}, session])
          await act(async () => {
            state.sessionIdentity = identity;
            renderer.update(<TaskFirstInstructions {...props} />);
          });
      } else
        for (const environmentId of [EnvironmentId.make("environment-b"), props.environmentId])
          await act(async () => {
            renderer.update(<TaskFirstInstructions {...props} environmentId={environmentId} />);
          });
      await act(async () => {
        read.resolve(new TextEncoder().encode("Deferred evidence").buffer);
        await read.promise;
      });
      expect(state.fileUpload).not.toHaveBeenCalled();
      expect(state.fileReview).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
);

it.each(["session", "environment"] as const)(
  "late upload completion cannot restore a joint file after %s A-to-B-to-A",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      const p = await prepareReferenceTask(f, `joint-late-upload-${change}`);
      wireJointTransportUi(f);
      const props = {
        task: p.task,
        environmentId: EnvironmentId.make("environment-a"),
        stale: false,
        readVersion: 1,
        onOpen: vi.fn(),
      };
      await act(async () => {
        renderer = create(<TaskFirstInstructions {...props} />);
      });
      await openJointInstructions();
      await chooseInstructionModule(taskInstructionSkillModules()[0]!.id);
      const uploaded = deferred<void>();
      state.fileUpload.mockImplementationOnce(({ image, environmentId }) => {
        state.fileUploadPromise = (async () => {
          await uploaded.promise;
          const attachment = await f.uploadFile(image.name, await image.file.text());
          state.fileUploads[image.id] = {
            status: "ready",
            environmentId,
            attachmentId: attachment.id,
          };
        })();
      });
      const file = new File(["Late uploaded reference"], "late-upload.txt", { type: "text/plain" });
      await act(async () => {
        renderer.root
          .findByProps({ "aria-label": "Choose task reference file" })
          .props.onChange({ currentTarget: { files: [file], value: "" } });
        await file.arrayBuffer();
      });
      expect(state.fileUpload).toHaveBeenCalledTimes(1);
      if (change === "session") {
        const session = state.sessionIdentity;
        for (const identity of [{}, session])
          await act(async () => {
            state.sessionIdentity = identity;
            renderer.update(<TaskFirstInstructions {...props} />);
          });
      } else
        for (const environmentId of [EnvironmentId.make("environment-b"), props.environmentId])
          await act(async () => {
            renderer.update(<TaskFirstInstructions {...props} environmentId={environmentId} />);
          });
      await act(async () => {
        uploaded.resolve();
        await state.fileUploadPromise;
        renderer.update(<TaskFirstInstructions {...props} />);
      });
      await openJointInstructions();
      await chooseInstructionModule(taskInstructionSkillModules()[0]!.id);
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.skillReview.mock.results.at(-1)!.value;
      });
      expect(state.fileReview).not.toHaveBeenCalled();
      expect(state.fileUpload).toHaveBeenCalledTimes(1);
      expect(state.fileRelease).toHaveBeenCalledTimes(1);
      expect(state.startStep).not.toHaveBeenCalled();
      expect(text()).not.toContain("Reviewed task reference file");
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
);
it("joint expiry retires both inputs and the captured Start callback", async () => {
  await withTaskTransportFixture(async (f) => {
    await mountedJointDraft(f, "joint-ui-expiry");
    const realTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (
          typeof callback === "function" &&
          delay !== undefined &&
          delay > 290000 &&
          delay <= 300000
        )
          expire = () => callback(...args);
        return realTimeout(callback, delay, ...args);
      });
    try {
      await creationClick("Review ordinary task launch");
      await act(async () => {
        await state.fileReview.mock.results[0]!.value;
      });
      const reviewed = await state.fileReview.mock.results[0]!.value;
      if (reviewed._tag !== "Success" || reviewed.value.status !== "available")
        throw new Error("No joint review");
      const oldStart = creationButton("Start reviewed ordinary task")!.props.onClick;
      if (!expire) throw new Error("No review expiry timer");
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.parse(reviewed.value.review.expiresAt) + 1);
      try {
        await act(async () => {
          expire!();
        });
        await act(async () => {
          await oldStart();
        });
      } finally {
        clock.mockRestore();
      }
      expect(creationButton("Start reviewed ordinary task")).toBeUndefined();
      expect(text()).toContain("Reference file review expired");
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
    } finally {
      timer.mockRestore();
    }
  });
});

it.each(["manual", "auto"] as const)(
  "mounted accepted source creates, reviews and starts one independent %s destination",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      const source = await acceptedHandoffSource(
        f,
        `mounted-handoff-${mode}`,
        mode === "manual" ? "x".repeat(2047) + "😀" : undefined,
      );
      creationStorage();
      state.providers = f.providers.map((p) => ({
        ...p,
        displayName: p.driver,
        models: p.models.map((m) => ({ ...m, isDefault: false })),
      }));
      state.load.mockImplementation(() => f.snapshot());
      let readDone = deferred<void>(),
        sourceReads = 0;
      state.reviewRead.mockImplementation(async ({ input }) => {
        const r = await f.review(input);
        if (input.threadId === source.c.threadId && ++sourceReads % 2 === 0) readDone.resolve();
        return r;
      });
      state.readProjection.mockImplementation(({ input }) => f.projection(input));
      state.create.mockImplementation(({ input }) => f.create(input));
      state.readCreationStatus.mockImplementation(({ input }) => f.creationStatus(input));
      state.startStep.mockImplementation(({ input }) => f.start(input));
      state.firstLaunchRead.mockImplementation(({ input }) => f.launchStatus(input));
      await act(async () => {
        renderer = create(
          <TasksPage
            scope={{
              scopeEnvironmentId: "environment-a",
              scopeProjectId: "project-a",
              scopeProviderId: "codex",
            }}
          />,
        );
      });
      await act(async () => {
        await state.load.mock.results[0]!.value;
      });
      await selectOnlyInboxTaskForDetailJourney(renderer);
      expect(text()).toContain(source.c.title);
      expect(
        renderer.root
          .findAllByType(TaskOutputHandoff)
          .map((n) => ({ stale: n.props.stale, disabled: n.props.disabled })),
      ).toEqual([{ stale: false, disabled: false }]);
      await act(async () => {
        await readDone.promise;
      });
      expect(creationButton("Use this output in a new task")).toBeDefined();
      readDone = deferred<void>();
      await creationClick("Use this output in a new task");
      await act(async () => {
        await readDone.promise;
      });
      await fillCreation("Independent writing task", false);
      await creationClick("Select exact model: exact-second");
      for (const label of [
        "Optional token cap",
        "Optional reported cost cap (USD)",
        "Optional UTC deadline",
      ])
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": label })
            .props.onChange({ target: { value: "" } }),
        );
      await creationClick("Review new task");
      expect(
        renderer.root.findAllByType("pre").some((n) => n.children.join("") === source.source.text),
      ).toBe(true);
      expect(text()).toContain(source.source.result.itemId);
      expect((await f.inspect()).starts).toHaveLength(1);
      await act(async () => {
        const submit = creationButton("Create task")!.props.onClick;
        const pending = submit();
        submit();
        await pending;
      });
      const created = state.create.mock.calls[0]![0].input;
      expect(created.taskCreationReview.resultHandoff).toEqual(source.source);
      expect((await f.inspect()).starts).toHaveLength(1);
      expect(creationButton("Prepare created task for review/start")).toBeDefined();
      await act(async () => {
        await creationButton("Prepare created task for review/start")!.props.onClick();
      });
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Initial instructions" })
          .props.onChange({ target: { value: "Write an independent article." } }),
      );
      await creationClick(mode === "auto" ? "Choose Auto" : "Choose Manual");
      await act(async () => {
        await creationButton("Review ordinary task launch")!.props.onClick();
      });
      expect(
        renderer.root.findAllByType("pre").some((n) => n.children.join("") === source.source.text),
      ).toBe(true);
      expect(creationButton("Start reviewed ordinary task")).toBeDefined();
      expect((await f.inspect()).starts).toHaveLength(1);
      await act(async () => {
        await creationButton("Start reviewed ordinary task")!.props.onClick();
      });
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
      });
      const launch = state.startStep.mock.calls[0]![0].input;
      await act(async () => {
        await f.settle(launch.message.messageId);
      });
      expect((await f.inspect()).inputs.at(-1)).toBe(
        resultHandoffInput("Write an independent article.", source.source),
      );
      expect((await f.inspect()).starts).toHaveLength(2);
      expect((await f.snapshot()).tasks).toHaveLength(2);
      const persisted = await f.snapshot();
      await act(async () => renderer.unmount());
      creationStorage();
      state.load.mockImplementation(async () => ({
        ...persisted,
        tasks: persisted.tasks.filter((t) => t.threadId === created.threadId),
      }));
      state.reviewRead.mockReset().mockImplementation(({ input }) => f.review(input));
      await act(async () => {
        renderer = create(
          <TasksPage
            scope={{
              scopeEnvironmentId: "environment-a",
              scopeProjectId: "project-a",
              scopeProviderId: "codex",
            }}
          />,
        );
      });
      await act(async () => {
        await state.load.mock.results.at(-1)!.value;
      });
      await selectOnlyInboxTaskForDetailJourney(renderer);
      expect(text()).toContain("Native reference delivery:");
      expect(text()).toContain("adapter-accepted");
      expect(text()).toContain(source.source.result.outputSha256);
      expect(
        renderer.root
          .findAllByType("a")
          .some((n) => n.props.href === `/environment-a/${encodeURIComponent(source.c.threadId)}`),
      ).toBe(true);

      expect(await f.projection({ threadId: source.c.threadId })).toEqual({
        _tag: "Success",
        value: source.projection,
      });
    });
  },
  30000,
);

it.each(["environment", "session", "read-version"] as const)(
  "accepted output action and delayed selection retire through %s A-to-B-to-A",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      const s = await acceptedHandoffSource(f, `source-race-${change}`),
        task = (await f.snapshot()).tasks.find((t) => t.threadId === s.c.threadId)!;
      state.load.mockImplementation(() => f.snapshot());
      let readCount = 0;
      const verified = deferred<void>();
      state.reviewRead.mockImplementation(async ({ input }) => {
        const r = await f.review(input);
        if (++readCount === 2) verified.resolve();
        return r;
      });
      state.readProjection.mockImplementation(({ input }) => f.projection(input));
      const onSelect = vi.fn(),
        props = {
          task,
          environmentId: EnvironmentId.make("environment-a"),
          stale: false,
          readVersion: 1,
          disabled: false,
          onSelect,
        };
      await act(async () => {
        renderer = create(<TaskOutputHandoff {...props} />);
      });
      await act(async () => {
        await verified.promise;
        await f.flush();
      });
      const retained = creationButton("Use this output in a new task")!.props.onClick;
      const delayed = deferred<Awaited<ReturnType<typeof f.projection>>>(),
        entered = deferred<void>();
      state.readProjection.mockImplementationOnce(async ({ input }) => {
        const result = await f.projection(input);
        entered.resolve();
        await delayed.promise;
        return result;
      });
      await act(async () => retained());
      await act(async () => {
        await entered.promise;
      });
      const session = state.sessionIdentity;
      if (change === "session") state.sessionIdentity = { ...session!, syntheticReplacement: true };
      await act(async () =>
        renderer.update(
          <TaskOutputHandoff
            {...props}
            environmentId={EnvironmentId.make(
              change === "environment" ? "environment-b" : "environment-a",
            )}
            readVersion={change === "read-version" ? 2 : 1}
          />,
        ),
      );
      state.sessionIdentity = session;
      await act(async () => renderer.update(<TaskOutputHandoff {...props} />));
      await act(async () => {
        delayed.resolve(await f.projection({ threadId: s.c.threadId }));
        await f.flush();
      });
      await act(async () => retained());
      expect(onSelect).not.toHaveBeenCalled();
      expect(state.create).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);

it("handoff creation review retires through source read-version A-to-B-to-A", async () => {
  await withTaskTransportFixture(async (f) => {
    const s = await acceptedHandoffSource(f, "creator-source-version"),
      before = await f.executionCounts();
    creationStorage();
    state.providers = f.providers.map((p) => ({
      ...p,
      displayName: p.driver,
      models: p.models.map((m) => ({ ...m, isDefault: false })),
    }));
    state.create.mockImplementation(({ input }) => f.create(input));
    const props = {
      environmentId: EnvironmentId.make("environment-a"),
      project: { id: "project-a", title: "A" },
      providers: f.providers,
      request: { providerId: "codex", token: "source-version-creation", source: s.source },
      sourceVersion: "a",
      onLock: vi.fn(),
      onRelease: vi.fn(),
      onOpen: vi.fn(),
      refresh: () => f.snapshot(),
    };
    await act(async () => {
      renderer = create(<AgentsTaskCreator {...props} />);
    });
    await fillCreation("Independent source-version task", false);
    await creationClick("Select exact model: exact-second");
    await creationClick("Review new task");
    const retired = creationButton("Create task")!.props.onClick;
    await act(async () => renderer.update(<AgentsTaskCreator {...props} sourceVersion="b" />));
    await act(async () => renderer.update(<AgentsTaskCreator {...props} />));
    await act(async () => {
      await retired();
    });
    expect(creationButton("Create task")).toBeUndefined();
    expect(state.create).not.toHaveBeenCalled();
    expect(await f.executionCounts()).toEqual(before);
  });
}, 30000);

it.each(["source-observation", "destination-observation", "stale-aba"] as const)(
  "actual handoff convenience Start retires through %s A-to-B-to-A",
  async (change) => {
    await withTaskTransportFixture(async (f) => {
      const source = await acceptedHandoffSource(f, `convenience-${change}`);
      creationStorage();
      state.providers = f.providers.map((p) => ({
        ...p,
        displayName: p.driver,
        models: p.models.map((m) => ({ ...m, isDefault: false })),
      }));
      state.create.mockImplementation(({ input }) => f.create(input));
      state.readCreationStatus.mockImplementation(({ input }) => f.creationStatus(input));
      state.readProjection.mockImplementation(({ input }) => f.projection(input));
      state.reviewRead.mockImplementation(({ input }) => f.review(input));
      state.startStep.mockImplementation(({ input }) => f.start(input));
      state.firstLaunchRead.mockImplementation(({ input }) => f.launchStatus(input));
      state.load.mockImplementation(() => f.snapshot());
      let observation = { stale: false, readVersion: 1, tasks: (await f.snapshot()).tasks };
      const props = {
        environmentId: EnvironmentId.make("environment-a"),
        project: { id: "project-a", title: "A" },
        providers: f.providers,
        request: {
          providerId: "codex",
          token: `convenience-create-${change}`,
          source: source.source,
        },
        sourceVersion: "a",
        onLock: vi.fn(),
        onRelease: vi.fn(),
        onOpen: vi.fn(),
        refresh: async () => {
          const snapshot = await f.snapshot();
          observation = {
            stale: false,
            readVersion: observation.readVersion + 1,
            tasks: snapshot.tasks,
          };
          renderer.update(render());
          return snapshot;
        },
      };
      const render = () => <AgentsTaskCreator {...props} launchObservation={observation} />;
      await act(async () => {
        renderer = create(render());
      });
      await fillCreation("Independent convenience task", false);
      await creationClick("Select exact model: exact-second");
      for (const label of [
        "Optional token cap",
        "Optional reported cost cap (USD)",
        "Optional UTC deadline",
      ])
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": label })
            .props.onChange({ target: { value: "" } }),
        );
      await creationClick("Review new task");
      await act(async () => {
        await creationButton("Create task")!.props.onClick();
      });
      await act(async () => {
        await creationButton("Prepare created task for review/start")!.props.onClick();
      });
      await creationClick("Choose Manual");
      await act(async () => {
        await creationButton("Review ordinary task launch")!.props.onClick();
      });
      const retired = creationButton("Start reviewed ordinary task")!.props.onClick,
        before = await f.executionCounts(),
        a = observation;
      if (change === "stale-aba") observation = { ...a, stale: true };
      else
        observation = {
          ...a,
          readVersion: a.readVersion + 1,
          tasks: a.tasks.map((t) =>
            t.threadId ===
            (change === "source-observation"
              ? source.c.threadId
              : state.create.mock.calls[0]![0].input.threadId)
              ? { ...t, title: "Observed changed task" }
              : t,
          ),
        };
      await act(async () => renderer.update(render()));
      observation = a;
      await act(async () => renderer.update(render()));
      await act(async () => {
        await retired();
      });
      expect(state.startStep).not.toHaveBeenCalled();
      expect(await f.executionCounts()).toEqual(before);
      expect(creationButton("Start reviewed ordinary task")).toBeUndefined();
    });
  },
  30000,
);

const libraryScope = { scopeEnvironmentId: "environment-a", scopeProjectId: "project-a" };
type LibraryFixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
async function withLibraryFixture(check: (f: LibraryFixture) => Promise<void>) {
  await withTaskTransportFixture(async (f) => {
    try {
      await check(f);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
}
async function prepareLibrary(f: LibraryFixture) {
  creationStorage();
  const inputs = ["careful-a", "careful-b"].map((id) => ({
    type: "profile.save" as const,
    commandId: `save-library-${id}`,
    projectId: ProjectId.make("project-a"),
    expectedVersion: 0,
    draft: {
      id,
      displayName: "Careful reviewer",
      instructions: `Full ${id} instructions.\n${"Review every boundary. ".repeat(120)}End ${id}.`,
      description: "Reusable task input",
      purpose: "Review",
      responsibilities: [],
      exclusions: [],
      requiredOutputSections: ["Result"],
      artifactKind: "task-input",
      capabilityPreferences: [],
      taskConfiguration: {
        environmentId: EnvironmentId.make("environment-a"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
      },
    },
  }));
  for (const input of inputs) expect((await f.configuration(input))._tag).toBe("Success");
  state.providers = f.providers.map((p) => ({
    ...p,
    displayName: p.driver,
    models: p.models.map((m) => ({ ...m, isDefault: false })),
  }));
  state.load.mockImplementation(() => f.snapshot());
  state.catalog.mockImplementation(({ input }) => f.catalog(input));
  state.create.mockImplementation(({ input }) => f.create(input));
  state.readProjection.mockImplementation(({ input }) => f.projection(input));
  state.readCreationStatus.mockImplementation(({ input }) => f.creationStatus(input));
  state.reviewRead.mockImplementation(({ input }) => f.review(input));
  state.startStep.mockImplementation(({ input }) => f.start(input));
  state.firstLaunchRead.mockImplementation(({ input }) => f.launchStatus(input));
  state.autoPreview.mockImplementation(({ input }) => f.previewAuto(input));
  await act(async () => {
    renderer = create(<AgentsPage scope={libraryScope} />);
  });
  await act(async () => {
    await state.load.mock.results[0]!.value;
  });
  await act(async () => {
    await Promise.all(state.catalog.mock.results.map((r) => r.value));
  });
  return inputs;
}
function inspectLibrary(id = "careful-b") {
  return renderer.root.findByProps({
    "aria-label": `Inspect configuration Careful reviewer ${id} r1`,
  });
}
async function useLibrary() {
  await act(async () => {
    inspectLibrary().props.onClick();
  });
  await act(async () => {
    await creationButton("Use configuration")!.props.onClick();
  });
}

it.each(["manual", "auto"] as const)(
  "saved configuration library actual Agents journey creates independently and starts only explicit %s",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const inputs = await prepareLibrary(f);
      expect(
        renderer.root.findAllByProps({ "aria-label": "Saved task configuration library" }),
      ).toHaveLength(1);
      expect(inspectLibrary("careful-a")).toBeDefined();
      expect(inspectLibrary("careful-b")).toBeDefined();
      expect(state.create).not.toHaveBeenCalled();
      await act(async () => {
        inspectLibrary().props.onClick();
      });
      expect(
        renderer.root
          .findAllByType("pre")
          .some((n) => n.children.join("") === inputs[1]!.draft.instructions),
      ).toBe(true);
      await act(async () => {
        creationButton("Cancel inspection")!.props.onClick();
      });
      expect(state.configurationWrite).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
      await useLibrary();
      for (const label of [
        "Task title",
        "Goal",
        "Redirect",
        "Acceptance",
        "Provider start limit",
        "Stop conditions",
      ])
        expect(renderer.root.findByProps({ "aria-label": label }).props.value).toBe("");
      expect(text()).toContain("Selected saved configuration");
      await fillCreation(`Independent library ${mode}`, false);
      for (const label of [
        "Optional token cap",
        "Optional reported cost cap (USD)",
        "Optional UTC deadline",
      ])
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": label })
            .props.onChange({ target: { value: "" } }),
        );
      await creationClick("Review new task");
      expect(text()).toContain("careful-b");
      expect(text()).toContain("exact-second");
      expect((await f.snapshot()).tasks).toHaveLength(0);
      await act(async () => {
        const submit = creationButton("Create task")!.props.onClick;
        const first = submit();
        submit();
        await first;
      });
      expect(state.create).toHaveBeenCalledTimes(1);
      const c = state.create.mock.calls[0]![0].input;
      expect(c.taskCreationReview.configuration).toMatchObject({
        id: "careful-b",
        revision: 1,
        modelSelection: { instanceId: "codex", model: "exact-second" },
        instructions: inputs[1]!.draft.instructions,
      });
      expect((await f.inspect()).starts).toHaveLength(0);
      const projection = await f.projection({ threadId: c.threadId });
      if (projection._tag !== "Success") throw new Error("missing projection");
      expect(projection.value.thread.lineage).toMatchObject({
        rootThreadId: c.threadId,
        parentThreadId: null,
        relationshipToParent: null,
      });
      await act(async () => {
        await creationButton("Prepare created task for review/start")!.props.onClick();
      });
      expect(renderer.root.findByProps({ "aria-label": "Initial instructions" }).props.value).toBe(
        c.taskCreationReview.effectiveInstructions,
      );
      await creationClick(mode === "manual" ? "Choose Manual" : "Choose Auto");
      await act(async () => {
        await creationButton("Review ordinary task launch")!.props.onClick();
      });
      expect((await f.inspect()).starts).toHaveLength(0);
      await act(async () => {
        const start = creationButton("Start reviewed ordinary task")!.props.onClick;
        const first = start();
        start();
        await first;
      });
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
      });
      const launch = state.startStep.mock.calls[0]![0].input;
      await f.settle(launch.message.messageId);
      expect((await f.inspect()).starts).toHaveLength(1);
      const actualSelection = {
        instanceId: "codex",
        model: mode === "manual" ? "exact-second" : "bbb-auto",
      };
      expect(launch.taskFirstLaunch.routingMode).toBe(mode);
      expect((await f.inspect()).starts[0]).toEqual(actualSelection);
      expect(text()).toContain(actualSelection.model);
      const completedProjection = await f.projection({ threadId: c.threadId });
      if (completedProjection._tag !== "Success") throw new Error("missing actual run evidence");
      expect(completedProjection.value.runs[0]!.modelSelection).toEqual(actualSelection);
      expect(
        completedProjection.value.thread.agentsTaskCreation!.review.configuration!.modelSelection,
      ).toEqual(c.modelSelection);
      expect((await f.inspect()).inputs).toEqual([c.taskCreationReview.effectiveInstructions]);
      expect((await f.snapshot()).tasks).toHaveLength(1);
      expect(state.configurationWrite).not.toHaveBeenCalled();
    });
  },
  60000,
);

it.each(["unavailable provider", "unavailable model", "archived", "read-only"] as const)(
  "saved configuration library inspects %s without substituting or creating work",
  async (kind) => {
    await withLibraryFixture(async (f) => {
      const inputs = await prepareLibrary(f);
      if (kind === "archived") {
        expect(
          (
            await f.configuration({
              type: "profile.archive",
              commandId: "archive-library",
              projectId: inputs[1]!.projectId,
              profileId: "careful-b",
              expectedVersion: 1,
            })
          )._tag,
        ).toBe("Success");
        await act(async () => {
          await creationButton("Refresh saved task configurations")!.props.onClick();
        });
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "Inspect configuration Careful reviewer careful-b r1" })
            .props.onClick(),
        );
      } else {
        if (kind === "read-only") state.operate = false;
        else
          state.providers = state.providers.map((p) =>
            p.instanceId === "codex"
              ? kind === "unavailable provider"
                ? { ...p, enabled: false }
                : { ...p, models: p.models.filter((m) => m.slug !== "exact-second") }
              : p,
          );
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
        await act(async () => {
          await Promise.all(state.catalog.mock.results.map((r) => r.value));
        });
        await act(async () => inspectLibrary().props.onClick());
      }
      expect(
        renderer.root
          .findAllByType("pre")
          .some((n) => n.children.join("") === inputs[1]!.draft.instructions),
      ).toBe(true);
      expect(creationButton("Use configuration")!.props.disabled).toBe(true);
      await act(async () => {
        await creationButton("Use configuration")!.props.onClick();
      });
      expect(state.create).not.toHaveBeenCalled();
      expect(state.configurationWrite).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it.each(["edit", "archive"] as const)(
  "saved configuration library freshly rejects concurrent %s at Use",
  async (kind) => {
    await withLibraryFixture(async (f) => {
      const inputs = await prepareLibrary(f);
      await act(async () => inspectLibrary().props.onClick());
      if (kind === "edit")
        await f.configuration({
          ...inputs[1]!,
          commandId: "concurrent-edit",
          expectedVersion: 1,
          draft: { ...inputs[1]!.draft, instructions: "Changed exact instructions" },
        });
      else
        await f.configuration({
          type: "profile.archive",
          commandId: "concurrent-archive",
          projectId: inputs[1]!.projectId,
          profileId: "careful-b",
          expectedVersion: 1,
        });
      await act(async () => {
        await creationButton("Use configuration")!.props.onClick();
      });
      expect(text()).toContain("changed or became unavailable");
      expect(renderer.root.findAllByProps({ "aria-label": "Task title" })).toHaveLength(0);
      expect(state.create).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it.each([
  "library refresh",
  "directory refresh",
  "scope ABA",
  "session ABA",
  "provider ABA",
  "disconnect",
] as const)(
  "saved configuration library retires captured review/create on %s",
  async (kind) => {
    await withLibraryFixture(async (f) => {
      await prepareLibrary(f);
      await useLibrary();
      await fillCreation("Retired library task", false);
      await creationClick("Review new task");
      const submit = creationButton("Create task")!.props.onClick;
      if (kind === "library refresh")
        await act(async () => {
          await creationButton("Refresh saved task configurations")!.props.onClick();
        });
      if (kind === "directory refresh")
        await act(async () => {
          creationButton("Refresh agent directory")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      if (kind === "scope ABA") {
        await act(async () =>
          renderer.update(<AgentsPage scope={{ ...libraryScope, scopeProjectId: "missing" }} />),
        );
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
      }
      if (kind === "session ABA" || kind === "disconnect") {
        const original = state.sessionIdentity;
        state.sessionIdentity = null;
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
        if (kind === "session ABA") {
          state.sessionIdentity = original;
          await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
        }
      }
      if (kind === "provider ABA") {
        const original = state.providers;
        state.providers = original.map((p) => ({ ...p, enabled: false }));
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
        state.providers = original;
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
      }
      await act(async () => {
        await submit();
      });
      expect(state.create).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it.each(["scope ABA", "session ABA", "refresh", "unmount"] as const)(
  "saved configuration library ignores delayed Use after %s",
  async (change) => {
    await withLibraryFixture(async (f) => {
      await prepareLibrary(f);
      await act(async () => inspectLibrary().props.onClick());
      const result = await f.catalog({ projectId: ProjectId.make("project-a") });
      const delayed = deferred<typeof result>();
      state.catalog.mockReturnValueOnce(delayed.promise);
      const captured = creationButton("Use configuration")!.props.onClick;
      let pending: Promise<void>;
      await act(async () => {
        pending = captured();
        captured();
      });
      if (change === "scope ABA") {
        await act(async () =>
          renderer.update(<AgentsPage scope={{ ...libraryScope, scopeProjectId: "missing" }} />),
        );
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
      } else if (change === "session ABA") {
        const session = state.sessionIdentity;
        state.sessionIdentity = null;
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
        state.sessionIdentity = session;
        await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
      } else if (change === "refresh")
        await act(async () => {
          await creationButton("Refresh saved task configurations")!.props.onClick();
        });
      else await act(async () => renderer.unmount());
      await act(async () => {
        delayed.resolve(result);
        await pending!;
        await captured();
      });
      if (change !== "unmount")
        expect(renderer.root.findAllByProps({ "aria-label": "Task title" })).toHaveLength(0);
      expect(state.create).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it("saved configuration library hides another owner's catalog and fails closed on owner change before create", async () => {
  await withLibraryFixture(async (f) => {
    await prepareLibrary(f);
    await useLibrary();
    await fillCreation("Wrong owner library task", false);
    await creationClick("Review new task");
    await f.disconnect();
    await f.connectAs("different-owner");
    await act(async () => {
      await creationButton("Create task")!.props.onClick();
    });
    expect((await f.snapshot()).tasks).toHaveLength(0);
    expect((await f.inspect()).starts).toHaveLength(0);
    await act(async () => renderer.unmount());
    creationStorage();
    state.sessionIdentity = {};
    await act(async () => {
      renderer = create(<AgentsPage scope={libraryScope} />);
    });
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await act(async () => {
      await Promise.all(state.catalog.mock.results.map((r) => r.value));
    });
    expect(text()).not.toContain("careful-b");
    expect(renderer.root.findAllByProps({ "aria-label": "Configuration inspection" })).toHaveLength(
      0,
    );
  });
}, 30000);

it.each(["creation", "launch"] as const)(
  "saved configuration library actual-entry lost %s reply retains original identity across remount with read-only recovery",
  async (stage) => {
    await withLibraryFixture(async (f) => {
      await prepareLibrary(f);
      await useLibrary();
      await fillCreation("Library retained original", false);
      for (const label of [
        "Optional token cap",
        "Optional reported cost cap (USD)",
        "Optional UTC deadline",
      ])
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": label })
            .props.onChange({ target: { value: "" } }),
        );
      await creationClick("Review new task");
      if (stage === "creation") {
        f.dropNextReply();
        await creationClick("Create task", true);
      } else {
        await act(async () => {
          await creationButton("Create task")!.props.onClick();
        });
        await act(async () => {
          await creationButton("Prepare created task for review/start")!.props.onClick();
        });
        await creationClick("Choose Manual");
        await act(async () => {
          await creationButton("Review ordinary task launch")!.props.onClick();
        });
        f.dropNextReply();
        await creationClick("Start reviewed ordinary task", true);
      }
      const action = stage === "creation" ? state.create : state.startStep;
      await Promise.race([
        f.awaitDroppedReply(),
        action.mock.results[0]!.value.then(() => {
          throw new Error("Expected lost committed reply");
        }),
      ]);
      const original = readAgentsCreationAttempt().attempt!.command;
      const launchKey = firstLaunchStorageKey("environment-a", original.threadId);
      const originalLaunch = readFirstLaunchAttempt(launchKey).attempt?.command;
      await act(async () => {
        await f.disconnect();
        await action.mock.results[0]!.value;
        renderer.unmount();
      });
      await f.connect();
      state.sessionIdentity = {};
      const commands = (await f.inspect()).commands.length;
      await act(async () => {
        renderer = create(<AgentsPage scope={libraryScope} />);
      });
      await act(async () => {
        await state.load.mock.results.at(-1)!.value;
      });
      await creationClick("Recover task creation");
      await act(async () => {
        await state.readCreationStatus.mock.results.at(-1)!.value;
        await state.load.mock.results.at(-1)!.value;
        await state.readProjection.mock.results.at(-1)!.value;
      });
      expect(readAgentsCreationAttempt().attempt!.command).toEqual(original);
      expect(readAgentsCreationAttempt().attempt!.status).toBe("confirmed");
      if (stage === "launch") {
        await f.drain();
        await f.settle(originalLaunch!.messageId);
        expect(text()).toContain("UNKNOWN until reconciled");
        await creationClick("Read original launch status");
        await act(async () => {
          await state.firstLaunchRead.mock.results.at(-1)!.value;
        });
        expect(readFirstLaunchAttempt(launchKey).attempt!.command).toEqual(originalLaunch);
      }
      expect(state.create).toHaveBeenCalledTimes(1);
      expect(state.startStep).toHaveBeenCalledTimes(stage === "launch" ? 1 : 0);
      expect((await f.inspect()).commands).toHaveLength(commands);
      expect((await f.inspect()).starts).toHaveLength(stage === "launch" ? 1 : 0);
      expect((await f.snapshot()).tasks).toHaveLength(1);
    });
  },
  60000,
);

it("saved configuration library actual created-task Start review retires on directory refresh ABA", async () => {
  await withLibraryFixture(async (f) => {
    await prepareLibrary(f);
    await useLibrary();
    await fillCreation("Library stale Start", false);
    for (const label of [
      "Optional token cap",
      "Optional reported cost cap (USD)",
      "Optional UTC deadline",
    ])
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": label })
          .props.onChange({ target: { value: "" } }),
      );
    await creationClick("Review new task");
    await act(async () => {
      await creationButton("Create task")!.props.onClick();
    });
    await act(async () => {
      await creationButton("Prepare created task for review/start")!.props.onClick();
    });
    await creationClick("Choose Manual");
    await act(async () => {
      await creationButton("Review ordinary task launch")!.props.onClick();
    });
    const start = creationButton("Start reviewed ordinary task")!.props.onClick;
    await act(async () => {
      await creationButton("Refresh agent directory")!.props.onClick();
    });
    await act(async () => {
      await start();
    });
    expect(state.startStep).not.toHaveBeenCalled();
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it("saved configuration library retires delayed catalog, captured inspection and unsent selection across refresh/remount", async () => {
  await withLibraryFixture(async (f) => {
    await prepareLibrary(f);
    const inspect = inspectLibrary().props.onClick;
    const catalog = await f.catalog({ projectId: ProjectId.make("project-a") });
    const delayed = deferred<typeof catalog>();
    state.catalog.mockReturnValueOnce(delayed.promise);
    let pending: Promise<void>;
    await act(async () => {
      pending = creationButton("Refresh saved task configurations")!.props.onClick();
    });
    await act(async () => {
      await inspect();
    });
    expect(renderer.root.findAllByProps({ "aria-label": "Configuration inspection" })).toHaveLength(
      0,
    );
    await act(async () =>
      renderer.update(<AgentsPage scope={{ ...libraryScope, scopeProjectId: "missing" }} />),
    );
    await act(async () => {
      delayed.resolve(catalog);
      await pending!;
    });
    expect(text()).not.toContain("careful-b");
    await act(async () => renderer.update(<AgentsPage scope={libraryScope} />));
    await act(async () => {
      await Promise.all(state.catalog.mock.results.map((r) => r.value));
    });
    await useLibrary();
    await fillCreation("Unsent selection", false);
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(<AgentsPage scope={libraryScope} />);
    });
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await act(async () => {
      await Promise.all(state.catalog.mock.results.map((r) => r.value));
    });
    expect(renderer.root.findAllByProps({ "aria-label": "Task title" })).toHaveLength(0);
    expect(state.create).not.toHaveBeenCalled();
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it("saved configuration library refresh preserves an unrelated provider-first creation review", async () => {
  await mount();
  await creationClick("New task");
  await fillCreation();
  await creationClick("Review new task");
  expect(creationButton("Create task")).toBeDefined();
  await act(async () => {
    await creationButton("Refresh saved task configurations")!.props.onClick();
  });
  expect(creationButton("Create task")).toBeDefined();
  expect(state.create).not.toHaveBeenCalled();
});

it("saved configuration library keeps unsupported model options inspectable without stripping the exact selection", async () => {
  await withLibraryFixture(async (f) => {
    const inputs = await prepareLibrary(f);
    const catalog = await f.catalog({ projectId: ProjectId.make("project-a") });
    if (catalog._tag !== "Success") throw new Error("missing catalog");
    const unsupported = {
      ...catalog,
      value: {
        ...catalog.value,
        profiles: catalog.value.profiles.map((p) =>
          p.id !== "careful-b" || !p.taskConfiguration
            ? p
            : {
                ...p,
                taskConfiguration: {
                  ...p.taskConfiguration,
                  modelSelection: { ...p.taskConfiguration.modelSelection, options: [] },
                },
              },
        ),
      },
    };
    state.catalog.mockResolvedValue(unsupported);
    await act(async () => {
      await creationButton("Refresh saved task configurations")!.props.onClick();
    });
    await act(async () => inspectLibrary().props.onClick());
    expect(text()).toContain("model options unsupported");
    expect(creationButton("Use configuration")!.props.disabled).toBe(true);
    await act(async () => {
      await creationButton("Use configuration")!.props.onClick();
    });
    expect(
      renderer.root
        .findAllByType("pre")
        .some((n) => n.children.join("") === inputs[1]!.draft.instructions),
    ).toBe(true);
    expect(state.create).not.toHaveBeenCalled();
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it("saved configuration library never-sent creation stays UNKNOWN after reconnect and does not allocate a replacement", async () => {
  await withLibraryFixture(async (f) => {
    await prepareLibrary(f);
    await useLibrary();
    await fillCreation("Library unknown admission", false);
    await creationClick("Review new task");
    await f.disconnect();
    await act(async () => {
      await creationButton("Create task")!.props.onClick();
    });
    const original = readAgentsCreationAttempt().attempt!.command;
    expect((await f.inspect()).commands.filter((c) => c.type === "thread.create")).toHaveLength(0);
    await act(async () => renderer.unmount());
    await f.connect();
    state.sessionIdentity = {};
    await act(async () => {
      renderer = create(<AgentsPage scope={libraryScope} />);
    });
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await creationClick("Recover task creation");
    await act(async () => {
      await state.readCreationStatus.mock.results.at(-1)!.value;
    });
    expect(readAgentsCreationAttempt().attempt).toEqual({ status: "uncertain", command: original });
    expect(text()).toContain("unknown");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect((await f.snapshot()).tasks).toHaveLength(0);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it.each(["save", "archive"] as const)(
  "saved configuration library actual editor %s retires selected revision and captured review/create callbacks",
  async (action) => {
    await withLibraryFixture(async (f) => {
      await prepareLibrary(f);
      await useLibrary();
      await fillCreation("Library editor invalidation", false);
      await creationClick("Review new task");
      const capturedSubmit = creationButton("Create task")!.props.onClick;
      await creationClick("Back to task draft");
      const capturedPreview = creationButton("Review new task")!.props.onClick;
      await creationClick("Load saved configurations");
      await act(async () => {
        await state.catalog.mock.results.at(-1)!.value;
      });
      state.configurationWrite.mockImplementation(({ input }) => f.configuration(input));
      if (action === "save") {
        const editor = renderer.root.findByProps({ "aria-label": "Saved task configurations" });
        const edits = editor
          .findAllByType("button")
          .filter((b) => b.children.join("") === "Edit saved configuration Careful reviewer");
        await act(async () => {
          edits.at(-1)!.props.onClick();
        });
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "Working instructions" })
            .props.onChange({ target: { value: "Authoritative edited second revision." } }),
        );
        await creationClick("Save configuration revision");
      } else {
        const editor = renderer.root.findByProps({ "aria-label": "Saved task configurations" });
        const archive = editor
          .findAllByType("button")
          .filter((b) => b.children.join("") === "Archive saved configuration Careful reviewer");
        await act(async () => {
          archive.at(-1)!.props.onClick();
        });
      }
      await act(async () => {
        const result = await state.configurationWrite.mock.results.at(-1)!.value;
        expect(result._tag).toBe("Success");
      });
      const mutation = state.configurationWrite.mock.calls.at(-1)![0].input;
      expect(action === "save" ? mutation.draft.id : mutation.profileId).toBe("careful-b");
      const changed = await f.catalog({ projectId: ProjectId.make("project-a") });
      expect(changed._tag).toBe("Success");
      if (changed._tag !== "Success") throw new Error("missing authoritative catalog");
      expect(
        changed.value.profiles.find(
          (p) => p.id === "careful-b" && p.version === (action === "save" ? 2 : 1),
        )?.status,
      ).toBe(action === "save" ? "active" : "archived");
      await act(async () => {
        await capturedPreview();
        await capturedSubmit();
      });
      const staleSubmit = creationButton("Create task")?.props.onClick;
      if (staleSubmit)
        await act(async () => {
          await staleSubmit();
        });
      expect(state.create).not.toHaveBeenCalled();
      expect(text().includes("selection retired")).toBe(true);
      expect(creationButton("Review new task")!.props.disabled).toBe(true);
      expect((await f.snapshot()).tasks).toHaveLength(0);
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it("saved configuration library editor catalog loading preserves an ordinary provider-first review", async () => {
  await mount();
  await creationClick("New task");
  await fillCreation();
  const preview = creationButton("Review new task")!.props.onClick;
  await creationClick("Load saved configurations");
  await act(async () => {
    await state.catalog.mock.results.at(-1)!.value;
    await preview();
  });
  expect(creationButton("Create task")).toBeDefined();
  expect(text()).not.toContain("selection retired");
  expect(state.configurationWrite).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it("saved configuration library editor invalidation preserves a lost original archive command and reconciles without resend", async () => {
  await withLibraryFixture(async (f) => {
    await prepareLibrary(f);
    await useLibrary();
    await fillCreation("Library editor recovery", false);
    const preview = creationButton("Review new task")!.props.onClick;
    await creationClick("Load saved configurations");
    await act(async () => {
      await state.catalog.mock.results.at(-1)!.value;
    });
    state.configurationWrite.mockImplementation(({ input }) => f.configuration(input));
    state.configurationStatus.mockImplementation(({ input }) => f.configurationStatus(input));
    f.dropNextReply();
    await act(async () => {
      const editor = renderer.root.findByProps({ "aria-label": "Saved task configurations" });
      editor
        .findAllByType("button")
        .filter((b) => b.children.join("") === "Archive saved configuration Careful reviewer")
        .at(-1)!
        .props.onClick();
      await preview();
    });
    await Promise.race([
      f.awaitDroppedReply(),
      state.configurationWrite.mock.results[0]!.value.then(() => {
        throw new Error("Expected committed archive reply drop");
      }),
    ]);
    const key = "t3:saved-task-configuration-command:v1";
    const original = sessionStorage.getItem(key);
    expect(original).not.toBeNull();
    expect(creationButton("Create task")).toBeUndefined();
    await act(async () => {
      await f.disconnect();
      await state.configurationWrite.mock.results[0]!.value;
      renderer.unmount();
    });
    expect(sessionStorage.getItem(key)).toBe(original);
    await f.connect();
    state.sessionIdentity = {};
    await act(async () => {
      renderer = create(<AgentsPage scope={libraryScope} />);
    });
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await creationClick("Recover saved configuration");
    await act(async () => {
      await state.configurationStatus.mock.results[0]!.value;
    });
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(text()).toContain("Original configuration command is committed");
    expect(state.configurationWrite).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();
    expect((await f.snapshot()).tasks).toHaveLength(0);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it("saved configuration library editor read preserves an unchanged selection and retires an authoritatively changed revision", async () => {
  await withLibraryFixture(async (f) => {
    const inputs = await prepareLibrary(f);
    await useLibrary();
    await fillCreation("Library editor read", false);
    const preview = creationButton("Review new task")!.props.onClick;
    await creationClick("Load saved configurations");
    await act(async () => {
      await state.catalog.mock.results.at(-1)!.value;
      await preview();
    });
    expect(creationButton("Create task")).toBeDefined();
    expect(text()).not.toContain("selection retired");
    await creationClick("Back to task draft");
    const capturedPreview = creationButton("Review new task")!.props.onClick;
    expect(
      (
        await f.configuration({
          ...inputs[1]!,
          commandId: "external-editor-read-edit",
          expectedVersion: 1,
          draft: { ...inputs[1]!.draft, instructions: "Authoritative external edit." },
        })
      )._tag,
    ).toBe("Success");
    await creationClick("Load saved configurations");
    await act(async () => {
      await state.catalog.mock.results.at(-1)!.value;
      await capturedPreview();
    });
    expect(creationButton("Create task")).toBeUndefined();
    expect(creationButton("Review new task")!.props.disabled).toBe(true);
    expect(text()).toContain("selection retired");
    expect(state.create).not.toHaveBeenCalled();
    expect((await f.snapshot()).tasks).toHaveLength(0);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

const fullReviewText =
  "Beginning of persisted output\n" +
  "x".repeat(2300) +
  "\n<iframe src=evil></iframe> 😀 café\nEXACT ENDING\n  ";
async function setupFullReview(
  f: LibraryFixture,
  key = "full-review",
  output = fullReviewText,
  running = false,
) {
  creationStorage();
  f.setWorkflowOutput(output);
  if (running) f.runInput("First attributable output");
  const c = await completedForFullReview(
    running ? { ...f, settle: async () => f.awaitRunning() } : f,
    key,
  );
  state.providers = f.providers.map((p) => ({
    ...p,
    displayName: p.driver,
    models: p.models.map((m) => ({ ...m, isDefault: false })),
  }));
  state.load.mockImplementation(() => f.snapshot());
  state.reviewRead.mockImplementation(({ input }) => f.review(input));
  state.readProjection.mockImplementation(({ input }) => f.projection(input));
  state.startStep.mockImplementation(({ input }) => f.start(input));
  state.firstLaunchRead.mockImplementation(({ input }) => f.launchStatus(input));
  state.continuationRead.mockImplementation(({ input }) => f.continuationStatus(input));
  state.autoPreview.mockImplementation(({ input }) => f.previewAuto(input));
  state.reviewDecide.mockImplementation(({ input }) =>
    f.dispatch({
      type: "thread.task-contract.accept",
      commandId: CommandId.make(`full-accept-${key}`),
      threadId: input.threadId,
      revision: input.revision,
      reviewTask: input.reviewTask,
    }),
  );
  await act(async () => {
    renderer = create(<TasksPage scope={libraryScope} />);
  });
  await act(async () => {
    await state.load.mock.results[0]!.value;
  });
  await selectOnlyInboxTaskForDetailJourney(renderer);
  return c;
}
async function openFullReview() {
  await act(async () => {
    await creationButton("Open complete output")!.props.onClick();
  });
}
function completeText() {
  return renderer.root
    .findAllByType("pre")
    .filter((n) => n.props["aria-label"] === "Complete persisted assistant text")
    .map((n) => n.children.join(""));
}
async function awaitReviewReads(action: () => void, additional: number, f: LibraryFixture) {
  const target = state.reviewRead.mock.calls.length + additional,
    done = deferred<void>();
  state.reviewRead.mockImplementation(async ({ input }) => {
    const r = await f.review(input);
    if (state.reviewRead.mock.calls.length === target) done.resolve();
    return r;
  });
  await act(async () => {
    action();
    await done.promise;
    await f.flush();
  });
}
it("complete result review actual Tasks entry reads exact inert full output and uses existing explicit Accept", async () => {
  await withLibraryFixture(async (f) => {
    const c = await setupFullReview(f),
      before = await f.executionCounts();
    expect(completeText()).toEqual([]);
    expect(state.readProjection).not.toHaveBeenCalled();
    await openFullReview();
    expect(completeText()).toEqual([fullReviewText]);
    expect(text()).toContain("Persisted Goal");
    expect(text()).toContain(c.taskContract!.goal);
    expect(text()).toContain("Persisted Redirect");
    expect(text()).toContain("Persisted Acceptance criteria");
    expect(renderer.root.findAllByType("iframe")).toHaveLength(0);
    expect(text()).toContain("does not establish an accepted answer");
    expect(await f.executionCounts()).toEqual(before);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    await creationClick("Close complete output");
    expect(completeText()).toEqual([]);
    await openFullReview();
    await awaitReviewReads(
      () => renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
      1,
      f,
    );
    expect(creationButton("Confirm decision")).toBeDefined();
    expect(state.reviewDecide).not.toHaveBeenCalled();
    const refreshed = deferred<void>();
    state.load.mockImplementation(async () => {
      const s = await f.snapshot();
      if (state.reviewDecide.mock.calls.length) refreshed.resolve();
      return s;
    });
    await act(async () => {
      creationButton("Confirm decision")!.props.onClick();
      await refreshed.promise;
    });
    expect(state.reviewDecide).toHaveBeenCalledTimes(1);
    const p = await f.projection({ threadId: c.threadId });
    if (p._tag !== "Success") throw new Error("missing projection");
    expect(p.value.thread.taskAcceptedRevision).toBe(1);
    expect((await f.inspect()).starts).toHaveLength(1);
    expect(await f.executionCounts()).toEqual(before);
  });
}, 60000);
it("complete result review actual Tasks revision preparation reads full output and starts no work", async () => {
  await withLibraryFixture(async (f) => {
    await setupFullReview(f, "full-revision");
    const before = await f.executionCounts();
    await openFullReview();
    await awaitReviewReads(() => creationButton("Prepare revision request")!.props.onClick(), 2, f);
    expect(text()).toContain("Review revision request");
    expect(
      renderer.root.findAllByType("pre").some((n) => n.children.join("") === fullReviewText),
    ).toBe(true);
    expect(state.startStep).not.toHaveBeenCalled();
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    await creationClick("Cancel revision preparation");
    expect(await f.executionCounts()).toEqual(before);
  });
}, 30000);
it.each(["accept", "revision", "live"] as const)(
  "complete result review rejects unchanged-preview changed-tail through %s",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const c = await setupFullReview(f, `full-tail-${mode}`);
      await openFullReview();
      const before = (await f.snapshot()).tasks[0]!.resultReadout;
      if (mode === "accept")
        await awaitReviewReads(
          () => renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
          1,
          f,
        );
      await f.alterLatestOutput(
        c.threadId,
        fullReviewText.replace("EXACT ENDING", "CHANGED ENDING"),
      );
      expect((await f.snapshot()).tasks[0]!.resultReadout).toEqual(before);
      if (mode === "live") {
        const p = await f.projection({ threadId: c.threadId });
        if (p._tag !== "Success") throw new Error("missing projection");
        state.liveProjections.set(c.threadId, p.value);
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
      } else if (mode === "accept")
        await awaitReviewReads(() => creationButton("Confirm decision")!.props.onClick(), 2, f);
      else
        await awaitReviewReads(
          () => creationButton("Prepare revision request")!.props.onClick(),
          2,
          f,
        );
      expect(completeText()).toEqual([]);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      await act(async () => {
        await creationButton("Reload complete output")!.props.onClick();
      });
      expect(completeText()).toEqual([fullReviewText.replace("EXACT ENDING", "CHANGED ENDING")]);
    });
  },
  30000,
);

it.each([
  "missing",
  "duplicate",
  "streaming",
  "empty",
  "failed",
  "running",
  "wrong-project",
  "wrong-owner",
  "wrong-thread",
  "wrong-attempt",
  "missing-contract",
  "wrong-contract",
] as const)(
  "complete result review refuses %s projection evidence",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      await setupFullReview(f, `full-bad-${mode}`);
      const before = await f.executionCounts();
      state.readProjection.mockImplementation(async ({ input }) => {
        const r = await f.projection(input);
        if (r._tag !== "Success") return r;
        let p = r.value;
        if (mode === "missing") p = { ...p, attempts: [] };
        if (mode === "duplicate")
          p = {
            ...p,
            turnItems: [
              ...p.turnItems,
              ...p.turnItems.filter((i) => i.type === "assistant_message"),
            ],
          };
        if (mode === "streaming" || mode === "empty")
          p = {
            ...p,
            turnItems: p.turnItems.map((i) =>
              i.type === "assistant_message"
                ? { ...i, ...(mode === "streaming" ? { streaming: true } : { text: "" }) }
                : i,
            ),
          };
        if (mode === "failed" || mode === "running")
          p = { ...p, runs: p.runs.map((r) => ({ ...r, status: mode })) };
        if (mode === "wrong-owner")
          p = {
            ...p,
            thread: {
              ...p.thread,
              agentsTaskCreation: { ...p.thread.agentsTaskCreation!, actorId: "other-owner" },
            },
          };
        if (mode === "wrong-project")
          p = { ...p, thread: { ...p.thread, projectId: ProjectId.make("other-project") } };
        if (mode === "wrong-thread")
          p = { ...p, thread: { ...p.thread, id: ThreadId.make("other-thread") } };
        if (mode === "wrong-attempt")
          p = {
            ...p,
            runs: p.runs.map((r) => ({
              ...r,
              activeAttemptId: RunAttemptId.make("sibling-attempt"),
            })),
          };
        if (mode === "missing-contract")
          p = {
            ...p,
            messages: p.messages.map((m) => {
              const { taskFirstLaunch: _first, taskResultContinuation: _next, ...rest } = m;
              return rest;
            }),
          };
        if (mode === "wrong-contract")
          p = {
            ...p,
            messages: p.messages.map((m) =>
              m.taskFirstLaunch
                ? {
                    ...m,
                    taskFirstLaunch: {
                      ...m.taskFirstLaunch,
                      contract: {
                        ...m.taskFirstLaunch.contract,
                        goal: "Different persisted criteria",
                      },
                    },
                  }
                : m,
            ),
          };
        return { ...r, value: p };
      });
      await openFullReview();
      expect(completeText()).toEqual([]);
      expect(text().includes("unavailable")).toBe(true);
      expect(await f.executionCounts()).toEqual(before);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
    });
  },
  30000,
);

it.each(["close", "refresh", "back", "session ABA", "environment ABA", "unmount"] as const)(
  "complete result review retires delayed reads and captured callbacks on %s",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      await setupFullReview(f, `full-late-${mode}`);
      await openFullReview();
      const reload = creationButton("Reload complete output")!.props.onClick;
      const delay = deferred<Awaited<ReturnType<typeof f.projection>>>(),
        entered = deferred<void>();
      state.readProjection.mockImplementationOnce(async ({ input }) => {
        const r = await f.projection(input);
        entered.resolve();
        await delay.promise;
        return r;
      });
      let pending: Promise<void>;
      await act(async () => {
        pending = reload();
        await entered.promise;
      });
      if (mode === "close") await creationClick("Close complete output");
      if (mode === "refresh")
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      if (mode === "back") {
        await creationClick("Back to task inbox");
        await selectOnlyInboxTaskForDetailJourney(renderer);
      }
      if (mode === "session ABA") {
        const old = state.sessionIdentity;
        state.sessionIdentity = null;
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
        state.sessionIdentity = old;
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
      }
      if (mode === "environment ABA") {
        state.environmentId = "environment-b";
        await act(async () => renderer.update(<TasksPage />));
        state.environmentId = "environment-a";
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
      }
      if (mode === "unmount") await act(async () => renderer.unmount());
      const projection = await f.projection({
        threadId: state.readProjection.mock.calls[0]![0].input.threadId,
      });
      await act(async () => {
        delay.resolve(projection);
        await pending!;
        await reload();
      });
      if (mode !== "unmount") expect(completeText()).toEqual([]);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);

it("complete result review fails closed for readonly and changed owner, and blocks disconnected captured Open", async () => {
  await withLibraryFixture(async (f) => {
    await setupFullReview(f, "full-permissions");
    await f.disconnect();
    await f.connect(["orchestration:read"]);
    state.sessionIdentity = {};
    await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await openFullReview();
    expect(completeText()).toEqual([]);
    expect(text()).toContain("unavailable");
    await creationClick("Close complete output");
    await f.disconnect();
    await f.connectAs("another-owner");
    await openFullReview();
    expect(completeText()).toEqual([]);
    expect(text()).toContain("unavailable");
    await creationClick("Close complete output");
    const captured = creationButton("Open complete output")!.props.onClick;
    state.sessionIdentity = null;
    await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
    const reads = state.readProjection.mock.calls.length;
    await act(async () => {
      await captured();
    });
    expect(state.readProjection).toHaveBeenCalledTimes(reads);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
  });
}, 30000);

it("complete result review Close retires an existing unsent acceptance confirmation", async () => {
  await withLibraryFixture(async (f) => {
    await setupFullReview(f, "full-retired-accept");
    await openFullReview();
    await awaitReviewReads(
      () => renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
      1,
      f,
    );
    const confirm = creationButton("Confirm decision")!.props.onClick;
    await creationClick("Close complete output");
    await act(async () => {
      await confirm();
    });
    expect(creationButton("Confirm decision")).toBeUndefined();
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect((await f.inspect()).starts).toHaveLength(1);
  });
}, 30000);

it.each(["task ABA", "deletion"] as const)(
  "complete result review retires full output and old callbacks on %s",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const a = await setupFullReview(f, `full-life-${mode}`);
      await openFullReview();
      const reload = creationButton("Reload complete output")!.props.onClick;
      if (mode === "deletion") {
        expect(
          (
            await f.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("delete-full-review"),
              threadId: a.threadId,
            })
          )._tag,
        ).toBe("Success");
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      } else {
        const b = await completedForFullReview(f, "full-other-task");
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
        await creationClick("Back to task inbox");
        const tasks = (await f.snapshot()).tasks;
        await selectExactInboxTask(tasks.find((t) => t.threadId === b.threadId)!);
        await creationClick("Back to task inbox");
        await selectExactInboxTask(tasks.find((t) => t.threadId === a.threadId)!);
      }
      await act(async () => {
        await reload();
      });
      expect(completeText()).toEqual([]);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
    });
  },
  30000,
);

it.each(["manual", "auto"] as const)(
  "complete result review uses existing separately reviewed explicit %s revision Start",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const c = await setupFullReview(f, `full-start-${mode}`);
      await openFullReview();
      await awaitReviewReads(
        () => creationButton("Prepare revision request")!.props.onClick(),
        2,
        f,
      );
      await act(async () =>
        renderer.root.findByProps({ "aria-label": "Requested changes" }).props.onChange({
          target: { value: "Revise the ending from the complete persisted result." },
        }),
      );
      await creationClick(mode === "manual" ? "Choose Manual" : "Choose Auto");
      await act(async () => {
        await creationButton("Review result continuation")!.props.onClick();
      });
      expect((await f.inspect()).starts).toHaveLength(1);
      expect(state.startStep).not.toHaveBeenCalled();
      await act(async () => {
        const start = creationButton("Start reviewed result continuation")!.props.onClick;
        const first = start();
        start();
        await first;
      });
      await act(async () => {
        await state.startStep.mock.results[0]!.value;
      });
      await f.settle(state.startStep.mock.calls[0]![0].input.message.messageId);
      expect(state.startStep).toHaveBeenCalledTimes(1);
      expect((await f.inspect()).starts).toHaveLength(2);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
      const p = await f.projection({ threadId: c.threadId });
      if (p._tag !== "Success") throw new Error("missing projection");
      expect(p.value.thread.taskAcceptedRevision).toBeNull();
    });
  },
  60000,
);

it("complete result review preserves one original lost acceptance response without resend through close and remount", async () => {
  await withLibraryFixture(async (f) => {
    const c = await setupFullReview(f, "full-lost-accept");
    await openFullReview();
    await awaitReviewReads(
      () => renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
      1,
      f,
    );
    f.dropNextReply();
    await creationClick("Confirm decision", true);
    await Promise.race([
      f.awaitDroppedReply(),
      state.reviewDecide.mock.results[0]?.value?.then(() => {
        throw new Error("Expected lost decision reply");
      }) ?? new Promise<void>(() => {}),
    ]);
    await act(async () => {
      await f.disconnect();
      await state.reviewDecide.mock.results[0]!.value;
    });
    if (creationButton("Close complete output")) await creationClick("Close complete output");
    expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(0);
    await act(async () => renderer.unmount());
    await f.connect();
    state.sessionIdentity = {};
    await act(async () => {
      renderer = create(<TasksPage scope={libraryScope} />);
    });
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await selectOnlyInboxTaskForDetailJourney(renderer);
    expect(state.reviewDecide).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(0);
    const p = await f.projection({ threadId: c.threadId });
    if (p._tag !== "Success") throw new Error("missing projection");
    expect(p.value.thread.taskAcceptedRevision).toBe(1);
    expect(
      (await f.inspect()).commands.filter((c) => c.type === "thread.task-contract.accept"),
    ).toHaveLength(1);
    expect((await f.inspect()).starts).toHaveLength(1);
  });
}, 30000);

it.each(["accepted", "paused"] as const)(
  "complete result review inspects %s completed output without borrowing decision authority",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const c = await setupFullReview(f, `full-phase-${mode}`);
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
      const review = await f.review({
        environmentId: "environment-a",
        taskId: task.id,
        projectId: task.projectId,
        threadId: c.threadId,
        revision: 1,
      });
      if (review._tag !== "Success" || review.value.status !== "available")
        throw new Error("missing owner review");
      const decision =
        mode === "accepted"
          ? { type: "thread.task-contract.accept" as const, revision: 1 }
          : { type: "thread.task-contract.redirect" as const, revision: 1 };
      expect(
        (
          await f.dispatch({
            ...decision,
            commandId: CommandId.make(`phase-${mode}`),
            threadId: c.threadId,
            reviewTask: review.value.reference,
          })
        )._tag,
      ).toBe("Success");
      await act(async () => {
        creationButton("Refresh tasks")!.props.onClick();
        await state.load.mock.results.at(-1)!.value;
      });
      const before = await f.executionCounts();
      await openFullReview();
      expect(completeText()).toEqual([fullReviewText]);
      expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(0);
      expect(await f.executionCounts()).toEqual(before);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
    });
  },
  30000,
);

it.each(["close", "reload"] as const)(
  "complete result review synchronously retires captured revision Start on %s before React commits",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      await setupFullReview(f, `full-sync-${mode}`);
      await openFullReview();
      await awaitReviewReads(
        () => creationButton("Prepare revision request")!.props.onClick(),
        2,
        f,
      );
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Requested changes" })
          .props.onChange({ target: { value: "Revise only after a current full review." } }),
      );
      await creationClick("Choose Manual");
      await act(async () => {
        await creationButton("Review result continuation")!.props.onClick();
      });
      const start = creationButton("Start reviewed result continuation")!.props.onClick;
      const retire = creationButton(
        mode === "close" ? "Close complete output" : "Reload complete output",
      )!.props.onClick;
      await act(async () => {
        const read = retire();
        const pending = start();
        await read;
        await pending;
      });
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);

it.each(["confirm", "cancel", "dialog"] as const)(
  "complete result review confirmation ABA rejects captured %s A while B remains explicitly decidable",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const c = await setupFullReview(f, `full-confirm-aba-${mode}`);
      await openFullReview();
      await awaitReviewReads(
        () => renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
        1,
        f,
      );
      const old =
        mode === "dialog"
          ? renderer.root.findByType("dialog").props.onClose
          : creationButton(mode === "confirm" ? "Confirm decision" : "Cancel")!.props.onClick;
      await creationClick("Close complete output");
      await openFullReview();
      await awaitReviewReads(
        () => renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick(),
        1,
        f,
      );
      const own = creationButton("Confirm decision")!.props.onClick;
      await act(async () => {
        old();
      });
      expect(creationButton("Confirm decision")).toBeDefined();
      expect(state.reviewDecide).not.toHaveBeenCalled();
      await awaitReviewReads(() => own(), 2, f);
      await act(async () => {
        await state.reviewDecide.mock.results[0]!.value;
      });
      const p = await f.projection({ threadId: c.threadId });
      if (p._tag !== "Success") throw new Error("missing projection");
      expect(p.value.thread.taskAcceptedRevision).toBe(1);
      expect(state.reviewDecide).toHaveBeenCalledTimes(1);
    });
  },
  30000,
);

it.each([
  "save",
  "cancel",
  "dialog",
  "editor-cancel",
  "editor-preview",
  "sync-close-save",
  "sync-reload-save",
] as const)(
  "complete result review revision confirmation ABA rejects captured %s A and saves B's own text",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const c = await setupFullReview(f, `full-save-aba-${mode}`);
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
      const read = await f.review({
        environmentId: "environment-a",
        taskId: task.id,
        projectId: task.projectId,
        threadId: c.threadId,
        revision: 1,
      });
      if (read._tag !== "Success" || read.value.status !== "available")
        throw new Error("missing review");
      await f.dispatch({
        type: "thread.task-contract.redirect",
        commandId: CommandId.make(`pause-save-${mode}`),
        threadId: c.threadId,
        revision: 1,
        reviewTask: read.value.reference,
      });
      state.reviewDecide.mockImplementation(({ input }) =>
        f.dispatch(
          decodeCreationReviewCommand({
            ...input,
            type: `thread.task-contract.${input.action}`,
            commandId: CommandId.make(`save-new-${mode}`),
          }),
        ),
      );
      await act(async () => {
        creationButton("Refresh tasks")!.props.onClick();
        await state.load.mock.results.at(-1)!.value;
      });
      await openFullReview();
      const edit = async (goal: string) => {
        await awaitReviewReads(
          () => creationButton("Revise paused instructions")!.props.onClick(),
          1,
          f,
        );
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "goal instruction" })
            .props.onChange({ target: { value: goal } }),
        );
      };
      await edit("Proposed goal A");
      const editorOld = creationButton(
        mode === "editor-cancel" ? "Cancel editing" : "Preview instruction changes",
      )!.props.onClick;
      await awaitReviewReads(
        () => creationButton("Preview instruction changes")!.props.onClick(),
        1,
        f,
      );
      const old = mode.startsWith("editor-")
        ? editorOld
        : mode === "dialog"
          ? renderer.root.findByType("dialog").props.onClose
          : creationButton(mode === "save" ? "Save new revision" : "Cancel")!.props.onClick;
      if (mode === "sync-close-save" || mode === "sync-reload-save") {
        const retire = creationButton(
          mode === "sync-close-save" ? "Close complete output" : "Reload complete output",
        )!.props.onClick;
        const save = creationButton("Save new revision")!.props.onClick;
        await act(async () => {
          const pending = retire();
          save();
          await pending;
          await f.flush();
        });
        expect(state.reviewDecide).not.toHaveBeenCalled();
        const p = await f.projection({ threadId: c.threadId });
        if (p._tag !== "Success") throw new Error("missing projection");
        expect(p.value.thread.taskContract?.revision).toBe(1);
        expect((await f.inspect()).starts).toHaveLength(1);
        return;
      }
      await creationClick("Close complete output");
      await openFullReview();
      await edit("Proposed goal B");
      await awaitReviewReads(
        () => creationButton("Preview instruction changes")!.props.onClick(),
        1,
        f,
      );
      const own = creationButton("Save new revision")!.props.onClick,
        count = state.reviewRead.mock.calls.length;
      await act(async () => {
        old();
        await f.flush();
      });
      expect(creationButton("Save new revision")).toBeDefined();
      expect(state.reviewRead).toHaveBeenCalledTimes(count);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      await act(async () => {
        own();
      });
      await act(async () => {
        await state.reviewDecide.mock.results[0]!.value;
      });
      const p = await f.projection({ threadId: c.threadId });
      if (p._tag !== "Success") throw new Error("missing projection");
      expect(p.value.thread.taskContract?.goal).toBe("Proposed goal B");
      expect(p.value.thread.taskContract?.revision).toBe(2);
      expect(state.reviewDecide).toHaveBeenCalledTimes(1);
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);

it("complete result review rejects paired A when latest live evidence changed to B during the final review read", async () => {
  await withLibraryFixture(async (f) => {
    const c = await setupFullReview(f, "full-final-live-race");
    let reads = 0;
    const entered = deferred<void>(),
      release = deferred<void>();
    state.reviewRead.mockImplementation(async ({ input }) => {
      const r = await f.review(input);
      if (++reads === 2) {
        entered.resolve();
        await release.promise;
      }
      return r;
    });
    let pending: Promise<void>;
    await act(async () => {
      pending = creationButton("Open complete output")!.props.onClick();
      await entered.promise;
    });
    await f.alterLatestOutput(
      c.threadId,
      fullReviewText.replace("EXACT ENDING", "LIVE CHANGED ENDING"),
    );
    const latest = await f.projection({ threadId: c.threadId });
    if (latest._tag !== "Success") throw new Error("missing projection");
    state.liveProjections.set(c.threadId, latest.value);
    await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
    await act(async () => {
      release.resolve();
      await pending!;
    });
    expect(completeText()).toEqual([]);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
    state.reviewRead.mockImplementation(({ input }) => f.review(input));
    await act(async () => {
      await creationButton("Reload complete output")!.props.onClick();
    });
    expect(completeText()).toEqual([fullReviewText.replace("EXACT ENDING", "LIVE CHANGED ENDING")]);
  });
}, 30000);

it.each(["cancel", "dialog", "draft", "conversation", "change"] as const)(
  "complete result review old revision preparation %s cannot act on a newer preparation",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const c = await setupFullReview(f, `full-revision-cancel-aba-${mode}`);
      await openFullReview();
      await awaitReviewReads(
        () => creationButton("Prepare revision request")!.props.onClick(),
        2,
        f,
      );
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Requested changes" })
          .props.onChange({ target: { value: "Old A draft" } }),
      );
      const oldChange = renderer.root.findByProps({ "aria-label": "Requested changes" }).props
        .onChange;
      const old =
        mode === "change"
          ? () => oldChange({ target: { value: "Stale A edit" } })
          : mode === "dialog"
            ? renderer.root.findByType("dialog").props.onClose
            : creationButton(
                mode === "cancel"
                  ? "Cancel revision preparation"
                  : mode === "draft"
                    ? "Fill empty draft and open"
                    : "Open conversation for full context",
              )!.props.onClick;
      await creationClick("Cancel revision preparation");
      await awaitReviewReads(
        () => creationButton("Prepare revision request")!.props.onClick(),
        2,
        f,
      );
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Requested changes" })
          .props.onChange({ target: { value: "Current B draft" } }),
      );
      const reads = state.readProjection.mock.calls.length;
      await act(async () => {
        await old();
      });
      expect(state.readProjection).toHaveBeenCalledTimes(reads);
      expect(renderer.root.findByProps({ "aria-label": "Requested changes" }).props.value).toBe(
        "Current B draft",
      );
      expect(state.navigate).not.toHaveBeenCalled();
      expect(
        useComposerDraftStore
          .getState()
          .getComposerDraft(scopeThreadRef(EnvironmentId.make("environment-a"), c.threadId)),
      ).toBeNull();
      expect(creationButton("Cancel revision preparation")).toBeDefined();
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      await creationClick("Cancel revision preparation");
      expect(creationButton("Cancel revision preparation")).toBeUndefined();
    });
  },
  30000,
);

it.each(
  (["unavailable", "loading"] as const).flatMap((inspection) =>
    (["pause", "resume", "edit"] as const).map((action) => ({ inspection, action })),
  ),
)(
  "complete result review $inspection inspection preserves authorized non-result $action",
  async ({ inspection, action }) => {
    await withLibraryFixture(async (f) => {
      const key = `full-non-result-${inspection}-${action}`;
      const c = await setupFullReview(
        f,
        key,
        action === "pause" ? fullReviewText : "",
        action === "pause",
      );
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
      const input = {
        environmentId: "environment-a",
        taskId: task.id,
        projectId: task.projectId,
        threadId: c.threadId,
        revision: 1,
      };
      if (action !== "pause") {
        const r = await f.review(input);
        if (r._tag !== "Success" || r.value.status !== "available")
          throw new Error("missing review");
        expect(
          (
            await f.dispatch({
              type: "thread.task-contract.redirect",
              commandId: CommandId.make(`pause-${key}`),
              threadId: c.threadId,
              revision: 1,
              reviewTask: r.value.reference,
            })
          )._tag,
        ).toBe("Success");
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      } else {
        expect(task.resultReadout).toMatchObject({ status: "available", runStatus: "running" });
      }
      const authoritative = await f.review(input);
      if (authoritative._tag !== "Success" || authoritative.value.status !== "available")
        throw new Error("missing authority");
      expect(
        action === "edit"
          ? authoritative.value.canEditInstructions
          : authoritative.value.actions.includes(action === "pause" ? "redirect" : "resume"),
      ).toBe(true);
      state.reviewDecide.mockImplementation(({ input }) =>
        f.dispatch(
          decodeCreationReviewCommand({
            ...input,
            type: `thread.task-contract.${input.action}`,
            commandId: CommandId.make(`decide-${key}`),
          }),
        ),
      );
      const entered = deferred<void>(),
        release = deferred<void>();
      state.readProjection.mockImplementation(async ({ input }) => {
        entered.resolve();
        if (inspection === "loading") await release.promise;
        return f.projection(input);
      });
      let pending: Promise<void> | undefined;
      try {
        if (inspection === "loading") {
          await act(async () => {
            pending = creationButton("Open complete output")!.props.onClick();
            await entered.promise;
          });
          expect(text()).toContain("Reading complete persisted output");
        } else {
          await openFullReview();
          expect(text()).toContain("Complete persisted output is unavailable");
        }
        expect(completeText()).toEqual([]);
        expect(state.reviewDecide).not.toHaveBeenCalled();
        expect(state.startStep).not.toHaveBeenCalled();
        await awaitReviewReads(
          () =>
            creationButton(
              action === "pause"
                ? "Pause for redirect"
                : action === "resume"
                  ? "Resume under this contract"
                  : "Revise paused instructions",
            )!.props.onClick(),
          1,
          f,
        );
        if (action === "edit") {
          expect(renderer.root.findByProps({ "aria-label": "goal instruction" })).toBeDefined();
          await act(async () =>
            renderer.root
              .findByProps({ "aria-label": "goal instruction" })
              .props.onChange({ target: { value: "Explicitly reviewed revised criteria" } }),
          );
          await awaitReviewReads(
            () => creationButton("Preview instruction changes")!.props.onClick(),
            1,
            f,
          );
        }
        const confirm = creationButton(
          action === "edit" ? "Save new revision" : "Confirm decision",
        );
        expect(confirm).toBeDefined();
        expect(state.reviewDecide).not.toHaveBeenCalled();
        await act(async () => {
          confirm!.props.onClick();
          await f.flush();
        });
        expect(state.reviewDecide).toHaveBeenCalledTimes(1);
        await act(async () => {
          await state.reviewDecide.mock.results[0]!.value;
        });
        const p = await f.projection({ threadId: c.threadId });
        if (p._tag !== "Success") throw new Error("missing projection");
        expect(p.value.thread.taskContractPhase).toBe(
          action === "resume" ? "active" : "redirected",
        );
        expect(p.value.thread.taskContract?.revision).toBe(action === "edit" ? 2 : 1);
        if (action === "edit")
          expect(p.value.thread.taskContract?.goal).toBe("Explicitly reviewed revised criteria");
        expect(state.startStep).not.toHaveBeenCalled();
        expect((await f.inspect()).starts).toHaveLength(1);
      } finally {
        release.resolve();
        await act(async () => {
          await pending;
        });
      }
      expect(completeText()).toEqual([]);
    });
  },
  30000,
);

const comparisonFirstText =
  "Previous output\n" + "p".repeat(2300) + "\n😀 <script>inert</script> PREVIOUS ENDING\n  ";
const comparisonCurrentText =
  "Revised output\n" + "r".repeat(2300) + "\n🧪 <iframe>inert</iframe> REVISED ENDING\n  ";
const comparisonChanges =
  "Keep the Unicode 😀 and multiline output.\nAddress this exact ending.\n  ";
function comparisonTexts() {
  return renderer.root
    .findAllByType("pre")
    .filter((n) =>
      [
        "Previous persisted output",
        "Persisted requested changes",
        "Current persisted output",
      ].includes(n.props["aria-label"]),
    )
    .map((n) => [n.props["aria-label"], n.children.join("")]);
}
it("result revision comparison actual Tasks journey shows exact linked outputs and persisted changes read-only", async () => {
  await withLibraryFixture(async (f) => {
    const c = await setupFullReview(f, "comparison-ui", comparisonFirstText);
    await awaitReviewReads(() => creationButton("Prepare revision request")!.props.onClick(), 2, f);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Requested changes" })
        .props.onChange({ target: { value: comparisonChanges } }),
    );
    await creationClick("Choose Manual");
    await act(async () => {
      await creationButton("Review result continuation")!.props.onClick();
    });
    expect((await f.inspect()).starts).toHaveLength(1);
    f.setWorkflowOutput(comparisonCurrentText);
    await creationClick("Start reviewed result continuation");
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    await f.settle(state.startStep.mock.calls[0]![0].input.message.messageId);
    await act(async () => {
      creationButton("Refresh tasks")!.props.onClick();
      await state.load.mock.results.at(-1)!.value;
    });
    const before = await f.executionCounts();
    expect(creationButton("Compare revised result")).toBeDefined();
    await act(async () => {
      await creationButton("Compare revised result")!.props.onClick();
    });
    expect(comparisonTexts()).toEqual([
      ["Previous persisted output", comparisonFirstText],
      ["Persisted requested changes", comparisonChanges],
      ["Current persisted output", comparisonCurrentText],
    ]);
    expect(renderer.root.findAllByType("script")).toHaveLength(0);
    expect(renderer.root.findAllByType("iframe")).toHaveLength(0);
    expect(text()).toContain("Recorded run selection");
    expect(text()).toContain("Persisted Goal");
    expect(text()).toContain(c.threadId);
    expect(await f.executionCounts()).toEqual(before);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    expect(state.startStep).toHaveBeenCalledTimes(1);
    await creationClick("Close result comparison");
    expect(comparisonTexts()).toEqual([]);
    expect(await f.executionCounts()).toEqual(before);
  });
}, 30000);

async function seedComparison(f: LibraryFixture, key: string) {
  const c = await setupFullReview(f, key, comparisonFirstText);
  const { m: prepared } = await prepareComparisonContinuation(f, c, key);
  const m = { ...prepared, text: comparisonChanges };
  f.setWorkflowOutput(comparisonCurrentText);
  expect((await sendComparisonContinuation(f, m, m))._tag).toBe("Success");
  await f.settle(m.messageId);
  await act(async () => {
    creationButton("Refresh tasks")!.props.onClick();
    await state.load.mock.results.at(-1)!.value;
  });
  return { c, m };
}
async function openComparison() {
  await act(async () => {
    await creationButton("Compare revised result")!.props.onClick();
  });
}

it.each([
  "digest",
  "previous-tail",
  "missing-binding",
  "missing-historical-input",
  "wrong-task",
  "sibling-projection",
  "failed-current",
  "streaming-current",
] as const)(
  "result revision comparison fails closed for %s evidence",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const { c, m } = await seedComparison(f, `comparison-bad-${mode}`);
      const sibling =
        mode === "sibling-projection"
          ? await completedForFullReview(f, "comparison-sibling")
          : null;
      state.readProjection.mockImplementation(async ({ input }) => {
        const r = await f.projection(sibling ? { threadId: sibling.threadId } : input);
        if (r._tag !== "Success") return r;
        let p = r.value;
        if (mode === "digest" || mode === "wrong-task")
          p = {
            ...p,
            messages: p.messages.map((v) =>
              v.id === m.messageId && v.taskResultContinuation
                ? {
                    ...v,
                    taskResultContinuation: {
                      ...v.taskResultContinuation,
                      ...(mode === "digest"
                        ? {
                            priorResult: {
                              ...v.taskResultContinuation.priorResult,
                              outputSha256: "0".repeat(64),
                            },
                          }
                        : {
                            reference: {
                              ...v.taskResultContinuation.reference,
                              taskId: "sibling-task",
                            },
                          }),
                    },
                  }
                : v,
            ),
          };
        if (mode === "missing-binding" || mode === "missing-historical-input")
          p = {
            ...p,
            messages: p.messages.map((v) => {
              if (v.id !== (mode === "missing-binding" ? m.messageId : m.priorResult.messageId))
                return v;
              const { taskFirstLaunch: _first, taskResultContinuation: _next, ...rest } = v;
              return rest;
            }),
          };
        if (mode === "previous-tail")
          p = {
            ...p,
            turnItems: p.turnItems.map((v) =>
              v.id === m.priorResult.itemId && v.type === "assistant_message"
                ? { ...v, text: comparisonFirstText.replace("PREVIOUS ENDING", "ALTERED ENDING") }
                : v,
            ),
          };
        if (mode === "failed-current")
          p = {
            ...p,
            runs: p.runs.map((v) =>
              v.userMessageId === m.messageId ? { ...v, status: "failed" as const } : v,
            ),
          };
        if (mode === "streaming-current")
          p = {
            ...p,
            turnItems: p.turnItems.map((v) =>
              v.runId !== m.priorResult.runId ? { ...v, streaming: true } : v,
            ),
          };
        return { ...r, value: p };
      });
      const before = await f.executionCounts();
      await openComparison();
      expect(comparisonTexts()).toEqual([]);
      expect(text()).toContain("Comparison unavailable");
      if (mode === "digest" || mode === "previous-tail") expect(text()).toContain("digest");
      if (mode === "missing-binding") expect(text()).toContain("no revision-continuation binding");
      expect(creationButton("Open conversation for comparison context")).toBeDefined();
      expect(await f.executionCounts()).toEqual(before);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
      await creationClick("Open conversation for comparison context");
      expect(state.navigate).toHaveBeenCalledTimes(1);
      expect(c.threadId).toBe(m.threadId);
    });
  },
  30000,
);

it.each(["close", "refresh", "back", "session ABA", "environment ABA", "unmount"] as const)(
  "result revision comparison retires delayed reads and captured callbacks on %s",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const { c } = await seedComparison(f, `comparison-late-${mode}`);
      await openComparison();
      const reload = creationButton("Reload result comparison")!.props.onClick;
      const close = creationButton("Close result comparison")!.props.onClick;
      const entered = deferred<void>(),
        release = deferred<void>();
      state.readProjection.mockImplementationOnce(async ({ input }) => {
        const r = await f.projection(input);
        entered.resolve();
        await release.promise;
        return r;
      });
      let pending: Promise<void>;
      const before = await f.executionCounts();
      await act(async () => {
        pending = reload();
        await entered.promise;
      });
      if (mode === "close") await creationClick("Close result comparison");
      if (mode === "refresh")
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      if (mode === "back") {
        await creationClick("Back to task inbox");
        await selectOnlyInboxTaskForDetailJourney(renderer);
      }
      if (mode === "session ABA") {
        const old = state.sessionIdentity;
        state.sessionIdentity = null;
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
        state.sessionIdentity = old;
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
      }
      if (mode === "environment ABA") {
        state.environmentId = "environment-b";
        await act(async () => renderer.update(<TasksPage />));
        state.environmentId = "environment-a";
        await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
      }
      if (mode === "unmount") await act(async () => renderer.unmount());
      await act(async () => {
        release.resolve();
        await pending!;
      });
      const reads = state.readProjection.mock.calls.length;
      await act(async () => {
        await reload();
        close();
      });
      expect(state.readProjection).toHaveBeenCalledTimes(reads);
      if (mode !== "unmount") expect(comparisonTexts()).toEqual([]);
      expect(await f.executionCounts()).toEqual(before);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      expect(state.feedbackSubmit).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(2);
      expect(c.threadId).toContain("comparison-late");
    });
  },
  30000,
);

it("result revision comparison captured A cannot close or reload reopened B after a delayed response", async () => {
  await withLibraryFixture(async (f) => {
    await seedComparison(f, "comparison-read-aba");
    await openComparison();
    const oldReload = creationButton("Reload result comparison")!.props.onClick,
      oldClose = creationButton("Close result comparison")!.props.onClick;
    const entered = deferred<void>(),
      release = deferred<void>();
    state.readProjection.mockImplementationOnce(async ({ input }) => {
      const r = await f.projection(input);
      entered.resolve();
      await release.promise;
      return r;
    });
    let pending: Promise<void>;
    await act(async () => {
      pending = oldReload();
      await entered.promise;
    });
    await creationClick("Close result comparison");
    await openComparison();
    const expected = comparisonTexts();
    expect(expected).toHaveLength(3);
    await act(async () => {
      release.resolve();
      await pending!;
    });
    expect(comparisonTexts()).toEqual(expected);
    const reads = state.readProjection.mock.calls.length;
    await act(async () => {
      await oldReload();
      oldClose();
    });
    expect(comparisonTexts()).toEqual(expected);
    expect(state.readProjection).toHaveBeenCalledTimes(reads);
    await creationClick("Close result comparison");
    expect(comparisonTexts()).toEqual([]);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
  });
}, 30000);

it.each(["current", "previous"] as const)(
  "result revision comparison invalidates a live %s full-tail change behind the same preview",
  async (side) => {
    await withLibraryFixture(async (f) => {
      const { c, m } = await seedComparison(f, `comparison-live-${side}`);
      await openComparison();
      const r = await f.projection({ threadId: c.threadId });
      if (r._tag !== "Success") throw new Error("missing projection");
      if (side === "current")
        await f.alterLatestOutput(
          c.threadId,
          comparisonCurrentText.replace("REVISED ENDING", "CHANGED ENDING"),
        );
      const changed =
        side === "current"
          ? await f.projection({ threadId: c.threadId })
          : {
              ...r,
              value: {
                ...r.value,
                turnItems: r.value.turnItems.map((v) =>
                  v.id === m.priorResult.itemId && v.type === "assistant_message"
                    ? {
                        ...v,
                        text: comparisonFirstText.replace("PREVIOUS ENDING", "CHANGED ENDING"),
                      }
                    : v,
                ),
              },
            };
      if (changed._tag !== "Success") throw new Error("missing changed projection");
      state.liveProjections.set(c.threadId, changed.value);
      if (side === "previous") state.readProjection.mockImplementation(async () => changed);
      await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
      expect(comparisonTexts()).toEqual([]);
      expect(text()).toContain("Reload the pair");
      await act(async () => {
        await creationButton("Reload result comparison")!.props.onClick();
      });
      if (side === "current")
        expect(comparisonTexts().at(-1)?.[1]).toBe(
          comparisonCurrentText.replace("REVISED ENDING", "CHANGED ENDING"),
        );
      else {
        expect(comparisonTexts()).toEqual([]);
        expect(text()).toContain("digest");
      }
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
    });
  },
  30000,
);

it("result revision comparison rejects paired A when live B arrives during the delayed final authority read", async () => {
  await withLibraryFixture(async (f) => {
    const { c } = await seedComparison(f, "comparison-final-race");
    const entered = deferred<void>(),
      release = deferred<void>();
    let reads = 0;
    state.reviewRead.mockImplementation(async ({ input }) => {
      const r = await f.review(input);
      if (++reads === 2) {
        entered.resolve();
        await release.promise;
      }
      return r;
    });
    let pending: Promise<void>;
    await act(async () => {
      pending = creationButton("Compare revised result")!.props.onClick();
      await entered.promise;
    });
    await f.alterLatestOutput(
      c.threadId,
      comparisonCurrentText.replace("REVISED ENDING", "NEW LIVE ENDING"),
    );
    const r = await f.projection({ threadId: c.threadId });
    if (r._tag !== "Success") throw new Error("missing live projection");
    state.liveProjections.set(c.threadId, r.value);
    await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
    await act(async () => {
      release.resolve();
      await pending!;
    });
    expect(comparisonTexts()).toEqual([]);
    expect(text()).toContain("changed during the reads");
    state.reviewRead.mockImplementation(({ input }) => f.review(input));
    await act(async () => {
      await creationButton("Reload result comparison")!.props.onClick();
    });
    expect(comparisonTexts().at(-1)?.[1]).toBe(
      comparisonCurrentText.replace("REVISED ENDING", "NEW LIVE ENDING"),
    );
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
  });
}, 30000);

it("result revision comparison follows only the new third run's predecessor after retiring the older pair", async () => {
  await withLibraryFixture(async (f) => {
    const { c } = await seedComparison(f, "comparison-third");
    await openComparison();
    const old = creationButton("Reload result comparison")!.props.onClick;
    const { m } = await prepareComparisonContinuation(f, c, "comparison-third-next");
    const third = { ...m, text: "Third recorded feedback 🧪\n" };
    const thirdText = "Third completed ending 😀\n";
    f.setWorkflowOutput(thirdText);
    expect((await sendComparisonContinuation(f, third, third))._tag).toBe("Success");
    await f.settle(third.messageId);
    await act(async () => {
      creationButton("Refresh tasks")!.props.onClick();
      await state.load.mock.results.at(-1)!.value;
    });
    expect(comparisonTexts()).toEqual([]);
    const reads = state.readProjection.mock.calls.length;
    await act(async () => {
      await old();
    });
    expect(state.readProjection).toHaveBeenCalledTimes(reads);
    const before = await f.executionCounts();
    await openComparison();
    expect(comparisonTexts()).toEqual([
      ["Previous persisted output", comparisonCurrentText],
      ["Persisted requested changes", third.text],
      ["Current persisted output", thirdText],
    ]);
    expect(await f.executionCounts()).toEqual(before);
    expect((await f.inspect()).starts).toHaveLength(3);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.startStep).not.toHaveBeenCalled();
  });
}, 30000);

it.each(["task ABA", "deletion"] as const)(
  "result revision comparison retires an old pair on %s",
  async (mode) => {
    await withLibraryFixture(async (f) => {
      const { c } = await seedComparison(f, `comparison-life-${mode}`);
      await openComparison();
      const old = creationButton("Reload result comparison")!.props.onClick;
      if (mode === "deletion") {
        expect(
          (
            await f.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("comparison-delete"),
              threadId: c.threadId,
            })
          )._tag,
        ).toBe("Success");
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      } else {
        const other = await completedForFullReview(f, "comparison-other-task");
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
        await creationClick("Back to task inbox");
        const tasks = (await f.snapshot()).tasks;
        await selectExactInboxTask(tasks.find((t) => t.threadId === other.threadId)!);
        await creationClick("Back to task inbox");
        await selectExactInboxTask(tasks.find((t) => t.threadId === c.threadId)!);
      }
      const reads = state.readProjection.mock.calls.length;
      await act(async () => {
        await old();
      });
      expect(state.readProjection).toHaveBeenCalledTimes(reads);
      expect(comparisonTexts()).toEqual([]);
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
    });
  },
  30000,
);

it("result revision comparison blocks wrong owner, readonly and disconnected captured requests", async () => {
  await withLibraryFixture(async (f) => {
    await seedComparison(f, "comparison-scope");
    await f.disconnect();
    await f.connect(["orchestration:read"]);
    state.sessionIdentity = {};
    await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
    await act(async () => {
      await state.load.mock.results.at(-1)!.value;
    });
    await openComparison();
    expect(comparisonTexts()).toEqual([]);
    expect(text()).toContain("Comparison unavailable");
    await creationClick("Close result comparison");
    await f.disconnect();
    await f.connectAs("another-owner");
    await openComparison();
    expect(comparisonTexts()).toEqual([]);
    expect(text()).toContain("Comparison unavailable");
    await creationClick("Close result comparison");
    const old = creationButton("Compare revised result")!.props.onClick;
    state.sessionIdentity = null;
    await act(async () => renderer.update(<TasksPage scope={libraryScope} />));
    const reads = state.reviewRead.mock.calls.length;
    await act(async () => {
      await old();
    });
    expect(state.reviewRead).toHaveBeenCalledTimes(reads);
    expect(state.startStep).not.toHaveBeenCalled();
    expect(state.reviewDecide).not.toHaveBeenCalled();
  });
}, 30000);

it("result revision comparison never substitutes the retained unsent changes draft", async () => {
  await withLibraryFixture(async (f) => {
    await seedComparison(f, "comparison-unsent-draft");
    await awaitReviewReads(() => creationButton("Prepare revision request")!.props.onClick(), 2, f);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Requested changes" })
        .props.onChange({ target: { value: "UNSENT local draft" } }),
    );
    await creationClick("Cancel revision preparation");
    const before = await f.executionCounts();
    await openComparison();
    expect(comparisonTexts()[1]).toEqual(["Persisted requested changes", comparisonChanges]);
    expect(await f.executionCounts()).toEqual(before);
    expect(state.startStep).not.toHaveBeenCalled();
  });
}, 30000);

it.each(["accept", "pause", "resume", "edit", "lost acceptance"] as const)(
  "result revision comparison unavailable view preserves independent explicit %s authority",
  async (action) => {
    await withLibraryFixture(async (f) => {
      const key = `comparison-controls-${action}`;
      const c = await setupFullReview(
        f,
        key,
        action === "resume" || action === "edit" ? "" : comparisonFirstText,
        action === "pause",
      );
      if (action === "resume" || action === "edit") {
        const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
        const r = await f.review({
          environmentId: "environment-a",
          taskId: task.id,
          projectId: task.projectId,
          threadId: c.threadId,
          revision: 1,
        });
        if (r._tag !== "Success" || r.value.status !== "available")
          throw new Error("missing authority");
        expect(
          (
            await f.dispatch({
              type: "thread.task-contract.redirect",
              commandId: CommandId.make(`pause-${key}`),
              threadId: c.threadId,
              revision: 1,
              reviewTask: r.value.reference,
            })
          )._tag,
        ).toBe("Success");
        await act(async () => {
          creationButton("Refresh tasks")!.props.onClick();
          await state.load.mock.results.at(-1)!.value;
        });
      }
      state.reviewDecide.mockImplementation(({ input }) =>
        f.dispatch(
          decodeCreationReviewCommand({
            ...input,
            type: `thread.task-contract.${input.action}`,
            commandId: CommandId.make(`decision-${key}`),
          }),
        ),
      );
      const before = await f.executionCounts();
      await openComparison();
      expect(comparisonTexts()).toEqual([]);
      expect(text()).toContain("Comparison unavailable");
      if (action === "accept" || action === "lost acceptance")
        expect(text()).toContain("first launch");
      expect(await f.executionCounts()).toEqual(before);
      await awaitReviewReads(
        () => {
          if (action === "accept" || action === "lost acceptance")
            renderer.root.findByProps({ "data-task-contract-accept": "" }).props.onClick();
          else
            creationButton(
              action === "pause"
                ? "Pause for redirect"
                : action === "resume"
                  ? "Resume under this contract"
                  : "Revise paused instructions",
            )!.props.onClick();
        },
        1,
        f,
      );
      if (action === "edit") {
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "goal instruction" })
            .props.onChange({
              target: { value: "Explicit criteria change beside unavailable comparison" },
            }),
        );
        await awaitReviewReads(
          () => creationButton("Preview instruction changes")!.props.onClick(),
          1,
          f,
        );
      }
      expect(state.reviewDecide).not.toHaveBeenCalled();
      expect(state.startStep).not.toHaveBeenCalled();
      if (action === "lost acceptance") {
        f.dropNextReply();
        await creationClick("Confirm decision", true);
        await Promise.race([
          f.awaitDroppedReply(),
          state.reviewDecide.mock.results[0]?.value?.then(() => {
            throw new Error("Expected lost reply");
          }) ?? new Promise<void>(() => {}),
        ]);
        await act(async () => {
          await f.disconnect();
          await state.reviewDecide.mock.results[0]!.value;
        });
        if (creationButton("Close result comparison"))
          await creationClick("Close result comparison");
        await act(async () => renderer.unmount());
        await f.connect();
        state.sessionIdentity = {};
        await act(async () => {
          renderer = create(<TasksPage scope={libraryScope} />);
        });
        await act(async () => {
          await state.load.mock.results.at(-1)!.value;
        });
        await selectOnlyInboxTaskForDetailJourney(renderer);
        await openComparison();
        expect(renderer.root.findAllByProps({ "data-task-contract-accept": "" })).toHaveLength(0);
        expect(
          (await f.inspect()).commands.filter((v) => v.type === "thread.task-contract.accept"),
        ).toHaveLength(1);
      } else {
        await creationClick(action === "edit" ? "Save new revision" : "Confirm decision");
        await act(async () => {
          await state.reviewDecide.mock.results[0]!.value;
        });
      }
      expect(state.reviewDecide).toHaveBeenCalledTimes(1);
      const p = await f.projection({ threadId: c.threadId });
      if (p._tag !== "Success") throw new Error("missing projection");
      if (action === "accept" || action === "lost acceptance")
        expect(p.value.thread.taskAcceptedRevision).toBe(1);
      if (action === "pause" || action === "edit")
        expect(p.value.thread.taskContractPhase).toBe("redirected");
      if (action === "resume") expect(p.value.thread.taskContractPhase).toBe("active");
      if (action === "edit")
        expect(p.value.thread.taskContract).toMatchObject({
          revision: 2,
          goal: "Explicit criteria change beside unavailable comparison",
        });
      expect(state.startStep).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);

it("result revision comparison leaves a separately reviewed explicit revision Start independent", async () => {
  await withLibraryFixture(async (f) => {
    const { c } = await seedComparison(f, "comparison-independent-start");
    await openComparison();
    await awaitReviewReads(() => creationButton("Prepare revision request")!.props.onClick(), 2, f);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Requested changes" })
        .props.onChange({
          target: { value: "Explicit third revision from its own reviewed controls" },
        }),
    );
    await creationClick("Choose Manual");
    await act(async () => {
      await creationButton("Review result continuation")!.props.onClick();
    });
    expect((await f.inspect()).starts).toHaveLength(2);
    expect(state.startStep).not.toHaveBeenCalled();
    await creationClick("Start reviewed result continuation");
    await act(async () => {
      await state.startStep.mock.results[0]!.value;
    });
    await f.settle(state.startStep.mock.calls[0]![0].input.message.messageId);
    expect(state.startStep).toHaveBeenCalledTimes(1);
    expect((await f.inspect()).starts).toHaveLength(3);
    expect(state.reviewDecide).not.toHaveBeenCalled();
    expect(state.feedbackSubmit).not.toHaveBeenCalled();
    const p = await f.projection({ threadId: c.threadId });
    if (p._tag !== "Success") throw new Error("missing projection");
    expect(p.value.runs).toHaveLength(3);
    expect(p.value.thread.taskAcceptedRevision).toBeNull();
  });
}, 30000);
