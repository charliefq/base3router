import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { Cause } from "effect";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  publish: vi.fn(),
  draft: vi.fn(),
  wait: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { createNew: "create" } }));
vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: { publishRepository: "publish" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "create" ? mocks.create : mocks.publish),
}));
vi.mock("~/state/entities", () => ({ waitForProject: mocks.wait }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.draft }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: mocks.toast },
}));
import { useNewProject } from "./useNewProject";
let renderer: ReactTestRenderer;
function Harness({ openDraft }: { openDraft?: boolean }) {
  const run = useNewProject();
  return (
    <button
      onClick={() =>
        run({
          environmentId: EnvironmentId.make("fixture-a"),
          name: "Local project",
          github: null,
          ...(openDraft === undefined ? {} : { openDraft }),
        })
      }
    >
      Create project
    </button>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.create.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { projectId: "fixture-project", workspaceRoot: "/tmp/fixture-project" },
  });
  mocks.publish.mockReset();
  mocks.draft.mockReset().mockResolvedValue(undefined);
  mocks.wait.mockReset().mockResolvedValue({ id: "fixture-project" });
  mocks.toast.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("uses the existing project command without publishing, opening a draft or starting work for setup", async () => {
  await act(async () => {
    renderer = create(<Harness openDraft={false} />);
  });
  await act(async () => {
    expect(await renderer.root.findByType("button").props.onClick()).toBe(true);
  });
  expect(mocks.create).toHaveBeenCalledWith({
    environmentId: "fixture-a",
    input: { name: "Local project" },
  });
  expect(mocks.wait).toHaveBeenCalledTimes(1);
  expect(mocks.draft).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});
it("preserves the ordinary project flow's default draft navigation", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await renderer.root.findByType("button").props.onClick();
  });
  expect(mocks.draft).toHaveBeenCalledTimes(1);
  expect(mocks.publish).not.toHaveBeenCalled();
});
it("does not navigate after a failed project creation", async () => {
  mocks.create.mockResolvedValue({ _tag: "Failure", cause: Cause.interrupt() });
  await act(async () => {
    renderer = create(<Harness openDraft={false} />);
  });
  await act(async () => {
    expect(await renderer.root.findByType("button").props.onClick()).toBe(false);
  });
  expect(mocks.wait).not.toHaveBeenCalled();
  expect(mocks.draft).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});
