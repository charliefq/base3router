import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  startThreadTurn,
  editQueuedRun,
  type StartThreadTurnInput,
  type EditQueuedRunInput,
} from "@t3tools/client-runtime/operations";
import {
  CommandId,
  MessageId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { captureComposerSendDispatch } from "../ChatView.logic";
import { act, createElement, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env-a" }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [], readThreadShell: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/pullRequests", () => ({
  pullRequestEnvironment: {},
  usePullRequestList: () => ({ data: null }),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (v: unknown) => v }));
vi.mock("../../lib/composerPathSearchState", () => ({ useComposerPathSearch: () => [] }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
}));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "none" }));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: () => ({}),
  releaseAttachmentUpload: vi.fn(),
  releaseDraftAttachment: vi.fn(),
  releasePersistedAttachmentUpload: vi.fn(),
  readAttachmentUpload: () => null,
  startAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
  verifyStashedAttachmentUpload: vi.fn(),
}));
vi.mock("../ComposerPromptEditor", () => ({ ComposerPromptEditor: () => null }));
vi.mock("./ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: import("react").ReactNode }) =>
    createElement("button", props, children),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children: import("react").ReactNode;
    render?: import("react").ReactNode;
  }) => render ?? children,
}));
vi.mock("@base-ui/react/select", () => ({
  Select: {
    Icon: () => null,
    Trigger: ({ children }: { children: import("react").ReactNode }) => children,
  },
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: import("react").ReactNode }) => children,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectValue: () => null,
}));
vi.mock("./ComposerPrimaryActions", () => ({ ComposerPrimaryActions: () => null }));
vi.mock("./ComposerBannerStack", () => ({ ComposerBannerStack: () => null }));
vi.mock("./ComposerStashMenu", () => ({ ComposerStashMenu: () => null }));
vi.mock("./ComposerTasksBadge", () => ({
  ComposerTasksBadge: () => null,
  ComposerTasksContent: () => null,
  ComposerTasksDrawer: () => null,
}));
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: "codex" as ServerProvider["driver"],
  enabled: true,
  installed: true,
  status: "ready",
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-14T00:00:00Z",
  models: [{ slug: "fake", name: "Fake", isDefault: true, isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
};
const handle = createRef<ChatComposerHandle>(),
  noop = () => {};
function propsFor(environment = "env-a", id = "a"): ChatComposerProps {
  const target = scopeThreadRef(EnvironmentId.make(environment), ThreadId.make(id));
  return {
    composerDraftTarget: target,
    environmentId: target.environmentId,
    routeThreadRef: target,
    routeKind: "server",
    draftId: null,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: false,
    supportsQuestionAttachments: false,
    maxFileAttachmentBytes: null,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: noop,
    activeThreadId: target.threadId,
    activeThreadEnvironmentId: target.environmentId,
    activeThread: undefined,
    activeThreadShell: null,
    promptHistoryMessages: [],
    isServerThread: true,
    isLocalDraftThread: false,
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isConnecting: false,
    isSendBusy: false,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    bannerItems: [],
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    activeTasksProgress: null,
    activeTaskSteps: null,
    threadSyncPhase: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: [provider],
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: { instanceId: provider.instanceId, model: "fake" },
    activeThreadModelSelection: null,
    activeContextWindow: null,
    compactThreadUnavailable: false,
    compactDisabled: false,
    compactDisabledReason: null,
    resolvedTheme: "light",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: [],
    terminalOpen: false,
    gitCwd: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: noop,
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange: noop,
    onRestingChange: noop,
    promptRef: { current: "" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerRef: handle,
    onPageScrollKeyDown: noop,
    onPageScrollKeyUp: noop,
    onPageScrollRelease: noop,
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment: noop,
    onCompactContext: noop,
    onSend: noop,
    onResume: noop,
    onInterrupt: noop,
    onImplementPlanInNewThread: noop,
    onRespondToApproval: async () => {},
    onSelectActivePendingUserInputOption: noop,
    onAdvanceActivePendingUserInput: noop,
    onDismissActivePendingUserInput: noop,
    onPreviousActivePendingUserInputQuestion: noop,
    onChangeActivePendingUserInputCustomAnswer: noop,
    onProviderModelSelect: noop,
    onOpenProviderSetup: noop,
    getModelDisabledReason: () => null,
    toggleInteractionMode: noop,
    handleRuntimeModeChange: noop,
    handleInteractionModeChange: noop,
    focusComposer: noop,
    scheduleComposerFocus: noop,
    setThreadError: noop,
    onExpandImage: noop,
    onFileOpen: noop,
  };
}
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const events = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    getSelection: () => null,
  });
  vi.stubGlobal("document", {
    addEventListener: noop,
    removeEventListener: noop,
    activeElement: null,
    hasFocus: () => true,
  });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
const toggle = () =>
  renderer.root
    .findAllByType("button")
    .find((b) => b.props["data-composer-routing"] !== undefined)!;
it("keeps mounted composer routing and send context scoped across A B and another environment", async () => {
  await act(async () => {
    renderer = create(<ChatComposer {...propsFor()} />);
  });
  expect(handle.current!.getSendContext().routingMode).toBe("manual");
  await act(async () => toggle().props.onClick());
  expect(toggle().props["data-composer-routing"]).toBe("auto");
  expect(handle.current!.getSendContext().routingMode).toBe("auto");
  await act(async () => renderer.update(<ChatComposer {...propsFor("env-a", "b")} />));
  expect(handle.current!.getSendContext().routingMode).toBe("manual");
  expect(toggle().props["data-composer-routing"]).toBe("manual");
  await act(async () => renderer.update(<ChatComposer {...propsFor()} />));
  expect(handle.current!.getSendContext().routingMode).toBe("auto");
  await act(async () => renderer.update(<ChatComposer {...propsFor("env-b", "a")} />));
  expect(handle.current!.getSendContext().routingMode).toBe("manual");
});

it("restores explicit choice after remount and retains it when providers disappear", async () => {
  await act(async () => {
    renderer = create(<ChatComposer {...propsFor()} />);
  });
  await act(async () => toggle().props.onClick());
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<ChatComposer {...propsFor()} />);
  });
  expect(handle.current!.getSendContext().routingMode).toBe("auto");
  await act(async () => renderer.update(<ChatComposer {...propsFor()} providerStatuses={[]} />));
  expect(handle.current!.getSendContext().routingMode).toBe("auto");
  await act(async () => renderer.update(<ChatComposer {...propsFor()} />));
  await act(async () => toggle().props.onClick());
  expect(handle.current!.getSendContext().routingMode).toBe("manual");
  await act(async () => toggle().props.onClick());
  expect(handle.current!.getSendContext().routingMode).toBe("auto");
});

effectIt.effect(
  "binds production send requests before delayed navigation, toggles, fan-out and queue edits",
  () =>
    Effect.gen(function* () {
      const commands: { environment: EnvironmentId; command: OrchestrationV2Command }[] = [];
      const makeSupervisor = (environment: EnvironmentId) =>
        Effect.gen(function* () {
          const session = yield* SubscriptionRef.make(
            Option.some({
              client: {
                [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
                  Effect.sync(() => {
                    commands.push({ environment, command });
                    return { sequence: commands.length };
                  }),
              },
              initialConfig: Effect.succeed({
                environment: { capabilities: { serverResolvedCommandContext: true } },
              }),
            } as never),
          );
          return EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: { environmentId: environment, label: "Fake only" },
            session,
          } as never);
        });
      const envA = EnvironmentId.make("env-a"),
        envB = EnvironmentId.make("env-b");
      const supervisors = new Map([
        [envA, yield* makeSupervisor(envA)],
        [envB, yield* makeSupervisor(envB)],
      ]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const operations = {
        startTurn: ({
          environmentId,
          input,
        }: {
          environmentId: EnvironmentId;
          input: StartThreadTurnInput;
        }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* startThreadTurn(input).pipe(
              Effect.provideService(
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisors.get(environmentId)!,
              ),
            );
          }),
        editQueuedRun: ({
          environmentId,
          input,
        }: {
          environmentId: EnvironmentId;
          input: EditQueuedRunInput;
        }) =>
          editQueuedRun(input).pipe(
            Effect.provideService(
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisors.get(environmentId)!,
            ),
          ),
      };
      yield* Effect.promise(() =>
        act(async () => {
          renderer = create(<ChatComposer {...propsFor()} />);
        }),
      );
      yield* Effect.promise(() => act(async () => toggle().props.onClick()));
      const targetA = scopeThreadRef(envA, ThreadId.make("a"));
      const dispatchA = captureComposerSendDispatch(targetA, envA, handle.current, operations)!;
      // Input fixtures omit routing. The production seam owns mode/environment binding.
      const input = (id: string, thread: string, dispatchMode: "auto" | "queue" = "auto") => ({
        commandId: CommandId.make(id),
        threadId: ThreadId.make(thread),
        message: {
          messageId: MessageId.make(id),
          role: "user" as const,
          text: "Fixture prompt",
          attachments: [],
        },
        modelSelection: dispatchA.context.selectedModelSelection,
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
        dispatchMode,
      });
      const pending = yield* dispatchA
        .startTurn({ environmentId: envA, input: input("normal-a", "a") })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() =>
        act(async () => renderer.update(<ChatComposer {...propsFor("env-b", "b")} />)),
      );
      expect(
        captureComposerSendDispatch(targetA, envA, handle.current, operations),
      ).toBeUndefined();
      const targetB = scopeThreadRef(envB, ThreadId.make("b"));
      const dispatchB = captureComposerSendDispatch(targetB, envB, handle.current, operations)!;
      yield* Effect.promise(() => act(async () => toggle().props.onClick()));
      yield* Effect.promise(() =>
        act(async () => useComposerDraftStore.getState().setRoutingMode(targetA, "manual")),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      yield* dispatchB.startTurn({ environmentId: envB, input: input("normal-b", "b") });
      yield* dispatchA.startTurn({ environmentId: envA, input: input("queued-a", "a", "queue") });
      for (const id of ["fanout-one", "fanout-two"]) {
        yield* dispatchA.startTurn({ environmentId: envA, input: input(id, id) });
      }
      yield* dispatchA.editQueuedRun({
        environmentId: envA,
        input: {
          commandId: CommandId.make("edit-queued"),
          threadId: targetA.threadId,
          runId: RunId.make("queued-run"),
          text: "Edited queued text",
        },
      });
      expect(
        commands
          .slice(0, 5)
          .map(({ environment, command }) =>
            command.type === "message.dispatch"
              ? { environment, thread: command.threadId, mode: command.routingMode }
              : null,
          ),
      ).toEqual([
        { environment: envA, thread: "a", mode: "auto" },
        { environment: envB, thread: "b", mode: "manual" },
        { environment: envA, thread: "a", mode: "auto" },
        { environment: envA, thread: "fanout-one", mode: "auto" },
        { environment: envA, thread: "fanout-two", mode: "auto" },
      ]);
      expect(commands[2]?.command).toMatchObject({
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
      });
      expect(commands[5]).toMatchObject({
        environment: envA,
        command: { type: "queued-run.edit", threadId: "a", text: "Edited queued text" },
      });
      expect(commands[5]?.command).not.toHaveProperty("routingMode");
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    ),
);
