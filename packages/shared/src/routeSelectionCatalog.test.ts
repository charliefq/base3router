import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_ATTEMPT_BUDGET,
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_TIE_BREAK_DRIVERS,
  MODEL_ROUTER_UNKNOWN_METRICS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { routeHybridModel } from "./hybridRouter.ts";
import { selectNextAutoRoute } from "./modelRouterFailover.ts";
import { modelRouterCatalogForMode, modelRouterTargetKey, routeModel } from "./modelRouter.ts";

/**
 * Frozen catalog for the prepared route-selection comparison.
 * Slugs are the provider defaults in DEFAULT_MODEL_BY_PROVIDER. Drivers are
 * the Auto tie-break list. No prices and no measured samples are attached.
 */
const routeSelectionCatalog = MODEL_ROUTER_TIE_BREAK_DRIVERS.map((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const model = DEFAULT_MODEL_BY_PROVIDER[driver];
  if (model === undefined) {
    throw new Error(`No default model is configured for ${driverName}.`);
  }
  return {
    instanceId: ProviderInstanceId.make(driverName),
    driver,
    model,
    isDefault: false,
    capabilities: ["code", "tools"] as const,
    availabilityReasons: [] as const,
  };
});

const manualDriver = ProviderDriverKind.make("claudeAgent");
const manualModel = DEFAULT_MODEL_BY_PROVIDER[manualDriver];

describe("route-selection pilot catalog", () => {
  it("keeps one default slug for every Auto tie-break driver", () => {
    expect(routeSelectionCatalog.map((entry) => entry.driver)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
    ]);
    expect(routeSelectionCatalog.map((entry) => entry.model)).toEqual([
      "gpt-6-astra",
      "claude-fable-5-1",
      "auto",
      "grok-build",
      "openai/gpt-5",
      "antigravity-default",
    ]);
    expect(modelRouterCatalogForMode(routeSelectionCatalog, "auto")).toHaveLength(6);
  });

  it("selects the Codex default by v0 tie-break when every metric is unknown", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: routeSelectionCatalog,
      policy: MODEL_ROUTER_DEFAULT_POLICY,
    });
    expect(decision.policyVersion).toBe("model-router.v0");
    expect(decision.selected?.target).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
    });
    expect(decision.reasonCodes).toEqual(["SELECTED", "METRICS_UNKNOWN", "POLICY_TIE_BREAK"]);
    expect(decision.fallbacks.map((candidate) => candidate.target.instanceId)).toEqual([
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
    ]);
    expect(decision.estimatedCostUsd).toEqual({ status: "unknown" });
    expect(decision.estimatedLatencyMs).toEqual({ status: "unknown" });
    expect(decision.estimatedQuality).toEqual({ status: "unknown" });
    expect(decision.attemptBudget).toBe(MODEL_ROUTER_ATTEMPT_BUDGET);
    for (const candidate of decision.candidates) {
      expect(candidate.metrics).toEqual(MODEL_ROUTER_UNKNOWN_METRICS);
    }
  });

  it("pins Manual to the Claude default and refuses failover", () => {
    expect(manualModel).toBe("claude-fable-5-1");
    const decision = routeModel({
      mode: "manual",
      catalog: routeSelectionCatalog,
      policy: MODEL_ROUTER_DEFAULT_POLICY,
      manualOverride: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: manualModel ?? "",
      },
    });
    expect(decision.selected?.target).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-1",
    });
    expect(decision.reasonCodes).toContain("MANUAL_OVERRIDE");
    expect(decision.explanation).toContain("Automatic ranking was not applied");
    const selected = decision.selected;
    expect(selected).not.toBeNull();
    if (selected === null) return;
    const next = selectNextAutoRoute({
      decision,
      failedTarget: selected.target,
      classification: {
        category: "transient_transport",
        scope: "provider_instance",
        sideEffectsStarted: false,
        fallbackAllowed: true,
        reasonCode: "PROVIDER_COOLDOWN",
      },
      attemptedInstanceIds: new Set([selected.target.instanceId]),
      attemptedTargetKeys: new Set([modelRouterTargetKey(selected.target)]),
      attemptCount: 1,
      nowMs: Date.parse("2026-10-11T00:00:00.000Z"),
      cooldowns: [],
    });
    expect(next).toMatchObject({
      fallbackAllowed: false,
      next: null,
      terminalReason: "MANUAL_NO_FAILOVER",
    });
  });

  it("does not let an empty Hybrid evidence map change the Auto selection", () => {
    const hybrid = routeHybridModel({
      mode: "auto",
      catalog: routeSelectionCatalog,
      policy: MODEL_ROUTER_DEFAULT_POLICY,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
    });
    expect(hybrid.hybrid.usedHybridRanking).toBe(false);
    expect(hybrid.hybrid.fallbackToV0).toBe(true);
    expect(hybrid.decision.selected?.target.model).toBe("gpt-6-astra");
    expect(hybrid.decision.policyVersion).toBe("model-router.v0");
  });
});
