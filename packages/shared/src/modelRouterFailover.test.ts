import { describe, expect, it } from "vite-plus/test";
import {
  MODEL_ROUTER_ATTEMPT_BUDGET,
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_UNKNOWN_METRICS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRouterDecision,
} from "@t3tools/contracts";

import {
  classifyModelRouterFailure,
  formatModelRouterTerminalFailure,
  planModelRouterFailover,
  selectNextAutoRoute,
} from "./modelRouterFailover.ts";

const instance = (id: string) => ProviderInstanceId.make(id);
const driver = (id: string) => ProviderDriverKind.make(id);

const candidate = (input: {
  readonly instanceId: string;
  readonly model: string;
  readonly fallbackIndex: number;
  readonly driver?: string;
}): ModelRouterDecision["fallbacks"][number] => ({
  fallbackIndex: input.fallbackIndex,
  target: { instanceId: instance(input.instanceId), model: input.model },
  driver: driver(input.driver ?? input.instanceId),
  capabilities: ["code", "tools"],
  eligible: true,
  reasonCodes: [],
  preferredDefault: false,
  metrics: MODEL_ROUTER_UNKNOWN_METRICS,
});

const autoDecision = (): ModelRouterDecision => ({
  policyVersion: "model-router.v0",
  mode: "auto",
  task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
  policy: MODEL_ROUTER_DEFAULT_POLICY,
  selected: candidate({ instanceId: "codex", model: "gpt-5.5", fallbackIndex: 0 }),
  fallbacks: [
    candidate({
      instanceId: "claude",
      model: "claude-sonnet-4-6",
      fallbackIndex: 1,
      driver: "claudeAgent",
    }),
  ],
  candidates: [
    candidate({ instanceId: "codex", model: "gpt-5.5", fallbackIndex: 0 }),
    candidate({ instanceId: "codex", model: "gpt-5.4", fallbackIndex: 1 }),
    candidate({
      instanceId: "claude",
      model: "claude-sonnet-4-6",
      fallbackIndex: 2,
      driver: "claudeAgent",
    }),
  ],
  reasonCodes: ["SELECTED"],
  explanation: "Auto Route selected codex · gpt-5.5.",
  estimatedCostUsd: { status: "unknown" },
  estimatedLatencyMs: { status: "unknown" },
  estimatedQuality: { status: "unknown" },
  executionStatus: "bound",
  attemptBudget: MODEL_ROUTER_ATTEMPT_BUDGET,
  attempts: [],
  executed: candidate({ instanceId: "codex", model: "gpt-5.5", fallbackIndex: 0 }),
});

describe("model router failover", () => {
  it("classifies Codex usage-limit copy without an explicit category", () => {
    const classified = classifyModelRouterFailure({
      detail: "Codex usage limit reached. Send the message again once the limit resets.",
    });
    expect(classified.category).toBe("usage_quota_exhausted");
    expect(classified.scope).toBe("provider_instance");
    expect(classified.fallbackAllowed).toBe(true);
  });

  it("classifies Codex usage limits as instance-scoped quota exhaustion", () => {
    const classified = classifyModelRouterFailure({
      category: "usage_quota_exhausted",
      scope: "provider_instance",
      detail: "Codex usage limit reached. Send the message again once the limit resets.",
    });
    expect(classified.category).toBe("usage_quota_exhausted");
    expect(classified.scope).toBe("provider_instance");
    expect(classified.fallbackAllowed).toBe(true);
  });

  it("does not retry other models on the same exhausted account", () => {
    const decision = autoDecision();
    const next = selectNextAutoRoute({
      decision,
      failedTarget: { instanceId: instance("codex"), model: "gpt-5.5" },
      classification: classifyModelRouterFailure({
        category: "usage_quota_exhausted",
        scope: "provider_instance",
      }),
      attemptedInstanceIds: new Set(["codex"]),
      attemptedTargetKeys: new Set(["codex\u0000gpt-5.5"]),
      attemptCount: 1,
      nowMs: Date.parse("2026-09-30T00:00:00.000Z"),
      cooldowns: [],
    });
    expect(next.next?.target.instanceId).toBe("claude");
    expect(next.next?.target.model).not.toBe("gpt-5.4");
  });

  it("falls back to a different authorized provider", () => {
    const plan = planModelRouterFailover({
      decision: autoDecision(),
      failedTarget: { instanceId: instance("codex"), model: "gpt-5.5" },
      driver: driver("codex"),
      classification: classifyModelRouterFailure({
        category: "usage_quota_exhausted",
        scope: "provider_instance",
      }),
      attemptedInstanceIds: new Set(["codex"]),
      attemptedTargetKeys: new Set(["codex\u0000gpt-5.5"]),
      attemptCount: 1,
      nowMs: Date.parse("2026-09-30T00:00:00.000Z"),
      cooldowns: [],
      detail: "Codex usage limit reached. Send the message again once the limit resets.",
    });
    expect(plan.next?.target.instanceId).toBe("claude");
    expect(plan.attempt.fallbackAllowed).toBe(true);
    expect(plan.cooldown?.scope).toBe("provider_instance");
    expect(JSON.stringify(plan)).not.toMatch(/sk-|Bearer /);
  });

  it("caps Auto Route at three total attempts and prevents loops", () => {
    const decision = autoDecision();
    const exhausted = selectNextAutoRoute({
      decision,
      failedTarget: { instanceId: instance("claude"), model: "claude-sonnet-4-6" },
      classification: classifyModelRouterFailure({
        category: "transient_transport",
        scope: "provider_instance",
      }),
      attemptedInstanceIds: new Set(["codex", "claude", "cursor"]),
      attemptedTargetKeys: new Set([
        "codex\u0000gpt-5.5",
        "claude\u0000claude-sonnet-4-6",
        "cursor\u0000composer-2",
      ]),
      attemptCount: 3,
      nowMs: Date.parse("2026-09-30T00:00:00.000Z"),
      cooldowns: [],
    });
    expect(exhausted.next).toBeNull();
    expect(exhausted.terminalReason).toBe("FALLBACK_EXHAUSTED");
  });

  it("allows failover for transient pre-output failures", () => {
    const classified = classifyModelRouterFailure({
      tagged: "ProviderAdapterProcessError",
      sideEffectsStarted: false,
    });
    expect(classified.fallbackAllowed).toBe(true);
    expect(classified.category).toBe("transient_transport");
  });

  it("blocks automatic replay after output or a tool side effect", () => {
    const classified = classifyModelRouterFailure({
      category: "usage_quota_exhausted",
      scope: "provider_instance",
      sideEffectsStarted: true,
    });
    expect(classified.category).toBe("side_effect_started");
    expect(classified.fallbackAllowed).toBe(false);
    expect(
      formatModelRouterTerminalFailure({
        instanceId: "codex",
        model: "gpt-5.5",
        classification: classified,
        mode: "auto",
        terminalReason: "FALLBACK_BLOCKED_SIDE_EFFECT",
      }),
    ).toContain("Automatic replay was skipped");
  });

  it("does not silently switch Manual mode", () => {
    const decision = { ...autoDecision(), mode: "manual" as const };
    const next = selectNextAutoRoute({
      decision,
      failedTarget: { instanceId: instance("codex"), model: "gpt-5.5" },
      classification: classifyModelRouterFailure({
        category: "usage_quota_exhausted",
        scope: "provider_instance",
      }),
      attemptedInstanceIds: new Set(["codex"]),
      attemptedTargetKeys: new Set(["codex\u0000gpt-5.5"]),
      attemptCount: 1,
      nowMs: Date.parse("2026-09-30T00:00:00.000Z"),
      cooldowns: [],
    });
    expect(next.next).toBeNull();
    expect(next.terminalReason).toBe("MANUAL_NO_FAILOVER");
    expect(
      formatModelRouterTerminalFailure({
        instanceId: "codex",
        model: "gpt-5.5",
        classification: classifyModelRouterFailure({
          category: "usage_quota_exhausted",
          scope: "provider_instance",
        }),
        mode: "manual",
        terminalReason: "MANUAL_NO_FAILOVER",
      }),
    ).toContain("Manual selection was kept");
  });

  it("emits an honest terminal message when no alternate provider exists", () => {
    const decision = {
      ...autoDecision(),
      fallbacks: [],
      candidates: [candidate({ instanceId: "codex", model: "gpt-5.5", fallbackIndex: 0 })],
    };
    const next = selectNextAutoRoute({
      decision,
      failedTarget: { instanceId: instance("codex"), model: "gpt-5.5" },
      classification: classifyModelRouterFailure({
        category: "usage_quota_exhausted",
        scope: "provider_instance",
      }),
      attemptedInstanceIds: new Set(["codex"]),
      attemptedTargetKeys: new Set(["codex\u0000gpt-5.5"]),
      attemptCount: 1,
      nowMs: Date.parse("2026-09-30T00:00:00.000Z"),
      cooldowns: [],
    });
    expect(next.next).toBeNull();
    expect(
      formatModelRouterTerminalFailure({
        instanceId: "codex",
        model: "gpt-5.5",
        classification: classifyModelRouterFailure({
          category: "usage_quota_exhausted",
          scope: "provider_instance",
        }),
        mode: "auto",
        terminalReason: "NO_ALTERNATE_PROVIDER",
      }),
    ).toBe("Codex usage limit reached. No eligible alternate provider is currently configured.");
  });

  it("redacts secret-shaped failure details from attempt history", () => {
    const plan = planModelRouterFailover({
      decision: autoDecision(),
      failedTarget: { instanceId: instance("codex"), model: "gpt-5.5" },
      driver: driver("codex"),
      classification: classifyModelRouterFailure({
        category: "authentication_failed",
        scope: "provider_instance",
      }),
      attemptedInstanceIds: new Set(["codex"]),
      attemptedTargetKeys: new Set(["codex\u0000gpt-5.5"]),
      attemptCount: 1,
      nowMs: Date.parse("2026-09-30T00:00:00.000Z"),
      cooldowns: [],
      detail: "Authorization: Bearer sk-secret-token failed",
    });
    expect(plan.attempt.detail).toBe("[redacted]");
  });
});
