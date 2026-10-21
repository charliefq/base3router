import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TaskInbox } from "./TaskInbox";
import { TaskInboxDrafts, useTaskInboxDraft } from "./TaskInboxDrafts";
import { inboxTask as task } from "./taskInbox.test-fixtures";
import { inboxKeyText, type InboxKey } from "./taskInbox";
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "trigger",
  SelectValue: "value",
  SelectPopup: "popup",
  SelectItem: "option",
}));
const calls = vi.fn();
function Detail(props: { task: typeof task; environmentId: string }) {
  const [text, setText] = useTaskInboxDraft<string>("fixture-text", props, "");
  return (
    <div data-detail-task={props.task.id}>
      <input
        aria-label="Retained draft fixture"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}
const other = {
  ...task,
  id: "other",
  title: "Other task",
  projectId: "project-b",
  threadId: "thread-b",
  assigneeAgentId: "available",
};
let renderer: ReactTestRenderer;
let props: { environmentId: string; tasks: ReadonlyArray<typeof task>; stale: boolean };
function Page() {
  const [selection, setSelection] = useState<InboxKey | null>(null);
  return (
    <TaskInboxDrafts>
      <TaskInbox
        {...props}
        projects={[{ id: "project-b", label: "Current project" }]}
        assignees={[{ id: "offline", label: "Offline provider (unavailable)" }]}
        selection={selection}
        onSelect={(key) => {
          calls("select", key);
          setSelection(key);
        }}
        onBack={() => setSelection(null)}
        renderDetail={(task) => (
          <Detail
            key={inboxKeyText({
              environmentId: props.environmentId,
              projectId: task.projectId,
              taskId: task.id,
            })}
            task={task}
            environmentId={props.environmentId}
          />
        )}
      />
    </TaskInboxDrafts>
  );
}
const text = () => JSON.stringify(renderer.toJSON());
const button = (name: string) =>
  renderer.root.findAllByType("button").find((n) => n.children.join("") === name)!;
const view = async (id = task.id, projectId = task.projectId) =>
  act(async () =>
    renderer.root.findByProps({ "aria-label": `View task ${id} in ${projectId}` }).props.onClick(),
  );
const click = async (name: string) => act(async () => button(name).props.onClick());
const search = async (query: string) =>
  act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Inbox search" })
      .props.onChange({ target: { value: query } }),
  );
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.mockClear();
  props = { environmentId: "env-a", tasks: [task, other], stale: false };
  await act(async () => {
    renderer = create(<Page />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("starts with compact rows and no detail; search/filter/open/return/reset preserves list context", async () => {
  expect(renderer.root.findAllByProps({ "data-detail-task": task.id })).toHaveLength(0);
  expect(calls).not.toHaveBeenCalled();
  await search("é");
  expect(
    renderer.root.findAllByType("button").filter((n) => n.props["data-task-inbox-open"]),
  ).toHaveLength(1);
  await view();
  expect(renderer.root.findByProps({ "data-detail-task": task.id })).toBeTruthy();
  await click("Back to task inbox");
  expect(renderer.root.findByProps({ "aria-label": "Inbox search" }).props.value).toBe("é");
  expect(renderer.root.findAllByProps({ "data-detail-task": task.id })).toHaveLength(0);
  await search("no matching task");
  expect(text()).toContain("No tasks match");
  await click("Reset inbox filters");
  expect(renderer.root.findByProps({ "aria-label": "Inbox search" }).props.value).toBe("");
  expect(
    renderer.root.findAllByType("button").filter((n) => n.props["data-task-inbox-open"]),
  ).toHaveLength(2);
});
it("retains historical/unavailable choices and filters independently", async () => {
  expect(text()).toContain("historical-project (not in current directory)");
  expect(text()).toContain("Offline provider (unavailable)");
  const selects = renderer.root.findAllByType("select");
  await act(async () => selects[0]!.props.onValueChange(JSON.stringify(task.projectId)));
  await act(async () => selects[1]!.props.onValueChange(JSON.stringify("offline")));
  expect(
    renderer.root.findAllByType("button").filter((n) => n.props["data-task-inbox-open"]),
  ).toHaveLength(1);
  expect(calls).not.toHaveBeenCalled();
  await view();
  await click("Back to task inbox");
  expect(renderer.root.findAllByType("select")[0]!.props.value).toBe(
    JSON.stringify(task.projectId),
  );
  expect(renderer.root.findAllByType("select")[1]!.props.value).toBe(JSON.stringify("offline"));
});
it("keeps focus through live row/count/filter changes, deletion and duplicate identity without fallback", async () => {
  await view();
  await search("Other");
  expect(text()).toContain("Focus has not moved");
  expect(renderer.root.findByProps({ "data-detail-task": task.id })).toBeTruthy();
  props = { ...props, tasks: [{ ...task, title: "Updated title" }, other] };
  await act(async () => renderer.update(<Page />));
  expect(renderer.root.findByProps({ "data-detail-task": task.id })).toBeTruthy();
  props = { ...props, tasks: [other] };
  await act(async () => renderer.update(<Page />));
  expect(text()).toContain("missing or deleted");
  expect(renderer.root.findAllByProps({ "data-detail-task": other.id })).toHaveLength(0);
  props = { ...props, tasks: [task, task, other] };
  await act(async () => renderer.update(<Page />));
  expect(text()).toContain("identity is ambiguous");
  expect(renderer.root.findAllByProps({ "data-detail-task": task.id })).toHaveLength(0);
});
it("does not cross environments or mount hidden rows and keeps stale facts visibly stale", async () => {
  await view();
  props = { ...props, environmentId: "env-b", stale: true };
  await act(async () => renderer.update(<Page />));
  expect(text()).toContain("another environment");
  expect(text()).toContain("Stale inbox facts");
  expect(renderer.root.findAllByProps({ "data-detail-task": task.id })).toHaveLength(0);
  expect(calls).toHaveBeenCalledTimes(1);
});
it("retains only scoped inert draft text across A→B→A detail unmount", async () => {
  await view();
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Retained draft fixture" })
      .props.onChange({ target: { value: "Keep my inert draft" } }),
  );
  await view(other.id, other.projectId);
  expect(renderer.root.findByProps({ "aria-label": "Retained draft fixture" }).props.value).toBe(
    "",
  );
  await view();
  expect(renderer.root.findByProps({ "aria-label": "Retained draft fixture" }).props.value).toBe(
    "Keep my inert draft",
  );
});
