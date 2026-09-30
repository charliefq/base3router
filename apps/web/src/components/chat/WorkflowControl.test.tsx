import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type WorkflowCatalog,
  type WorkflowStagePreview,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({
  catalog: vi.fn(),
  action: vi.fn(),
  preview: vi.fn(),
  dispatch: vi.fn(),
  propose: vi.fn(),
  catalogCommand: Symbol("catalog"),
  actionCommand: Symbol("action"),
  previewCommand: Symbol("preview"),
  dispatchCommand: Symbol("dispatch"),
  proposeCommand: Symbol("propose"),
}));
vi.mock("~/state/workflow", () => ({
  workflowEnvironment: {
    catalog: mock.catalogCommand,
    action: mock.actionCommand,
    previewStage: mock.previewCommand,
    dispatchStage: mock.dispatchCommand,
    proposeArtifact: mock.proposeCommand,
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === mock.catalogCommand
      ? mock.catalog
      : command === mock.actionCommand
        ? mock.action
        : command === mock.previewCommand
          ? mock.preview
          : command === mock.dispatchCommand
            ? mock.dispatch
            : mock.propose,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

import { WorkflowControl } from "./WorkflowControl";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const at = "2026-09-28T00:00:00.000Z";
const profile: WorkflowCatalog["profiles"][number] = {
  id: "researcher",
  version: 1,
  projectId: null,
  origin: "built-in",
  status: "active",
  displayName: "Researcher",
  description: "Research",
  purpose: "Research a bounded question",
  responsibilities: [],
  exclusions: [],
  instructions: "Report what is known.",
  requiredOutputSections: ["Findings"],
  artifactKind: "report",
  capabilityPreferences: [],
  createdAt: at,
  updatedAt: at,
};
const stage: WorkflowCatalog["templates"][number]["stages"][number] = {
  id: "research",
  label: "Research",
  type: "agent",
  profileId: "researcher",
  profileVersion: 1,
  artifactKind: "report",
  requiredOutputSections: ["Findings"],
  approvalRequired: true,
  nextStageId: null,
  capabilityPreferences: [],
  taskPromptTemplate: "Research this.",
  maxAttempts: 3,
};
const template: WorkflowCatalog["templates"][number] = {
  id: "research-flow",
  version: 1,
  projectId: null,
  origin: "built-in",
  status: "active",
  displayName: "Research flow",
  description: "Research then review",
  stages: [stage],
  createdAt: at,
  updatedAt: at,
};
const run = (id: string): WorkflowCatalog["runs"][number] => ({
  id,
  projectId,
  templateId: template.id,
  templateVersion: 1,
  status: "active",
  currentStageId: stage.id,
  originatingThreadId: null,
  originatingMessageId: null,
  attempts: [
    {
      stageId: stage.id,
      attempt: 1,
      profileId: profile.id,
      profileVersion: 1,
      sourceThreadId: null,
      sourceMessageId: null,
      sourceTurnId: null,
      destinationThreadId: null,
      destinationMessageId: null,
      destinationTurnId: null,
      routeBinding: null,
      status: "pending",
      createdAt: at,
    },
  ],
  artifacts: [],
  decisions: [],
  createdAt: at,
  updatedAt: at,
  endedAt: null,
  pausedAt: null,
});
const catalog: WorkflowCatalog = {
  profiles: [profile],
  templates: [template],
  runs: [run("run-one"), run("run-two")],
};
const candidate = {
  fallbackIndex: 0,
  target: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  source: "explicit" as const,
  eligible: true,
  reasonCodes: [],
};
const preview = (packetText: string): WorkflowStagePreview => ({
  stage,
  profile,
  attempt: 1,
  packetText,
  route: {
    policyVersion: "dispatcher.phase-1a.v1",
    environmentId,
    actionKind: "workspace-write",
    projectResolution: { status: "resolved", source: "project-id", projectId, reasonCodes: [] },
    context: {
      threadId: null,
      messageId: null,
      hasPersistedMessage: false,
      attachmentCount: 0,
      composerContextKinds: [],
    },
    candidates: [candidate],
    selected: candidate,
    gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
  },
});
const success = <T,>(value: T) => ({ _tag: "Success" as const, value });
let renderer: ReactTestRenderer | null = null;
const text = () => JSON.stringify(renderer?.toJSON());
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((entry) => entry.props.children === label)!;
const select = (label: string) => renderer!.root.findByProps({ "aria-label": label });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  for (const handler of [mock.catalog, mock.action, mock.preview, mock.dispatch, mock.propose])
    handler.mockReset();
  mock.catalog.mockResolvedValue(success(catalog));
  mock.action.mockResolvedValue(success(catalog));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = async (available = true) => {
  await act(async () => {
    renderer = create(
      <WorkflowControl
        available={available}
        environmentId={environmentId}
        project={{ id: projectId, title: "Project" }}
        onOpenThread={vi.fn()}
      />,
    );
  });
};
const open = async () => {
  await act(async () => button("Workflow").props.onClick());
};

it("keeps legacy composition unchanged when workflow capability is unsupported", async () => {
  await mount(false);
  expect(renderer?.toJSON()).toBeNull();
  expect(mock.catalog).not.toHaveBeenCalled();
});

it("loads the server profile library and template selection on explicit open", async () => {
  await mount();
  await open();
  expect(mock.catalog).toHaveBeenCalledOnce();
  expect(text()).toContain("Research flow");
  await act(async () => button("Agent profiles").props.onClick());
  expect(text()).toContain("Researcher");
  await act(async () => button("Templates").props.onClick());
  expect(text()).toContain("Research flow");
});

it("keeps the latest stage preview when overlapping requests finish out of order", async () => {
  let resolveOld: ((value: ReturnType<typeof success<WorkflowStagePreview>>) => void) | undefined;
  let resolveNew: ((value: ReturnType<typeof success<WorkflowStagePreview>>) => void) | undefined;
  mock.preview.mockImplementation(
    ({ input }: { input: { runId: string } }) =>
      new Promise((resolve) => {
        if (input.runId === "run-one") resolveOld = resolve;
        else resolveNew = resolve;
      }),
  );
  await mount();
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-two" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  await act(async () => resolveNew?.(success(preview("PACKET TWO"))));
  await act(async () => resolveOld?.(success(preview("PACKET ONE"))));
  expect(text()).toContain("PACKET TWO");
  expect(text()).not.toContain("PACKET ONE");
  expect(text()).toContain("Provisional route");
});

it("prevents a double click from dispatching a second provider task", async () => {
  mock.preview.mockResolvedValue(success(preview("REVIEWABLE PACKET")));
  let resolveDispatch:
    | ((
        value: ReturnType<
          typeof success<{
            run: WorkflowCatalog["runs"][number];
            threadId: string;
            messageId: string;
          }>
        >,
      ) => void)
    | undefined;
  mock.dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveDispatch = resolve;
      }),
  );
  await mount();
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  await act(async () => {
    button("Confirm and start task").props.onClick();
    button("Confirm and start task").props.onClick();
  });
  expect(mock.dispatch).toHaveBeenCalledOnce();
  await act(async () =>
    resolveDispatch?.(
      success({ run: catalog.runs[0]!, threadId: "thread-1", messageId: "message-1" }),
    ),
  );
});
