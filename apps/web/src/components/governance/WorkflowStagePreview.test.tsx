import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type WorkflowCatalog,
  type WorkflowStagePreview,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  options: vi.fn(),
  query: vi.fn(),
  action: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (_family: unknown, options: unknown) => {
    mocks.options(options);
    return mocks.read;
  },
}));
vi.mock("../../state/workflow", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const preview = Atom.make(null);
  return {
    workflowEnvironment: {
      stagePreview: () => preview,
      catalog: (value: unknown) => value,
      action: "action",
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.action }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => mocks.query() }));
vi.mock("../../state/governance", () => ({ governanceEnvironment: {} }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ useUpdateEnvironmentSettings: () => vi.fn() }));
vi.mock("../chat/TaskContractPanel", () => ({ TaskContractReadout: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { ProjectWorkflowDecisions } from "./GovernanceSurfaces";

import {
  environmentId,
  projectId,
  profile,
  template,
  run,
} from "./WorkflowStagePreview.test-fixtures";
let props: Parameters<typeof ProjectWorkflowDecisions>[0];
let catalog: WorkflowCatalog;
let revision: number;
let isPending: boolean;
let renderer: ReactTestRenderer;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const preview = (): WorkflowStagePreview => {
  const run = catalog.runs[0]!;
  const stage = catalog.templates[0]!.stages.find((item) => item.id === run.currentStageId)!;
  const candidate = {
    fallbackIndex: 0,
    target: {
      instanceId: ProviderInstanceId.make("configured-provider"),
      model: "configured-model",
    },
    driver: ProviderDriverKind.make("codex"),
    modelFamily: "unknown",
    source: "environment-default" as const,
    eligible: true,
    reasonCodes: [],
  };
  return {
    stage,
    profile,
    attempt: run.attempts.findLast((item) => item.stageId === stage.id)!.attempt,
    packetText: "Fake task",
    route: {
      policyVersion: "dispatcher.phase-1a.v1",
      environmentId: props.environmentId,
      actionKind: "workspace-write",
      projectResolution: {
        status: "resolved",
        source: "project-id",
        projectId: props.projectId,
        reasonCodes: [],
      },
      context: {
        threadId: null,
        messageId: null,
        hasPersistedMessage: false,
        attachmentCount: 0,
        composerContextKinds: [],
      },
      candidates: [candidate],
      selected: candidate,
      gate: { decision: "ALLOW", reasonCodes: [] },
    },
  };
};
const button = (name = "Preview stage") =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === name)!;
const text = () => JSON.stringify(renderer.toJSON());
const update = async () => {
  await act(async () => renderer.update(<ProjectWorkflowDecisions {...props} />));
};
const click = async (name = "Preview stage") => {
  await act(async () => button(name).props.onClick());
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  props = { environmentId, projectId, projectTitle: "Project A", refreshTick: 0 };
  catalog = { profiles: [profile], templates: [template], runs: [run] };
  revision = 1;
  isPending = false;
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  mocks.read.mockReset().mockImplementation(async (target) => ({
    _tag: "Success",
    value: {
      ...preview(),
      ...(target.input.taskContract
        ? {
            review: {
              digest: "fixture-review",
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              taskContract: target.input.taskContract,
            },
          }
        : {}),
    },
  }));
  mocks.action.mockReset();
  mocks.options.mockClear();
  mocks.refresh.mockClear();
  mocks.query.mockImplementation(() => ({
    data: catalog,
    dataUpdatedAt: revision,
    isPending,
    isSuccess: true,
    error: null,
    refresh: mocks.refresh,
  }));
  await act(async () => {
    renderer = create(<ProjectWorkflowDecisions {...props} />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("reads only on demand, deduplicates same-render clicks and shows the actual route without dispatch", async () => {
  const response = deferred<{ _tag: string; value: WorkflowStagePreview }>();
  mocks.read.mockReturnValueOnce(response.promise);
  expect(mocks.read).not.toHaveBeenCalled();
  await act(async () => {
    const onClick = button().props.onClick;
    onClick();
    onClick();
  });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(button("Loading preview…").props.disabled).toBe(true);
  await act(async () => response.resolve({ _tag: "Success", value: preview() }));
  expect(text()).toContain("configured-provider");
  expect(text()).toContain("configured-model");
  expect(text()).toContain("Preview and review start no work");
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.options).toHaveBeenCalledWith({ reportFailure: false });
  await click();
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it.each(["project", "environment", "run", "stage", "attempt", "catalog", "refresh"])(
  "discards old responses after %s changes",
  async (change) => {
    const response = deferred<{ _tag: string; value: WorkflowStagePreview }>();
    const previous = preview();
    const old = {
      ...previous,
      route: {
        ...previous.route,
        selected: {
          ...previous.route.selected!,
          target: { ...previous.route.selected!.target, model: "old-model" },
        },
      },
    };
    mocks.read.mockReturnValueOnce(response.promise);
    await click();
    const run = catalog.runs[0]!;
    if (change === "project") props = { ...props, projectId: ProjectId.make("project-b") };
    if (change === "environment")
      props = { ...props, environmentId: EnvironmentId.make("environment-b") };
    if (change === "run") catalog = { ...catalog, runs: [{ ...run, id: "run-b" }] };
    if (change === "stage") {
      const next = { ...catalog.templates[0]!.stages[0]!, id: "new-stage" };
      catalog = {
        ...catalog,
        templates: [{ ...catalog.templates[0]!, stages: [next] }],
        runs: [
          {
            ...run,
            currentStageId: next.id,
            attempts: [{ ...run.attempts[0]!, stageId: next.id }],
          },
        ],
      };
    }
    if (change === "attempt")
      catalog = { ...catalog, runs: [{ ...run, attempts: [{ ...run.attempts[0]!, attempt: 2 }] }] };
    if (change === "catalog") revision++;
    if (change === "refresh") props = { ...props, refreshTick: 1 };
    await update();
    await click();
    expect(text()).toContain("configured-model");
    await act(async () => response.resolve({ _tag: "Success", value: old }));
    expect(text()).not.toContain("old-model");
    expect(text()).toContain("configured-model");
  },
);

it("reset invalidates a pending request and allows a fresh read", async () => {
  const response = deferred<{ _tag: string; value: WorkflowStagePreview }>();
  mocks.read.mockReturnValueOnce(response.promise);
  await click();
  await click("Reset preview");
  await act(async () => response.resolve({ _tag: "Success", value: preview() }));
  expect(text()).not.toContain("configured-model");
  await click();
  expect(text()).toContain("configured-model");
  await click("Reset preview");
  expect(text()).not.toContain("configured-model");
});

it.each(["throw", "failure"])("shows a %s error, then clears it on retry", async (kind) => {
  if (kind === "throw") mocks.read.mockRejectedValueOnce(new Error("preview offline"));
  else
    mocks.read.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("preview offline")),
    });
  await click();
  expect(text()).toContain("preview offline");
  await click();
  expect(text()).not.toContain("preview offline");
  expect(text()).toContain("configured-model");
});

it("shows denied and unknown routes without inventing a model", async () => {
  const value = preview();
  const denied = {
    ...value,
    route: {
      ...value.route,
      selected: null,
      candidates: [],
      gate: { decision: "DENY", reasonCodes: ["PROVIDER_NOT_INSTALLED"] },
    },
  };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: denied });
  await click();
  expect(text()).toContain("DENY");
  expect(text()).toContain("PROVIDER_NOT_INSTALLED");
  expect(text()).toContain("Unknown / none selected");
  expect(text()).not.toContain("configured-model");
});

it.each(["stage", "attempt", "human_gate"])(
  "rejects a response with stale %s instead of presenting permission",
  async (change) => {
    let value = preview();
    if (change === "stage") value = { ...value, stage: { ...value.stage, id: "old-stage" } };
    if (change === "attempt") value = { ...value, attempt: 9 };
    if (change === "human_gate")
      value = { ...value, stage: { ...value.stage, type: "human_gate" } };
    mocks.read.mockResolvedValueOnce({ _tag: "Success", value });
    await click();
    expect(text()).toContain("Refresh the workflow");
    expect(text()).not.toContain("configured-model");
  },
);

it("does not offer agent preview for a human gate or a dispatched attempt", async () => {
  const template = catalog.templates[0]!;
  catalog = {
    ...catalog,
    templates: [
      { ...template, stages: template.stages.map((stage) => ({ ...stage, type: "human_gate" })) },
    ],
  };
  await update();
  expect(button()).toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
  catalog = {
    ...catalog,
    templates: [template],
    runs: catalog.runs.map((run) => ({
      ...run,
      attempts: run.attempts.map((attempt) => ({ ...attempt, status: "dispatched" })),
    })),
  };
  await update();
  expect(button()).toBeUndefined();
});

it("removes an expired snapshot while the catalog is refreshing", async () => {
  await click();
  expect(text()).toContain("configured-model");
  isPending = true;
  await update();
  expect(text()).not.toContain("configured-model");
  isPending = false;
  revision++;
  await update();
  expect(text()).not.toContain("configured-model");
  await click();
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it("ignores an old request error after switching environment and reading a new preview", async () => {
  const response = deferred<void>();
  mocks.read.mockImplementationOnce(async () => {
    await response.promise;
    throw new Error("old environment offline");
  });
  await click();
  props = { ...props, environmentId: EnvironmentId.make("environment-b") };
  await update();
  await click();
  await act(async () => response.resolve());
  expect(text()).not.toContain("old environment offline");
  expect(text()).toContain("configured-model");
});

const fill = async (label: string, value: string) => {
  await act(async () =>
    renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
  );
};
const reviewStage = async () => {
  await click();
  await click("Choose configured-provider / configured-model");
  await fill("Goal", "Produce a discovery brief");
  await fill("Redirect", "Only Discovery, then stop");
  await fill("Acceptance", "Human reviews the listed sections");
  await fill("Stop conditions", "Stop before the next stage");
  await click("Review exact stage");
};
it("reviews without execution, then starts once with the exact reviewed contract and pre-saved identity", async () => {
  await reviewStage();
  expect(mocks.action).not.toHaveBeenCalled();
  expect(button("Start reviewed stage").props.disabled).toBe(false);
  const response = deferred<unknown>();
  mocks.action.mockImplementationOnce((target) => {
    const persisted = localStorage.getItem(
      `workflow-dispatch:${JSON.stringify([environmentId, projectId, run.id, "test-stage", 1])}`,
    );
    expect(persisted).toBe(target.input.dispatchId);
    return response.promise;
  });
  await act(async () => {
    const start = button("Start reviewed stage").props.onClick;
    start();
    start();
  });
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(mocks.action.mock.calls[0]![0].input).toMatchObject({
    target: {
      instanceId: "configured-provider",
      model: "configured-model",
    },
    review: {
      taskContract: {
        goal: "Produce a discovery brief",
        brake: { maxProviderStarts: 1, maxTokens: 4000 },
      },
    },
  });
  await act(async () =>
    response.resolve({ _tag: "Success", value: { threadId: "fixture-thread" } }),
  );
  expect(text()).toContain("Acceptance is not completed work");
  expect(button("Start reviewed stage").props.disabled).toBe(true);
});
it.each([
  "Goal",
  "Redirect",
  "Acceptance",
  "Stop conditions",
  "Maximum tokens",
  "Deadline (UTC)",
  "Model",
  "Provider instance",
  "Additional instruction",
])("invalidates review after editing %s", async (field) => {
  await reviewStage();
  await fill(field, field === "Maximum tokens" ? "2000" : "changed");
  expect(button("Start reviewed stage").props.disabled).toBe(true);
  expect(mocks.action).not.toHaveBeenCalled();
});
it("retains UNKNOWN across a lost reply, Reset and remount and only reconciles original identity", async () => {
  await reviewStage();
  mocks.action.mockRejectedValueOnce(new Error("lost reply"));
  await click("Start reviewed stage");
  const original = mocks.action.mock.calls[0]![0].input.dispatchId;
  await click("Reset preview");
  expect(button("Start reviewed stage").props.disabled).toBe(true);
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<ProjectWorkflowDecisions {...props} />);
  });
  expect(text()).toContain(original);
  expect(mocks.action).toHaveBeenCalledTimes(1);
  mocks.action.mockResolvedValueOnce({
    _tag: "Success",
    value: { status: "unknown", dispatchId: original },
  });
  await click("Reconcile original dispatch");
  expect(mocks.action).toHaveBeenCalledTimes(2);
  expect(mocks.action.mock.calls[1]![0].input).toEqual({
    environmentId,
    projectId,
    runId: run.id,
    stageId: "test-stage",
    attempt: 1,
  });
  expect(text()).toContain("No resend was attempted");
  expect(button("Start reviewed stage").props.disabled).toBe(true);
});
it("shows actual artifact sections, provenance, Unknown and redactions before human decisions", async () => {
  catalog = {
    ...catalog,
    runs: [
      {
        ...run,
        attempts: [{ ...run.attempts[0]!, status: "proposed" }],
        artifacts: [
          {
            id: "artifact-fixture",
            runId: run.id,
            stageId: "test-stage",
            attempt: 1,
            kind: "result",
            sourceTurnId: null,
            sourceOutcome: "failed",
            profileId: profile.id,
            profileVersion: 1,
            sections: [
              {
                label: "Evidence",
                content: "Observed fake output [credential omitted]",
                missing: false,
              },
              { label: "Missing", content: "Unknown", missing: true },
            ],
            missingSections: ["Missing"],
            extractionVersion: 1,
            redacted: true,
            status: "proposed",
            createdAt: run.createdAt,
            acceptedAt: null,
          },
        ],
      },
    ],
  };
  await update();
  expect(text()).toContain("Observed fake output");
  expect(text()).toContain("failed");
  expect(text()).toContain("Unknown");
  expect(text()).toContain("present");
  expect(button("Approve").props.disabled).toBe(true);
  expect(mocks.action).not.toHaveBeenCalled();
  mocks.action.mockResolvedValueOnce({ _tag: "Success", value: catalog });
  await click("Request revision");
  expect(mocks.action.mock.calls[0]![0].input.value).toBe("request_revision");
});
