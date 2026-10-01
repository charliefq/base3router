import type {
  ModelRouterAvailabilityCooldown,
  ModelRouterCandidate,
  ModelRouterDecision,
} from "@t3tools/contracts";
import { MODEL_ROUTER_ATTEMPT_BUDGET } from "@t3tools/contracts";
import {
  classifyModelRouterFailure,
  formatModelRouterTerminalFailure,
  planModelRouterFailover,
  appendModelRouterAttempt,
} from "@t3tools/shared/modelRouterFailover";

import { UI_LAB_NOW_MS } from "./fixtures";

/** Deterministic probes that must never appear in rendered UI after sanitization. */
export const UI_LAB_SECRET_PROBE = "sk-lab-not-a-real-secret";
export const UI_LAB_BEARER_PROBE = "Bearer lab-not-a-real-token";

export type FakeProviderBehavior =
  | "success"
  | "quota_exhaustion"
  | "rate_limiting"
  | "authentication_failure"
  | "transient_transport"
  | "failure_before_output"
  | "failure_after_output";

export type FakeProviderAdapter = {
  readonly instanceId: string;
  readonly model: string;
  readonly driver: string;
  readonly behavior: FakeProviderBehavior;
};

export type SimulatedTurnResult = {
  readonly decision: ModelRouterDecision;
  readonly error: string | null;
  readonly assistantText: string | null;
  readonly status: "completed" | "failed";
};

const BEHAVIOR_DETAIL: Record<Exclude<FakeProviderBehavior, "success">, string> = {
  quota_exhaustion: "Codex usage limit reached. Send the message again once the limit resets.",
  rate_limiting: "429 too many requests. Rate limit exceeded.",
  authentication_failure: `401 unauthorized invalid api key ${UI_LAB_BEARER_PROBE} ${UI_LAB_SECRET_PROBE}`,
  transient_transport: "ECONNRESET socket hang up. Network error, temporarily unavailable.",
  failure_before_output: "ProviderAdapterProcessError: process exited before output.",
  failure_after_output: "Provider failed after a tool call started.",
};

function classifyBehavior(behavior: Exclude<FakeProviderBehavior, "success">) {
  if (behavior === "failure_after_output") {
    return classifyModelRouterFailure({
      category: "side_effect_started",
      scope: "global",
      sideEffectsStarted: true,
      detail: BEHAVIOR_DETAIL[behavior],
    });
  }
  if (behavior === "failure_before_output") {
    return classifyModelRouterFailure({
      tagged: "ProviderAdapterProcessError",
      detail: BEHAVIOR_DETAIL[behavior],
    });
  }
  return classifyModelRouterFailure({ detail: BEHAVIOR_DETAIL[behavior] });
}

export function labAdapters(behaviors: {
  readonly codex?: FakeProviderBehavior;
  readonly claude?: FakeProviderBehavior;
  readonly cursor?: FakeProviderBehavior;
}): ReadonlyArray<FakeProviderAdapter> {
  return [
    {
      instanceId: "codex",
      model: "gpt-5.5",
      driver: "codex",
      behavior: behaviors.codex ?? "success",
    },
    {
      instanceId: "claude",
      model: "claude-sonnet-4-6",
      driver: "claudeAgent",
      behavior: behaviors.claude ?? "success",
    },
    {
      instanceId: "cursor",
      model: "composer-2",
      driver: "cursor",
      behavior: behaviors.cursor ?? "success",
    },
  ];
}

export function simulateRoutedTurn(input: {
  readonly decision: ModelRouterDecision;
  readonly adapters: ReadonlyArray<FakeProviderAdapter>;
  readonly prompt: string;
  readonly nowMs?: number;
}): SimulatedTurnResult {
  const nowMs = input.nowMs ?? UI_LAB_NOW_MS;
  const adapterByInstance = new Map(
    input.adapters.map((adapter) => [adapter.instanceId, adapter] as const),
  );
  let decision: ModelRouterDecision = {
    ...input.decision,
    executionStatus: "running",
    attempts: [],
    executed: input.decision.selected,
  };
  const attemptedInstanceIds = new Set<string>();
  const attemptedTargetKeys = new Set<string>();
  let cooldowns: ModelRouterAvailabilityCooldown[] = [];
  let current: ModelRouterCandidate | null = decision.selected;
  let attemptCount = 0;
  const budget = decision.attemptBudget ?? MODEL_ROUTER_ATTEMPT_BUDGET;

  while (current !== null) {
    if (attemptCount >= budget) {
      const classification = classifyModelRouterFailure({
        category: "transient_transport",
        scope: "provider_instance",
      });
      return {
        decision: { ...decision, executionStatus: "failed" },
        error: formatModelRouterTerminalFailure({
          instanceId: current.target.instanceId,
          model: current.target.model,
          classification,
          mode: decision.mode,
          terminalReason: "FALLBACK_EXHAUSTED",
        }),
        assistantText: null,
        status: "failed",
      };
    }

    const adapter = adapterByInstance.get(current.target.instanceId);
    const behavior = adapter?.behavior ?? "success";
    attemptCount += 1;
    attemptedInstanceIds.add(current.target.instanceId);
    attemptedTargetKeys.add(`${current.target.instanceId}\u0000${current.target.model}`);

    if (behavior === "success") {
      decision = appendModelRouterAttempt(
        decision,
        {
          attempt: attemptCount,
          target: current.target,
          driver: current.driver,
          outcome: "succeeded",
          fallbackAllowed: false,
          nextTarget: null,
        },
        current,
        "completed",
      );
      return {
        decision,
        error: null,
        assistantText: `Lab reply via ${current.target.instanceId} · ${current.target.model}: ${input.prompt}`,
        status: "completed",
      };
    }

    const classification = classifyBehavior(behavior);
    const detail = BEHAVIOR_DETAIL[behavior];
    const plan = planModelRouterFailover({
      decision,
      failedTarget: current.target,
      driver: current.driver,
      classification,
      attemptedInstanceIds,
      attemptedTargetKeys,
      attemptCount,
      nowMs,
      cooldowns,
      detail,
    });
    if (plan.cooldown) {
      cooldowns = [...cooldowns, plan.cooldown];
    }
    const partialOutput =
      behavior === "failure_after_output" ? "Partial lab output before the provider failed." : null;
    if (plan.next === null || decision.mode === "manual") {
      decision = appendModelRouterAttempt(decision, plan.attempt, current, "failed");
      return {
        decision,
        error: formatModelRouterTerminalFailure({
          instanceId: current.target.instanceId,
          model: current.target.model,
          classification,
          mode: decision.mode,
          terminalReason: plan.terminalReason,
          detail,
        }),
        assistantText: partialOutput,
        status: "failed",
      };
    }
    decision = appendModelRouterAttempt(decision, plan.attempt, plan.next, "running");
    current = plan.next;
  }

  return {
    decision: { ...decision, executionStatus: "failed" },
    error: "No eligible model is currently configured.",
    assistantText: null,
    status: "failed",
  };
}

export function labDocumentContainsSecretProbe(text: string): boolean {
  return text.includes(UI_LAB_SECRET_PROBE) || text.includes(UI_LAB_BEARER_PROBE);
}
