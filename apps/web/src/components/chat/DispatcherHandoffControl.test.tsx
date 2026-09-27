import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TaskHandoffId,
  ThreadId,
  TurnId,
  type DispatcherHandoffPreview,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  preview: vi.fn(),
  routePreview: vi.fn(),
  start: vi.fn(),
  previewCommand: Symbol("preview"),
  routePreviewCommand: Symbol("route-preview"),
  startCommand: Symbol("start"),
}));

vi.mock("~/state/dispatcher", () => ({
  dispatcherEnvironment: {
    previewHandoff: state.previewCommand,
    previewRoute: state.routePreviewCommand,
  },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { startTurn: state.startCommand },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === state.previewCommand
      ? state.preview
      : command === state.routePreviewCommand
        ? state.routePreview
        : state.start,
}));

import { DispatcherHandoffControl, DispatcherRoutePreview } from "./DispatcherRouteStatus";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.preview.mockReset();
  state.routePreview.mockReset();
  state.start.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

const sourceInstanceId = ProviderInstanceId.make("codex-work");
const targetInstanceId = ProviderInstanceId.make("claude-work");
const environmentId = EnvironmentId.make("environment-1");
const sourceTurnId = TurnId.make("turn-1");
const target = { instanceId: targetInstanceId, model: "claude-sonnet" };

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: sourceInstanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Work",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-26T00:00:00Z",
    models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: targetInstanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Work",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-26T00:00:00Z",
    models: [{ slug: "claude-sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: ProviderInstanceId.make("cursor-work"),
    driver: ProviderDriverKind.make("cursor"),
    displayName: "Cursor Work",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-26T00:00:00Z",
    models: [{ slug: "cursor-auto", name: "Auto", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

const thread = (overrides: Partial<OrchestrationThread> = {}) => ({
  id: ThreadId.make("thread-1"),
  latestTurn: {
    turnId: sourceTurnId,
    state: "completed" as const,
    requestedAt: "2026-09-26T00:00:00Z",
    startedAt: "2026-09-26T00:00:01Z",
    completedAt: "2026-09-26T00:01:00Z",
    assistantMessageId: MessageId.make("assistant-1"),
  },
  latestRoute: {
    messageId: MessageId.make("message-1"),
    binding: {
      policyVersion: "dispatcher.phase-1a.v1" as const,
      target: { instanceId: sourceInstanceId, model: "gpt-5" },
      driver: ProviderDriverKind.make("codex"),
      modelFamily: "openai",
      fallbackIndex: 0,
      source: "explicit" as const,
      gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED" as const] },
    },
  },
  latestHandoff: null,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...overrides,
});

const preview: DispatcherHandoffPreview = {
  handoffId: TaskHandoffId.make("handoff-1"),
  packet: {
    originalObjective: "Build it",
    latestUserInstruction: "Continue it",
    branch: "feature",
    commit: "abc123",
    completedWork: "Unknown",
    remainingSteps: "Unknown",
    testResults: "Unknown",
    references: [],
  },
  packetText: "# Task handoff\n\nReviewed context",
  route: null,
  availability: { status: "ready" },
};

const text = () => JSON.stringify(renderer?.toJSON());
const buttons = () => renderer!.root.findAllByType("button");

describe("dispatcher handoff UI", () => {
  it("labels preview as unbound, lets the user edit it, and submits the reviewed packet once", async () => {
    state.preview.mockResolvedValue({ _tag: "Success", value: preview });
    state.start.mockResolvedValue({ _tag: "Success", value: {} });
    await act(async () => {
      renderer = create(
        <DispatcherHandoffControl
          environmentId={environmentId}
          providers={providers}
          thread={thread()}
        />,
      );
    });
    await act(async () => buttons()[0]!.props.onClick());
    await act(async () => undefined);

    expect(text()).toContain("Preview only");
    expect(text()).toContain("not bound until you continue");
    const textarea = renderer!.root.findByType("textarea");
    await act(async () =>
      textarea.props.onChange({
        target: { value: "Reviewed by the user" },
        currentTarget: { value: "Reviewed by the user" },
      }),
    );
    const continueButton = buttons().find((button) =>
      JSON.stringify(button.props.children).includes("Continue and bind route"),
    );
    await act(async () => {
      continueButton!.props.onClick();
      continueButton!.props.onClick();
    });

    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start.mock.calls[0]![0].input).toMatchObject({
      threadId: "thread-1",
      message: { text: "Reviewed by the user", attachments: [] },
      modelSelection: target,
      handoffRequest: {
        handoffId: "handoff-1",
        sourceTurnId: "turn-1",
        target,
        packetText: "Reviewed by the user",
      },
    });
  });

  it("renders persisted continued state as authoritative without rendering packet contents", async () => {
    await act(async () => {
      renderer = create(
        <DispatcherHandoffControl
          environmentId={environmentId}
          providers={providers}
          thread={thread({
            latestHandoff: {
              handoffId: TaskHandoffId.make("handoff-1"),
              sourceTurnId,
              destinationMessageId: MessageId.make("message-2"),
              destinationTurnId: TurnId.make("turn-2"),
              target,
              status: "continued",
              failureReason: null,
              createdAt: "2026-09-26T00:02:00Z",
              updatedAt: "2026-09-26T00:02:01Z",
            },
          })}
        />,
      );
    });

    expect(text()).toContain("Continued with another provider");
    expect(text()).toContain("Claude Work");
    expect(text()).not.toContain("Reviewed context");
  });

  it("keeps the newest preview when destination requests overlap", async () => {
    let resolveFirst!: (value: { _tag: "Success"; value: DispatcherHandoffPreview }) => void;
    let resolveSecond!: (value: { _tag: "Success"; value: DispatcherHandoffPreview }) => void;
    state.preview
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    await act(async () => {
      renderer = create(
        <DispatcherHandoffControl
          environmentId={environmentId}
          providers={providers}
          thread={thread()}
        />,
      );
    });
    await act(async () => buttons()[0]!.props.onClick());
    await act(async () => undefined);

    await act(async () =>
      renderer!.root.findByType("select").props.onChange({
        target: { value: "cursor-work\u0000cursor-auto" },
      }),
    );
    await act(async () =>
      resolveSecond({
        _tag: "Success",
        value: { ...preview, packetText: "Newest cursor context" },
      }),
    );
    await act(async () =>
      resolveFirst({
        _tag: "Success",
        value: { ...preview, packetText: "Stale claude context" },
      }),
    );

    expect(renderer!.root.findByType("textarea").props.value).toBe("Newest cursor context");
  });

  it("does not offer handoff when the server capability is unsupported", async () => {
    await act(async () => {
      renderer = create(
        <DispatcherRoutePreview
          available
          environmentId={environmentId}
          project={{ id: ProjectId.make("project-1"), title: "Project" }}
          preferredRoute={{ instanceId: sourceInstanceId, model: "gpt-5" }}
          providers={providers}
          boundRoute={thread().latestRoute}
          handoffAvailable={false}
          thread={thread()}
        />,
      );
    });

    expect(text()).toContain("Bound route");
    expect(text()).not.toContain("Continue with another provider");
    expect(state.preview).not.toHaveBeenCalled();
  });
});
