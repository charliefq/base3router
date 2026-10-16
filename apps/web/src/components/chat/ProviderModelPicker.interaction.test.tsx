import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (value: object) => unknown) => select({ favorites: [] }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../../keybindings", () => ({
  shortcutLabelForCommand: () => null,
  modelPickerJumpCommandForIndex: () => null,
  modelPickerJumpIndexFromCommand: () => null,
  resolveShortcutCommand: () => null,
}));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./ChatGptSharingControl", () => ({ ChatGptSharingControl: () => null }));
vi.mock("./ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./ModelPickerSidebar", () => ({ ModelPickerSidebar: () => null }));
vi.mock("./ModelListRow", () => ({ ModelListRow: () => null }));
vi.mock("../ui/button", () => ({ Button: "button", InlineButton: "button" }));
vi.mock("./ComposerControl", () => ({
  ComposerControl: "button",
  ComposerControlChevron: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", async () => {
  const React = await import("react");
  const Context = React.createContext(false);
  return {
    Popover: ({ children, open }: { children: React.ReactNode; open: boolean }) => (
      <Context.Provider value={open}>{children}</Context.Provider>
    ),
    PopoverTrigger: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement;
    }) => React.cloneElement(render, {}, children),
    PopoverPopup: ({ children }: { children: React.ReactNode }) =>
      React.useContext(Context) ? children : null,
  };
});
vi.mock("../ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => children,
  ComboboxSearchInput: "input",
  ComboboxListVirtualized: ({ children }: { children: React.ReactNode }) => children,
  ComboboxEmpty: () => null,
  ComboboxItem: "div",
}));
vi.mock("@legendapp/list/react", () => ({ LegendList: () => null }));

const instanceId = ProviderInstanceId.make("openrouter-team");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("openrouter"),
  displayName: "Team OpenRouter",
  enabled: true,
  installed: true,
  status: "ready",
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-16T00:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const entries = deriveProviderInstanceEntries([provider]);
const models = [
  { slug: "vendor/one", name: "One" },
  { slug: "vendor/two", name: "Two" },
  { slug: "vendor/blocked", name: "Blocked" },
];
let renderer: ReactTestRenderer;
let saved = { routingMode: "manual" as "auto" | "manual", instanceId, model: "vendor/one" };
const selected = vi.fn();
function Harness() {
  const [choice, setChoice] = useState(saved);
  const [open, setOpen] = useState(true);
  return (
    <ProviderModelPicker
      activeInstanceId={choice.instanceId}
      model={choice.model}
      routingMode={choice.routingMode}
      onRoutingModeChange={(routingMode) =>
        setChoice((current) => (saved = { ...current, routingMode }))
      }
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map([[instanceId, models]])}
      open={open}
      onOpenChange={setOpen}
      getModelDisabledReason={(_, model) =>
        model === "vendor/blocked" ? "Fixture policy denied" : null
      }
      onInstanceModelChange={(selectedInstanceId, model) => {
        selected(selectedInstanceId, model);
        setChoice((current) => (saved = { ...current, instanceId: selectedInstanceId, model }));
      }}
    />
  );
}
beforeEach(() => {
  saved = { routingMode: "manual", instanceId, model: "vendor/one" };
  selected.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    innerWidth: 1024,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: vi.fn(),
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: { style: {}, clientWidth: 1024 },
    body: { style: {} },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
const cards = () =>
  renderer.root.findByProps({ "aria-label": "Model cards" }).findAllByType("button");
it("selects the actual catalog identity, closes the picker, and retains it on remount", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(
    renderer.root.findByProps({ "data-chat-provider-model-picker": "true" }).props["aria-label"],
  ).toBe("Model routing: Manual, Team OpenRouter: One (vendor/one)");
  expect(cards()[2]!.props.disabled).toBe(true);
  await act(async () => {
    const select = cards()[1]!.props.onClick;
    select();
    select();
  });
  expect(selected).toHaveBeenCalledExactlyOnceWith(instanceId, "vendor/two");
  expect(saved).toEqual({ routingMode: "manual", instanceId, model: "vendor/two" });
  expect(
    renderer.root.findByProps({ "data-chat-provider-model-picker": "true" }).props["aria-label"],
  ).toBe("Model routing: Manual, Team OpenRouter: Two (vendor/two)");
  expect(renderer.root.findAllByProps({ "aria-label": "Model cards" })).toHaveLength(0);
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(
    cards().find((card) => card.props["aria-label"].startsWith("Two ·"))!.props["aria-pressed"],
  ).toBe(true);
});
it("keeps the saved binding when switching Auto and back, and Escape cancels without selecting", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const mode = (name: string) =>
    renderer.root.findAllByType("button").find((button) => button.children.join("") === name)!;
  await act(async () => mode("Auto").props.onClick());
  expect(saved).toEqual({ routingMode: "auto", instanceId, model: "vendor/one" });
  expect(renderer.root.findAllByProps({ "aria-label": "Model cards" })).toHaveLength(0);
  await act(async () => mode("Manual").props.onClick());
  await act(async () =>
    renderer.root
      .findByType("input")
      .props.onKeyDown({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() }),
  );
  expect(selected).not.toHaveBeenCalled();
  expect(saved).toEqual({ routingMode: "manual", instanceId, model: "vendor/one" });
});
it("moves keyboard focus between enabled cards and skips denied models", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const first = { focus: vi.fn() };
  const second = { focus: vi.fn() };
  const target = Object.assign(first, {
    parentElement: { querySelectorAll: () => [first, second] },
  });
  await act(async () =>
    cards()[0]!.props.onKeyDown({
      key: "ArrowRight",
      currentTarget: target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }),
  );
  expect(second.focus).toHaveBeenCalledOnce();
  expect(selected).not.toHaveBeenCalled();
});
