import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  profile as baseProfile,
  template as baseTemplate,
  run as baseRun,
} from "./WorkflowStagePreview.test-fixtures";
// Mounted behavior fixture; production built-ins are exercised by authenticated transport tests.
const roles = ["bill", "zackburg", "implementer"].map((id) => ({
  ...baseProfile,
  id,
  displayName: id,
  requiredOutputSections: ["Result", "Risks"],
}));
const templates = [
  {
    ...baseTemplate,
    id: "saas-production",
    stages: [
      {
        ...baseTemplate.stages[0]!,
        id: "architecture",
        profileId: "zackburg",
        profileVersion: 1,
        requiredOutputSections: ["Result", "Risks"],
        nextStageId: "feedback",
      },
      {
        ...baseTemplate.stages[0]!,
        id: "feedback",
        profileId: "bill",
        profileVersion: 1,
        requiredOutputSections: ["Legacy feedback override"],
        nextStageId: null,
      },
    ],
  },
];
const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  status: vi.fn(),
  refresh: vi.fn(),
  session: {},
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return { usePreparedConnection: () => Option.some(mocks.session) };
});
vi.mock("../../state/workflow", () => ({
  workflowEnvironment: { action: "action", templateCommandStatus: "status" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (tag: string) => (tag === "action" ? mocks.action : mocks.status),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "trigger",
  SelectValue: "value",
  SelectPopup: "popup",
  SelectItem: "option",
}));
import { WorkflowTemplates } from "./WorkflowTemplates";
let renderer: ReactTestRenderer;
let props: Parameters<typeof WorkflowTemplates>[0];
const button = (name: string) =>
  renderer.root.findAllByType("button").find((n) => n.children.join("") === name)!;
const text = () => JSON.stringify(renderer.toJSON());
const update = async () => act(async () => renderer.update(<WorkflowTemplates {...props} />));
const click = async (name: string) => act(async () => button(name).props.onClick());
const input = async (label: string, value: string) =>
  act(async () =>
    renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
  );
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  mocks.action.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  mocks.status.mockReset().mockResolvedValue({ _tag: "Success", value: "committed" });
  mocks.refresh.mockReset();
  mocks.session = {};
  props = {
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project-a"),
    catalog: {
      reusableTemplatesVersion: 1,
      runBriefVersion: 1,
      profiles: roles,
      templates: templates,
      runs: [],
    },
    fresh: true,
    refresh: mocks.refresh,
  };
  await act(async () => {
    renderer = create(<WorkflowTemplates {...props} />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
async function copied() {
  await click("Copy SaaS Production v1");
  await input("Workflow name", "My supervised workflow");
}
it("edits an exact saved version with expectedVersion and leaves existing saved source and selection unchanged", async () => {
  await copied();
  await click("Review workflow save");
  await click("Confirm workflow command");
  const command = mocks.action.mock.calls[0]![0].input;
  const v1 = {
    ...command.draft,
    version: 1,
    origin: "custom" as const,
    status: "active" as const,
    projectId: props.projectId,
    createdAt: templates[0]!.createdAt,
    updatedAt: templates[0]!.updatedAt,
  };
  const original = JSON.stringify(v1);
  props = { ...props, catalog: { ...props.catalog, templates: [...props.catalog.templates, v1] } };
  await update();
  await act(async () => renderer.root.findByType("select").props.onValueChange(`${v1.id}@1`));
  await click("Edit selected workflow version");
  await input("Stage 1 instructions", "Version two reviewed instructions");
  await click("Review workflow save");
  expect(text()).toContain("Save immutable v2, expected v1");
  await click("Confirm workflow command");
  expect(mocks.action.mock.calls[1]![0].input).toMatchObject({
    type: "template.save",
    expectedVersion: 1,
    draft: { id: v1.id },
  });
  expect(JSON.stringify(v1)).toBe(original);
  await input("Run brief", "Reviewed fixture run requirements");
  await click("Review ledger creation");
  await click("Confirm workflow command");
  expect(mocks.action.mock.calls[2]![0].input).toMatchObject({
    type: "run.start",
    templateId: v1.id,
    templateVersion: 1,
  });
});
it("retires ledger review if selected source content changes even without a timestamp change", async () => {
  await act(async () =>
    renderer.root.findByType("select").props.onValueChange("saas-production@1"),
  );
  await input("Run brief", "Reviewed fixture run requirements");
  await click("Review ledger creation");
  const old = button("Confirm workflow command").props.onClick;
  props = {
    ...props,
    catalog: {
      ...props.catalog,
      templates: props.catalog.templates.map((t) => ({
        ...t,
        stages: t.stages.map((s) => ({
          ...s,
          taskPromptTemplate: s.taskPromptTemplate + " changed",
        })),
      })),
    },
  };
  await update();
  await act(async () => old());
  expect(mocks.action).not.toHaveBeenCalled();
  expect(button("Confirm workflow command")).toBeUndefined();
});
it("retains the original ledger run identity on lost reply and reconciliation after remount", async () => {
  mocks.action.mockRejectedValue(new Error("lost ledger reply"));
  await act(async () =>
    renderer.root.findByType("select").props.onValueChange("saas-production@1"),
  );
  await input("Run brief", "Reviewed fixture run requirements");
  await click("Review ledger creation");
  await click("Confirm workflow command");
  const original = mocks.action.mock.calls[0]![0].input;
  await act(async () => renderer.update(<></>));
  await update();
  mocks.status.mockResolvedValue({ _tag: "Success", value: "unknown" });
  await click("Check original workflow command");
  expect(mocks.status).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: original,
  });
  expect(original.runId).toBeTruthy();
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(button("Review ledger creation").props.disabled).toBe(true);
});
it("disables another ledger for a paused workflow, an archived selection or an old server", async () => {
  await act(async () =>
    renderer.root.findByType("select").props.onValueChange("saas-production@1"),
  );
  props = {
    ...props,
    catalog: {
      ...props.catalog,
      runs: [{ ...baseRun, projectId: props.projectId, status: "paused" }],
    },
  };
  await update();
  expect(button("Review ledger creation").props.disabled).toBe(true);
  expect(text()).toContain("already has an open workflow");
  props = {
    ...props,
    catalog: {
      ...props.catalog,
      runs: [],
      templates: props.catalog.templates.map((t) => ({ ...t, status: "archived" })),
    },
  };
  await update();
  expect(button("Review ledger creation").props.disabled).toBe(true);
  expect(text()).toContain("selected template version is archived");
  const { reusableTemplatesVersion: _version, ...legacy } = props.catalog;
  props = { ...props, catalog: legacy };
  await update();
  expect(button("New workflow draft").props.disabled).toBe(true);
  expect(mocks.action).not.toHaveBeenCalled();
});
it("reviews a role-derived bounded custom copy then saves once, without selecting or creating a ledger", async () => {
  await copied();
  await click("Review workflow save");
  expect(text()).toContain("Save immutable v1");
  expect(mocks.action).not.toHaveBeenCalled();
  await act(async () => {
    const confirm = button("Confirm workflow command").props.onClick;
    confirm();
    confirm();
  });
  expect(mocks.action).toHaveBeenCalledTimes(1);
  const command = mocks.action.mock.calls[0]![0].input;
  expect(command).toMatchObject({
    type: "template.save",
    expectedVersion: 0,
    projectId: props.projectId,
  });
  const feedback = command.draft.stages.at(-1);
  expect(feedback.requiredOutputSections).toEqual(roles[0]!.requiredOutputSections);
  expect(command.draft.stages.every((s: { approvalRequired: boolean }) => s.approvalRequired)).toBe(
    true,
  );
  expect(mocks.refresh).toHaveBeenCalled();
  expect(mocks.status).toHaveBeenCalledWith({ environmentId: props.environmentId, input: command });
  expect(mocks.action.mock.calls.some(([call]) => call.input.type === "run.start")).toBe(false);
});
it.each(["environment", "project", "session", "A-B-A", "facts", "stale"])(
  "retires confirmation on %s without sending",
  async (change) => {
    await copied();
    await click("Review workflow save");
    const confirm = button("Confirm workflow command").props.onClick;
    const original = { ...props };
    if (change === "environment" || change === "A-B-A")
      props = { ...props, environmentId: EnvironmentId.make("environment-b") };
    if (change === "project") props = { ...props, projectId: ProjectId.make("project-b") };
    if (change === "session") mocks.session = {};
    if (change === "facts")
      props = {
        ...props,
        catalog: {
          ...props.catalog,
          templates: props.catalog.templates.map((t) => ({
            ...t,
            updatedAt: "2026-10-19T22:00:00Z",
          })),
        },
      };
    if (change === "stale") props = { ...props, fresh: false };
    await update();
    if (change === "A-B-A") {
      props = original;
      await update();
      expect(text()).toContain("My supervised workflow");
    }
    await act(async () => confirm());
    expect(mocks.action).not.toHaveBeenCalled();
    expect(button("Confirm workflow command")).toBeUndefined();
  },
);
it("keeps the original save identity after a lost reply and remount, and reconciles without resending", async () => {
  mocks.action.mockRejectedValue(new Error("lost reply"));
  await copied();
  await click("Review workflow save");
  await click("Confirm workflow command");
  const command = mocks.action.mock.calls[0]![0].input;
  expect(text()).toContain("UNKNOWN");
  await act(async () => renderer.update(<></>));
  await update();
  expect(text()).toContain(command.commandId);
  expect(button("Review workflow save").props.disabled).toBe(true);
  mocks.status.mockResolvedValue({ _tag: "Success", value: "unknown" });
  await click("Check original workflow command");
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(mocks.status).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: command,
  });
  mocks.status.mockResolvedValue({ _tag: "Success", value: "committed" });
  await click("Check original workflow command");
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(text()).toContain("Original command committed");
});
it("requires a separate exact saved-version selection and creates only the reviewed ledger identity", async () => {
  const select = renderer.root.findByType("select");
  await act(async () => select.props.onValueChange("saas-production@1"));
  await input("Run brief", "Reviewed fixture run requirements");
  await click("Review ledger creation");
  expect(mocks.action).not.toHaveBeenCalled();
  expect(text()).toContain("saas-production v1");
  await click("Confirm workflow command");
  expect(mocks.action.mock.calls[0]![0].input).toMatchObject({
    type: "run.start",
    templateId: "saas-production",
    templateVersion: 1,
  });
  expect(mocks.action).toHaveBeenCalledTimes(1);
});
it("shows invalid scratch bounds, unavailable roles and an already open workflow without falling back", async () => {
  await click("New workflow draft");
  expect(button("Review workflow save").props.disabled).toBe(true);
  await input("Workflow name", "Scratch");
  await input("Workflow description", "Only approved work");
  await click("Add stage");
  expect(text()).toContain("exact active built-in role");
  const select = renderer.root.findAllByType("select").at(-1)!;
  await act(async () => select.props.onValueChange("human_gate"));
  expect(text()).toContain("first stage must be an agent");
  await act(async () => select.props.onValueChange("zackburg@1"));
  expect(button("Review workflow save").props.disabled).toBe(false);
  props = { ...props, catalog: { ...props.catalog, profiles: [] } };
  await update();
  expect(button("Review workflow save").props.disabled).toBe(true);
});
it("blocks mutations when original-command storage cannot be retained", async () => {
  await copied();
  await click("Review workflow save");
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  });
  await click("Confirm workflow command");
  expect(mocks.action).not.toHaveBeenCalled();
  expect(text()).toContain("No mutation was sent");
});

it("does not claim an acknowledged mutation was unsent when clearing its recovery record fails", async () => {
  await copied();
  await click("Review workflow save");
  const storage = globalThis.sessionStorage;
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => {
      if (JSON.parse(value).command === null) throw new Error("clear denied");
      storage.setItem(key, value);
    },
  });
  await click("Confirm workflow command");
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(text()).toContain(mocks.action.mock.calls[0]![0].input.commandId);
  expect(text()).toContain("storage could not be updated");
  expect(text()).toContain("Original command is committed");
  expect(text()).not.toContain("No mutation was sent");
  expect(button("Review workflow save").props.disabled).toBe(true);
  vi.stubGlobal("sessionStorage", storage);
  await click("Check original workflow command");
  expect(button("New workflow draft").props.disabled).toBe(false);
  expect(mocks.action).toHaveBeenCalledTimes(1);
});

it("requires and reviews the exact run brief before sending one ledger command", async () => {
  await act(async () =>
    renderer.root.findByType("select").props.onValueChange("saas-production@1"),
  );
  expect(button("Review ledger creation").props.disabled).toBe(true);
  const brief = "  保留原始要求 😀\r\nNo silent deletion.  ";
  await input("Run brief", brief);
  await click("Review ledger creation");
  expect(renderer.root.findByProps({ "aria-label": "Reviewed run brief" }).children.join("")).toBe(
    brief,
  );
  expect(text()).toContain("saas-production v1");
  expect(mocks.action).not.toHaveBeenCalled();
  await click("Confirm workflow command");
  expect(mocks.action.mock.calls[0]![0].input).toMatchObject({
    type: "run.start",
    templateId: "saas-production",
    templateVersion: 1,
    brief,
  });
  expect(renderer.root.findByProps({ "aria-label": "Run brief" }).props.value).toBe("");
});

it.each(["brief-A-B-A", "environment", "project", "session", "context-A-B-A", "capability"])(
  "retires exact brief confirmation on %s while retained text grants no authority",
  async (change) => {
    await act(async () =>
      renderer.root.findByType("select").props.onValueChange("saas-production@1"),
    );
    await input("Run brief", "Original retained brief");
    await click("Review ledger creation");
    const confirm = button("Confirm workflow command").props.onClick;
    const original = props;
    if (change === "brief-A-B-A") {
      await input("Run brief", "Other brief");
      await input("Run brief", "Original retained brief");
    }
    if (change === "environment" || change === "context-A-B-A")
      props = { ...props, environmentId: EnvironmentId.make("environment-b") };
    if (change === "project") props = { ...props, projectId: ProjectId.make("project-b") };
    if (change === "session") mocks.session = {};
    if (change === "capability") {
      const catalog = { ...props.catalog };
      delete catalog.runBriefVersion;
      props = { ...props, catalog };
    }
    await update();
    if (change === "context-A-B-A") {
      props = original;
      await update();
      expect(text()).toContain("Original retained brief");
    }
    await act(async () => confirm());
    expect(mocks.action).not.toHaveBeenCalled();
    expect(button("Confirm workflow command")).toBeUndefined();
  },
);
it.each(["", " \n\t", "bad\ud800", "bad\u0000"])(
  "blocks malformed/blank brief review: %j",
  async (brief) => {
    await act(async () =>
      renderer.root.findByType("select").props.onValueChange("saas-production@1"),
    );
    await input("Run brief", brief);
    expect(button("Review ledger creation").props.disabled).toBe(true);
    await click("Review ledger creation");
    expect(button("Confirm workflow command")).toBeUndefined();
    expect(mocks.action).not.toHaveBeenCalled();
  },
);
it("keeps committed ledger truth and original identity when receipt cleanup storage fails", async () => {
  await act(async () =>
    renderer.root.findByType("select").props.onValueChange("saas-production@1"),
  );
  await input("Run brief", "Original committed brief");
  await click("Review ledger creation");
  const set = globalThis.sessionStorage.setItem;
  globalThis.sessionStorage.setItem = (key, raw) => {
    if (JSON.parse(raw).command === null) throw new Error("cleanup failed");
    set(key, raw);
  };
  await click("Confirm workflow command");
  expect(text()).toContain("Original command is committed; recovery storage could not be updated");
  expect(text()).toContain("Original committed brief");
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(button("Review ledger creation").props.disabled).toBe(true);
  globalThis.sessionStorage.setItem = set;
  await click("Check original workflow command");
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByProps({ "aria-label": "Run brief" }).props.value).toBe("");
});
