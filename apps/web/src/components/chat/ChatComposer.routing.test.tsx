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
  setThreadRuntimeMode,
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
import { captureComposerSendDispatch, readComposerSendContextForTarget } from "../ChatView.logic";
import { act, cloneElement, createElement, createRef, type ReactElement } from "react";
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
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import { makeThreadFixture } from "../../test-fixtures";
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
const uploadFixture = vi.hoisted(() => ({ uploads: {} as Record<string, AttachmentUploadState> }));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: () => uploadFixture.uploads,
  releaseAttachmentUpload: vi.fn(),
  releaseDraftAttachment: vi.fn(),
  releasePersistedAttachmentUpload: vi.fn(),
  readAttachmentUpload: (id: string) => uploadFixture.uploads[id] ?? null,
  startAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
  verifyStashedAttachmentUpload: vi.fn(),
}));
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: ({
    value,
    onCommandKeyDown,
  }: {
    value: string;
    onCommandKeyDown: (key: string, event: KeyboardEvent) => boolean;
  }) =>
    createElement("textarea", {
      value,
      readOnly: true,
      onKeyDown: (event: KeyboardEvent) => onCommandKeyDown(event.key, event),
    }),
}));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  StageBackdropButtonArt: () => null,
}));
vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: ({
    routingMode,
    onRoutingModeChange,
  }: {
    routingMode: "auto" | "manual";
    onRoutingModeChange: (mode: "auto" | "manual") => void;
  }) =>
    createElement("button", {
      "data-composer-routing": routingMode,
      onClick: () => onRoutingModeChange(routingMode === "auto" ? "manual" : "auto"),
    }),
}));

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
  }) =>
    render
      ? cloneElement(render as ReactElement<{ children?: import("react").ReactNode }>, {}, children)
      : children,
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
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        antigravity: { ...DEFAULT_UNIFIED_SETTINGS.providers.antigravity, enabled: true },
      },
    },
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
  uploadFixture.uploads = {};
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
    getElementById: () => ({}),
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

const signedOut: ServerProvider = {
  ...provider,
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: "antigravity" as ServerProvider["driver"],
  status: "error",
  auth: { status: "unauthenticated" },
  models: [
    {
      slug: "gemini-pro",
      name: "Gemini",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
    },
  ],
};
const manualSelection = {
  instanceId: signedOut.instanceId,
  model: "gemini-pro",
  options: [{ id: "effort", value: "high" }],
};
const primarySend = () =>
  renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;

it.each([
  { method: "click", routeKind: "draft" },
  { method: "keyboard", routeKind: "draft" },
  { method: "click", routeKind: "server" },
  { method: "keyboard", routeKind: "server" },
] as const)(
  "Auto can submit $method in $routeKind with signed-out saved Manual Antigravity and ready Codex",
  async ({ method, routeKind }) => {
    const props = {
      ...propsFor(),
      routeKind,
      isLocalDraftThread: routeKind === "draft",
      isServerThread: routeKind === "server",
    };
    const onSend = vi.fn();
    const store = useComposerDraftStore.getState();
    store.setModelSelection(props.composerDraftTarget, manualSelection, { explicit: true });
    store.setPrompt(props.composerDraftTarget, "Explain this code");
    await act(async () => {
      renderer = create(
        <ChatComposer {...props} providerStatuses={[signedOut, provider]} onSend={onSend} />,
      );
    });
    if (routeKind === "draft") {
      const input = (key: string) =>
        renderer.root.findAllByType("input").find((node) => node.props[key] !== undefined)!;
      await act(async () =>
        input("data-task-contract-toggle").props.onChange({ target: { checked: true } }),
      );
      for (const [key, value] of [
        ["goal", "Explain this code"],
        ["redirect", "Keep fixture scope"],
        ["acceptance", "Owner checks the fake result"],
        ["max-starts", "3"],
        ["stop", "Scope changed"],
      ]) {
        await act(async () =>
          input(`data-task-contract-${key}`).props.onChange({ target: { value } }),
        );
      }
      expect(handle.current!.getSendContext().taskContractError).toBeNull();
      expect(handle.current!.getSendContext().taskContract?.brake.maxProviderStarts).toBe(3);
    }
    expect(primarySend().props.disabled).toBe(true);
    expect(handle.current!.getSendContext().selectedModelSelection).toEqual(manualSelection);
    await act(async () => toggle().props.onClick());
    expect(primarySend().props.disabled).toBe(false);
    expect(handle.current!.getSendContext().providerAvailable).toBe(true);
    await act(async () => {
      if (method === "click")
        primarySend().props.onClick({ preventDefault: noop, metaKey: false, ctrlKey: false });
      else pressEnter();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(handle.current!.getSendContext().routingMode).toBe("auto");
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(
        <ChatComposer {...props} providerStatuses={[signedOut, provider]} onSend={onSend} />,
      );
    });
    expect(primarySend().props.disabled).toBe(false);
    expect(handle.current!.getSendContext().routingMode).toBe("auto");
    await act(async () =>
      renderer.update(
        <ChatComposer {...propsFor("env-a", "other")} providerStatuses={[signedOut, provider]} />,
      ),
    );
    expect(handle.current!.getSendContext().routingMode).toBe("manual");
    await act(async () =>
      renderer.update(
        <ChatComposer {...propsFor("env-b", "a")} providerStatuses={[signedOut, provider]} />,
      ),
    );
    expect(handle.current!.getSendContext().routingMode).toBe("manual");
    await act(async () =>
      renderer.update(
        <ChatComposer {...props} providerStatuses={[signedOut, provider]} onSend={onSend} />,
      ),
    );
    expect(handle.current!.getSendContext().routingMode).toBe("auto");
    expect(handle.current!.getSendContext().selectedModelSelection).toEqual(manualSelection);
    await act(async () => toggle().props.onClick());
    expect(primarySend().props.disabled).toBe(true);
    expect(handle.current!.getSendContext().selectedModelSelection).toEqual(manualSelection);
  },
);

function pressEnter() {
  renderer.root.findByType("textarea").props.onKeyDown({
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: noop,
  });
}
const unusableManualCases: ReadonlyArray<{ name: string; snapshot: ServerProvider }> = [
  { name: "uninstalled", snapshot: { ...signedOut, installed: false } },
  {
    name: "unloaded models",
    snapshot: { ...signedOut, status: "ready", auth: { status: "authenticated" }, models: [] },
  },
  {
    name: "unavailable saved model",
    snapshot: {
      ...signedOut,
      status: "ready",
      auth: { status: "authenticated" },
      models: provider.models,
    },
  },
];
it.each(unusableManualCases)(
  "Auto allows an alternative with $name while Manual stays blocked",
  async ({ snapshot }) => {
    const props = propsFor();
    const store = useComposerDraftStore.getState();
    store.setModelSelection(props.composerDraftTarget, manualSelection, { explicit: true });
    store.setPrompt(props.composerDraftTarget, "Explain this code");
    const onSend = vi.fn();
    await act(async () => {
      renderer = create(
        <ChatComposer {...props} providerStatuses={[snapshot, provider]} onSend={onSend} />,
      );
    });
    expect(primarySend().props.disabled).toBe(true);
    await act(async () => pressEnter());
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => toggle().props.onClick());
    expect(primarySend().props.disabled).toBe(false);
    expect(handle.current!.getSendContext().providerAvailable).toBe(true);
    await act(async () => pressEnter());
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => toggle().props.onClick());
    expect(primarySend().props.disabled).toBe(true);
    expect(
      store.getComposerDraft(props.composerDraftTarget)?.modelSelectionByProvider[
        signedOut.instanceId
      ],
    ).toEqual(manualSelection);
  },
);
const blockedAutoCases: ReadonlyArray<{
  name: string;
  changes: Partial<ChatComposerProps>;
  attachment?: boolean;
}> = [
  { name: "no eligible provider", changes: { providerStatuses: [signedOut] } },
  {
    name: "uninstalled alternative",
    changes: { providerStatuses: [signedOut, { ...provider, installed: false }] },
  },
  { name: "unloaded catalog", changes: { providerCatalogKnown: false } },
  { name: "connecting", changes: { isConnecting: true } },
  {
    name: "disconnected",
    changes: {
      environmentUnavailable: {
        label: "Disconnected",
        connection: { phase: "offline", error: null, traceId: null },
      },
    },
  },
  {
    name: "locked continuation",
    changes: { lockedProvider: signedOut.driver, activeThreadModelSelection: manualSelection },
  },
  { name: "queued edit", changes: { editingQueuedAttachments: [] } },
  { name: "plan mode", changes: { interactionMode: "plan" } },
  { name: "plan follow up", changes: { showPlanFollowUpPrompt: true } },
  { name: "failed attachment", changes: { supportsAttachmentUploads: true }, attachment: true },
];
it.each(blockedAutoCases)("Auto fails safely for $name", async ({ changes, attachment }) => {
  const props = { ...propsFor(), providerStatuses: [signedOut, provider], ...changes };
  const store = useComposerDraftStore.getState();
  store.setModelSelection(props.composerDraftTarget, manualSelection, { explicit: true });
  store.setPrompt(props.composerDraftTarget, "Explain this code");
  store.setRoutingMode(props.composerDraftTarget, "auto");
  if (attachment) {
    uploadFixture.uploads.failed = {
      status: "failed",
      environmentId: props.environmentId,
      reason: "Fixture upload rejected",
    };
    store.addFiles(props.composerDraftTarget, [
      {
        type: "file",
        id: "failed",
        name: "fixture.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: null,
        uploadedAttachmentId: "prior-upload",
        uploadEnvironmentId: props.environmentId,
      },
    ]);
  }
  const onSend = vi.fn();
  await act(async () => {
    renderer = create(<ChatComposer {...props} onSend={onSend} />);
  });
  if (!props.showPlanFollowUpPrompt) expect(primarySend().props.disabled).toBe(true);
  await act(async () => pressEnter());
  expect(onSend).not.toHaveBeenCalled();
  expect(
    store.getComposerDraft(props.composerDraftTarget)?.modelSelectionByProvider[
      signedOut.instanceId
    ],
  ).toEqual(manualSelection);
});
it("excludes ready OpenRouter from local Auto and closes readiness when the eligible catalog changes", async () => {
  const props = propsFor();
  const store = useComposerDraftStore.getState();
  store.setModelSelection(props.composerDraftTarget, manualSelection, { explicit: true });
  store.setPrompt(props.composerDraftTarget, "Explain this code");
  store.setRoutingMode(props.composerDraftTarget, "auto");
  const onSend = vi.fn();
  const remote: ServerProvider = {
    ...provider,
    driver: "openrouter" as ServerProvider["driver"],
    instanceId: ProviderInstanceId.make("openrouter"),
  };
  const settings = {
    ...props.settings,
    providerInstances: {
      ...props.settings.providerInstances,
      [remote.instanceId]: { driver: remote.driver, enabled: true },
    },
  };
  await act(async () => {
    renderer = create(
      <ChatComposer
        {...props}
        settings={settings}
        providerStatuses={[signedOut, provider, remote]}
        onSend={onSend}
      />,
    );
  });
  expect(primarySend().props.disabled).toBe(false);
  await act(async () =>
    renderer.update(
      <ChatComposer
        {...props}
        settings={settings}
        providerStatuses={[signedOut, remote]}
        onSend={onSend}
      />,
    ),
  );
  expect(primarySend().props.disabled).toBe(true);
  expect(handle.current!.getSendContext().providerAvailable).toBe(false);
  await act(async () => pressEnter());
  expect(onSend).not.toHaveBeenCalled();
  await act(async () =>
    renderer.update(
      <ChatComposer
        {...props}
        settings={settings}
        providerStatuses={[signedOut, provider, remote]}
        onSend={onSend}
      />,
    ),
  );
  expect(primarySend().props.disabled).toBe(false);
  await act(async () => pressEnter());
  expect(onSend).toHaveBeenCalledTimes(1);
});

effectIt.effect.each([false, true])(
  "Compact retains original provider readiness with healthy selected model=%s while Auto Send works",
  (healthy) =>
    Effect.gen(function* () {
      const baseProps = propsFor();
      const props = {
        ...baseProps,
        activeThread: makeThreadFixture({
          id: baseProps.activeThreadId!,
          environmentId: baseProps.environmentId,
          modelSelection: manualSelection,
          runtimeMode: "approval-required",
          runtime: null,
        }),
        activeThreadModelSelection: manualSelection,
      };
      const store = useComposerDraftStore.getState();
      store.setModelSelection(props.composerDraftTarget, manualSelection, { explicit: true });
      store.setPrompt(props.composerDraftTarget, "Explain this code");
      store.setRoutingMode(props.composerDraftTarget, "auto");
      const selected: ServerProvider = {
        ...signedOut,
        status: "ready",
        auth: { status: "authenticated" },
        continuation: { groupKey: "google-fixture" },
        slashCommands: [{ name: "compact", description: "Compact context" }],
        models: healthy ? signedOut.models : provider.models,
      };
      const commands: OrchestrationV2Command[] = [];
      const session = yield* SubscriptionRef.make(
        Option.some({
          client: {
            [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
          },
          initialConfig: Effect.succeed({
            environment: { capabilities: { serverResolvedCommandContext: true } },
          }),
        } as never),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: { environmentId: props.environmentId, label: "Fake only" },
        session,
      } as never);
      let compactRequest: Effect.Effect<unknown, never, Crypto.Crypto> | undefined;
      let turnRequest: Effect.Effect<unknown, never, Crypto.Crypto> | undefined;
      const start = (text: string, id: string) => {
        const context = readComposerSendContextForTarget(
          props.composerDraftTarget,
          props.environmentId,
          handle.current,
        )!;
        return startThreadTurn({
          commandId: CommandId.make(id),
          threadId: props.activeThreadId!,
          message: { messageId: MessageId.make(id), role: "user", text, attachments: [] },
          modelSelection: context.selectedModelSelection,
          runtimeMode: "approval-required",
          interactionMode: context.interactionMode,
          routingMode: context.routingMode,
        });
      };
      // Exercise the settings and /compact client requests used by ChatView's consumer.
      // The shared compactContext entry point must stop before this consumer is entered.
      const onCompactContext = vi.fn(() => {
        const context = readComposerSendContextForTarget(
          props.composerDraftTarget,
          props.environmentId,
          handle.current,
        );
        if (!context?.providerAvailable) return;
        compactRequest = setThreadRuntimeMode({
          commandId: CommandId.make("compact-settings"),
          threadId: props.activeThreadId!,
          runtimeMode: "approval-required",
        }).pipe(
          Effect.andThen(start("/compact", "compact-turn")),
          Effect.orDie,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
      });
      const onSend = () => {
        turnRequest = start("Explain this code", "ordinary-turn").pipe(
          Effect.orDie,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
      };
      yield* Effect.promise(() =>
        act(async () => {
          renderer = create(
            <ChatComposer
              {...props}
              providerStatuses={[selected, provider]}
              compactDisabled={false}
              onCompactContext={onCompactContext}
              onSend={onSend}
            />,
          );
        }),
      );
      expect(primarySend().props.disabled).toBe(false);
      yield* Effect.promise(() => act(async () => handle.current!.compactContext()));
      if (compactRequest) yield* compactRequest;
      expect(onCompactContext).toHaveBeenCalledTimes(healthy ? 1 : 0);
      expect(commands.map((command) => command.type)).toEqual(
        healthy ? ["thread.runtime-mode.set", "message.dispatch"] : [],
      );
      expect(
        commands
          .filter((command) => command.type === "message.dispatch")
          .map((command) => command.text),
      ).toEqual(healthy ? ["/compact"] : []);
      yield* Effect.promise(() => act(async () => pressEnter()));
      expect(turnRequest).toBeDefined();
      if (turnRequest) yield* turnRequest;
      expect(
        commands.filter(
          (command) => command.type === "message.dispatch" && command.text === "Explain this code",
        ),
      ).toHaveLength(1);
      expect(
        store.getComposerDraft(props.composerDraftTarget)?.modelSelectionByProvider[
          signedOut.instanceId
        ],
      ).toEqual(manualSelection);
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
