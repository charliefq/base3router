import { expect, it } from "vite-plus/test";
import { type CollaborationTask } from "@t3tools/contracts";
import {
  deriveTaskInbox,
  defaultInboxFilters,
  inboxKey,
  resolveInboxSelection,
  taskInboxFacts,
} from "./taskInbox";
import { inboxTask as task } from "./taskInbox.test-fixtures";

const input = (tasks: ReadonlyArray<CollaborationTask> = [task]) => ({
  environmentId: "env-a",
  tasks,
  projects: [{ id: "current", label: "Current" }],
  assignees: [{ id: "offline", label: "Offline provider (unavailable)" }],
  filters: defaultInboxFilters,
  stale: false,
});
it("derives overlapping evidence, never success from ledger completed or old revision acceptance", () => {
  const facts = taskInboxFacts(task, "env-a", false);
  expect(facts.labels).toEqual(["clarification", "waiting", "review", "paused", "failure"]);
  expect(facts.ledger).toBe("completed");
  expect(facts.outcome).toContain("failed");
  expect(facts.acceptance).toContain("current revision 2 not recorded");
  expect(
    taskInboxFacts(
      {
        ...task,
        contractReadout: {
          ...task.contractReadout!,
          status: "available",
          contract:
            task.contractReadout!.status === "available"
              ? task.contractReadout!.contract
              : (() => {
                  throw new Error();
                })(),
          phase: "redirected",
          acceptedRevision: 2,
        },
      },
      "env-a",
      false,
    ).labels,
  ).toContain("accepted");
});
it.each(["environment", "project", "task", "revision"])(
  "rejects mismatched review hint %s as attention authority",
  (change) => {
    const review = { ...task.review!, reference: { ...task.review!.reference } };
    if (change === "environment") review.reference.environmentId = "other";
    if (change === "project") review.reference.projectId = "other";
    if (change === "task") review.reference.taskId = "other";
    if (change === "revision") review.revision = 1;
    const facts = taskInboxFacts({ ...task, review }, "env-a", false);
    expect(facts.labels).not.toContain("review");
    expect(facts.labels).toContain("unknown");
  },
);
it("keeps missing and stale facts unknown while preserving separately recorded labels", () => {
  const { contractReadout: _contract, resultReadout: _result, review: _hint, ...legacy } = task;
  const facts = taskInboxFacts(legacy, "env-a", false);
  expect(facts.labels).toContain("unknown");
  expect(facts.labels).not.toContain("accepted");
  expect(facts.outcome).toContain("unknown");
  const stale = taskInboxFacts(task, "env-a", true);
  expect(stale.labels).toContain("failure");
  expect(stale.labels).toContain("unknown");
});
it("searches Unicode title and exact ID text without changing task identities", () => {
  for (const query of ["é", "任务-a", "修复"]) {
    const result = deriveTaskInbox({ ...input(), filters: { ...defaultInboxFilters, query } });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.key.taskId).toBe("任务-Ａ");
  }
});
it("preserves historical projects and unavailable assignees, all/reset/counts and zero-match", () => {
  const a = deriveTaskInbox(input());
  expect(a.projects).toContainEqual({
    id: task.projectId,
    label: "historical-project (not in current directory)",
  });
  expect(a.assignees).toContainEqual({ id: "offline", label: "Offline provider (unavailable)" });
  expect(a.counts.all).toBe(1);
  expect(a.counts.failure).toBe(1);
  expect(a.counts.review).toBe(1);
  const filtered = deriveTaskInbox({
    ...input(),
    filters: { query: "", projectId: "missing", assigneeId: "gone", attention: "all" },
  });
  expect(filtered.rows).toHaveLength(0);
  expect(filtered.total).toBe(1);
  expect(filtered.projects.some((p) => p.id === "missing")).toBe(true);
  expect(filtered.assignees.some((p) => p.id === "gone")).toBe(true);
  expect(deriveTaskInbox({ ...input(), filters: defaultInboxFilters }).rows).toHaveLength(1);
});
it("resolves scoped identity without fallback across duplicate IDs, deletion or environment change", () => {
  const other = { ...task, projectId: "other-project" };
  const key = inboxKey("env-a", task);
  expect(resolveInboxSelection([other, task], "env-a", key)).toEqual({ status: "selected", task });
  expect(resolveInboxSelection([other], "env-a", key).status).toBe("unavailable");
  expect(resolveInboxSelection([task], "env-b", key).status).toBe("unavailable");
  const duplicate = deriveTaskInbox(input([task, { ...task, title: "Duplicate" }, other]));
  expect(duplicate.rows.map((r) => r.ambiguous)).toEqual([true, true, false]);
  expect(resolveInboxSelection([task, task], "env-a", key).status).toBe("unavailable");
  expect(resolveInboxSelection([task], "env-a", null).status).toBe("none");
});
it("keeps a missing provider-turn link unknown independently of current owner acceptance", () => {
  if (task.resultReadout?.status !== "available" || task.contractReadout?.status !== "available")
    throw new Error("Fixture unavailable");
  const facts = taskInboxFacts(
    {
      ...task,
      contractReadout: { ...task.contractReadout, acceptedRevision: 2 },
      resultReadout: {
        ...task.resultReadout,
        runStatus: "completed",
        providerTurnId: null,
        providerTurnStatus: "completed",
        content: {
          status: "output",
          itemId: "output",
          preview: "Historical output",
          truncated: false,
        },
      },
    },
    "env-a",
    false,
  );
  expect(facts.labels).toContain("accepted");
  expect(facts.labels).toContain("unknown");
  expect(facts.outcome).toContain("provider turn: unknown");
});

it("does not attribute an unlinked provider failure to a completed run", () => {
  if (task.resultReadout?.status !== "available") throw new Error("Fixture unavailable");
  const facts = taskInboxFacts(
    {
      ...task,
      resultReadout: {
        ...task.resultReadout,
        runStatus: "completed",
        providerTurnId: null,
        providerTurnStatus: "failed",
        content: {
          status: "output",
          itemId: "output",
          preview: "Historical output",
          truncated: false,
        },
      },
    },
    "env-a",
    false,
  );
  expect(facts.labels).toContain("unknown");
  expect(facts.labels).not.toContain("failure");
});
