import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { ProjectId, type ScheduledTask, type ScheduledTaskUpsertInput } from "@t3tools/contracts";
// Load the server-owned fixture through a typed integration boundary. The web
// composite project must not import the server's entire source graph.
interface ScheduleFixture {
  upsert(input: ScheduledTaskUpsertInput): Promise<{ task: ScheduledTask }>;
  list(): Promise<{ tasks: readonly ScheduledTask[] }>;
  delete(input: { id: ScheduledTask["id"] }): Promise<unknown>;
  dispose(): Promise<void>;
}
const fixtureModule: { createFixture(): ScheduleFixture } = await import(
  "../../../../server/src/scheduledTasks/testkit/creationFixture.ts" as string
);
const state = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  environmentId: "env-a",
  connected: true,
  upsert: vi.fn(),
  read: vi.fn(),
  toast: vi.fn(),
  settings: {
    defaultModelSelection: {
      instanceId: "codex",
      model: "fake",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
      ],
    },
  },
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Fake",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "fake", name: "Fake", isDefault: true }],
    },
  ],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => "providers",
    scheduledTasksLive: () => "list",
    upsertScheduledTask: "upsert",
    readScheduledTasks: "read",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "upsert" | "read") => state[name] ?? vi.fn(),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: state.tasks }, error: null }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () =>
    ["env-a", "env-b"].map((environmentId) => ({
      environmentId,
      id: ProjectId.make("project"),
      title: "Project",
    })),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (environmentId: string) => ({
    environmentId,
    label: environmentId,
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: { environment: { platform: { machine: "linux" } } },
  }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const envs = ["env-a", "env-b"].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: state.connected ? "connected" : "disconnected" },
      serverConfig: { environment: { platform: { machine: "linux" } } },
    }));
    return {
      scope: { kind: "all", environmentIds: ["env-a", "env-b"] },
      environments: envs,
      connectedEnvironments: state.connected ? envs : [],
      environment: envs.find((e) => e.environmentId === state.environmentId),
    };
  },
}));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return { useEnvironmentSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, ...state.settings }) };
});
vi.mock("../WorktreeBaseBranchPicker", () => ({ WorktreeBaseBranchPicker: () => null }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/switch", () => ({ Switch: "switch" }));
vi.mock("../ui/toggle-group", () => ({ ToggleGroup: "toggles", Toggle: "toggle" }));
vi.mock("../ui/menu", () => ({
  Menu: "menu",
  MenuTrigger: "div",
  MenuPopup: "div",
  MenuItem: "menuitem",
  MenuSeparator: "hr",
}));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "div",
  SelectValue: "span",
  SelectPopup: "div",
  SelectItem: "option",
}));
vi.mock("../ui/empty", () => ({
  Empty: "div",
  EmptyHeader: "div",
  EmptyTitle: "div",
  EmptyDescription: "div",
  EmptyMedia: "div",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "dialog",
  DialogClose: "close",
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "div",
  DialogTitle: "h2",
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (x: unknown) => x,
  toastManager: { add: state.toast },
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: "main",
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: import("react").ReactNode;
    headerAction: import("react").ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    control,
  }: {
    title: import("react").ReactNode;
    control: import("react").ReactNode;
  }) => (
    <div>
      {title}
      {control}
    </div>
  ),
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  useRelativeTimeTick: () => {},
}));
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
let renderer: ReactTestRenderer;
const storage = new Map<string, string>();
const button = (text: string) =>
  renderer.root.findAllByType("button").find((n) => n.children.includes(text))!;
const click = async (text: string) => {
  await act(async () => {
    button(text).props.onClick();
  });
};
const text = () =>
  renderer.root
    .findAllByType("p")
    .map((n) => n.children.filter((c) => typeof c === "string").join(" "))
    .join(" ");
async function openDraft() {
  await click("New task");
  await act(async () => {
    renderer.root
      .findByProps({ id: "scheduled-task-title" })
      .props.onChange({ target: { value: "Same title" } });
    renderer.root
      .findByProps({ id: "scheduled-task-prompt" })
      .props.onChange({ target: { value: "Exact submitted prompt" } });
  });
}
let fixture: ScheduleFixture;
async function service() {
  return fixture;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  storage.clear();
  state.tasks = [];
  state.toast.mockClear();
  state.environmentId = "env-a";
  state.connected = true;
  state.upsert.mockReset();
  state.read.mockReset();
  fixture = fixtureModule.createFixture();
  await act(async () => {
    renderer = create(<ScheduledTasksSettings />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  await fixture.dispose();
  vi.unstubAllGlobals();
});
it.each([false, true])("schedule recovery interrupted=%s", async (interrupted) => {
  const schedules = await service();
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => {
    await schedules.upsert(input);
    return {
      _tag: "Failure",
      cause: interrupted ? Cause.interrupt() : Cause.fail(new Error("response lost")),
    };
  });
  state.read.mockImplementation(async () => ({
    _tag: "Success",
    value: await schedules.list(),
  }));
  await openDraft();
  await click("Create task");
  expect(state.upsert.mock.calls.length, JSON.stringify(state.toast.mock.calls)).toBe(1);
  await act(async () => {
    await state.upsert.mock.results[0]!.value;
  });
  await click("Create task");
  expect(state.upsert).toHaveBeenCalledTimes(1);
  const submitted = state.upsert.mock.calls[0]![0];
  expect(submitted.input.commandId).toBeTruthy();
  expect(submitted.input.modelSelection.options).toEqual(
    state.settings.defaultModelSelection.options,
  );
  expect(text()).toContain("outcome is uncertain");
  await click("Recover scheduled task");
  expect(state.read).toHaveBeenCalledWith({ environmentId: "env-a", input: {} });
  expect((await schedules.list()).tasks).toHaveLength(1);
  expect(state.upsert).toHaveBeenCalledTimes(1);
  expect(storage.size).toBe(0);
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function rerender() {
  await act(async () => renderer.update(<ScheduledTasksSettings />));
}
async function remount() {
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<ScheduledTasksSettings />);
  });
}
async function closeDialog() {
  await act(async () => renderer.root.findByType("dialog").props.onOpenChange(false));
}
async function lostCreate() {
  const schedules = await service();
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => {
    await schedules.upsert(input);
    return { _tag: "Failure", cause: Cause.fail(new Error("response lost")) };
  });
  state.read.mockImplementation(async () => ({ _tag: "Success", value: await schedules.list() }));
  await openDraft();
  await click("Create task");
  await act(async () => {
    await state.upsert.mock.results[0]!.value;
  });
  return {
    schedules,
    submitted: state.upsert.mock.calls[0]![0] as {
      environmentId: string;
      input: ScheduledTaskUpsertInput;
    },
  };
}
async function recover() {
  await click("Recover scheduled task");
  const result = state.read.mock.results.at(-1);
  if (result)
    await act(async () => {
      await Promise.resolve(result.value).catch(() => undefined);
    });
}
it("retains exact identity across close/reopen, remount, and another selected environment", async () => {
  const { schedules, submitted } = await lostCreate();
  const original = [...storage.values()][0];
  await closeDialog();
  await click("New task");
  expect(renderer.root.findAllByType("dialog")).toHaveLength(0);
  state.environmentId = "env-b";
  await remount();
  expect(button("New task").props.disabled).toBe(true);
  await click("New task");
  expect([...storage.values()][0]).toBe(original);
  await schedules.upsert({ ...submitted.input, commandId: undefined });
  await recover();
  expect(state.read).toHaveBeenLastCalledWith({ environmentId: "env-a", input: {} });
  expect(storage.size).toBe(0);
  expect(state.upsert).toHaveBeenCalledTimes(1);
  expect((await schedules.list()).tasks).toHaveLength(2);
});
it.each(["failure", "interruption", "throw", "absent", "wrong-id", "wrong-options"] as const)(
  "schedule recovery mode=%s",
  async (mode) => {
    const { schedules, submitted } = await lostCreate();
    const original = [...storage.values()][0];
    const row = (await schedules.list()).tasks[0]!;
    if (mode === "throw") state.read.mockRejectedValueOnce(new Error("offline"));
    else if (mode === "failure" || mode === "interruption")
      state.read.mockResolvedValueOnce({
        _tag: "Failure",
        cause: mode === "failure" ? Cause.fail(new Error("offline")) : Cause.interrupt(),
      });
    else
      state.read.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          tasks:
            mode === "absent"
              ? []
              : [
                  {
                    ...row,
                    ...(mode === "wrong-id"
                      ? { id: "another-identity" }
                      : { modelSelection: { ...row.modelSelection, options: [] } }),
                  },
                ],
        },
      });
    await recover();
    expect([...storage.values()][0]).toBe(original);
    expect(button("New task").props.disabled).toBe(true);
    expect(state.read).toHaveBeenCalledWith({ environmentId: submitted.environmentId, input: {} });
    expect(state.upsert).toHaveBeenCalledTimes(1);
    expect((await schedules.list()).tasks[0]).toEqual(row);
  },
);
it("does not read disconnected and retires a read crossing disconnection", async () => {
  const { schedules } = await lostCreate();
  state.connected = false;
  await rerender();
  expect(button("Recover scheduled task").props.disabled).toBe(true);
  await click("Recover scheduled task");
  expect(state.read).not.toHaveBeenCalled();
  state.connected = true;
  await rerender();
  const response = deferred<unknown>();
  state.read.mockReturnValueOnce(response.promise);
  await click("Recover scheduled task");
  state.connected = false;
  await rerender();
  await act(async () => response.resolve({ _tag: "Success", value: await schedules.list() }));
  expect(storage.size).toBe(1);
  expect(state.upsert).toHaveBeenCalledTimes(1);
  state.connected = true;
  await rerender();
  await recover();
  expect(storage.size).toBe(0);
});
it.each(["edit", "delete"] as const)("schedule recovery change=%s", async (change) => {
  const { schedules, submitted } = await lostCreate();
  const created = (await schedules.list()).tasks[0]!;
  if (change === "delete") await schedules.delete({ id: created.id });
  else
    await schedules.upsert({
      ...submitted.input,
      id: created.id,
      requireExisting: true,
      prompt: "Later edit",
      modelSelection: { ...submitted.input.modelSelection, options: [] },
    });
  const before = await schedules.list();
  await recover();
  await recover();
  expect(storage.size).toBe(1);
  expect(state.upsert).toHaveBeenCalledTimes(1);
  expect(await schedules.list()).toEqual(before);
  expect(text()).toContain(change === "delete" ? "will not be recreated" : "later changes");
});
it("rejects double clicks and old callbacks while preserving a replacement edit draft", async () => {
  const schedules = await service();
  const committed = deferred<{ task: ScheduledTask }>();
  const response = deferred<unknown>();
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => {
    const result = await schedules.upsert(input);
    committed.resolve(result);
    return response.promise;
  });
  await openDraft();
  const submit = button("Create task").props.onClick;
  await act(async () => {
    submit();
    submit();
  });
  const result = await committed.promise;
  expect(state.upsert).toHaveBeenCalledTimes(1);
  state.tasks = [result.task];
  await remount();
  expect(button("New task").props.disabled).toBe(true);
  await act(async () =>
    renderer.root
      .findAllByType("menuitem")
      .find((n) => n.children.includes("Edit"))!
      .props.onClick(),
  );
  await act(async () =>
    renderer.root
      .findByProps({ id: "scheduled-task-title" })
      .props.onChange({ target: { value: "Replacement edit draft" } }),
  );
  await act(async () => {
    response.resolve({ _tag: "Success", value: result });
    await state.upsert.mock.results[0]!.value;
  });
  expect(renderer.root.findByProps({ id: "scheduled-task-title" }).props.value).toBe(
    "Replacement edit draft",
  );
  await act(async () => submit());
  expect(state.upsert).toHaveBeenCalledTimes(1);
  expect((await schedules.list()).tasks[0]!.title).toBe("Same title");
});
it("fails closed before mutation if recovery storage cannot be written", async () => {
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await openDraft();
  await click("Create task");
  expect(state.upsert).not.toHaveBeenCalled();
  expect(storage.size).toBe(0);
});
it("blocks creation if retained identity is corrupt", async () => {
  storage.set("t3:scheduled-task-creation:v1", "broken");
  await remount();
  expect(button("New task").props.disabled).toBe(true);
  await click("New task");
  expect(state.upsert).not.toHaveBeenCalled();
  expect(text()).toContain("could not be read");
});
it.each([
  "title",
  "prompt",
  "enabled",
  "schedule",
  "projectId",
  "threadId",
  "workspaceStrategy",
  "instance",
  "model",
  "option-value",
  "option-presence",
  "runtimeMode",
  "interactionMode",
] as const)("schedule recovery field=%s", async (field) => {
  const { schedules } = await lostCreate();
  const row = (await schedules.list()).tasks[0]!;
  const changed = { ...row };
  switch (field) {
    case "title":
      changed.title = "Changed";
      break;
    case "prompt":
      changed.prompt = "Changed";
      break;
    case "enabled":
      changed.enabled = !row.enabled;
      break;
    case "schedule":
      changed.schedule = { type: "interval", everyMs: 120000 };
      break;
    case "projectId":
      changed.projectId = ProjectId.make("other");
      break;
    case "threadId":
      changed.threadId = "other" as ScheduledTask["threadId"];
      break;
    case "workspaceStrategy":
      changed.workspaceStrategy = { type: "root" };
      break;
    case "instance":
      changed.modelSelection = {
        ...row.modelSelection,
        instanceId: "other" as ScheduledTask["modelSelection"]["instanceId"],
      };
      break;
    case "model":
      changed.modelSelection = { ...row.modelSelection, model: "other" };
      break;
    case "option-value":
      changed.modelSelection = {
        ...row.modelSelection,
        options: [
          { id: "effort", value: "low" },
          { id: "fastMode", value: true },
        ],
      };
      break;
    case "option-presence": {
      const { options: _, ...selection } = row.modelSelection;
      changed.modelSelection = selection;
      break;
    }
    case "runtimeMode":
      changed.runtimeMode = "approval-required";
      break;
    case "interactionMode":
      changed.interactionMode = "plan";
      break;
  }
  state.read.mockResolvedValueOnce({ _tag: "Success", value: { tasks: [changed] } });
  const original = [...storage.values()][0];
  await recover();
  expect([...storage.values()][0]).toBe(original);
  expect(state.upsert).toHaveBeenCalledTimes(1);
  expect((await schedules.list()).tasks[0]).toEqual(row);
});
it("keeps normal edit requireExisting, full options and nextRunAt behavior", async () => {
  const { schedules, submitted } = await lostCreate();
  await recover();
  await closeDialog();
  const row = (await schedules.list()).tasks[0]!;
  state.tasks = [row];
  await rerender();
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => ({
    _tag: "Success",
    value: await schedules.upsert(input),
  }));
  await act(async () =>
    renderer.root
      .findAllByType("menuitem")
      .find((n) => n.children.includes("Edit"))!
      .props.onClick(),
  );
  await act(async () =>
    renderer.root
      .findByProps({ id: "scheduled-task-title" })
      .props.onChange({ target: { value: "Edited title" } }),
  );
  await click("Save task");
  await act(async () => {
    await state.upsert.mock.results.at(-1)!.value;
  });
  const edit = state.upsert.mock.calls.at(-1)![0];
  expect(edit.input).toMatchObject({
    id: row.id,
    requireExisting: true,
    modelSelection: submitted.input.modelSelection,
  });
  expect(edit.input.commandId).toBeUndefined();
  expect(storage.size).toBe(0);
  const saved = (await schedules.list()).tasks[0]!;
  expect(saved.title).toBe("Edited title");
  expect(saved.nextRunAt).toBe(row.nextRunAt);
});
it("ignores a saved submit callback after environment switching or dialog closure", async () => {
  await openDraft();
  const stale = button("Create task").props.onClick;
  await act(async () => renderer.root.findAllByType("select")[0]!.props.onValueChange("env-b"));
  await act(async () => stale());
  expect(state.upsert).not.toHaveBeenCalled();
  await closeDialog();
  await act(async () => stale());
  expect(state.upsert).not.toHaveBeenCalled();
  expect(storage.size).toBe(0);
});

it("releases the retained identity only after a matching successful response", async () => {
  const schedules = await service();
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => ({
    _tag: "Success",
    value: await schedules.upsert(input),
  }));
  await openDraft();
  const submit = button("Create task").props.onClick;
  await act(async () => {
    submit();
    submit();
  });
  await act(async () => {
    await state.upsert.mock.results[0]!.value;
  });
  expect(renderer.root.findAllByType("dialog")).toHaveLength(0);
  expect(storage.size).toBe(0);
  expect(state.read).not.toHaveBeenCalled();
  await act(async () => submit());
  expect(state.upsert).toHaveBeenCalledTimes(1);
  const rows = (await schedules.list()).tasks;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.runCount).toBe(0);
  expect(rows[0]!.lastRunStatus).toBe("never");
});
it("retains an independent full-options snapshot when later configuration changes", async () => {
  const { submitted } = await lostCreate();
  const original = [...storage.values()][0];
  const options = state.settings.defaultModelSelection.options;
  try {
    options[0]!.value = "low";
    expect(submitted.input.modelSelection.options?.[0]!.value).toBe("high");
    expect([...storage.values()][0]).toBe(original);
    await recover();
    expect(storage.size).toBe(0);
    expect(state.upsert).toHaveBeenCalledTimes(1);
  } finally {
    options[0]!.value = "high";
  }
});
