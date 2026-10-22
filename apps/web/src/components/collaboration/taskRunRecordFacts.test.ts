import { describe, it, expect } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { TaskRunRecord } from "@t3tools/contracts";
import { elapsedMs, recordUsage, executedModels, recordEta } from "./taskRunRecordFacts";
const decodeRecord = Schema.decodeUnknownSync(TaskRunRecord);
const start = "2026-10-22T00:00:00.000Z";
function fixture(status = "running", usage?: object, resolved?: string, id = "r") {
  return decodeRecord({
    title: "Fixture",
    projectId: "project",
    governance: "chat",
    revision: null,
    goal: "Do work",
    run: {
      id,
      threadId: "thread",
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "requested" },
      providerThreadId: "pt",
      userMessageId: "m",
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: start,
      startedAt: start,
      completedAt: status === "completed" ? "2026-10-22T00:01:00.000Z" : null,
      checkpointId: null,
      contextHandoffId: null,
    },
    attempts: [],
    turns: [
      {
        provider: "codex",
        turn: {
          id: "turn",
          providerThreadId: "pt",
          nodeId: "node",
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: start,
          completedAt: null,
          modelIdentity: { requested: "requested", ...(resolved ? { resolved } : {}) },
          ...(usage ? { turnTokenUsage: usage } : {}),
        },
      },
    ],
  });
}
describe("persisted run facts", () => {
  it("does not turn a requested model or context window into actual execution usage", () => {
    const r = fixture();
    expect(executedModels(r)).toEqual(["codex · Model not reported"]);
    expect(recordUsage(r).total).toBeNull();
  });
  it("counts each final turn snapshot once and does not add cached/reasoning subsets", () => {
    const r = fixture(
      "running",
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 50,
        reasoningTokens: 10,
      },
      "actual",
    );
    expect(recordUsage({ ...r, turns: [...r.turns, ...r.turns] })).toEqual({
      total: 120,
      complete: true,
      subagents: true,
    });
    expect(executedModels(r)).toEqual(["codex · actual"]);
  });
  it("preserves known zero, partial usage and unknown distinctly", () => {
    expect(
      recordUsage(
        fixture("running", {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 0,
          outputTokens: 0,
        }),
      ).total,
    ).toBe(0);
    expect(
      recordUsage(
        fixture("running", {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: false,
          outputTokens: 8,
        }),
      ),
    ).toMatchObject({ total: 8, complete: false });
    expect(recordUsage(fixture()).total).toBeNull();
  });
  it("uses durable accumulated accounting and refuses historical increments without coverage", () => {
    const r = fixture("running", {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 10,
      outputTokens: 2,
    });
    const entry = r.turns[0]!;
    const incremental = {
      ...entry,
      turn: { ...entry.turn, usageAccounting: "incremental" as const },
    };
    expect(recordUsage({ ...r, turns: [incremental] }).total).toBeNull();
    expect(
      recordUsage({
        ...r,
        turns: [
          {
            ...incremental,
            accounting: { inputTokens: 110, outputTokens: 22, status: "complete" },
          },
        ],
      }).total,
    ).toBe(132);
  });
  it("freezes terminal duration and declines ungrounded countdowns", () => {
    const now = Date.parse(start) + 30000;
    expect(elapsedMs(fixture("completed"), now + 999999)).toBe(60000);
    expect(recordEta(fixture(), [], now).remainingMs).toBeNull();
    const r = fixture("running", undefined, "actual");
    const history = Array.from({ length: 5 }, (_, i) =>
      fixture("completed", undefined, "actual", String(i)),
    );
    expect(recordEta(r, history, now).remainingMs).toBe(30000);
    expect(recordEta(r, history, now + 100000).remainingMs).toBeNull();
    expect(
      recordEta({ ...r, run: { ...r.run, status: "waiting" } }, history, now).remainingMs,
    ).toBeNull();
  });
});
