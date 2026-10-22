import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ControllerStatus } from "@t3tools/contracts";
import type { ControllerManagement } from "@t3tools/client-runtime/controllers/onboarding";
import { ControllerClientError } from "@t3tools/client-runtime/controllers/client";
import { ControllerConnect } from "./ControllerConnect";
const props = {
  environmentId: "e1",
  projects: [{ id: "p1", title: "Project One" }],
  onProviderSetup: () => {},
  onClose: () => {},
};
const status: typeof ControllerStatus.Type = {
  version: 1,
  environmentId: "e1",
  configuration: "configured",
  lastAuthenticatedAt: "2026-10-22T01:00:00Z",
  identity: {
    id: "real-id-42",
    displayName: "Owner Grok",
    projects: ["p1"],
    actions: ["get_task"],
    generation: 1,
    expiresAt: "2027-01-01T00:00:00Z",
    revokedAt: null,
    supervisedTasks: 1,
  },
  tasks: [
    {
      version: 1,
      controllerId: "real-id-42",
      taskId: "task-one",
      threadId: "thread-1",
      projectId: "p1",
      fence: 3,
      contractRevision: 1,
      admission: "admitted",
      execution: "not_started",
      terminal: false,
      run: null,
      receipt: { commandId: "command-1", status: "accepted" },
      feedback: null,
      result: { status: "unavailable", reason: "Not executed" },
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
async function bind() {
  await press("Load controller identities");
  await act(async () =>
    renderer.root.findByType("select").props.onChange({ target: { value: "real-id-42" } }),
  );
  await press("Check bridge status");
}
const baseManagement: ControllerManagement = {
  list: async () => [status.identity!],
  read: async () => status,
  revoke: async () => {},
};
describe("controller onboarding owner-session flow", () => {
  it("prepares a draft without connecting and preserves future unsupported states", async () => {
    await mount();
    expect(text()).toContain("Needs setup");
    await act(async () =>
      renderer.root.findAllByType("input")[0]!.props.onChange({ target: { checked: true } }),
    );
    await press("Prepare setup handoff");
    expect(text()).toContain("needs_setup");
    expect(text()).toContain("create a new reviewed task");
    await press("Muse (future)");
    expect(text()).toContain("Unavailable — future adapter");
    await press("dot (future)");
    expect(text()).toContain("Unavailable — future adapter");
  });
  it("requires concrete identity selection, reports untested configuration and disconnects only after revocation", async () => {
    const calls: string[] = [];
    let resolve!: () => void;
    await mount({
      ...baseManagement,
      read: async (id) => {
        calls.push(id);
        return status;
      },
      revoke: (id) => {
        calls.push(`revoke:${id}`);
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    await bind();
    expect(calls).toEqual(["real-id-42"]);
    expect(text()).toContain("Configured — live connection untested");
    expect(text()).toContain("task-one");
    expect(text()).not.toContain("Verified connected");
    await press("Disconnect controller");
    expect(renderer.root.findByType("select").props.value).toBe("real-id-42");
    await act(async () => resolve());
    expect(renderer.root.findByType("select").props.value).toBe("");
    expect(text()).not.toContain("task-one");
    expect(calls).toContain("revoke:real-id-42");
  });
  it("retains the binding after uncertain revoke and reports expired/denied states truthfully", async () => {
    let expired = false;
    await mount({
      ...baseManagement,
      read: async () => ({ ...status, configuration: expired ? "expired" : "configured" }),
      revoke: async () => {
        throw new ControllerClientError("uncertain");
      },
    });
    await bind();
    await press("Disconnect controller");
    expect(text()).toContain("outcome uncertain");
    expect(renderer.root.findByType("select").props.value).toBe("real-id-42");
    expired = true;
    await press("Check bridge status");
    expect(text()).toContain("Expired — unavailable");
    await act(async () =>
      renderer.update(
        <ControllerConnect
          {...props}
          management={{
            ...baseManagement,
            list: async () => {
              throw new ControllerClientError("denied");
            },
          }}
        />,
      ),
    );
    await press("Load controller identities");
    expect(text()).toContain("Owner session denied");
    expect(text()).not.toContain("task-one");
  });
  it("drops late status evidence after switching environment", async () => {
    let resolve!: (value: typeof ControllerStatus.Type) => void;
    const management = {
      ...baseManagement,
      read: () =>
        new Promise<typeof ControllerStatus.Type>((done) => {
          resolve = done;
        }),
    };
    await mount(management);
    await bind();
    await act(async () =>
      renderer.update(<ControllerConnect {...props} environmentId="e2" management={management} />),
    );
    await act(async () => resolve(status));
    expect(text()).not.toContain("task-one");
    expect(renderer.root.findByType("select").props.value).toBe("");
  });
});
