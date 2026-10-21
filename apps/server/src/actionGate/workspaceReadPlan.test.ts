import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { planMcpToolAction } from "./mcpToolPlan.ts";
it("classifies only recorded worktree status as a local read; handoff and unknown tools remain unclassified", () => {
  const plan = (toolName: string) =>
    planMcpToolAction({
      toolName,
      args: {},
      environmentId: EnvironmentId.make("e"),
      threadId: ThreadId.make("t"),
    });
  const read = plan("t3_worktree_status");
  expect(read.spec?.riskClass).toBe("read-only-local");
  expect(read.action?.sideEffectClass).toBe("read");
  expect(read.spec?.idempotent).toBe(true);
  for (const name of ["t3_worktree_handoff", "t3_worktree_list", "unknown_tool"]) {
    expect(plan(name).spec).toBeUndefined();
    expect(plan(name).action?.riskClass).toBe("unclassified");
  }
});
