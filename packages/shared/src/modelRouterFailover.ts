import {
  MODEL_ROUTER_ATTEMPT_BUDGET,
  type ModelRouterAvailabilityCooldown,
  type ModelRouterCandidate,
  type ModelRouterDecision,
  type ModelRouterFailureCategory,
  type ModelRouterFailureScope,
  type ModelRouterReasonCode,
  type ModelRouterRouteAttempt,
  type ModelRouterTarget,
} from "@t3tools/contracts";

import { MODEL_ROUTER_SECRET_REDACTION, modelRouterTargetKey } from "./modelRouter.ts";

const SECRET_SHAPED =
  /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|CURSOR_API_KEY\s*=|api[_-]?key\s*[=:]|Authorization\s*:/i;

const USAGE_LIMIT_DETAIL = /usage limit reached/i;
const RATE_LIMIT_DETAIL = /rate limit|too many requests|429\b/i;
const AUTH_DETAIL = /unauthoriz|unauthentic|\b401\b|\b403\b|invalid api key|not signed in/i;
const TRANSPORT_DETAIL =
  /econnreset|etimedout|socket hang up|network error|temporarily unavailable/i;
const MODEL_UNAVAILABLE_DETAIL = /model .*not found|unknown model|model is not available/i;

export type ModelRouterFailureClassification = {
  readonly category: ModelRouterFailureCategory;
  readonly scope: ModelRouterFailureScope;
  readonly sideEffectsStarted: boolean;
  readonly fallbackAllowed: boolean;
  readonly reasonCode: ModelRouterReasonCode;
};

export type ModelRouterFailoverPlan = {
  readonly classification: ModelRouterFailureClassification;
  readonly fallbackAllowed: boolean;
  readonly next: ModelRouterCandidate | null;
  readonly terminalReason: ModelRouterReasonCode;
  readonly attempt: ModelRouterRouteAttempt;
  readonly cooldown: ModelRouterAvailabilityCooldown | null;
};

const COOLDOWN_MS: Record<ModelRouterFailureCategory, number> = {
  model_unavailable: 60_000,
  provider_instance_unavailable: 60_000,
  usage_quota_exhausted: 15 * 60_000,
  rate_limited: 30_000,
  authentication_failed: 5 * 60_000,
  transient_transport: 15_000,
  non_retryable_request: 0,
  side_effect_started: 0,
};

function sanitizeDetail(detail: string): string {
  return SECRET_SHAPED.test(detail) ? MODEL_ROUTER_SECRET_REDACTION : detail.slice(0, 512);
}

function providerLabel(instanceId: string): string {
  if (instanceId.startsWith("claude")) return "Claude";
  if (instanceId.startsWith("codex")) return "Codex";
  if (instanceId.startsWith("cursor")) return "Cursor";
  if (instanceId.startsWith("grok")) return "Grok";
  if (instanceId.startsWith("opencode")) return "OpenCode";
  if (instanceId.startsWith("antigravity")) return "Antigravity";
  return instanceId;
}

function reasonForCategory(category: ModelRouterFailureCategory): ModelRouterReasonCode {
  switch (category) {
    case "usage_quota_exhausted":
      return "PROVIDER_USAGE_LIMIT";
    case "rate_limited":
      return "PROVIDER_RATE_LIMITED";
    case "side_effect_started":
      return "FALLBACK_BLOCKED_SIDE_EFFECT";
    default:
      return "PROVIDER_COOLDOWN";
  }
}

function fallbackAllowedFor(
  category: ModelRouterFailureCategory,
  scope: ModelRouterFailureScope,
  sideEffectsStarted: boolean,
): boolean {
  if (sideEffectsStarted || category === "side_effect_started") return false;
  if (category === "non_retryable_request" || scope === "global") return false;
  return true;
}

export function classifyModelRouterFailure(input: {
  readonly category?: ModelRouterFailureCategory;
  readonly scope?: ModelRouterFailureScope;
  readonly sideEffectsStarted?: boolean;
  readonly tagged?: string;
  readonly detail?: string;
}): ModelRouterFailureClassification {
  const sideEffectsStarted = input.sideEffectsStarted === true;
  let category = input.category;
  let scope = input.scope;

  if (category === undefined) {
    switch (input.tagged) {
      case "ProviderWorkspaceMissingError":
      case "ProviderAdapterValidationError":
      case "ProviderValidationError":
        category = "non_retryable_request";
        scope = "global";
        break;
      case "ProviderAdapterSessionNotFoundError":
      case "ProviderInstanceNotFoundError":
      case "ProviderUnsupportedError":
        category = "provider_instance_unavailable";
        scope = "provider_instance";
        break;
      case "ProviderAdapterProcessError":
        category = "transient_transport";
        scope = "provider_instance";
        break;
      default: {
        const detail = input.detail ?? "";
        if (USAGE_LIMIT_DETAIL.test(detail)) {
          category = "usage_quota_exhausted";
          scope = "provider_instance";
        } else if (RATE_LIMIT_DETAIL.test(detail)) {
          category = "rate_limited";
          scope = "provider_instance";
        } else if (AUTH_DETAIL.test(detail)) {
          category = "authentication_failed";
          scope = "provider_instance";
        } else if (MODEL_UNAVAILABLE_DETAIL.test(detail)) {
          category = "model_unavailable";
          scope = "model";
        } else if (TRANSPORT_DETAIL.test(detail)) {
          category = "transient_transport";
          scope = "provider_instance";
        } else {
          category = "non_retryable_request";
          scope = "global";
        }
      }
    }
  }

  if (sideEffectsStarted) {
    category = "side_effect_started";
    scope = "global";
  }

  const resolvedCategory = category ?? "non_retryable_request";
  const resolvedScope = scope ?? "global";
  return {
    category: resolvedCategory,
    scope: resolvedScope,
    sideEffectsStarted,
    fallbackAllowed: fallbackAllowedFor(resolvedCategory, resolvedScope, sideEffectsStarted),
    reasonCode: reasonForCategory(resolvedCategory),
  };
}

export function cooldownFromFailure(input: {
  readonly instanceId: ModelRouterTarget["instanceId"];
  readonly model: string;
  readonly classification: ModelRouterFailureClassification;
  readonly nowMs: number;
}): ModelRouterAvailabilityCooldown | null {
  const ttl = COOLDOWN_MS[input.classification.category];
  if (ttl <= 0) return null;
  return {
    instanceId: input.instanceId,
    ...(input.classification.scope === "model" ? { model: input.model } : {}),
    scope: input.classification.scope,
    category: input.classification.category,
    until: new Date(input.nowMs + ttl).toISOString(),
    reasonCode: input.classification.reasonCode,
  };
}

function candidateMatchesCooldown(
  candidate: ModelRouterCandidate,
  cooldown: ModelRouterAvailabilityCooldown,
  nowMs: number,
): boolean {
  if (Date.parse(cooldown.until) <= nowMs) return false;
  if (candidate.target.instanceId !== cooldown.instanceId) return false;
  if (cooldown.scope === "model") return candidate.target.model === cooldown.model;
  return true;
}

export function selectNextAutoRoute(input: {
  readonly decision: ModelRouterDecision;
  readonly failedTarget: ModelRouterTarget;
  readonly classification: ModelRouterFailureClassification;
  readonly attemptedInstanceIds: ReadonlySet<string>;
  readonly attemptedTargetKeys: ReadonlySet<string>;
  readonly attemptCount: number;
  readonly budget?: number;
  readonly nowMs: number;
  readonly cooldowns: ReadonlyArray<ModelRouterAvailabilityCooldown>;
}): {
  readonly fallbackAllowed: boolean;
  readonly next: ModelRouterCandidate | null;
  readonly terminalReason: ModelRouterReasonCode;
} {
  const budget = input.budget ?? input.decision.attemptBudget ?? MODEL_ROUTER_ATTEMPT_BUDGET;
  if (input.decision.mode !== "auto") {
    return { fallbackAllowed: false, next: null, terminalReason: "MANUAL_NO_FAILOVER" };
  }
  if (!input.classification.fallbackAllowed) {
    return {
      fallbackAllowed: false,
      next: null,
      terminalReason:
        input.classification.category === "side_effect_started"
          ? "FALLBACK_BLOCKED_SIDE_EFFECT"
          : "FALLBACK_EXHAUSTED",
    };
  }
  if (input.attemptCount >= budget) {
    return { fallbackAllowed: false, next: null, terminalReason: "FALLBACK_EXHAUSTED" };
  }

  const skipInstance =
    input.classification.scope === "provider_instance" ||
    input.classification.scope === "global" ||
    input.classification.category === "usage_quota_exhausted" ||
    input.classification.category === "rate_limited" ||
    input.classification.category === "authentication_failed";

  const pool = [
    ...input.decision.fallbacks,
    ...input.decision.candidates.filter((candidate) => candidate.eligible),
  ];
  const seen = new Set<string>();
  for (const candidate of pool) {
    const key = modelRouterTargetKey(candidate.target);
    if (seen.has(key) || !candidate.eligible) continue;
    seen.add(key);
    if (input.attemptedTargetKeys.has(key)) continue;
    if (input.attemptedInstanceIds.has(candidate.target.instanceId) && skipInstance) continue;
    if (skipInstance && candidate.target.instanceId === input.failedTarget.instanceId) {
      continue;
    }
    if (
      input.classification.scope === "model" &&
      candidate.target.instanceId === input.failedTarget.instanceId &&
      candidate.target.model === input.failedTarget.model
    ) {
      continue;
    }
    if (
      input.cooldowns.some((cooldown) => candidateMatchesCooldown(candidate, cooldown, input.nowMs))
    ) {
      continue;
    }
    return { fallbackAllowed: true, next: candidate, terminalReason: "FALLBACK_ATTEMPTED" };
  }

  return { fallbackAllowed: true, next: null, terminalReason: "NO_ALTERNATE_PROVIDER" };
}

export function planModelRouterFailover(input: {
  readonly decision: ModelRouterDecision;
  readonly failedTarget: ModelRouterTarget;
  readonly driver: ModelRouterCandidate["driver"];
  readonly classification: ModelRouterFailureClassification;
  readonly attemptedInstanceIds: ReadonlySet<string>;
  readonly attemptedTargetKeys: ReadonlySet<string>;
  readonly attemptCount: number;
  readonly nowMs: number;
  readonly cooldowns: ReadonlyArray<ModelRouterAvailabilityCooldown>;
  readonly detail: string;
}): ModelRouterFailoverPlan {
  const selected = selectNextAutoRoute(input);
  const cooldown = cooldownFromFailure({
    instanceId: input.failedTarget.instanceId,
    model: input.failedTarget.model,
    classification: input.classification,
    nowMs: input.nowMs,
  });
  return {
    classification: input.classification,
    fallbackAllowed: selected.fallbackAllowed && selected.next !== null,
    next: selected.next,
    terminalReason: selected.terminalReason,
    cooldown,
    attempt: {
      attempt: input.attemptCount,
      target: input.failedTarget,
      driver: input.driver,
      outcome: "failed",
      failureCategory: input.classification.category,
      failureScope: input.classification.scope,
      fallbackAllowed: selected.fallbackAllowed && selected.next !== null,
      nextTarget: selected.next?.target ?? null,
      detail: sanitizeDetail(input.detail),
    },
  };
}

export function formatModelRouterTerminalFailure(input: {
  readonly instanceId: string;
  readonly model: string;
  readonly classification: ModelRouterFailureClassification;
  readonly mode: ModelRouterDecision["mode"];
  readonly terminalReason: ModelRouterReasonCode;
  readonly detail?: string;
}): string {
  const label = providerLabel(input.instanceId);
  const quota =
    input.classification.category === "usage_quota_exhausted"
      ? `${label} usage limit reached.`
      : input.classification.category === "rate_limited"
        ? `${label} is rate limited.`
        : input.classification.category === "authentication_failed"
          ? `${label} is not authorized.`
          : input.classification.category === "model_unavailable"
            ? `${label} model ${input.model} is unavailable.`
            : input.classification.category === "transient_transport"
              ? `${label} had a temporary connection failure.`
              : input.classification.category === "provider_instance_unavailable"
                ? `${label} is currently unavailable.`
                : sanitizeDetail(input.detail ?? `${label} request failed.`);

  if (input.classification.category === "side_effect_started") {
    return `${quota} Automatic replay was skipped because the turn had already started work. Retry from the composer or switch to Auto Route.`;
  }
  if (input.mode === "manual") {
    return `${quota} Manual selection was kept. Switch to Auto Route in the composer to try another authorized provider, or open Provider settings.`;
  }
  if (input.terminalReason === "NO_ALTERNATE_PROVIDER") {
    return `${quota} No eligible alternate provider is currently configured.`;
  }
  if (input.terminalReason === "FALLBACK_EXHAUSTED") {
    return `${quota} Auto Route reached its attempt budget without an eligible alternate provider.`;
  }
  return quota;
}

export function appendModelRouterAttempt(
  decision: ModelRouterDecision,
  attempt: ModelRouterRouteAttempt,
  executed: ModelRouterCandidate | null,
  executionStatus: ModelRouterDecision["executionStatus"],
): ModelRouterDecision {
  const attempts = [...(decision.attempts ?? []), attempt].slice(0, 8);
  return {
    ...decision,
    attempts,
    executed,
    executionStatus,
    reasonCodes: [...new Set([...decision.reasonCodes, "FALLBACK_ATTEMPTED"])].slice(
      0,
      16,
    ) as typeof decision.reasonCodes,
  };
}
