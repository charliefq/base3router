import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type ServerProvider,
  type TaskContractReviewInput,
} from "@t3tools/contracts";

import { TaskRevisionRequest } from "./TaskRevisionRequest";
import { completed as completedResult } from "./testkit/resultContinuationJourney";
import { continuationStorageKey } from "./taskFirstLaunchAttempt";
import { TaskFirstInstructions } from "./TaskFirstInstructions";
import { AgentsTaskCreator } from "./AgentsTaskCreator";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
import { readAgentsCreationAttempt } from "./agentsTaskCreationAttempt";
import { readFirstLaunchAttempt, firstLaunchStorageKey } from "./taskFirstLaunchAttempt";

type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
const state = vi.hoisted(() => ({
  fixture: null as Fixture | null,
  providers: [] as ReadonlyArray<ServerProvider>,
  create: vi.fn(),
  projection: vi.fn(),
  review: vi.fn(),
  creationStatus: vi.fn(),
  launchStatus: vi.fn(),
  continuationStatus: vi.fn(),
  start: vi.fn(),
  configuration: vi.fn(),
  catalog: vi.fn(),
  configurationStatus: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "providers" ? state.providers : {}),
}));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: "providers",
  primaryServerKeybindingsAtom: "keys",
  serverEnvironment: { configValueAtom: () => "upload-config" },
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(() => {
    throw new Error("No-file exact-model journey must not upload");
  }),
  releaseDraftAttachment: vi.fn(),
  useAttachmentUploadStore: (
    select: (state: { uploadsByImageId: Record<string, never> }) => unknown,
  ) => select({ uploadsByImageId: {} }),
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return { usePreparedConnection: () => Option.fromNullishOr(state.fixture?.identity()) };
});
vi.mock("../../state/workflow", () => ({
  workflowEnvironment: {
    configurationAction: "configuration",
    readCatalog: "catalog",
    configurationStatus: "configurationStatus",
  },
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    create: "create",
    readProjection: "projection",
    readTaskReview: "review",
    readCreationStatus: "creationStatus",
    readFirstLaunchStatus: "launchStatus",
    readResultContinuationStatus: "continuationStatus",
    startTurn: "start",
    readAutoPreview: "preview",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (tag: string) => (state as unknown as Record<string, unknown>)[tag],
}));
vi.mock("./TaskCapabilityStepControls", () => ({ TaskCapabilityStepControls: () => null }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/alert-dialog", async () => {
  const React = await import("react");
  const C = React.createContext(false);
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
      <C.Provider value={open}>{children}</C.Provider>
    ),
    AlertDialogPopup: ({ children }: { children: React.ReactNode }) =>
      React.useContext(C) ? <section>{children}</section> : null,
    AlertDialogHeader: "div",
    AlertDialogTitle: "h3",
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogFooter: "div",
  };
});
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
vi.mock("../chat/composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("../chat/ChatGptSharingControl", () => ({ ChatGptSharingControl: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../chat/ModelPickerSidebar", () => ({ ModelPickerSidebar: () => null }));

vi.mock("../ui/button", () => ({ Button: "button", InlineButton: "button" }));
vi.mock("../chat/ComposerControl", () => ({
  ComposerControl: "button",
  ComposerControlChevron: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactNode;
  }) => render ?? children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", async () => {
  const React = await import("react");
  const C = React.createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => {
      const value = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
      return <C.Provider value={value}>{children}</C.Provider>;
    },
    PopoverTrigger: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement;
    }) => {
      const c = React.useContext(C);
      return React.cloneElement(
        render as React.ReactElement<{ onClick: () => void }>,
        { onClick: () => c.onOpenChange(!c.open) },
        children,
      );
    },
    PopoverPopup: ({ children }: { children: React.ReactNode }) =>
      React.useContext(C).open ? children : null,
  };
});
vi.mock("../ui/combobox", async () => {
  const React = await import("react");
  const C = React.createContext((_value: string) => {});
  return {
    Combobox: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange: (value: string, details: { event: object }) => void;
    }) => {
      const select = React.useCallback(
        (value: string) => onValueChange(value, { event: {} }),
        [onValueChange],
      );
      return <C.Provider value={select}>{children}</C.Provider>;
    },
    ComboboxSearchInput: "input",
    ComboboxListVirtualized: ({ children }: { children: React.ReactNode }) => children,
    ComboboxEmpty: () => null,
    ComboboxItem: ({
      value,
      disabled,
      children,
    }: {
      value: string;
      disabled?: boolean;
      children: React.ReactNode;
    }) => {
      const select = React.useContext(C);
      return (
        <button
          disabled={disabled}
          data-model-value={value}
          onClick={() => !disabled && select(value)}
        >
          {children}
        </button>
      );
    },
  };
});
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: ReadonlyArray<string>;
    renderItem: (value: { item: string; index: number }) => React.ReactNode;
  }) => (
    <>
      {data.map((item, index) => (
        <div key={item}>{renderItem({ item, index })}</div>
      ))}
    </>
  ),
}));

let renderer: ReactTestRenderer;
let records: Map<string, string>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  records = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => records.get(k) ?? null,
    setItem: (k: string, v: string) => records.set(k, v),
    removeItem: (k: string) => records.delete(k),
  });
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
  for (const mock of [
    state.create,
    state.projection,
    state.review,
    state.creationStatus,
    state.launchStatus,
    state.continuationStatus,
    state.start,
    state.configuration,
    state.catalog,
    state.configurationStatus,
  ])
    mock.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  state.fixture = null;
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.join("") === name);
const click = async (name: string, twice = false) => {
  await act(async () => {
    const b = button(name);
    if (!b) throw new Error(`Missing ${name}`);
    expect(b.props.disabled).not.toBe(true);
    b.props.onClick();
    if (twice) b.props.onClick();
  });
};
const wire = (f: Fixture) => {
  state.fixture = f;
  state.providers = f.providers;
  state.configuration.mockImplementation(
    ({ input }: { input: Parameters<Fixture["configuration"]>[0] }) => f.configuration(input),
  );
  state.catalog.mockImplementation(({ input }: { input: Parameters<Fixture["catalog"]>[0] }) =>
    f.catalog(input),
  );
  state.configurationStatus.mockImplementation(
    ({ input }: { input: Parameters<Fixture["configurationStatus"]>[0] }) =>
      f.configurationStatus(input),
  );
  state.create.mockImplementation(({ input }: { input: Parameters<Fixture["create"]>[0] }) =>
    f.create(input),
  );
  state.projection.mockImplementation(
    ({ input }: { input: Parameters<Fixture["projection"]>[0] }) => f.projection(input),
  );
  state.review.mockImplementation(({ input }: { input: TaskContractReviewInput }) =>
    f.review(input),
  );
  state.creationStatus.mockImplementation(
    ({ input }: { input: Parameters<Fixture["creationStatus"]>[0] }) => f.creationStatus(input),
  );
  state.continuationStatus.mockImplementation(
    ({ input }: { input: Parameters<Fixture["continuationStatus"]>[0] }) =>
      f.continuationStatus(input),
  );
  state.launchStatus.mockImplementation(
    ({ input }: { input: Parameters<Fixture["launchStatus"]>[0] }) => f.launchStatus(input),
  );
  state.start.mockImplementation(({ input }: { input: Parameters<Fixture["start"]>[0] }) =>
    f.start(input),
  );
};
const fields = async () => {
  for (const [label, value] of Object.entries({
    "Task title": "Exact UI transport",
    Goal: "Fix the chosen model path",
    Redirect: "Stay in fixture scope",
    Acceptance: "Owner checks output",
    "Provider start limit": "3",
    "Stop conditions": "Scope changed",
  }))
    await act(async () =>
      renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
    );
};
const selectModel = async (model: string) => {
  await act(async () =>
    renderer.root.findByProps({ "data-chat-provider-model-picker": "true" }).props.onClick(),
  );
  const item = renderer.root
    .findAllByType("button")
    .find(
      (b) =>
        typeof b.props["data-model-value"] === "string" &&
        b.props["data-model-value"].includes(model),
    );
  expect(item).toBeDefined();
  await act(async () => item!.props.onClick());
};
it.each(["manual", "auto"] as const)(
  "mounted saved configuration flow freezes visible input, creates two tasks, and separately starts one through actual %s transport",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      wire(f);
      const refresh = vi.fn(f.snapshot);
      const props = {
        environmentId: EnvironmentId.make("environment-a"),
        project: { id: "project-a", title: "Fixture" },
        providers: f.providers,
        request: { providerId: "codex", token: "configuration-task-one" },
        onLock: vi.fn(),
        onRelease: vi.fn(),
        onOpen: vi.fn(),
        refresh,
      };
      await act(async () => {
        renderer = create(<AgentsTaskCreator {...props} />);
      });
      await fields();
      await selectModel("exact-second");
      for (const [label, value] of [
        ["Configuration name", "Careful reviewer"],
        ["Working instructions", "Read the bounded source and report evidence."],
      ])
        await act(async () =>
          renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
        );
      await click("Save new configuration", true);
      await act(async () => {
        await state.configuration.mock.results[0]!.value;
      });
      expect(state.configuration).toHaveBeenCalledTimes(1);
      await click("Use saved configuration Careful reviewer r1");
      await click("Review new task");
      expect(JSON.stringify(renderer.toJSON())).toContain("Careful reviewer");
      expect(JSON.stringify(renderer.toJSON())).toContain(
        "Read the bounded source and report evidence.",
      );
      expect((await f.inspect()).starts).toHaveLength(0);
      await click("Create task");
      await act(async () => {
        await state.create.mock.results[0]!.value;
        await Promise.all([
          refresh.mock.results.at(-1)!.value,
          state.projection.mock.results.at(-1)!.value,
        ]);
      });
      const first = readAgentsCreationAttempt().attempt!.command;
      expect(first.taskCreationReview!.configuration!.revision).toBe(1);
      await act(async () =>
        renderer.update(
          <AgentsTaskCreator
            {...props}
            request={{ providerId: "codex", token: "configuration-task-two" }}
          />,
        ),
      );
      await fields();
      await click("Load saved configurations");
      await act(async () => {
        await state.catalog.mock.results.at(-1)!.value;
      });
      await click("Use saved configuration Careful reviewer r1");
      await click("Review new task");
      await click("Create task");
      await act(async () => {
        await state.create.mock.results[1]!.value;
        await Promise.all([
          refresh.mock.results.at(-1)!.value,
          state.projection.mock.results.at(-1)!.value,
        ]);
      });
      const second = readAgentsCreationAttempt().attempt!.command;
      expect(second.threadId).not.toBe(first.threadId);
      expect(second.taskCreationReview!.configuration).toEqual(
        first.taskCreationReview!.configuration,
      );
      expect((await f.snapshot()).tasks).toHaveLength(2);
      expect((await f.inspect()).starts).toHaveLength(0);
      const reads = state.review.mock.results.length;
      await click("Prepare created task for review/start");
      await act(async () => {
        await state.review.mock.results[reads]!.value;
        await state.projection.mock.results.at(-1)!.value;
        await state.review.mock.results[reads + 1]!.value;
      });
      const initial = renderer.root.findByProps({ "aria-label": "Initial instructions" });
      expect(initial.props.value).toBe(second.taskCreationReview!.effectiveInstructions);
      expect(initial.props.disabled).toBe(true);
      await click(mode === "manual" ? "Choose Manual" : "Choose Auto");
      await click("Review ordinary task launch");
      if (mode === "auto")
        f.setProviders([
          {
            ...f.providers[0]!,
            models: [
              {
                ...f.providers[0]!.models[0]!,
                slug: "aaa-configured-auto",
                name: "Actual configured Auto",
              },
              ...f.providers[0]!.models,
            ],
          },
        ]);
      await click("Start reviewed ordinary task", true);
      await act(async () => {
        await state.start.mock.results[0]!.value;
        await state.launchStatus.mock.results.at(-1)!.value;
      });
      await f.drain();
      await click("Read original launch status");
      await act(async () => {
        await state.launchStatus.mock.results.at(-1)!.value;
      });
      expect((await f.inspect()).inputs).toEqual([
        second.taskCreationReview!.effectiveInstructions,
      ]);
      expect(JSON.stringify(renderer.toJSON())).toContain(
        "Transport answer: Read the bounded source and report evidence.",
      );
      expect(state.start).toHaveBeenCalledTimes(1);
      expect((await f.inspect()).starts[0]!.model).toBe(
        mode === "auto" ? "aaa-configured-auto" : "exact-second",
      );
      expect(second.taskCreationReview!.configuration!.modelSelection.model).toBe("exact-second");
    });
  },
  30000,
);
it("mounted lost configuration reply retains its original identity after remount and reads recovery without resend", async () => {
  await withTaskTransportFixture(async (f) => {
    wire(f);
    const props = {
      environmentId: EnvironmentId.make("environment-a"),
      project: { id: "project-a", title: "Fixture" },
      providers: f.providers,
      request: { providerId: "codex", token: "lost-configuration-task" },
      onLock: vi.fn(),
      onRelease: vi.fn(),
      onOpen: vi.fn(),
      refresh: f.snapshot,
    };
    await act(async () => {
      renderer = create(<AgentsTaskCreator {...props} />);
    });
    await fields();
    await selectModel("exact-second");
    for (const [label, value] of [
      ["Configuration name", "Lost reply"],
      ["Working instructions", "Retain the original reviewed identity."],
    ])
      await act(async () =>
        renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
      );
    f.dropNextReply();
    await click("Save new configuration");
    await Promise.race([
      f.awaitDroppedReply(),
      state.configuration.mock.results[0]!.value.then(() => {
        throw new Error("No drop");
      }),
    ]);
    const original = state.configuration.mock.calls[0]![0].input;
    await act(async () => renderer.unmount());
    await f.disconnect();
    await state.configuration.mock.results[0]!.value;
    await f.connect();
    await act(async () => {
      renderer = create(<AgentsTaskCreator {...props} />);
    });
    expect(button("Review new task")!.props.disabled).toBe(true);
    await click("Recover saved configuration");
    await act(async () => {
      await state.configurationStatus.mock.results[0]!.value;
    });
    expect(state.configurationStatus.mock.calls[0]![0].input).toEqual(original);
    expect(state.configuration).toHaveBeenCalledTimes(1);
    await click("Load saved configurations");
    await act(async () => {
      await state.catalog.mock.results.at(-1)!.value;
    });
    expect(button("Use saved configuration Lost reply r1")).toBeDefined();
    expect((await f.inspect()).starts).toHaveLength(0);
    expect(state.create).not.toHaveBeenCalled();
  });
}, 30000);

it.each(["edit", "archive"] as const)(
  "mounted selected configuration fails closed after a concurrent %s",
  async (operation) => {
    await withTaskTransportFixture(async (f) => {
      wire(f);
      const props = {
        environmentId: EnvironmentId.make("environment-a"),
        project: { id: "project-a", title: "Fixture" },
        providers: f.providers,
        request: { providerId: "codex", token: `stale-configuration-${operation}` },
        onLock: vi.fn(),
        onRelease: vi.fn(),
        onOpen: vi.fn(),
        refresh: f.snapshot,
      };
      await act(async () => {
        renderer = create(<AgentsTaskCreator {...props} />);
      });
      await fields();
      await selectModel("exact-second");
      for (const [label, value] of [
        ["Configuration name", "Selected revision"],
        ["Working instructions", "Only this reviewed input."],
      ])
        await act(async () =>
          renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
        );
      await click("Save new configuration");
      await act(async () => {
        await state.configuration.mock.results[0]!.value;
      });
      const original = state.configuration.mock.calls[0]![0].input;
      await click("Use saved configuration Selected revision r1");
      const concurrent =
        operation === "edit"
          ? {
              ...original,
              commandId: "concurrent-edit",
              expectedVersion: 1,
              draft: { ...original.draft, instructions: "Different future instructions." },
            }
          : {
              type: "profile.archive" as const,
              commandId: "concurrent-archive",
              projectId: original.projectId,
              profileId: original.draft.id,
              expectedVersion: 1,
            };
      expect((await f.configuration(concurrent))._tag).toBe("Success");
      await click("Review new task");
      await click("Create task");
      await act(async () => {
        await state.create.mock.results[0]!.value;
      });
      expect((await state.create.mock.results[0]!.value)._tag).toBe("Failure");
      expect(
        readAgentsCreationAttempt().attempt!.command.taskCreationReview!.configuration!.revision,
      ).toBe(1);
      expect((await f.snapshot()).tasks).toHaveLength(0);
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it("mounted save/edit/archive/restore keeps selection explicit and preserves revision identity", async () => {
  await withTaskTransportFixture(async (f) => {
    wire(f);
    const props = {
      environmentId: EnvironmentId.make("environment-a"),
      project: { id: "project-a", title: "Fixture" },
      providers: f.providers,
      request: { providerId: "codex", token: "configuration-controls" },
      onLock: vi.fn(),
      onRelease: vi.fn(),
      onOpen: vi.fn(),
      refresh: f.snapshot,
    };
    await act(async () => {
      renderer = create(<AgentsTaskCreator {...props} />);
    });
    await fields();
    await selectModel("exact-second");
    for (const [label, value] of [
      ["Configuration name", "Reusable input"],
      ["Working instructions", "First reviewed instruction."],
    ])
      await act(async () =>
        renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
      );
    await click("Save new configuration");
    await act(async () => {
      await state.configuration.mock.results.at(-1)!.value;
    });
    await click("Use saved configuration Reusable input r1");
    await click("Edit saved configuration Reusable input");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Working instructions" })
        .props.onChange({ target: { value: "Second reviewed instruction." } }),
    );
    await click("Save configuration revision");
    await act(async () => {
      await state.configuration.mock.results.at(-1)!.value;
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Selected saved configuration: ");
    await click("Review new task");
    expect(JSON.stringify(renderer.toJSON())).toContain("First reviewed instruction.");
    await click("Back to task draft");
    await click("Use saved configuration Reusable input r2");
    await click("Archive saved configuration Reusable input");
    await act(async () => {
      await state.configuration.mock.results.at(-1)!.value;
    });
    expect(button("Use saved configuration Reusable input r2")!.props.disabled).toBe(true);
    await click("Restore saved configuration Reusable input");
    await act(async () => {
      await state.configuration.mock.results.at(-1)!.value;
    });
    await click("Use saved configuration Reusable input r2");
    await click("Review new task");
    expect(JSON.stringify(renderer.toJSON())).toContain("Second reviewed instruction.");
    expect(state.configuration).toHaveBeenCalledTimes(4);
    expect((await f.inspect()).starts).toHaveLength(0);
    expect(state.create).not.toHaveBeenCalled();
  });
}, 30000);

it.each(["manual", "auto"] as const)(
  "real picker creation and production client %s transport reach exact correlated result and reconnect",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      wire(f);
      const onOpen = vi.fn();
      const refresh = vi.fn(f.snapshot);
      const token = 1;
      const props = {
        environmentId: EnvironmentId.make("environment-a"),
        project: { id: "project-a", title: "Fixture" },
        providers: f.providers,
        request: { providerId: "codex", token: `picker-${mode}-${token}` },
        onLock: vi.fn(),
        onRelease: vi.fn(),
        onOpen,
        refresh,
      };
      await act(async () => {
        renderer = create(<AgentsTaskCreator {...props} />);
      });
      await fields();
      expect(button("Review new task")!.props.disabled).toBe(true);
      await selectModel("exact-second");
      expect(button("Review new task")!.props.disabled).toBe(false);
      await click("Review new task");
      expect(JSON.stringify(renderer.toJSON())).toContain("exact-second");
      expect(state.create).not.toHaveBeenCalled();
      expect((await f.inspect()).starts).toHaveLength(0);
      await click("Create task", true);
      await act(async () => {
        await state.create.mock.results[0]!.value;
        await Promise.all([
          refresh.mock.results.at(-1)!.value,
          state.projection.mock.results.at(-1)!.value,
        ]);
      });
      expect(state.create).toHaveBeenCalledTimes(1);
      const original = readAgentsCreationAttempt().attempt!.command;
      expect(original.modelSelection.model).toBe("exact-second");
      expect((await f.inspect()).starts).toHaveLength(0);
      const reads = state.review.mock.results.length;
      await click("Prepare created task for review/start");
      await act(async () => {
        await state.review.mock.results[reads]!.value;
        await state.projection.mock.results.at(-1)!.value;
        await state.review.mock.results[reads + 1]!.value;
      });
      const instructions = "Use this exact entered instruction through the real transport.";
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Initial instructions" })
          .props.onChange({ target: { value: instructions } }),
      );
      await click(mode === "manual" ? "Choose Manual" : "Choose Auto");
      await click("Review ordinary task launch");
      if (mode === "auto")
        f.setProviders([
          {
            ...f.providers[0]!,
            models: [
              { ...f.providers[0]!.models[0]!, slug: "aaa-after-review", name: "Actual Auto" },
              ...f.providers[0]!.models,
            ],
          },
        ]);
      await click("Start reviewed ordinary task", true);
      await act(async () => {
        await state.start.mock.results[0]!.value;
        await state.launchStatus.mock.results.at(-1)!.value;
      });
      await f.drain();
      const saved = readFirstLaunchAttempt(
        firstLaunchStorageKey("environment-a", original.threadId),
      ).attempt!;
      expect(saved.command.taskFirstLaunch?.modelSelection.model).toBe("exact-second");
      await click("Read original launch status");
      await act(async () => {
        await state.launchStatus.mock.results.at(-1)!.value;
      });
      const prose = JSON.stringify(renderer.toJSON());
      expect(prose).toContain("run status");
      expect(prose).toContain("completed");
      expect(prose).toContain(`Transport answer: ${instructions}`);
      const after = await f.projection({ threadId: original.threadId });
      if (after._tag !== "Success") throw new Error("Missing actual RPC projection");
      expect(after.value.messages[0]!.id).toBe(saved.command.messageId);
      expect(after.value.thread.taskAcceptedRevision).toBeNull();
      const actual = await f.inspect();
      expect(actual.inputs).toEqual([instructions]);
      expect(actual.starts).toHaveLength(1);
      expect(actual.starts[0]!.model).toBe(mode === "manual" ? "exact-second" : "aaa-after-review");
      expect(actual.commands.map((c) => c.commandId)).toEqual([
        original.commandId,
        saved.command.commandId,
      ]);
      await act(async () => {
        renderer.unmount();
      });
      await f.disconnect();
      await f.connect();
      await act(async () => {
        renderer = create(<AgentsTaskCreator {...props} request={null} />);
      });
      await click("Recover task creation");
      await act(async () => {
        await state.creationStatus.mock.results.at(-1)!.value;
        await state.projection.mock.results.at(-1)?.value;
      });
      expect(readAgentsCreationAttempt().attempt!.command.commandId).toBe(original.commandId);
      expect(
        readFirstLaunchAttempt(firstLaunchStorageKey("environment-a", original.threadId)).attempt!
          .command.commandId,
      ).toBe(saved.command.commandId);
      expect((await f.inspect()).starts).toHaveLength(1);
      expect(state.start).toHaveBeenCalledTimes(1);
    });
  },
  30000,
);

it.each(["creation", "launch"] as const)(
  "lost %s reply over actual socket retains original storage through disconnect/remount and only reads recovery",
  async (stage) => {
    await withTaskTransportFixture(async (f) => {
      wire(f);
      const refresh = vi.fn(f.snapshot);
      const props = {
        environmentId: EnvironmentId.make("environment-a"),
        project: { id: "project-a", title: "Fixture" },
        providers: f.providers,
        request: { providerId: "codex", token: `lost-${stage}` },
        onLock: vi.fn(),
        onRelease: vi.fn(),
        onOpen: vi.fn(),
        refresh,
      };
      await act(async () => {
        renderer = create(<AgentsTaskCreator {...props} />);
      });
      await fields();
      await selectModel("exact-second");
      await click("Review new task");
      if (stage === "creation") f.dropNextReply();
      await click("Create task", true);
      if (stage === "launch") {
        await act(async () => {
          await state.create.mock.results[0]!.value;
          await Promise.all([
            refresh.mock.results.at(-1)!.value,
            state.projection.mock.results.at(-1)!.value,
          ]);
        });
        const n = state.review.mock.results.length;
        await click("Prepare created task for review/start");
        await act(async () => {
          await state.review.mock.results[n]!.value;
          await state.projection.mock.results.at(-1)!.value;
          await state.review.mock.results[n + 1]!.value;
        });
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "Initial instructions" })
            .props.onChange({ target: { value: "Keep my original transport launch identity." } }),
        );
        await click("Choose Manual");
        await click("Review ordinary task launch");
        f.dropNextReply();
        await click("Start reviewed ordinary task", true);
      }
      await Promise.race([
        f.awaitDroppedReply(),
        (stage === "creation" ? state.create : state.start).mock.results[0]!.value.then(
          (result: unknown) => {
            throw new Error(`Expected committed response drop; received ${String(result)}`);
          },
        ),
      ]);
      const original = readAgentsCreationAttempt().attempt!.command;
      const launchKey = firstLaunchStorageKey("environment-a", original.threadId);
      const retained = readFirstLaunchAttempt(launchKey).attempt?.command;
      await act(async () => {
        await f.disconnect();
        await (stage === "creation" ? state.create : state.start).mock.results[0]!.value;
        renderer.unmount();
      });
      await f.connect();
      const before = (await f.inspect()).commands.length;
      if (stage === "creation") {
        await act(async () => {
          renderer = create(<AgentsTaskCreator {...props} request={null} />);
        });
        await click("Recover task creation");
        await act(async () => {
          await state.creationStatus.mock.results.at(-1)!.value;
          await Promise.all([
            refresh.mock.results.at(-1)!.value,
            state.projection.mock.results.at(-1)!.value,
          ]);
        });
        expect(readAgentsCreationAttempt().attempt!.status).toBe("confirmed");
        expect((await f.inspect()).starts).toHaveLength(0);
      } else {
        await f.drain();
        const task = (await f.snapshot()).tasks.find((t) => t.threadId === original.threadId)!;
        await act(async () => {
          renderer = create(
            <TaskFirstInstructions
              task={task}
              environmentId={EnvironmentId.make("environment-a")}
              stale={false}
              readVersion={2}
              onOpen={vi.fn()}
            />,
          );
        });
        expect(JSON.stringify(renderer.toJSON())).toContain("UNKNOWN until reconciled");
        await click("Read original launch status");
        await act(async () => {
          await state.launchStatus.mock.results.at(-1)!.value;
        });
        expect(JSON.stringify(renderer.toJSON())).toContain(
          "Transport answer: Keep my original transport launch identity.",
        );
        expect(readFirstLaunchAttempt(launchKey).attempt!.command.commandId).toBe(
          retained!.commandId,
        );
        expect((await f.inspect()).starts).toHaveLength(1);
      }
      expect((await f.inspect()).commands).toHaveLength(before);
      expect(readAgentsCreationAttempt().attempt!.command.commandId).toBe(original.commandId);
      expect(state.create).toHaveBeenCalledTimes(1);
      expect(state.start).toHaveBeenCalledTimes(stage === "launch" ? 1 : 0);
    });
  },
  30000,
);

it.each(["creation", "launch"] as const)(
  "disconnected %s send keeps production recovery storage UNKNOWN without admission or resend",
  async (stage) => {
    await withTaskTransportFixture(async (f) => {
      wire(f);
      const refresh = vi.fn(f.snapshot);
      const props = {
        environmentId: EnvironmentId.make("environment-a"),
        project: { id: "project-a", title: "Fixture" },
        providers: f.providers,
        request: { providerId: "codex", token: `unknown-${stage}` },
        onLock: vi.fn(),
        onRelease: vi.fn(),
        onOpen: vi.fn(),
        refresh,
      };
      await act(async () => {
        renderer = create(<AgentsTaskCreator {...props} />);
      });
      await fields();
      await selectModel("exact-second");
      await click("Review new task");
      let task: Awaited<ReturnType<Fixture["snapshot"]>>["tasks"][number] | undefined;
      if (stage === "launch") {
        await click("Create task");
        await act(async () => {
          await state.create.mock.results[0]!.value;
          await Promise.all([
            refresh.mock.results.at(-1)!.value,
            state.projection.mock.results.at(-1)!.value,
          ]);
        });
        task = (await f.snapshot()).tasks[0]!;
        const n = state.review.mock.results.length;
        await click("Prepare created task for review/start");
        await act(async () => {
          await state.review.mock.results[n]!.value;
          await state.projection.mock.results.at(-1)!.value;
          await state.review.mock.results[n + 1]!.value;
        });
        await click("Choose Manual");
        await click("Review ordinary task launch");
      }
      await f.disconnect();
      await click(stage === "creation" ? "Create task" : "Start reviewed ordinary task");
      await act(async () => {
        await (stage === "creation" ? state.create : state.start).mock.results[0]!.value;
        renderer.unmount();
      });
      const original = readAgentsCreationAttempt().attempt!.command;
      const key = firstLaunchStorageKey("environment-a", original.threadId);
      const launch = readFirstLaunchAttempt(key).attempt?.command;
      await f.connect();
      const before = (await f.inspect()).commands.length;
      if (stage === "creation") {
        await act(async () => {
          renderer = create(<AgentsTaskCreator {...props} request={null} />);
        });
        await click("Recover task creation");
        await act(async () => {
          await state.creationStatus.mock.results.at(-1)!.value;
        });
        expect(readAgentsCreationAttempt().attempt!.status).toBe("uncertain");
        expect((await f.snapshot()).tasks).toHaveLength(0);
      } else {
        await act(async () => {
          renderer = create(
            <TaskFirstInstructions
              task={task!}
              environmentId={EnvironmentId.make("environment-a")}
              stale={false}
              readVersion={2}
              onOpen={vi.fn()}
            />,
          );
        });
        await click("Read original launch status");
        await act(async () => {
          await state.launchStatus.mock.results.at(-1)!.value;
        });
        expect(readFirstLaunchAttempt(key).attempt!.status).toBe("unknown");
        expect(readFirstLaunchAttempt(key).attempt!.command.commandId).toBe(launch!.commandId);
      }
      expect((await f.inspect()).commands).toHaveLength(before);
      expect((await f.inspect()).starts).toHaveLength(0);
      expect(readAgentsCreationAttempt().attempt!.command.commandId).toBe(original.commandId);
    });
  },
  30000,
);

async function prepareResultReview(load: ReturnType<typeof vi.fn>) {
  const reviews = state.review.mock.results.length,
    projections = state.projection.mock.results.length,
    snapshots = load.mock.results.length;
  await click("Prepare revision request");
  await act(async () => {
    await state.review.mock.results[reviews]!.value;
    await load.mock.results[snapshots]!.value;
    await state.projection.mock.results[projections]!.value;
    await state.projection.mock.results[projections + 1]!.value;
    await load.mock.results[snapshots + 1]!.value;
    await state.review.mock.results[reviews + 1]!.value;
  });
}
it.each(["manual", "auto"] as const)(
  "mounted result-bound %s review starts the same task's exact next output without composer Send",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      const c = await completedResult(f, `mounted-continuation-${mode}`);
      wire(f);
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
      const load = vi.fn(f.snapshot),
        onOpen = vi.fn();
      const props = {
        task,
        environmentId: EnvironmentId.make("environment-a"),
        stale: false,
        readVersion: 0,
        readCollaboration: load,
        onOpen,
      };
      await act(async () => {
        renderer = create(<TaskRevisionRequest {...props} />);
      });
      await prepareResultReview(load);
      const changes = "Owner requested exact changes from Tasks.";
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Requested changes" })
          .props.onChange({ target: { value: changes } }),
      );
      await click(mode === "manual" ? "Choose Manual" : "Choose Auto");
      await click("Review result continuation");
      const body = JSON.stringify(renderer.toJSON());
      expect(body).toContain(changes);
      expect(body).toContain(
        task.resultReadout!.status === "available" ? task.resultReadout!.runId : "",
      );
      expect(body).toContain("Scope changed");
      expect(body).toContain("Owner reads actual linked output");
      expect((await f.inspect()).starts).toHaveLength(1);
      expect(state.start).not.toHaveBeenCalled();
      if (mode === "auto")
        f.setProviders([
          {
            ...f.providers[0]!,
            models: [
              {
                ...f.providers[0]!.models[0]!,
                slug: "aaa-mounted-continuation",
                name: "Actual next",
              },
              ...f.providers[0]!.models,
            ],
          },
        ]);
      await click("Start reviewed result continuation", true);
      await act(async () => {
        await state.start.mock.results[0]!.value;
        await state.continuationStatus.mock.results.at(-1)!.value;
      });
      const key = continuationStorageKey("environment-a", c.threadId);
      const original = readFirstLaunchAttempt(key).attempt!.command;
      expect(original.taskFirstLaunch).toBeUndefined();
      expect(original.taskResultContinuation!.text).toBe(changes);
      await f.settle(original.messageId);
      await click("Read original continuation status");
      await act(async () => {
        await state.continuationStatus.mock.results.at(-1)!.value;
      });
      expect(JSON.stringify(renderer.toJSON())).toContain(`Transport answer: ${changes}`);
      expect(onOpen).not.toHaveBeenCalled();
      expect((await f.inspect()).inputs).toEqual(["First attributable output", changes]);
      expect((await f.inspect()).starts[1]!.model).toBe(
        mode === "manual" ? "exact-second" : "aaa-mounted-continuation",
      );
      expect(state.start).toHaveBeenCalledTimes(1);
      const after = await f.projection({ threadId: c.threadId });
      if (after._tag !== "Success") throw new Error("Missing same-task history");
      expect(after.value.runs).toHaveLength(2);
      expect(after.value.thread.taskContract).toEqual(original.taskResultContinuation!.contract);
      expect(after.value.thread.taskAcceptedRevision).toBeNull();
      if (mode === "manual") {
        const latestTask = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
        await act(async () =>
          renderer.update(<TaskRevisionRequest {...props} task={latestTask} readVersion={1} />),
        );
        await prepareResultReview(load);
        expect(readFirstLaunchAttempt(key).attempt!.command.commandId).toBe(original.commandId);
        await click("Review changes on latest result");
        expect(readFirstLaunchAttempt(key).attempt).toBeNull();
        const next = "A third explicit reviewed turn.";
        await act(async () =>
          renderer.root
            .findByProps({ "aria-label": "Requested changes" })
            .props.onChange({ target: { value: next } }),
        );
        await click("Choose Manual");
        await click("Review result continuation");
        await click("Start reviewed result continuation");
        await act(async () => {
          await state.start.mock.results[1]!.value;
          await state.continuationStatus.mock.results.at(-1)!.value;
        });
        const third = readFirstLaunchAttempt(key).attempt!.command;
        expect(third.commandId).not.toBe(original.commandId);
        expect(third.taskResultContinuation!.priorResult.runId).toBe(
          latestTask.resultReadout!.status === "available" ? latestTask.resultReadout!.runId : "",
        );
        await f.settle(third.messageId);
        expect((await f.inspect()).inputs).toEqual(["First attributable output", changes, next]);
        expect((await f.snapshot()).tasks).toHaveLength(1);
      }
    });
  },
  30000,
);
it("mounted lost continuation reply retains original command across disconnect/remount and only reads recovery", async () => {
  await withTaskTransportFixture(async (f) => {
    const c = await completedResult(f, "mounted-lost-continuation");
    wire(f);
    const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
    const load = vi.fn(f.snapshot);
    const props = {
      task,
      environmentId: EnvironmentId.make("environment-a"),
      stale: false,
      readVersion: 0,
      readCollaboration: load,
      onOpen: vi.fn(),
    };
    await act(async () => {
      renderer = create(<TaskRevisionRequest {...props} />);
    });
    await prepareResultReview(load);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Requested changes" })
        .props.onChange({ target: { value: "Retain this exact original continuation." } }),
    );
    await click("Choose Manual");
    await click("Review result continuation");
    f.dropNextReply();
    await click("Start reviewed result continuation", true);
    await Promise.race([
      f.awaitDroppedReply(),
      state.start.mock.results[0]!.value.then(() => {
        throw new Error("No dropped reply");
      }),
    ]);
    const key = continuationStorageKey("environment-a", c.threadId);
    const original = readFirstLaunchAttempt(key).attempt!.command;
    await act(async () => renderer.unmount());
    await f.disconnect();
    await state.start.mock.results[0]!.value;
    await f.connect();
    await f.settle(original.messageId);
    const latestTask = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
    await act(async () => {
      renderer = create(<TaskRevisionRequest {...props} task={latestTask} readVersion={1} />);
    });
    await click("Read original continuation status");
    await act(async () => {
      await state.continuationStatus.mock.results.at(-1)!.value;
    });
    expect(readFirstLaunchAttempt(key).attempt!.command).toEqual(original);
    expect(readFirstLaunchAttempt(key).attempt!.status).toBe("admitted");
    expect(state.start).toHaveBeenCalledTimes(1);
    expect((await f.inspect()).starts).toHaveLength(2);
  });
}, 30000);
