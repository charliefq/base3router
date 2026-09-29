import { describe, expect, it } from "@effect/vitest";

import { cursorCloudAgentIdFromDispatch } from "./CursorCloudAgentId.ts";

describe("Cursor Cloud agent id", () => {
  it("derives a deterministic bc-<uuid-v5> from run/stage/attempt/dispatch", () => {
    const first = cursorCloudAgentIdFromDispatch({
      runId: "run-one",
      stageId: "research",
      attempt: 1,
      dispatchId: "dispatch-1",
    });
    const second = cursorCloudAgentIdFromDispatch({
      runId: "run-one",
      stageId: "research",
      attempt: 1,
      dispatchId: "dispatch-1",
    });
    const other = cursorCloudAgentIdFromDispatch({
      runId: "run-one",
      stageId: "research",
      attempt: 1,
      dispatchId: "dispatch-2",
    });
    expect(first).toMatch(
      /^bc-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).toBe(second);
    expect(other).not.toBe(first);
  });
});
