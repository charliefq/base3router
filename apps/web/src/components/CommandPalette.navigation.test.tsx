import { KeybindingsConfig, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  keybindings: [] as ResolvedKeybindingsConfig,
  operation: vi.fn(),
  open: null as null | ((detail: { query?: string }) => void),
  theme: {
    theme: "default",
    themeHalves: { light: "default", dark: "default" },
    resolvedTheme: "dark",
    appearanceMode: "dark",
    setAppearanceMode: vi.fn(),
    setTheme: vi.fn(),
    setThemeHalf: vi.fn(),
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
  useParams: ({ select }: { select: (value: object) => unknown }) => select({}),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "keys" ? mocks.keybindings : []),
}));
vi.mock("../commandPaletteBus", () => ({
  onOpenCommandPalette: (callback: typeof mocks.open) => {
    mocks.open = callback;
    return () => {
      mocks.open = null;
    };
  },
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => mocks.theme }));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectSortOrder: "manual",
    sidebarThreadSortOrder: "newest",
    sidebarProjectGrouping: "none",
  }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeThread: null,
    activeDraftThread: null,
    defaultProjectRef: null,
    handleNewThread: mocks.operation,
  }),
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => null,
    scratchWorkspaceRootFor: () => null,
    startScratchThread: mocks.operation,
  }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => mocks.operation }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: vi.fn(),
}));
vi.mock("../state/queries", () => ({ useThreadSearch: () => ({ matches: [], isPending: false }) }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.operation }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.operation }));
vi.mock("../state/filesystem", () => ({ filesystemEnvironment: { browse: vi.fn() } }));
vi.mock("../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../state/threads", () => ({ threadEnvironment: { stopSession: "stop" } }));
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: {
    repository: "repository",
    cloneRepository: "clone",
    startProjectClone: "start",
    discovery: vi.fn(),
  },
}));
vi.mock("../state/server", () => ({
  serverEnvironment: { refreshProviders: "refresh" },
  primaryServerKeybindingsAtom: "keys",
  primaryServerProvidersAtom: "providers",
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: () => [],
  legacyProjectCwdPreferenceKey: (value: string) => value,
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: () => false,
  selectActiveRightPanel: () => null,
  PULL_REQUESTS_PANEL_REF: null,
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: () => false,
  selectThreadTerminalUiState: () => ({ terminalOpen: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));
vi.mock("./files/ProjectFilePicker", () => ({ ProjectFilePicker: () => null }));
vi.mock("./search/ProjectContentSearchDialog", () => ({ ProjectContentSearchDialog: () => null }));
vi.mock("./pullRequest/LinkPullRequestDialog", () => ({ openLinkPullRequestDialog: vi.fn() }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("./ui/command", async () => {
  const React = await import("react");
  type Item = CommandPaletteActionItem | CommandPaletteSubmenuItem;
  const Items = React.createContext<ReadonlyArray<Item>>([]);
  const Dialog = React.createContext(false);
  const Input = React.createContext<{ value: string; onValueChange: (value: string) => void }>({
    value: "",
    onValueChange: () => {},
  });
  const wrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    CommandDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
      <Dialog.Provider value={open}>{children}</Dialog.Provider>
    ),
    CommandDialogPopup: ({ children }: { children: React.ReactNode }) =>
      React.useContext(Dialog) ? <div>{children}</div> : null,
    Command: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) => {
      const input = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange]);
      return <Input.Provider value={input}>{children}</Input.Provider>;
    },
    CommandInput: ({ onKeyDown }: { onKeyDown: (event: unknown) => void }) => {
      const input = React.useContext(Input);
      return (
        <input
          value={input.value}
          onChange={(event) => input.onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      );
    },
    CommandGroup: ({
      items,
      children,
    }: {
      items: ReadonlyArray<Item>;
      children: React.ReactNode;
    }) => <Items.Provider value={items}>{children}</Items.Provider>,
    CommandCollection: ({ children }: { children: (item: Item) => React.ReactNode }) =>
      React.useContext(Items).map(children),
    CommandItem: ({
      value,
      onClick,
      children,
    }: {
      value: string;
      onClick: () => void;
      children: React.ReactNode;
    }) => (
      <button value={value} onClick={onClick}>
        {children}
      </button>
    ),
    CommandGroupLabel: wrapper,
    CommandList: wrapper,
    CommandShortcut: wrapper,
    CommandPanel: wrapper,
    CommandFooter: wrapper,
    CommandFooterAction: wrapper,
  };
});
import { CommandPalette } from "./CommandPalette";

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(KeybindingsConfig));
let renderer: ReactTestRenderer;
let keyboard: EventTarget;
class FocusElement {
  readonly isConnected = true;
  readonly tagName = "div";
  constructor(readonly owner: "drawer" | "preview") {}
  closest(selector: string) {
    return this.owner === "drawer" && selector === "[data-terminal-owner]"
      ? { dataset: { terminalOwner: "drawer" } }
      : this.owner === "preview" && selector === "[data-preview-panel-mode]"
        ? this
        : null;
  }
}
const press = async (key: string, overrides: Readonly<Record<string, unknown>> = {}) => {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  });
  await act(async () => {
    keyboard.dispatchEvent(event);
  });
  return event;
};
const open = async (query = "") => {
  await act(async () => mocks.open!({ query }));
};
const search = async (query: string) => {
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ target: { value: query } }),
  );
};
const rows = () =>
  renderer.root.findAllByType("button").filter((row) => typeof row.props.value === "string");
const values = () => rows().map((row) => row.props.value);
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Linux" });
  keyboard = new EventTarget();
  vi.stubGlobal("window", keyboard);
  vi.stubGlobal("HTMLElement", FocusElement);
  vi.stubGlobal("document", { activeElement: null });
  mocks.keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  mocks.navigate.mockReset().mockResolvedValue(undefined);
  mocks.operation.mockReset();
  await act(async () => {
    renderer = create(
      <CommandPalette>
        <span>App</span>
      </CommandPalette>,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([
  ["agent", "action:agents"],
  ["providers", "action:agents"],
  ["task", "action:tasks"],
  ["delegation", "action:tasks"],
])("searches %s and selects the existing route", async (query, value) => {
  await open();
  await search(query);
  expect(values()).toContain(value);
  const row = rows().find((item) => item.props.value === value)!;
  await act(async () => row.props.onClick());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: value === "action:agents" ? "/agents" : "/tasks",
  });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(mocks.operation).not.toHaveBeenCalled();
});
it("offers one of each in Actions, supports action-only search and preserves existing navigation", async () => {
  await open();
  expect(values().filter((value) => value === "action:agents")).toHaveLength(1);
  expect(values().filter((value) => value === "action:tasks")).toHaveLength(1);
  await search("> collaboration");
  expect(values().sort()).toEqual(["action:agents", "action:tasks"]);
  await search("> usage");
  await act(async () =>
    rows()
      .find((row) => row.props.value === "action:usage")!
      .props.onClick(),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/usage" });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  await open("settings");
  await act(async () =>
    rows()
      .find((row) => row.props.value === "action:settings")!
      .props.onClick(),
  );
  expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/settings" });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});

it.each([
  ["agents", "/agents"],
  ["tasks", "/tasks"],
])("closes before %s navigation finishes", async (query, route) => {
  let finish!: () => void;
  mocks.navigate.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await open(query);
  await act(async () =>
    rows()
      .find((row) => row.props.value === `action:${query}`)!
      .props.onClick(),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({ to: route });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  await act(async () => finish());
  expect(mocks.operation).not.toHaveBeenCalled();
});

it.each([
  ["a", "/agents"],
  ["t", "/tasks"],
] as const)(
  "dispatches a decoded custom %s chord through the existing navigation and closes first",
  async (key, route) => {
    mocks.keybindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig(
        decodeConfig(
          '[{"key":"ctrl+alt+a","command":"agents.open","when":"!terminalFocus && !previewFocus"},{"key":"ctrl+alt+t","command":"tasks.open","when":"!terminalFocus && !previewFocus"}]',
        ),
      ),
    );
    await act(async () =>
      renderer.update(
        <CommandPalette>
          <span>App</span>
        </CommandPalette>,
      ),
    );
    let finish!: () => void;
    mocks.navigate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await open();
    const event = await press(key);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: route });
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(mocks.operation).not.toHaveBeenCalled();
    await act(async () => finish());
  },
);
it("honors customized focus conditions, repeat, composition and already consumed events", async () => {
  mocks.keybindings = compileResolvedKeybindingsConfig(
    decodeConfig(
      '[{"key":"ctrl+alt+a","command":"agents.open","when":"!terminalFocus && !previewFocus"}]',
    ),
  );
  await act(async () =>
    renderer.update(
      <CommandPalette>
        <span>App</span>
      </CommandPalette>,
    ),
  );
  for (const owner of ["drawer", "preview"] as const) {
    vi.stubGlobal("document", { activeElement: new FocusElement(owner) });
    expect((await press("a")).defaultPrevented).toBe(false);
  }
  vi.stubGlobal("document", { activeElement: null });
  await press("a", { repeat: true });
  await press("a", { isComposing: true });
  const consumed = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "a",
    ctrlKey: true,
    altKey: true,
  });
  consumed.preventDefault();
  await act(async () => {
    keyboard.dispatchEvent(consumed);
  });
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.operation).not.toHaveBeenCalled();
  await press("a");
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
});
it("preserves legacy default palette navigation and leaves new navigation unbound by default", async () => {
  expect(
    DEFAULT_RESOLVED_KEYBINDINGS.some(
      (binding) => binding.command === "agents.open" || binding.command === "tasks.open",
    ),
  ).toBe(false);
  await press("k", { altKey: false });
  expect(renderer.root.findAllByType("input")).toHaveLength(1);
  await search("tasks");
  await act(async () =>
    rows()
      .find((row) => row.props.value === "action:tasks")!
      .props.onClick(),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/tasks" });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  mocks.navigate.mockClear();
  await press("a");
  await press("t");
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.operation).not.toHaveBeenCalled();
});
