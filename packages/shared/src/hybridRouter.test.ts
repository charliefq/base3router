import { describe, expect, it } from "vite-plus/test";
import {
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  LOCAL_TASK_CLASSIFIER_VERSION,
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
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
    expect(result.decision.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
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
    expect(result.decision.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
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
    expect(result.decision.policyVersion).toBe(HYBRID_ROUTER_POLICY_VERSION);
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
    expect(result.decision.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
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

it("keeps Hybrid winner, distinct-instance fallbacks, estimates and reasons consistent", () => {
  const measuredCatalog = [
    {
      ...entry({ instanceId: "codex", model: "a", isDefault: true }),
      metrics: {
        quality: { status: "known" as const, value: 0.9 },
        costUsd: { status: "known" as const, value: 0.2 },
        latencyMs: { status: "known" as const, value: 100 },
      },
    },
    {
      ...entry({ instanceId: "claude", model: "b" }),
      metrics: {
        quality: { status: "known" as const, value: 0.1 },
        costUsd: { status: "known" as const, value: 0.3 },
        latencyMs: { status: "known" as const, value: 200 },
      },
    },
    entry({ instanceId: "claude", model: "b-other" }),
    entry({ instanceId: "third", model: "c" }),
  ];
  const result = routeHybridModel({
    mode: "auto",
    catalog: measuredCatalog,
    activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
    weights: {
      ...DEFAULT_HYBRID_ROUTER_WEIGHTS,
      preference: 0,
      latency: 0,
      cost: 0,
      marketPrior: 0,
      explicitPositive: 0,
      explicitNegative: 0,
      reworkProxy: 0,
      verification: 0,
      success: 10,
    },
    evidenceByTarget: new Map([
      ["codex\u0000a", enough(0, 100)],
      ["claude\u0000b", enough(1, 200)],
    ]),
  });
  expect(result.decision.selected?.target).toEqual({ instanceId: "claude", model: "b" });
  expect(result.decision.executed).toEqual(result.decision.selected);
  expect(result.decision.estimatedCostUsd).toEqual({ status: "known", value: 0.3 });
  expect(result.decision.estimatedLatencyMs).toEqual({ status: "known", value: 200 });
  expect(result.decision.estimatedQuality).toEqual({ status: "known", value: 0.1 });
  expect(result.decision.fallbacks.map((candidate) => candidate.target.instanceId)).toEqual([
    "codex",
    "third",
  ]);
  expect(result.decision.fallbacks.flatMap((candidate) => candidate.reasonCodes)).not.toContain(
    "SELECTED",
  );
  expect(result.decision.reasonCodes).toContain("HYBRID_RANKED");
  expect(result.decision.explanation).toContain("claude");
});

it("uses actual weights and requires a weighted evidence component before Hybrid execution", () => {
  const measured = new Map([
    ["codex\u0000gpt-5.5", enough(0, 1000)],
    ["claude\u0000claude-sonnet-4-6", enough(1, 200)],
  ]);
  const weights = {
    ...DEFAULT_HYBRID_ROUTER_WEIGHTS,
    preference: 0,
    marketPrior: 0,
    success: 0,
    latency: 0,
    cost: 0,
    explicitPositive: 0,
    explicitNegative: 0,
    reworkProxy: 0,
    verification: 0,
  };
  const result = routeHybridModel({
    mode: "auto",
    catalog,
    activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
    evidenceByTarget: measured,
    weights,
  });
  expect(result.hybrid.usedHybridRanking).toBe(false);
  expect(result.decision.selected?.target.instanceId).toBe("codex");
  const loadFailure = routeHybridModel({
    mode: "auto",
    catalog,
    activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
    evidenceByTarget: measured,
    policyLoadFailure: "Policy snapshot unavailable; Router V0 was used.",
  });
  expect(loadFailure.hybrid.usedHybridRanking).toBe(false);
  expect(loadFailure.hybrid.fallbackToV0).toBe(true);
  expect(loadFailure.hybrid.fallbackReason).toContain("unavailable");
  expect(loadFailure.decision.selected?.target.instanceId).toBe("codex");
});

it("does not claim Hybrid execution for an evidence-free winner when only another candidate has sufficient evidence", () => {
  const result = routeHybridModel({
    mode: "auto",
    catalog,
    activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
    weights: {
      ...DEFAULT_HYBRID_ROUTER_WEIGHTS,
      preference: 0,
      marketPrior: 10,
      success: 1,
      latency: 0,
      cost: 0,
      explicitPositive: 0,
      explicitNegative: 0,
      reworkProxy: 0,
      verification: 0,
    },
    evidenceByTarget: new Map([
      ["codex\u0000gpt-5.5", { ...emptyLocalEvidence(), marketPriorShare: 1 }],
      ["claude\u0000claude-sonnet-4-6", enough(1, 200)],
    ]),
  });
  expect(result.hybrid.usedHybridRanking).toBe(false);
  expect(result.hybrid.fallbackToV0).toBe(true);
  expect(result.decision.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
});

describe("explicit task-conditioned policy", () => {
  const profile = {
    classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
    category: "writing" as const,
    source: "local-heuristic" as const,
  };
  const conditionedCatalog = [
    entry({ instanceId: "a", model: "a" }),
    entry({ instanceId: "b", model: "b" }),
  ];
  const local = (n: number, positive: boolean) =>
    evidence({ successTrials: n, successCount: positive ? n : 0 });
  const input = (n: number) => ({
    mode: "auto" as const,
    catalog: conditionedCatalog,
    activePolicyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
    localTaskProfile: profile,
    evidenceByTarget: new Map([
      ["a\u0000a", local(n, false)],
      ["b\u0000b", local(n, true)],
    ]),
  });
  it("falls back at seven trials and ranks at eight only when every eligible model is covered", () => {
    const seven = routeHybridModel(input(7));
    expect(seven.hybrid.usedHybridRanking).toBe(false);
    expect(seven.hybrid.fallbackReason).toContain("every eligible candidate");
    const eight = routeHybridModel(input(8));
    expect(eight.hybrid.usedHybridRanking).toBe(true);
    expect(eight.decision.selected?.target.instanceId).toBe("b");
    expect(eight.decision.policyVersion).toBe(HYBRID_TASK_ROUTER_POLICY_VERSION);
    expect(eight.hybrid.policyVersion).toBe(HYBRID_TASK_ROUTER_POLICY_VERSION);
    expect(eight.decision.explanation).toContain("Local task writing");
    const missing = routeHybridModel({
      ...input(8),
      catalog: [...conditionedCatalog, entry({ instanceId: "c", model: "c" })],
    });
    expect(missing.hybrid.usedHybridRanking).toBe(false);
    expect(missing.hybrid.fallbackToV0).toBe(true);
  });
  it("keeps unavailable, unauthenticated, cooldown and hard-filtered models out of coverage", () => {
    for (const reason of [
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_UNAUTHENTICATED",
      "PROVIDER_COOLDOWN",
    ] as const) {
      const result = routeHybridModel({
        ...input(8),
        catalog: [
          ...conditionedCatalog,
          { ...entry({ instanceId: "c", model: "c" }), availabilityReasons: [reason] },
        ],
      });
      expect(result.hybrid.usedHybridRanking).toBe(true);
      expect(result.hybrid.eligibleCount).toBe(2);
      expect(
        result.decision.fallbacks.some((candidate) => candidate.target.instanceId === "c"),
      ).toBe(false);
    }
    const hard = routeHybridModel({
      ...input(8),
      constraints: { requiredCapabilities: ["code"] },
      catalog: [conditionedCatalog[0]!, { ...conditionedCatalog[1]!, capabilities: [] }],
    });
    expect(hard.decision.selected?.target.instanceId).toBe("a");
    const impossible = routeHybridModel({ ...input(8), constraints: { maxCostUsd: 0 } });
    expect(impossible.decision.selected).toBeNull();
    expect(impossible.hybrid.usedHybridRanking).toBe(false);
  });
  it("rejects absent, unknown and unsupported profiles while preserving Manual", () => {
    const { localTaskProfile: _, ...absent } = input(8);
    for (const request of [
      absent,
      { ...input(8), localTaskProfile: { ...profile, category: "unknown" as const } },
      { ...input(8), localTaskProfile: { ...profile, classifierVersion: "other" } },
    ]) {
      const result = routeHybridModel(request);
      expect(result.hybrid.fallbackToV0).toBe(true);
      expect(result.hybrid.usedHybridRanking).toBe(false);
      expect(result.decision.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
    }
    const manual = routeHybridModel({
      ...input(8),
      mode: "manual",
      manualOverride: conditionedCatalog[0]!,
    });
    expect(manual.decision.selected?.target.instanceId).toBe("a");
    expect(manual.hybrid.usedHybridRanking).toBe(false);
  });
  it("compares new shadow with the actual active v1 choice without replacing its decision", () => {
    const aggregate = new Map([
      ["a\u0000a", local(24, true)],
      ["b\u0000b", local(24, false)],
    ]);
    const active = {
      mode: "auto" as const,
      catalog: conditionedCatalog,
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      evidenceByTarget: aggregate,
      localTaskProfile: profile,
    };
    const original = routeHybridModel(active);
    const shadow = routeHybridModel({
      ...active,
      shadowPolicy: {
        policyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
        weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
        shrinkageK: 10,
        minSampleRate: 8,
        evidenceByTarget: input(24).evidenceByTarget,
      },
    });
    expect(shadow.decision).toEqual(original.decision);
    expect(shadow.hybrid.selected?.instanceId).toBe("a");
    expect(shadow.hybrid.challenger).toMatchObject({
      policyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
      selected: { instanceId: "b", model: "b" },
      agreement: "disagreement",
    });
    const insufficient = routeHybridModel({
      ...active,
      shadowPolicy: {
        policyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
        weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
        shrinkageK: 10,
        minSampleRate: 8,
        evidenceByTarget: input(7).evidenceByTarget,
      },
    });
    expect(insufficient.decision).toEqual(original.decision);
    expect(insufficient.hybrid.challenger?.agreement).toBe("inapplicable");
    expect(insufficient.hybrid.challenger?.fallbackReason).toContain("coverage");
  });
});

it("preserves the existing V0 / v1 shadow decision while calculating its explicit shadow independently", () => {
  const measured = new Map([
    ["codex\u0000gpt-5.5", enough(0.4, 900)],
    ["claude\u0000claude-sonnet-4-6", enough(1, 200)],
  ]);
  const original = routeHybridModel({
    mode: "auto",
    catalog,
    activePolicyVersion: MODEL_ROUTER_POLICY_VERSION,
    evidenceByTarget: measured,
    challengerEnabled: true,
  });
  const explicit = routeHybridModel({
    mode: "auto",
    catalog,
    activePolicyVersion: MODEL_ROUTER_POLICY_VERSION,
    evidenceByTarget: measured,
    shadowPolicy: {
      policyVersion: HYBRID_ROUTER_POLICY_VERSION,
      weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
      shrinkageK: 10,
      minSampleRate: 8,
      evidenceByTarget: measured,
    },
  });
  expect(explicit.decision).toEqual(original.decision);
});

it("selects debugging A and writing B from distinct exact task cohorts on the same catalog", () => {
  const sameCatalog = [
    entry({ instanceId: "a", model: "a" }),
    entry({ instanceId: "b", model: "b" }),
  ];
  const candidate = (success: boolean) =>
    evidence({ successTrials: 24, successCount: success ? 24 : 0 });
  const result = (category: "debugging" | "writing") =>
    routeHybridModel({
      mode: "auto",
      catalog: sameCatalog,
      activePolicyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
      localTaskProfile: {
        classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
        category,
        source: "local-heuristic",
      },
      evidenceByTarget: new Map([
        ["a\u0000a", candidate(category === "debugging")],
        ["b\u0000b", candidate(category === "writing")],
      ]),
    });
  expect(result("debugging").decision.selected?.target.instanceId).toBe("a");
  expect(result("writing").decision.selected?.target.instanceId).toBe("b");
  expect(result("writing").decision.policyVersion).toBe(HYBRID_TASK_ROUTER_POLICY_VERSION);
});
