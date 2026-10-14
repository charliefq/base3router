import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { CollaborationTask, CollaborationTaskBudgetReadout } from "./collaboration.ts";

const decodeBudget = Schema.decodeUnknownSync(CollaborationTaskBudgetReadout);
const decodeTask = Schema.decodeUnknownSync(CollaborationTask);

describe("additive budget evidence", () => {
  it("preserves an unknown read and accepts historical tasks without budget evidence", () => {
    expect(
      decodeBudget({
        status: "unavailable",
        reason: "budget_read_failed",
      }),
    ).toEqual({ status: "unavailable", reason: "budget_read_failed" });
    const task = decodeTask({
      id: "task",
      title: "Task",
      ownerAgentId: "owner",
      assigneeAgentId: "provider",
      projectId: "project",
      state: "blocked",
      waitReason: null,
      acceptance: "Check",
      threadId: null,
      correlationId: "task",
      revision: 1,
      pendingClarificationId: null,
      gateDecision: "DENY",
    });
    expect(task.budgetReadout).toBeUndefined();
  });
  it("retains partial nulls and rejects negative remaining starts", () => {
    const readout = {
      status: "available",
      taskId: "task",
      threadId: "root",
      rootThreadId: "root",
      environmentId: "environment",
      contractRevision: 2,
      observedAt: "2026-10-14T00:00:00.000Z",
      reservedStarts: 3,
      declaredStarts: 2,
      remainingStarts: 0,
      declared: { tokens: null, costUsd: null, deadline: null },
      frozen: {
        tokens: 100,
        costUsd: 2,
        deadline: "2026-10-15T00:00:00.000Z",
        frozenAt: "2026-10-14T00:00:00.000Z",
      },
      usage: {
        status: "partial",
        attempts: 3,
        reportedTokens: 110,
        reportedCostUsd: null,
        priceStatus: "unverified",
        remainingTokens: null,
        verifiedRemainingCostUsd: null,
      },
      issues: ["usage_incomplete"],
    };
    expect(decodeBudget(readout)).toEqual(readout);
    expect(() => decodeBudget({ ...readout, remainingStarts: -1 })).toThrow();
  });
});
