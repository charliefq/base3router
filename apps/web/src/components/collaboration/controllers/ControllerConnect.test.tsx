import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type {
  ControllerConnection,
  ControllerManagement,
} from "@t3tools/client-runtime/controllers/onboarding";
import { ControllerConnect } from "./ControllerConnect";

const props = {
  environmentId: "e1",
  projects: [{ id: "p1", title: "Project One" }],
  onProviderSetup: () => {},
  onClose: () => {},
};
const evidence: ControllerConnection = {
  version: 1,
  controller: "grokbot",
  callerId: "g1",
  environmentId: "e1",
  status: "verified_connected",
  evidence: "fixture",
  verifiedAt: "2026-10-22T00:00:00Z",
  grant: { projectIds: ["p1"], actions: ["get_task"] },
  tasks: [
    { taskId: "task-one", projectId: "p1", supervisorId: "g1", state: "running", runId: "run-one" },
    {
      taskId: "other-caller-task",
      projectId: "p1",
      supervisorId: "other",
      state: "running",
      runId: "r2",
    },
  ],
};
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function mount(management?: ControllerManagement) {
  await act(async () => {
    renderer = create(<ControllerConnect {...props} {...(management ? { management } : {})} />);
  });
}
function text() {
  return JSON.stringify(renderer.toJSON());
}
async function press(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes(label))!;
  expect(button.props.disabled).not.toBe(true);
  await act(async () => {
    await button.props.onClick();
  });
}
describe("controller onboarding fixture flow", () => {
  it("drafts permissions without connecting and preserves future unsupported states", async () => {
    await mount();
    expect(text()).toContain("Needs setup");
    expect(text()).not.toContain("Verified connected");
    const project = renderer.root.findAllByType("input")[0]!;
    await act(async () => project.props.onChange({ target: { checked: true } }));
    await press("Prepare setup handoff");
    expect(text()).toContain("needs_setup");
    expect(text()).toContain("p1");
    expect(text()).toContain("No verified permissions.");
    await press("Muse (future)");
    expect(text()).toContain("Unavailable — future adapter");
    await press("dot (future)");
    expect(text()).toContain("Unavailable — future adapter");
  });
  it("labels fixture evidence, scopes tasks, and confirms revoke then disconnect", async () => {
    const calls: string[] = [];
    await mount({
      read: async () => evidence,
      revoke: async () => {
        calls.push("revoke");
      },
      disconnect: async () => {
        calls.push("disconnect");
      },
    });
    await press("Check bridge status");
    expect(text()).toContain("Fixture preview — not live");
    expect(text()).toContain("task-one");
    expect(text()).not.toContain("other-caller-task");
    await press("Revoke controller access");
    expect(text()).toContain("Revoked");
    expect(text()).not.toContain("task-one");
    await press("Disconnect controller");
    expect(text()).toContain("Disconnected");
    expect(calls).toEqual(["revoke", "disconnect"]);
  });
  it("clears verification after a failed refresh or mismatched environment", async () => {
    let calls = 0;
    await mount({
      read: async () => {
        if (++calls > 1) throw new Error("Unavailable");
        return { ...evidence, evidence: "bridge" };
      },
      revoke: async () => {},
      disconnect: async () => {},
    });
    await press("Check bridge status");
    expect(text()).toContain("Verified connected");
    await press("Check bridge status");
    expect(text()).not.toContain("Verified connected");
    expect(text()).toContain("could not be confirmed");
    await act(async () =>
      renderer.update(
        <ControllerConnect
          {...props}
          management={{
            read: async () => ({ ...evidence, environmentId: "other" }),
            revoke: async () => {},
            disconnect: async () => {},
          }}
        />,
      ),
    );
    await press("Check bridge status");
    expect(text()).not.toContain("task-one");
  });
  it("does not let a late status response reconnect a switched controller", async () => {
    let resolve!: (value: ControllerConnection) => void;
    await mount({
      read: () =>
        new Promise((done) => {
          resolve = done;
        }),
      revoke: async () => {},
      disconnect: async () => {},
    });
    await press("Check bridge status");
    await press("Muse (future)");
    await act(async () => resolve(evidence));
    expect(text()).toContain("Unavailable — future adapter");
    expect(text()).not.toContain("task-one");
  });
});
