import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_DEFAULT_GUIDANCE_MODE,
  OPENROUTER_GUIDANCE_POLICY_VERSION,
  OPENROUTER_OBSERVATION_VERSION,
  OPENROUTER_SKIP_REASONS,
  OpenRouterGuidanceMode,
  OpenRouterMarketPriorV0,
  OpenRouterSkipReason,
  OpenRouterTeacherObservationV0,
  TaskProfileV0,
  emptyOpenRouterObservation,
} from "./openRouter.ts";
import { DispatcherTaskRouteBinding } from "./dispatcher.ts";
import { MODEL_ROUTER_DEFAULT_POLICY } from "./modelRouter.ts";
import { ServerSettings } from "./settings.ts";

const decodeMode = Schema.decodeUnknownExit(OpenRouterGuidanceMode);
const decodeObservation = Schema.decodeUnknownExit(OpenRouterTeacherObservationV0);
const decodeProfile = Schema.decodeUnknownExit(TaskProfileV0);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeBinding = Schema.decodeUnknownExit(DispatcherTaskRouteBinding);

describe("openrouter guidance contracts", () => {
  it("keeps Off as the default and rejects unknown modes", () => {
    expect(OPENROUTER_DEFAULT_GUIDANCE_MODE).toBe("off");
    expect(OPENROUTER_AUTO_SLUG).toBe("openrouter/auto");
    expect(OPENROUTER_GUIDANCE_POLICY_VERSION).toBe("openrouter-guidance.v0");
    expect(Exit.isSuccess(decodeMode("off"))).toBe(true);
    expect(Exit.isSuccess(decodeMode("shadow"))).toBe(true);
    expect(Exit.isSuccess(decodeMode("teacher"))).toBe(true);
    expect(Exit.isSuccess(decodeMode("auto"))).toBe(false);
  });

  it("preserves unknown future OpenRouter task tags without inventing confidence", () => {
    const decoded = decodeProfile({
      version: "openrouter-task-profile.v0",
      macroCategory: "other",
      rawExternalTag: "future:unknown_task_kind",
      source: "openrouter_auto",
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.rawExternalTag).toBe("future:unknown_task_kind");
      expect(decoded.value.confidence).toBeUndefined();
      expect(decoded.value.macroCategory).toBe("other");
    }
  });

  it("rejects fabricated numeric metrics and never encodes credentials", () => {
    const rejected = decodeObservation({
      version: OPENROUTER_OBSERVATION_VERSION,
      policyVersion: OPENROUTER_GUIDANCE_POLICY_VERSION,
      guidanceMode: "shadow",
      status: "observed",
      taskProfile: {
        version: "openrouter-task-profile.v0",
        macroCategory: "coding",
        source: "openrouter_auto",
      },
      allowedModels: ["anthropic/claude-sonnet-4.5"],
      costTier: "medium",
      privacyPolicy: "zdr_deny_collection",
      agreement: "agreement",
      nestedFallbacks: [],
      reportedCostUsd: 0,
    });
    expect(Exit.isFailure(rejected)).toBe(true);

    const observation = emptyOpenRouterObservation({
      guidanceMode: "off",
      status: "not_requested",
      skipReason: "guidance_off",
    });
    const encoded = JSON.stringify(observation);
    expect(encoded).not.toContain("sk-or-");
    expect(encoded).not.toContain("Bearer ");
    expect(encoded).not.toContain("Authorization");
    expect(encoded).not.toMatch(/"messages"|"content":/);
    expect(observation.privacyPolicy).toBe("zdr_deny_collection");
  });

  it("accepts every remaining skip reason and rejects removed privacy_blocked", () => {
    const decodeSkip = Schema.decodeUnknownExit(OpenRouterSkipReason);
    expect(OPENROUTER_SKIP_REASONS).not.toContain("privacy_blocked");
    for (const reason of OPENROUTER_SKIP_REASONS) {
      expect(Exit.isSuccess(decodeSkip(reason))).toBe(true);
      const observation = emptyOpenRouterObservation({
        guidanceMode: "shadow",
        status: "skipped",
        skipReason: reason,
      });
      expect(Exit.isSuccess(decodeObservation(observation))).toBe(true);
    }
    expect(Exit.isSuccess(decodeSkip("privacy_blocked"))).toBe(false);
  });

  it("decodes pre-Phase-10 settings and bindings without guidance fields", () => {
    const settings = decodeSettings({});
    expect(settings.openRouter.guidanceMode).toBe("off");
    expect(settings.openRouter.shadowConsent).toBe(false);
    expect(settings.providers.openrouter.enabled).toBe(false);

    const bound = decodeBinding({
      policyVersion: "dispatcher.phase-1a.v1",
      target: { instanceId: "codex", model: "gpt-5.4" },
      driver: "codex",
      modelFamily: "gpt",
      fallbackIndex: 0,
      source: "provider-default",
      gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
      modelRoute: {
        policyVersion: "model-router.v0",
        mode: "auto",
        task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: ["code"] },
        policy: MODEL_ROUTER_DEFAULT_POLICY,
        selected: null,
        fallbacks: [],
        candidates: [],
        reasonCodes: ["NO_ELIGIBLE_CANDIDATES"],
        explanation: "none",
        estimatedCostUsd: { status: "unknown" },
        estimatedLatencyMs: { status: "unknown" },
        estimatedQuality: { status: "unknown" },
        executionStatus: "bound",
      },
    });
    expect(Exit.isSuccess(bound)).toBe(true);
    if (Exit.isSuccess(bound)) {
      expect(bound.value.openRouter).toBeUndefined();
    }
  });

  it("labels market priors as sampled and keeps missing scores unknown", () => {
    const decoded = Schema.decodeUnknownExit(OpenRouterMarketPriorV0)({
      version: "openrouter-market-prior.v0",
      source: "openrouter_classifications",
      sampled: true,
      observedAt: "2026-10-01T00:00:00.000Z",
      freshness: "fresh",
      asOf: "2026-06-17",
      classifications: [
        {
          tag: "code:general_impl",
          displayName: "Code Generation",
          macroCategory: "code",
          usageShare: { status: "known", value: 0.23 },
          tokenShare: { status: "unknown" },
          models: [],
        },
      ],
      catalog: [],
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.sampled).toBe(true);
      expect(decoded.value.classifications[0]?.tokenShare).toEqual({ status: "unknown" });
    }
  });
});
