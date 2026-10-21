import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskOccurrence,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

const decodeOccurrence = Schema.decodeUnknownSync(ScheduledTaskOccurrence);
const occurrenceJson = Schema.fromJsonString(ScheduledTaskOccurrence);
const encodeOccurrenceJson = Schema.encodeSync(occurrenceJson);
const decodeOccurrenceJson = Schema.decodeUnknownSync(occurrenceJson);
const legacyOccurrence = {
  id: "occurrence",
  commandId: "command",
  messageId: "message",
  threadId: null,
  runId: "run",
  status: "running",
  lastEventSequence: 7,
  blockedReason: null,
};

describe("ScheduledTaskOccurrence run evidence", () => {
  it("keeps legacy occurrence JSON readable without inventing run evidence", () => {
    const decoded = decodeOccurrence(legacyOccurrence);
    expect(decoded).toEqual(legacyOccurrence);
    expect(decoded.runStatus).toBeUndefined();
    expect(decodeOccurrenceJson(encodeOccurrenceJson(decoded))).toEqual(decoded);
  });
  it.each([
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ])("round trips the existing durable run state %s", (runStatus) => {
    const decoded = decodeOccurrence({ ...legacyOccurrence, runStatus });
    expect(decoded.runStatus).toBe(runStatus);
    expect(decodeOccurrenceJson(encodeOccurrenceJson(decoded))).toEqual(decoded);
  });
  it("rejects invented run states", () => {
    expect(() => decodeOccurrence({ ...legacyOccurrence, runStatus: "executing" })).toThrow();
  });
});
