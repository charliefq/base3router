import { describe, expect, it } from "vite-plus/test";

import {
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  emptyTiming,
  emptyUsageMeasurement,
  type TurnOutcomeObservationV0,
} from "@t3tools/contracts";

import {
  classifyTurnTerminal,
  costFromReportedAndEstimate,
  durationMs,
  effectivePolicyVersion,
  estimateCatalogCostUsd,
  isImmediateAbandonmentProxy,
  mergeTerminalWrite,
  nanosToDurationMs,
  quantityFromOptionalNumber,
  usageFromOpenRouter,
  usageFromTurnTokenUsage,
} from "./turnOutcome.ts";

describe("turn outcome measurements", () => {
  it("treats absent numbers as unknown, not zero", () => {
    const missing = quantityFromOptionalNumber({
      value: undefined,
      unit: "usd",
      source: "not_reported",
      provenance: "unknown",
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(missing.status).toBe("unknown");
    expect(missing).not.toHaveProperty("value");
  });

  it("never overwrites reported cost with a catalog estimate", () => {
    const cost = costFromReportedAndEstimate({
      reportedUsd: 0.012,
      estimatedUsd: 0.04,
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(cost.reportedUsd.status).toBe("known");
    if (cost.reportedUsd.status === "known") expect(cost.reportedUsd.value).toBe(0.012);
    expect(cost.estimatedUsd.status).toBe("known");
    expect(cost.mixedProvenance).toBe(true);
    expect(cost.reportedSource).toBe("openrouter_accounting");
  });

  it("rejects non-monotonic durations", () => {
    expect(durationMs(100, 90)).toBeUndefined();
    expect(durationMs(100, 150)).toBe(50);
    expect(isImmediateAbandonmentProxy(30_000)).toBe(true);
    expect(isImmediateAbandonmentProxy(180_000)).toBe(false);
  });

  it("estimates catalog cost from snapshot prices without filling missing tokens as zero", () => {
    expect(
      estimateCatalogCostUsd({
        promptTokens: 100,
        completionTokens: 50,
        promptPricePerToken: 0.000002,
        completionPricePerToken: 0.000008,
      }),
    ).toBeCloseTo(0.0006);
    expect(estimateCatalogCostUsd({ promptTokens: 10 })).toBeUndefined();
  });

  it("preserves OpenRouter usage provenance as estimated when marked", () => {
    const usage = usageFromOpenRouter({
      promptTokens: 15,
      estimated: true,
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(usage.promptTokens.status).toBe("known");
    if (usage.promptTokens.status === "known") {
      expect(usage.promptTokens.provenance).toBe("estimated");
    }
    expect(usage.completionTokens.status).toBe("unknown");
  });

  it("uses monotonic nanosecond deltas for duration", () => {
    expect(nanosToDurationMs(0n, 50_000_000n)).toBe(50);
    expect(nanosToDurationMs(100n, 50n)).toBeUndefined();
  });

  it("keeps incomplete token usage unknown", () => {
    const usage = usageFromTurnTokenUsage({
      tokenUsage: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 10,
      },
      completeAccounting: false,
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(usage.promptTokens.status).toBe("unknown");
  });

  it("attributes Hybrid only when ranking was used", () => {
    expect(effectivePolicyVersion({ usedHybridRanking: true })).toBe(HYBRID_ROUTER_POLICY_VERSION);
    expect(effectivePolicyVersion({ usedHybridRanking: false })).toBe(MODEL_ROUTER_POLICY_VERSION);
  });
});

describe("classifyTurnTerminal", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: Parameters<typeof classifyTurnTerminal>[0];
    readonly category: ReturnType<typeof classifyTurnTerminal>["terminalCategory"];
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
  }> = [
    {
      name: "completed success",
      input: { eventType: "turn.completed", state: "completed", stopReason: "end_turn" },
      category: "success",
    },
    {
      name: "completed success with tool_use stop",
      input: { eventType: "turn.completed", state: "completed", stopReason: "tool_use" },
      category: "success",
    },
    {
      name: "completed max_tokens",
      input: { eventType: "turn.completed", state: "completed", stopReason: "max_tokens" },
      category: "success",
    },
    {
      name: "failed completion",
      input: { eventType: "turn.completed", state: "failed" },
      category: "provider_failure",
    },
    {
      name: "usage quota exhausted",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "usage_quota_exhausted",
      },
      category: "provider_failure",
    },
    {
      name: "authentication failed",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "authentication_failed",
      },
      category: "provider_failure",
    },
    {
      name: "rate limited",
      input: { eventType: "turn.completed", state: "failed", failureCategory: "rate_limited" },
      category: "provider_failure",
    },
    {
      name: "transient transport",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "transient_transport",
      },
      category: "provider_failure",
    },
    {
      name: "model unavailable",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "model_unavailable",
      },
      category: "provider_failure",
    },
    {
      name: "non retryable request",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "non_retryable_request",
      },
      category: "provider_failure",
    },
    {
      name: "OpenRouter policy violation",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "non_retryable_request",
        openRouterStatus: "policy_violation",
        openRouterErrorCategory: "policy_violation",
      },
      category: "provider_failure",
    },
    {
      name: "policy violation cannot be success even if state completed",
      input: {
        eventType: "turn.completed",
        state: "completed",
        openRouterErrorCategory: "policy_violation",
      },
      category: "provider_failure",
    },
    {
      name: "cancelled completion",
      input: { eventType: "turn.completed", state: "cancelled", stopReason: "cancelled" },
      category: "cancelled",
      cancelled: true,
    },
    {
      name: "ACP cancelled stop reason",
      input: { eventType: "turn.completed", state: "completed", stopReason: "cancelled" },
      category: "cancelled",
      cancelled: true,
    },
    {
      name: "interrupted without timeout",
      input: { eventType: "turn.completed", state: "interrupted" },
      category: "infrastructure_failure",
    },
    {
      name: "interrupted timeout",
      input: {
        eventType: "turn.completed",
        state: "interrupted",
        errorMessage: "request timed out",
      },
      category: "timeout",
      timedOut: true,
    },
    {
      name: "Grok stall timeout",
      input: {
        eventType: "turn.completed",
        state: "failed",
        errorMessage: "Grok ACP turn stalled without content or tool progress for 120000ms.",
      },
      category: "timeout",
      timedOut: true,
    },
    {
      name: "user abort",
      input: { eventType: "turn.aborted", abortReason: "Interrupted by user." },
      category: "cancelled",
      cancelled: true,
    },
    {
      name: "prompt timeout abort",
      input: { eventType: "turn.aborted", abortReason: "Prompt timed out." },
      category: "timeout",
      timedOut: true,
    },
    {
      name: "unknown missing state",
      input: { eventType: "turn.completed" },
      category: "unknown",
    },
    {
      name: "completed timeout stop reason is not success",
      input: { eventType: "turn.completed", state: "completed", stopReason: "timeout" },
      category: "timeout",
      timedOut: true,
    },
    {
      name: "provider instance unavailable",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "provider_instance_unavailable",
      },
      category: "provider_failure",
    },
    {
      name: "side effect started failure",
      input: {
        eventType: "turn.completed",
        state: "failed",
        failureCategory: "side_effect_started",
      },
      category: "provider_failure",
    },
    {
      name: "completed success",
      input: { eventType: "turn.completed", state: "completed", stopReason: "end_turn" },
      category: "success",
    },
  ];

  it.each(cases)("$name", (entry) => {
    const result = classifyTurnTerminal(entry.input);
    expect(result.terminalCategory).toBe(entry.category);
    expect(result.timedOut).toBe(entry.timedOut === true);
    expect(result.cancelled).toBe(entry.cancelled === true);
    if (entry.category !== "success") {
      expect(result.terminalCategory).not.toBe("success");
    }
  });
});

describe("mergeTerminalWrite", () => {
  const observation = (
    category: TurnOutcomeObservationV0["terminalCategory"],
    extras: Partial<TurnOutcomeObservationV0> = {},
  ): TurnOutcomeObservationV0 => ({
    version: TURN_OUTCOME_OBSERVATION_VERSION,
    observationId: "syn-obs-merge" as TurnOutcomeObservationV0["observationId"],
    environmentId: "lab-environment" as TurnOutcomeObservationV0["environmentId"],
    recordedAt: "2026-10-03T00:00:00.000Z",
    policyVersion: "model-router.v0",
    routingMode: "auto",
    model: "gpt-5.5",
    taskProfile: UNKNOWN_TASK_PROFILE,
    timing: emptyTiming(),
    usage: emptyUsageMeasurement(),
    cost: emptyCostMeasurement(),
    providerAttempts: 1,
    fallbackCount: 0,
    cancelled: category === "cancelled",
    timedOut: category === "timeout",
    finishReason:
      category === "cancelled" ? "cancelled" : category === "timeout" ? "timeout" : "stop",
    terminalCategory: category,
    evidence: emptyOutcomeEvidence(),
    ...extras,
  });

  it("rejects success after cancel, timeout, or provider failure", () => {
    for (const category of ["cancelled", "timeout", "provider_failure"] as const) {
      const result = mergeTerminalWrite(observation(category), observation("success"));
      expect(result.kind).toBe("rejected");
      expect(result.observation.terminalCategory).toBe(category);
      expect(result.reason).toBe("success_after_failure");
    }
  });

  it("keeps duplicate success idempotent and can enrich unknown usage", () => {
    const duplicate = mergeTerminalWrite(observation("success"), observation("success"));
    expect(duplicate.kind).toBe("idempotent");
    const enriched = mergeTerminalWrite(
      observation("success"),
      observation("success", {
        usage: {
          ...emptyUsageMeasurement(),
          promptTokens: {
            status: "known",
            value: 12,
            unit: "token",
            source: "provider_reported",
            provenance: "observed",
            observedAt: "2026-10-03T00:00:01.000Z",
          },
        },
      }),
    );
    expect(enriched.kind).toBe("enriched");
    expect(enriched.observation.terminalCategory).toBe("success");
    expect(enriched.observation.usage.promptTokens.status).toBe("known");
  });
});
