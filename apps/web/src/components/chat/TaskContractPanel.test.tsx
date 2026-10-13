import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { TaskContractReadout } from "./TaskContractPanel";
vi.mock("../ui/button", () => ({ Button: "button" }));
const fields = {
  goal: "Fixture goal",
  redirect: "Ask owner",
  acceptance: "Owner review",
  maxProviderStarts: 2,
  stopConditions: "Scope changed",
  revision: 1,
  phase: "active",
  acceptedRevision: null,
};
let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
it.each(["success", "failure"] as const)(
  "guards repeated and sibling decisions until the real async callback settles: %s",
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const accept = vi.fn(() => promise);
    const redirect = vi.fn();
    await act(async () => {
      renderer = create(
        <TaskContractReadout {...fields} onAccept={accept} onRedirect={redirect} />,
      );
    });
    const buttons = renderer.root.findAllByType("button");
    await act(async () => {
      buttons[0]!.props.onClick();
      buttons[0]!.props.onClick();
      buttons[1]!.props.onClick();
    });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("button").every((b) => b.props.disabled)).toBe(true);
    await act(async () => {
      if (outcome === "success") resolve();
      else reject(new Error("Lost reply"));
    });
    const current = renderer.root.findAllByType("button");
    if (outcome === "success") {
      expect(current.every((b) => !b.props.disabled)).toBe(true);
      await act(async () => current[1]!.props.onClick());
      expect(redirect).toHaveBeenCalledTimes(1);
    } else {
      expect(current.every((b) => b.props.disabled)).toBe(true);
      expect(JSON.stringify(renderer.toJSON())).toContain("Refresh the contract");
      await act(async () => current[0]!.props.onClick());
      expect(accept).toHaveBeenCalledTimes(1);
      await act(async () =>
        renderer.update(
          <TaskContractReadout {...fields} revision={2} onAccept={accept} onRedirect={redirect} />,
        ),
      );
      expect(renderer.root.findAllByType("button").every((b) => !b.props.disabled)).toBe(true);
    }
  },
);
it("keeps existing synchronous chat callbacks usable after completion", async () => {
  const accept = vi.fn();
  await act(async () => {
    renderer = create(<TaskContractReadout {...fields} onAccept={accept} />);
  });
  await act(async () => renderer.root.findAllByType("button")[0]!.props.onClick());
  expect(accept).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType("button")[0]!.props.disabled).toBe(false);
});
