// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: import("react").ReactNode }) => <div>{children}</div>,
}));
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

let root: Root;
let container: HTMLDivElement;
let fixture: ScheduleFixture;
const storage = new Map<string, string>();
const findButton = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
function enterText(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
// jsdom does not synthesize native button activation from keyboard events.
// Assert real modal focus reachability, then send the zero-detail click emitted
// by keyboard activation, without reaching into React props or handlers.
async function keyboardActivate(button: HTMLButtonElement) {
  expect(button).toBeDefined();
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.focus();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
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
  state.connected = true;
  state.environmentId = "env-a";
  state.upsert.mockReset();
  state.read.mockReset();
  state.toast.mockClear();
  fixture = fixtureModule.createFixture();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ScheduledTasksSettings />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await fixture.dispose();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps recovery keyboard reachable inside the real modal after interruption=%s",
  async (interrupted) => {
    state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => {
      await fixture.upsert(input);
      return {
        _tag: "Failure",
        cause: interrupted ? Cause.interrupt() : Cause.fail(new Error("response lost")),
      };
    });
    state.read.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("read unavailable")),
    });
    state.read.mockImplementation(async () => ({ _tag: "Success", value: await fixture.list() }));
    await keyboardActivate(findButton("New task"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.dataset.slot).toBe("dialog-popup");
    expect(document.querySelector('[data-slot="dialog-backdrop"]')).not.toBeNull();
    await act(async () => {
      enterText("scheduled-task-title", "Modal recovery");
      enterText("scheduled-task-prompt", "Exact modal prompt");
    });
    await keyboardActivate(findButton("Create task", dialog));
    await act(async () => {
      await state.upsert.mock.results[0]!.value;
    });
    expect(findButton("Create task", dialog).disabled).toBe(true);
    const recover = findButton("Recover scheduled task", dialog);
    expect(
      recover,
      "Recovery must be inside the focus-trapped modal, not behind its backdrop",
    ).toBeDefined();
    expect(dialog.textContent).toContain("outcome is uncertain");
    await keyboardActivate(recover);
    await act(async () => {
      await state.read.mock.results[0]!.value;
    });
    expect(dialog.textContent).toContain("outcome is uncertain");
    expect(storage.size).toBe(1);
    expect(findButton("Create task", dialog).disabled).toBe(true);
    await keyboardActivate(findButton("Recover scheduled task", dialog));
    await act(async () => {
      await state.read.mock.results[1]!.value;
    });
    expect(storage.size).toBe(0);
    expect(dialog.textContent).toContain("creation recovered");
    expect(state.upsert).toHaveBeenCalledTimes(1);
    expect((await fixture.list()).tasks).toHaveLength(1);
    await keyboardActivate(findButton("Close", dialog));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);

it("closing an uncertain real dialog preserves creation and exposes recovery on the page", async () => {
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => {
    await fixture.upsert(input);
    return { _tag: "Failure", cause: Cause.fail(new Error("response lost")) };
  });
  state.read.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("read unavailable")),
  });
  await keyboardActivate(findButton("New task"));
  await act(async () => {
    enterText("scheduled-task-title", "Retained after close");
    enterText("scheduled-task-prompt", "Keep the original schedule");
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await keyboardActivate(findButton("Create task", dialog));
  await act(async () => {
    await state.upsert.mock.results[0]!.value;
  });
  const original = [...storage.values()][0];
  expect(dialog.textContent).toContain("Closing this dialog does not cancel creation");
  expect(findButton("Cancel", dialog)).toBeUndefined();
  await keyboardActivate(findButton("Close", dialog));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect([...storage.values()][0]).toBe(original);
  expect(findButton("New task").disabled).toBe(true);
  await keyboardActivate(findButton("Recover scheduled task"));
  await act(async () => {
    await state.read.mock.results[0]!.value;
  });
  expect([...storage.values()][0]).toBe(original);
  expect(document.body.textContent).toContain("outcome is uncertain");
  expect(state.upsert).toHaveBeenCalledTimes(1);
  expect((await fixture.list()).tasks).toHaveLength(1);
});
