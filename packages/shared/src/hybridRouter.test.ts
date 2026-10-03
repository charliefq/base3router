import { describe, expect, it } from "vite-plus/test";
import {
  HYBRID_ROUTER_POLICY_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  MODEL_ROUTER_POLICY_VERSION,
} from "@t3tools/contracts";

import { emptyLocalEvidence, routeHybridModel, type LocalModelEvidence } from "./hybridRouter.ts";
import type { ModelRouterCatalogEntry } from "./modelRouter.ts";

const instance = (id: string) => ProviderInstanceId.make(id);
const driver = (id: string) => ProviderDriverKind.make(id);

const entry = (input: {
  readonly instanceId: string;
  readonly model: string;
  readonly isDefault?: boolean;
}): ModelRouterCatalogEntry => ({
  instanceId: instance(input.instanceId),
  driver: driver(input.instanceId),
  model: input.model,
  isDefault: input.isDefault ?? false,
  capabilities: ["code", "tools"],
  availabilityReasons: [],
});

const catalog: ReadonlyArray<ModelRouterCatalogEntry> = [
  entry({ instanceId: "codex", model: "gpt-5.5", isDefault: true }),
  entry({ instanceId: "claude", model: "claude-sonnet-4-6" }),
];

const evidence = (overrides: Partial<LocalModelEvidence>): LocalModelEvidence => ({
  ...emptyLocalEvidence(),
  ...overrides,
});

const enough = (successRate: number, latency: number): LocalModelEvidence =>
  evidence({
    successTrials: 24,
    successCount: Math.round(24 * successRate),
    latencySamples: Array.from({ length: 24 }, () => latency),
    costSamples: Array.from({ length: 24 }, () => 0.02),
    costProvenance: "observed",
    costSource: "openrouter_accounting",
    reworkTrials: 24,
    reworkProxies: 2,
    verificationTrials: 21,
    verificationPassed: 18,
  });

describe("routeHybridModel", () => {
  it("falls back to Router V0 when evidence is insufficient", () => {
    const result = routeHybridModel({
      mode: "auto",
      catalog,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
    });
    expect(result.hybrid.usedHybridRanking).toBe(false);
    expect(result.hybrid.fallbackToV0).toBe(true);
    expect(result.decision.reasonCodes).toContain("HYBRID_INSUFFICIENT_EVIDENCE");
    expect(result.decision.selected?.target.instanceId).toBe("codex");
  });

  it("does not let Hybrid outweigh a missing capability", () => {
    const result = routeHybridModel({
      mode: "auto",
      catalog,
      constraints: { requiredCapabilities: ["vision"] },
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: new Map([
        [`${instance("claude")}\u0000claude-sonnet-4-6`, enough(0.99, 200)],
      ]),
    });
    expect(result.decision.selected).toBeNull();
    expect(result.hybrid.usedHybridRanking).toBe(false);
  });

  it("bypasses ranking for Manual", () => {
    const result = routeHybridModel({
      mode: "manual",
      catalog,
      manualOverride: { instanceId: instance("claude"), model: "claude-sonnet-4-6" },
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: new Map([[`${instance("codex")}\u0000gpt-5.5`, enough(0.99, 100)]]),
    });
    expect(result.decision.reasonCodes).toContain("MANUAL_OVERRIDE");
    expect(result.hybrid.usedHybridRanking).toBe(false);
    expect(result.decision.selected?.target.model).toBe("claude-sonnet-4-6");
  });

  it("ranks with local evidence when Hybrid is active", () => {
    const result = routeHybridModel({
      mode: "auto",
      catalog,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: new Map([
        [`${instance("codex")}\u0000gpt-5.5`, enough(0.4, 800)],
        [`${instance("claude")}\u0000claude-sonnet-4-6`, enough(0.95, 120)],
      ]),
    });
    expect(result.hybrid.usedHybridRanking).toBe(true);
    expect(result.decision.selected?.target.model).toBe("claude-sonnet-4-6");
    expect(result.decision.reasonCodes).toContain("HYBRID_RANKED");
    expect(result.hybrid.explanation).toContain(HYBRID_ROUTER_POLICY_VERSION);
    expect(result.hybrid.explanation).not.toMatch(/better because/i);
  });

  it("keeps policy shadow from changing V0 execution", () => {
    const result = routeHybridModel({
      mode: "auto",
      catalog,
      activePolicyVersion: MODEL_ROUTER_POLICY_VERSION,
      challengerEnabled: true,
      evidenceByTarget: new Map([
        [`${instance("codex")}\u0000gpt-5.5`, enough(0.4, 800)],
        [`${instance("claude")}\u0000claude-sonnet-4-6`, enough(0.95, 120)],
      ]),
    });
    expect(result.hybrid.usedHybridRanking).toBe(false);
    expect(result.decision.selected?.target.instanceId).toBe("codex");
    expect(result.hybrid.challenger?.kind).toBe("policy_shadow");
    expect(result.hybrid.challenger?.selected?.model).toBe("claude-sonnet-4-6");
    expect(result.hybrid.challenger?.agreement).toBe("disagreement");
  });

  it("shrinks small samples toward the prior instead of treating them as certain", () => {
    const weak = evidence({
      successTrials: 8,
      successCount: 8,
      latencySamples: Array.from({ length: 8 }, () => 100),
    });
    const strong = enough(0.8, 110);
    const result = routeHybridModel({
      mode: "auto",
      catalog,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: new Map([
        [`${instance("codex")}\u0000gpt-5.5`, weak],
        [`${instance("claude")}\u0000claude-sonnet-4-6`, strong],
      ]),
    });
    const success = result.hybrid.components.find((entry) => entry.id === "success");
    expect(success?.status).toBe("used");
    if (success?.value.status === "known") {
      expect(success.value.value).toBeLessThan(1);
    }
  });

  it("breaks remaining ties deterministically", () => {
    const same = enough(0.8, 200);
    const left = routeHybridModel({
      mode: "auto",
      catalog,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: new Map([
        [`${instance("codex")}\u0000gpt-5.5`, same],
        [`${instance("claude")}\u0000claude-sonnet-4-6`, same],
      ]),
    });
    const right = routeHybridModel({
      mode: "auto",
      catalog,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: new Map([
        [`${instance("codex")}\u0000gpt-5.5`, same],
        [`${instance("claude")}\u0000claude-sonnet-4-6`, same],
      ]),
    });
    expect(left.decision.selected).toEqual(right.decision.selected);
  });
});
