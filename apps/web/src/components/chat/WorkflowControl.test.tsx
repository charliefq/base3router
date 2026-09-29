import {
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type CursorCloudRunnerBinding,
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
  followUp: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
  catalogCommand: Symbol("catalog"),
  actionCommand: Symbol("action"),
  previewCommand: Symbol("preview"),
  dispatchCommand: Symbol("dispatch"),
  proposeCommand: Symbol("propose"),
  followUpCommand: Symbol("followUp"),
  cancelCommand: Symbol("cancel"),
  refreshCommand: Symbol("refresh"),
}));
vi.mock("~/state/workflow", () => ({
  workflowEnvironment: {
    catalog: mock.catalogCommand,
    action: mock.actionCommand,
    previewStage: mock.previewCommand,
    dispatchStage: mock.dispatchCommand,
    proposeArtifact: mock.proposeCommand,
    cursorCloudFollowUp: mock.followUpCommand,
    cursorCloudCancel: mock.cancelCommand,
    cursorCloudRefresh: mock.refreshCommand,
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
            : command === mock.followUpCommand
              ? mock.followUp
              : command === mock.cancelCommand
                ? mock.cancel
                : command === mock.refreshCommand
                  ? mock.refresh
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
  for (const handler of [
    mock.catalog,
    mock.action,
    mock.preview,
    mock.dispatch,
    mock.propose,
    mock.followUp,
    mock.cancel,
    mock.refresh,
  ])
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

const mount = async (available = true, cursorCloudAvailable = false) => {
  await act(async () => {
    renderer = create(
      <WorkflowControl
        available={available}
        cursorCloudAvailable={cursorCloudAvailable}
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

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const cursorTarget = {
  mode: "repository" as const,
  repositoryUrl: "https://github.com/charliefq/base3router",
  startingRef: sha,
};
const cursorPreview = (
  packetText: string,
  gate: WorkflowStagePreview["route"]["gate"] = preview("x").route.gate,
): WorkflowStagePreview => ({
  ...preview(packetText),
  cursorCloud: {
    available: true,
    configured: true,
    target: cursorTarget,
    payload:
      gate.decision === "ALLOW"
        ? {
            runnerKind: "cursor-cloud",
            provider: ProviderDriverKind.make("cursor"),
            model: "composer-2",
            target: cursorTarget,
            workOnCurrentBranch: false,
            autoCreatePR: false,
            credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
          }
        : null,
    gate,
  },
});
const cursorBinding = (status: CursorCloudRunnerBinding["status"]): CursorCloudRunnerBinding => ({
  provider: ProviderDriverKind.make("cursor"),
  model: "composer-2",
  runnerKind: "cursor-cloud",
  target: cursorTarget,
  cursorAgentId: "bc-agent",
  cursorRunId: "run-cloud-1",
  cursorAgentUrl: "https://cursor.com/agents/bc-agent",
  cursorAgentStatus: status === "running" ? "ACTIVE" : "IDLE",
  cursorRunStatus: status === "running" ? "RUNNING" : "FINISHED",
  status,
  sanitizedResult: status === "finished" ? "Done" : undefined,
  sanitizedError: status === "error" ? "The Cursor agent is busy with another run." : undefined,
  createdAt: at,
  updatedAt: at,
  credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
});
const boundCatalog = (binding: CursorCloudRunnerBinding): WorkflowCatalog => ({
  ...catalog,
  runs: [
    {
      ...catalog.runs[0]!,
      attempts: [
        {
          ...catalog.runs[0]!.attempts[0]!,
          status: "dispatched",
          destinationThreadId:
            "thread-1" as WorkflowCatalog["runs"][number]["attempts"][number]["destinationThreadId"],
          runnerBinding: binding,
        },
      ],
    },
  ],
});

it("hides Cursor Cloud when the server capability is off", async () => {
  mock.preview.mockResolvedValue(success(preview("LOCAL PACKET")));
  await mount(true, false);
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  expect(text()).not.toContain("Cursor Cloud");
  expect(text()).toContain("Provisional route");
  expect(text()).not.toMatch(/Bearer |crsr_|sk-|CURSOR_API_KEY=/);
});

it("previews Cursor Cloud as a distinct runner with an exact starting SHA", async () => {
  mock.preview.mockImplementation(
    ({ input }: { input: { cursorCloudTarget?: typeof cursorTarget } }) =>
      Promise.resolve(
        success(input.cursorCloudTarget ? cursorPreview("CURSOR PACKET") : preview("LOCAL PACKET")),
      ),
  );
  await mount(true, true);
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  await act(async () =>
    select("Execution runner").props.onChange({ target: { value: "cursor-cloud" } }),
  );
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "GitHub repository URL" }).props.onChange({
      target: { value: cursorTarget.repositoryUrl },
    });
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Exact starting commit SHA" }).props.onChange({
      target: { value: sha },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  expect(text()).toContain("Cursor Cloud");
  expect(text()).toContain(sha);
  expect(text()).toContain("workOnCurrentBranch");
  expect(text()).toContain("autoCreatePR");
  expect(text()).toContain("ActionGate approved");
  expect(text()).not.toMatch(/Bearer |crsr_|sk-|CURSOR_API_KEY=/);
  expect(mock.preview).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ cursorCloudTarget: cursorTarget }),
    }),
  );
});

it("requires ActionGate approval and a valid target before Cursor Cloud dispatch", async () => {
  mock.preview.mockResolvedValue(
    success(cursorPreview("DENIED", { decision: "DENY", reasonCodes: ["PROVIDER_UNAVAILABLE"] })),
  );
  await mount(true, true);
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () =>
    select("Execution runner").props.onChange({ target: { value: "cursor-cloud" } }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  expect(text()).toContain("ActionGate denied");
  expect(button("Confirm and start task").props.disabled).toBe(true);
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it("dispatches the immutable Cursor Cloud payload after approval", async () => {
  mock.preview.mockResolvedValue(success(cursorPreview("CURSOR PACKET")));
  mock.dispatch.mockResolvedValue(
    success({ run: catalog.runs[0]!, threadId: "thread-1", messageId: "message-1" }),
  );
  await mount(true, true);
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  await act(async () =>
    select("Execution runner").props.onChange({ target: { value: "cursor-cloud" } }),
  );
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "GitHub repository URL" }).props.onChange({
      target: { value: cursorTarget.repositoryUrl },
    });
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Exact starting commit SHA" }).props.onChange({
      target: { value: sha },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(181);
  });
  await act(async () => button("Confirm and start task").props.onClick());
  expect(mock.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        runnerKind: "cursor-cloud",
        cursorCloudTarget: cursorTarget,
      }),
    }),
  );
});

it("renders agent and run identity and disables follow-up while busy", async () => {
  mock.catalog.mockResolvedValue(success(boundCatalog(cursorBinding("running"))));
  await mount(true, true);
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  expect(text()).toContain("bc-agent");
  expect(text()).toContain("run-cloud-1");
  expect(text()).toContain("Follow-up is disabled while the Cursor run is active.");
  expect(button("Send follow-up").props.disabled).toBe(true);
  expect(text()).not.toMatch(/Bearer |crsr_|sk-|CURSOR_API_KEY=/);
});

it("requires ActionGate-backed cancellation and shows sanitized busy errors", async () => {
  mock.catalog.mockResolvedValue(success(boundCatalog(cursorBinding("finished"))));
  mock.cancel.mockResolvedValue(
    success({
      run: boundCatalog(cursorBinding("cancelled")).runs[0]!,
      runnerBinding: cursorBinding("cancelled"),
    }),
  );
  mock.followUp.mockResolvedValue({
    _tag: "Failure",
    cause: new Error("The Cursor agent is busy with another run."),
  });
  await mount(true, true);
  await open();
  await act(async () => select("Workflow run").props.onChange({ target: { value: "run-one" } }));
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Cursor Cloud follow-up" }).props.onChange({
      target: { value: "Continue the review." },
    }),
  );
  await act(async () => button("Send follow-up").props.onClick());
  expect(text()).toContain("The Cursor agent is busy with another run.");
  expect(text()).not.toMatch(/Bearer |crsr_|sk-|CURSOR_API_KEY=/);
  await act(async () => button("Cancel Cursor run").props.onClick());
  expect(mock.cancel).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        runId: "run-one",
        stageId: "research",
        attempt: 1,
      }),
    }),
  );
});
