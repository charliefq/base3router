import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  ModelRouterConstraints,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRouterMetrics,
  type ModelRouterCandidate,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  MODEL_ROUTER_SECRET_REDACTION,
  applyModelRouterCooldowns,
  modelRouterCatalogForMode,
  modelRouterCatalogFromProviders,
  modelRouterDecisionOmitsSecrets,
  routeModel,
  type ModelRouterCatalogEntry,
} from "./modelRouter.ts";

const instance = (id: string) => ProviderInstanceId.make(id);
const driver = (id: string) => ProviderDriverKind.make(id);

const entry = (input: {
  readonly instanceId: string;
  readonly model: string;
  readonly driver?: ModelRouterCatalogEntry["driver"];
  readonly isDefault?: boolean;
  readonly capabilities?: ModelRouterCatalogEntry["capabilities"];
  readonly availabilityReasons?: ModelRouterCatalogEntry["availabilityReasons"];
  readonly metrics?: ModelRouterMetrics;
}): ModelRouterCatalogEntry => ({
  instanceId: instance(input.instanceId),
  driver: input.driver ?? driver(input.instanceId),
  model: input.model,
  isDefault: input.isDefault ?? false,
  capabilities: input.capabilities ?? ["code", "tools"],
  availabilityReasons: input.availabilityReasons ?? [],
  ...(input.metrics ? { metrics: input.metrics } : {}),
});

describe("estimated hard limits", () => {
  const metrics = (costUsd: number, latencyMs: number, quality = 1): ModelRouterMetrics => ({
    quality: { status: "known", value: quality },
    costUsd: { status: "known", value: costUsd },
    latencyMs: { status: "known", value: latencyMs },
  });
  const rows = [
    {
      field: "maxCostUsd",
      value: 0.5,
      limit: 1,
      eligible: true,
      reason: "ESTIMATED_COST_LIMIT_EXCEEDED",
    },
    {
      field: "maxCostUsd",
      value: 1,
      limit: 1,
      eligible: true,
      reason: "ESTIMATED_COST_LIMIT_EXCEEDED",
    },
    {
      field: "maxCostUsd",
      value: 2,
      limit: 1,
      eligible: false,
      reason: "ESTIMATED_COST_LIMIT_EXCEEDED",
    },
    {
      field: "maxLatencyMs",
      value: 50,
      limit: 100,
      eligible: true,
      reason: "ESTIMATED_LATENCY_LIMIT_EXCEEDED",
    },
    {
      field: "maxLatencyMs",
      value: 100,
      limit: 100,
      eligible: true,
      reason: "ESTIMATED_LATENCY_LIMIT_EXCEEDED",
    },
    {
      field: "maxLatencyMs",
      value: 101,
      limit: 100,
      eligible: false,
      reason: "ESTIMATED_LATENCY_LIMIT_EXCEEDED",
    },
    {
      field: "maxCostUsd",
      value: 0,
      limit: 0,
      eligible: true,
      reason: "ESTIMATED_COST_LIMIT_EXCEEDED",
    },
    {
      field: "maxLatencyMs",
      value: 0,
      limit: 0,
      eligible: true,
      reason: "ESTIMATED_LATENCY_LIMIT_EXCEEDED",
    },
  ] as const;
  it.each(rows)("filters $field metric $value against $limit (eligible=$eligible)", (row) => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({
          instanceId: "fixture-limit",
          model: "fixture-model",
          metrics: row.field === "maxCostUsd" ? metrics(row.value, 0) : metrics(0, row.value),
        }),
      ],
      constraints: { [row.field]: row.limit },
    });
    expect(decision.candidates[0]?.eligible).toBe(row.eligible);
    expect(decision.candidates[0]?.reasonCodes).toEqual(row.eligible ? [] : [row.reason]);
    expect(decision.selected?.target.model ?? null).toBe(row.eligible ? "fixture-model" : null);
    expect(decision.fallbacks).toEqual([]);
    const estimate =
      row.field === "maxCostUsd" ? decision.estimatedCostUsd : decision.estimatedLatencyMs;
    expect(estimate).toEqual(
      row.eligible ? { status: "known", value: row.value } : { status: "unknown" },
    );
  });

  it.each([
    { field: "maxCostUsd", reason: "ESTIMATED_COST_UNKNOWN" },
    { field: "maxLatencyMs", reason: "ESTIMATED_LATENCY_UNKNOWN" },
  ] as const)("fails closed for unknown $field evidence", ({ field, reason }) => {
    const decision = routeModel({
      mode: "auto",
      catalog: [entry({ instanceId: "fixture-unknown", model: "unknown" })],
      constraints: { [field]: 0 },
    });
    expect(decision.candidates[0]).toMatchObject({ eligible: false, reasonCodes: [reason] });
    expect(decision.selected).toBeNull();
    expect(decision.reasonCodes).toContain(reason);
    expect(decision.estimatedCostUsd).toEqual({ status: "unknown" });
    expect(decision.estimatedLatencyMs).toEqual({ status: "unknown" });
  });

  it("does not constrain an unknown dimension without its corresponding limit", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({
          instanceId: "fixture-partial",
          model: "partial",
          metrics: { ...metrics(0.5, 0), latencyMs: { status: "unknown" } },
        }),
      ],
      constraints: { maxCostUsd: 1 },
    });
    expect(decision.candidates[0]?.eligible).toBe(true);
    expect(decision.selected?.target.model).toBe("partial");
    expect(decision.estimatedLatencyMs).toEqual({ status: "unknown" });
  });

  const constrainedCatalog = [
    entry({ instanceId: "over-cost", model: "expensive", metrics: metrics(2, 1, 100) }),
    entry({ instanceId: "over-latency", model: "slow", metrics: metrics(0.1, 101, 80) }),
    entry({ instanceId: "unknown", model: "unknown" }),
    entry({
      instanceId: "good-low",
      model: "good-low",
      driver: driver("codex"),
      metrics: metrics(0.2, 10, 1),
    }),
    entry({
      instanceId: "good-high",
      model: "good-high",
      driver: driver("claudeAgent"),
      metrics: metrics(0.3, 20, 5),
    }),
  ];
  it("filters both limits before weighted ranking and exposes only eligible fallbacks deterministically", () => {
    const input = {
      mode: "auto" as const,
      catalog: constrainedCatalog,
      constraints: { maxCostUsd: 1, maxLatencyMs: 100 },
      policy: {
        version: "model-router.v0" as const,
        qualityWeight: 1,
        costWeight: 0,
        latencyWeight: 0,
      },
    };
    const decision = routeModel(input);
    expect(decision.selected?.target.instanceId).toBe("good-high");
    expect(decision.fallbacks.map((item) => item.target.instanceId)).toEqual(["good-low"]);
    expect(
      decision.candidates.find((item) => item.target.instanceId === "over-cost"),
    ).toMatchObject({ eligible: false, reasonCodes: ["ESTIMATED_COST_LIMIT_EXCEEDED"] });
    expect(
      decision.candidates.find((item) => item.target.instanceId === "over-latency"),
    ).toMatchObject({ eligible: false, reasonCodes: ["ESTIMATED_LATENCY_LIMIT_EXCEEDED"] });
    expect(decision.candidates.find((item) => item.target.instanceId === "unknown")).toMatchObject({
      eligible: false,
      reasonCodes: ["ESTIMATED_COST_UNKNOWN", "ESTIMATED_LATENCY_UNKNOWN"],
    });
    expect(decision.estimatedCostUsd).toEqual({ status: "known", value: 0.3 });
    expect(routeModel(input)).toEqual(decision);
    expect(routeModel({ ...input, catalog: constrainedCatalog.toReversed() })).toEqual(decision);
  });

  it.each([
    {
      constraints: { maxCostUsd: 1 },
      metrics: metrics(2, 1),
      reason: "ESTIMATED_COST_LIMIT_EXCEEDED",
    },
    {
      constraints: { maxLatencyMs: 100 },
      metrics: metrics(0.1, 101),
      reason: "ESTIMATED_LATENCY_LIMIT_EXCEEDED",
    },
    {
      constraints: { maxCostUsd: 1 },
      metrics: { ...metrics(0, 0), costUsd: { status: "unknown" as const } },
      reason: "ESTIMATED_COST_UNKNOWN",
    },
    {
      constraints: { maxLatencyMs: 100 },
      metrics: { ...metrics(0, 0), latencyMs: { status: "unknown" as const } },
      reason: "ESTIMATED_LATENCY_UNKNOWN",
    },
  ])("keeps manual provenance while rejecting $reason overrides", (row) => {
    const decision = routeModel({
      mode: "manual",
      catalog: [
        entry({ instanceId: "manual", model: "manual", metrics: row.metrics }),
        entry({ instanceId: "other", model: "other", metrics: metrics(0, 0) }),
      ],
      manualOverride: { instanceId: instance("manual"), model: "manual" },
      constraints: row.constraints,
    });
    expect(decision.selected).toBeNull();
    expect(decision.executed).toBeNull();
    expect(decision.reasonCodes).toContain("MANUAL_OVERRIDE");
    expect(decision.reasonCodes).toContain(row.reason);
    expect(decision.reasonCodes).not.toContain("SELECTED");
    expect(decision.candidates.find((item) => item.target.instanceId === "manual")?.eligible).toBe(
      false,
    );
    expect(decision.fallbacks.map((item) => item.target.instanceId)).toEqual(["other"]);
    expect(decision.estimatedCostUsd.status).toBe("unknown");
    expect(decision.estimatedLatencyMs.status).toBe("unknown");
  });

  it("allows a manual override exactly at both supplied limits", () => {
    const decision = routeModel({
      mode: "manual",
      catalog: [entry({ instanceId: "manual", model: "manual", metrics: metrics(1, 100) })],
      manualOverride: { instanceId: instance("manual"), model: "manual" },
      constraints: { maxCostUsd: 1, maxLatencyMs: 100 },
    });
    expect(decision.selected).toMatchObject({ eligible: true, target: { instanceId: "manual" } });
    expect(decision.reasonCodes).toContain("MANUAL_OVERRIDE");
    expect(decision.estimatedCostUsd).toEqual({ status: "known", value: 1 });
    expect(decision.estimatedLatencyMs).toEqual({ status: "known", value: 100 });
  });

  it.each(["maxCostUsd", "maxLatencyMs"] as const)(
    "decodes only finite non-negative optional $field without a default",
    (field) => {
      const decode = Schema.decodeUnknownOption(ModelRouterConstraints);
      for (const value of [0, 0.5, 100]) {
        const decoded = decode({ [field]: value });
        expect(decoded._tag).toBe("Some");
        if (decoded._tag === "Some") expect(decoded.value[field]).toBe(value);
      }
      for (const value of [-0.1, Number.NaN, Infinity, -Infinity, null])
        expect(decode({ [field]: value })._tag).toBe("None");
      const empty = decode({});
      expect(empty._tag).toBe("Some");
      if (empty._tag === "Some") expect(empty.value[field]).toBeUndefined();
    },
  );

  it.each([
    {
      mode: "auto" as const,
      hash: "f57047c11b494c0923aac4aaf88982a6db2573a3c5d015e2aa68eeed3a54bd74",
    },
    {
      mode: "manual" as const,
      hash: "74cdcb20e9b318425d25958f5489c8b78446efb0a03ff5b43b928876fbf366fc",
    },
  ])("preserves exact-base $mode routing identity when limits are absent", ({ mode, hash }) => {
    const catalog = [
      entry({
        instanceId: "fixture-a",
        model: "fixture-a",
        driver: driver("codex"),
        capabilities: ["code"],
      }),
      entry({
        instanceId: "fixture-b",
        model: "fixture-b",
        driver: driver("claudeAgent"),
        capabilities: ["code"],
      }),
    ];
    const input = {
      mode,
      catalog,
      ...(mode === "manual"
        ? {
            manualOverride: { instanceId: instance("fixture-missing"), model: "fixture-missing" },
          }
        : {}),
    };
    const decision = routeModel(input);
    // Base-generated identity oracle excludes the explanation and attribution being repaired.
    const {
      explanation: _explanation,
      reasonCodes: _reasons,
      selectionBasis: _basis,
      ...identity
    } = decision;
    const candidateIdentity = (candidate: ModelRouterCandidate | null | undefined) => {
      if (candidate == null) return candidate;
      const { reasonCodes: _codes, ...rest } = candidate;
      return rest;
    };
    const routingIdentity = {
      ...identity,
      selected: candidateIdentity(identity.selected),
      fallbacks: identity.fallbacks.map(candidateIdentity),
      candidates: identity.candidates.map(candidateIdentity),
      executed: candidateIdentity(identity.executed),
    };
    expect(
      NodeCrypto.createHash("sha256").update(JSON.stringify(routingIdentity)).digest("hex"),
    ).toBe(hash);
    expect(routeModel({ ...input, constraints: {} })).toEqual(decision);
  });
});

describe("Manual explicit hard constraints", () => {
  const target = { instanceId: instance("manual"), model: "manual-model" };
  const manual = entry({
    instanceId: "manual",
    model: target.model,
    driver: driver("codex"),
    metrics: {
      quality: { status: "known", value: 1 },
      costUsd: { status: "known", value: 0.5 },
      latencyMs: { status: "known", value: 100 },
    },
  });
  const peer = entry({
    instanceId: "peer",
    model: "peer-model",
    driver: driver("claudeAgent"),
    capabilities: ["code", "tools", "vision"],
  });
  const rejected: ReadonlyArray<{
    name: string;
    constraints: ModelRouterConstraints;
    reason: string;
  }> = [
    {
      name: "missing capability",
      constraints: { requiredCapabilities: ["vision"] },
      reason: "REQUIRED_CAPABILITY_MISSING",
    },
    {
      name: "instance allow mismatch",
      constraints: { allowedInstanceIds: [instance("peer")] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "instance exclude match",
      constraints: { excludedInstanceIds: [target.instanceId] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "driver allow mismatch",
      constraints: { allowedDrivers: [driver("claudeAgent")] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "driver exclude match",
      constraints: { excludedDrivers: [driver("codex")] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "model allow mismatch",
      constraints: { allowedModels: [peer.model] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "model exclude match",
      constraints: { excludedModels: [target.model] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "empty instance allow",
      constraints: { allowedInstanceIds: [] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "empty driver allow",
      constraints: { allowedDrivers: [] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "empty model allow",
      constraints: { allowedModels: [] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "intersecting include/exclude",
      constraints: { allowedModels: [target.model, peer.model], excludedModels: [target.model] },
      reason: "CONSTRAINT_EXCLUDED",
    },
    {
      name: "capability with numeric limits",
      constraints: { requiredCapabilities: ["vision"], maxCostUsd: 0.5, maxLatencyMs: 100 },
      reason: "REQUIRED_CAPABILITY_MISSING",
    },
    {
      name: "instance mismatch and exceeded cost",
      constraints: { allowedInstanceIds: [instance("peer")], maxCostUsd: 0.4 },
      reason: "CONSTRAINT_EXCLUDED",
    },
  ];
  it.each(rejected)("rejects $name without switching to a peer", ({ constraints, reason }) => {
    const decision = routeModel({
      mode: "manual",
      catalog: [manual, peer],
      manualOverride: target,
      constraints,
    });
    expect(decision.mode).toBe("manual");
    expect(decision.selected).toBeNull();
    expect(decision.executed).toBeNull();
    expect(decision.attempts).toEqual([]);
    expect(decision.reasonCodes).toContain("MANUAL_OVERRIDE");
    expect(decision.reasonCodes).toContain(reason);
  });
  const allowed: ReadonlyArray<ModelRouterConstraints | undefined> = [
    undefined,
    {},
    { requiredCapabilities: [], excludedInstanceIds: [], excludedDrivers: [], excludedModels: [] },
    { requiredCapabilities: ["code", "tools", "code"] },
    { allowedInstanceIds: [target.instanceId], excludedInstanceIds: [instance("peer")] },
    { allowedDrivers: [driver("codex")], excludedDrivers: [driver("claudeAgent")] },
    { allowedModels: [target.model], excludedModels: [peer.model] },
    {
      allowedInstanceIds: [instance("peer"), target.instanceId, target.instanceId],
      allowedDrivers: [driver("codex"), driver("codex")],
      allowedModels: [peer.model, target.model, target.model],
      maxCostUsd: 0.5,
      maxLatencyMs: 100,
    },
  ];
  it.each(allowed)("keeps a legal explicit target for %j", (constraints) => {
    const decision = routeModel({
      mode: "manual",
      catalog: [manual, peer],
      manualOverride: target,
      ...(constraints === undefined ? {} : { constraints }),
    });
    expect(decision.selected?.target).toEqual(target);
    expect(decision.executed?.target).toEqual(target);
  });
  it("does not turn availability hints into Manual hard constraints", () => {
    const decision = routeModel({
      mode: "manual",
      catalog: [{ ...manual, availabilityReasons: ["PROVIDER_UNAVAILABLE"] }, peer],
      manualOverride: target,
      constraints: { allowedInstanceIds: [target.instanceId] },
    });
    expect(decision.selected?.target).toEqual(target);
    expect(decision.selected?.eligible).toBe(false);
  });
  it("ignores ordering and duplicates in constraint lists", () => {
    const base = { mode: "manual" as const, catalog: [manual, peer], manualOverride: target };
    const left = routeModel({
      ...base,
      constraints: {
        allowedModels: [target.model, peer.model],
        excludedModels: ["other", "other"],
        requiredCapabilities: ["code", "tools"],
      },
    });
    const right = routeModel({
      ...base,
      constraints: {
        allowedModels: [peer.model, target.model, target.model],
        excludedModels: ["other"],
        requiredCapabilities: ["tools", "code", "code"],
      },
    });
    expect(left.selected?.target).toEqual(right.selected?.target);
    expect(left.reasonCodes).toEqual(right.reasonCodes);
  });
  it("checks the requested target even when it falls outside the bounded candidate display", () => {
    const catalog = [
      ...Array.from({ length: 70 }, (_, i) => entry({ instanceId: `first-${i}`, model: "first" })),
      entry({ instanceId: "zz-manual", model: "last" }),
    ];
    const decision = routeModel({
      mode: "manual",
      catalog,
      manualOverride: { instanceId: instance("zz-manual"), model: "last" },
      constraints: { excludedModels: ["last"] },
    });
    expect(
      decision.candidates.some((candidate) => candidate.target.instanceId === "zz-manual"),
    ).toBe(false);
    expect(decision.selected).toBeNull();
    expect(decision.reasonCodes).toContain("CONSTRAINT_EXCLUDED");
  });
  it.each([
    { constraints: { allowedDrivers: [driver("codex")] }, reason: "CONSTRAINT_METADATA_UNKNOWN" },
    {
      constraints: { excludedDrivers: [driver("claudeAgent")] },
      reason: "CONSTRAINT_METADATA_UNKNOWN",
    },
    { constraints: { allowedDrivers: [] }, reason: "CONSTRAINT_EXCLUDED" },
    {
      constraints: { requiredCapabilities: ["code" as const] },
      reason: "REQUIRED_CAPABILITY_MISSING",
    },
  ])("does not invent unknown metadata for $reason", ({ constraints, reason }) => {
    const unknown = { ...manual, driver: null, capabilities: [] };
    const decision = routeModel({
      mode: "manual",
      catalog: [unknown],
      manualOverride: target,
      constraints,
    });
    expect(decision.selected).toBeNull();
    expect(decision.executed).toBeNull();
    expect(decision.reasonCodes).toContain(reason);
    expect(decision.candidates[0]?.driver).toBeNull();
    expect(decision.candidates[0]?.capabilities).toEqual([]);
  });
  it("does not reject unrelated identity constraints because metadata is unknown", () => {
    const unknown = { ...manual, driver: null, capabilities: [] };
    const decision = routeModel({
      mode: "manual",
      catalog: [unknown],
      manualOverride: target,
      constraints: {
        allowedInstanceIds: [target.instanceId],
        allowedModels: [target.model],
        excludedDrivers: [],
        requiredCapabilities: [],
      },
    });
    expect(decision.selected?.target).toEqual(target);
    expect(decision.selected?.driver).toBeNull();
  });
  it("Auto excludes only related unknown-driver conditions", () => {
    const unknown = { ...manual, driver: null };
    const decision = routeModel({
      mode: "auto",
      catalog: [unknown, peer],
      constraints: { excludedDrivers: [driver("codex")] },
    });
    expect(decision.selected?.target.instanceId).toBe(peer.instanceId);
    expect(
      decision.candidates.find((candidate) => candidate.target.instanceId === target.instanceId)
        ?.reasonCodes,
    ).toContain("CONSTRAINT_METADATA_UNKNOWN");
  });
});

const known = (value: number): ModelRouterMetrics => ({
  quality: { status: "known", value },
  costUsd: { status: "known", value: 1 },
  latencyMs: { status: "known", value: 100 },
});

const provider = (input: {
  readonly instanceId: string;
  readonly models: ReadonlyArray<string>;
  readonly authStatus?: ServerProvider["auth"]["status"];
}): ServerProvider => ({
  instanceId: instance(input.instanceId),
  driver: driver(input.instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: input.authStatus ?? "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: input.models.map((model) => ({
    slug: model,
    name: model,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

describe("routeModel", () => {
  const catalog = [
    entry({ instanceId: "claude", model: "claude-sonnet-4-6", driver: driver("claudeAgent") }),
    entry({ instanceId: "codex", model: "gpt-5.4", driver: driver("codex"), isDefault: true }),
    entry({ instanceId: "cursor", model: "composer-2", driver: driver("cursor") }),
  ];

  it("is deterministic for identical Auto inputs", () => {
    const input = { mode: "auto" as const, catalog };
    expect(routeModel(input)).toEqual(routeModel(input));
    expect(routeModel(input).selected?.target).toEqual({
      instanceId: instance("codex"),
      model: "gpt-5.4",
    });
  });

  it("filters models missing required capabilities", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({ instanceId: "visionless", model: "text-only", capabilities: ["code", "tools"] }),
        entry({
          instanceId: "multimodal",
          model: "vision-1",
          capabilities: ["code", "tools", "vision"],
        }),
      ],
      constraints: { requiredCapabilities: ["vision"] },
    });
    expect(decision.selected?.target.model).toBe("vision-1");
    expect(
      decision.candidates.find((candidate) => candidate.target.model === "text-only")?.reasonCodes,
    ).toContain("REQUIRED_CAPABILITY_MISSING");
  });

  it("filters unavailable or unauthorized candidates", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({
          instanceId: "codex",
          model: "gpt-5.4",
          availabilityReasons: ["PROVIDER_UNAUTHENTICATED"],
        }),
        entry({ instanceId: "claude", model: "claude-sonnet-4-6", driver: driver("claudeAgent") }),
      ],
    });
    expect(decision.selected?.target.instanceId).toBe("claude");
    expect(
      decision.candidates.find((candidate) => candidate.target.instanceId === "codex")?.eligible,
    ).toBe(false);
  });

  it("applies manual override without Auto ranking", () => {
    const decision = routeModel({
      mode: "manual",
      catalog,
      manualOverride: { instanceId: instance("cursor"), model: "composer-2" },
    });
    expect(decision.mode).toBe("manual");
    expect(decision.selected?.target.model).toBe("composer-2");
    expect(decision.reasonCodes).toContain("MANUAL_OVERRIDE");
    expect(decision.explanation).toContain("Manual selection");
  });

  it("tie-breaks Auto by preferred default, then documented driver order", () => {
    const withoutPreferred = routeModel({ mode: "auto", catalog });
    expect(withoutPreferred.selected?.target.instanceId).toBe("codex");
    const preferred = routeModel({
      mode: "auto",
      catalog,
      preferredTargets: [{ instanceId: instance("claude"), model: "claude-sonnet-4-6" }],
    });
    expect(preferred.selected?.target.instanceId).toBe("claude");
    expect(preferred.reasonCodes).toContain("PREFERRED_DEFAULT");
  });

  it("orders eligible fallbacks after the selected model", () => {
    const decision = routeModel({ mode: "auto", catalog });
    expect(decision.selected?.target.model).toBe("gpt-5.4");
    expect(decision.fallbacks.map((candidate) => candidate.target.instanceId)).toEqual([
      "claude",
      "cursor",
    ]);
  });

  it("does not treat extra models on the same instance as executable fallbacks", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({ instanceId: "codex", model: "gpt-5.5", driver: driver("codex") }),
        entry({ instanceId: "codex", model: "gpt-5.4", driver: driver("codex") }),
        entry({ instanceId: "claude", model: "claude-sonnet-4-6", driver: driver("claudeAgent") }),
      ],
    });
    expect(decision.fallbacks).toHaveLength(1);
    expect(decision.fallbacks[0]?.target.instanceId).toBe("claude");
  });

  it("marks cooled-down provider instances ineligible", () => {
    const catalog = applyModelRouterCooldowns(
      [
        entry({ instanceId: "codex", model: "gpt-5.5" }),
        entry({
          instanceId: "claude",
          model: "claude-sonnet-4-6",
          driver: driver("claudeAgent"),
        }),
      ],
      [
        {
          instanceId: instance("codex"),
          scope: "provider_instance",
          category: "usage_quota_exhausted",
          until: "2026-09-30T00:15:00.000Z",
          reasonCode: "PROVIDER_USAGE_LIMIT",
        },
      ],
      Date.parse("2026-09-30T00:00:00.000Z"),
    );
    const decision = routeModel({ mode: "auto", catalog });
    expect(decision.selected?.target.instanceId).toBe("claude");
    expect(
      decision.candidates.find((candidate) => candidate.target.instanceId === "codex")?.reasonCodes,
    ).toContain("PROVIDER_USAGE_LIMIT");
  });

  it("keeps unknown metrics unknown and does not invent scores", () => {
    const decision = routeModel({ mode: "auto", catalog });
    expect(decision.estimatedCostUsd).toEqual({ status: "unknown" });
    expect(decision.estimatedLatencyMs).toEqual({ status: "unknown" });
    expect(decision.estimatedQuality).toEqual({ status: "unknown" });
    expect(decision.reasonCodes).toContain("METRICS_UNKNOWN");
    expect(JSON.stringify(decision)).not.toContain('"status":"known"');
  });

  it("uses policy weights only when every eligible candidate has known metrics", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({ instanceId: "cheap", model: "fast", driver: driver("codex"), metrics: known(1) }),
        entry({
          instanceId: "quality",
          model: "best",
          driver: driver("claudeAgent"),
          metrics: {
            quality: { status: "known", value: 10 },
            costUsd: { status: "known", value: 8 },
            latencyMs: { status: "known", value: 400 },
          },
        }),
      ],
      policy: {
        version: "model-router.v0",
        qualityWeight: 10,
        costWeight: 1,
        latencyWeight: 0,
      },
    });
    expect(decision.selected?.target.model).toBe("best");
    expect(decision.estimatedQuality).toEqual({ status: "known", value: 10 });
  });

  it("never copies provider secrets into a decision", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: modelRouterCatalogFromProviders([
        provider({
          instanceId: "codex",
          models: ["gpt-5.4"],
        }),
      ]),
    });
    expect(modelRouterDecisionOmitsSecrets(decision)).toBe(true);
    expect(JSON.stringify(decision)).not.toContain("sk-secret-token");
    expect(JSON.stringify(decision)).not.toContain("OPENAI_API_KEY");
    expect(
      routeModel({
        mode: "auto",
        catalog: [
          entry({
            instanceId: "codex",
            model: "gpt-5.4",
          }),
        ],
      }).explanation,
    ).not.toContain(MODEL_ROUTER_SECRET_REDACTION);
  });

  it("represents future API drivers without requiring live adapters", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [
        entry({ instanceId: "qwen_lab", model: "qwen3", driver: driver("qwen") }),
        entry({ instanceId: "codex", model: "gpt-5.4", driver: driver("codex") }),
      ],
    });
    expect(decision.selected?.target.instanceId).toBe("codex");
    expect(decision.candidates.some((candidate) => candidate.driver === "qwen")).toBe(true);
  });

  it("excludes OpenRouter from Auto Route ranking", () => {
    const catalog = [
      entry({ instanceId: "openrouter", model: "openrouter/auto", driver: driver("openrouter") }),
      entry({ instanceId: "codex", model: "gpt-5.4", driver: driver("codex") }),
    ];
    expect(modelRouterCatalogForMode(catalog, "auto").map((item) => item.driver)).toEqual([
      "codex",
    ]);
    expect(modelRouterCatalogForMode(catalog, "manual").map((item) => item.instanceId)).toEqual([
      "openrouter",
      "codex",
    ]);
  });
});

describe("selection basis", () => {
  const known = (value: number) => ({ status: "known" as const, value });
  const metrics = (quality: number): ModelRouterMetrics => ({
    quality: known(quality),
    costUsd: known(1),
    latencyMs: known(10),
  });
  const a = entry({ instanceId: "codex", model: "a", metrics: metrics(20) });
  const b = entry({ instanceId: "claude", model: "b", metrics: metrics(10) });
  it.each([true, false])(
    "attributes strict score wins accurately (winner preferred=%s)",
    (preferred) => {
      const decision = routeModel({
        mode: "auto",
        catalog: [b, a],
        preferredTargets: [preferred ? a : b],
      });
      expect(decision.selected?.target).toEqual({ instanceId: a.instanceId, model: a.model });
      expect(decision.selectionBasis).toMatchObject({
        outcome: "score",
        selectedScore: 9,
        runnerUpScore: -1,
        tieBreak: [],
        dimensions: { quality: { participation: "weighted", weight: 1, complete: true } },
      });
      expect(decision.reasonCodes).not.toContain("PREFERRED_DEFAULT");
      expect(decision.reasonCodes).not.toContain("POLICY_TIE_BREAK");
      expect(decision.explanation).toContain("higher weighted catalog-estimate score");
      expect(decision.explanation).not.toContain("configured default");
    },
  );
  it("records preference only when it breaks an equal-score tie", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [a, { ...b, metrics: metrics(20) }],
      preferredTargets: [b],
    });
    expect(decision.selected?.target.model).toBe("b");
    expect(decision.selectionBasis).toMatchObject({
      outcome: "tie",
      selectedScore: 9,
      runnerUpScore: 9,
      tieBreak: ["preferred"],
    });
    expect(decision.reasonCodes).toContain("PREFERRED_DEFAULT");
    expect(decision.reasonCodes).toContain("POLICY_TIE_BREAK");
  });
  it("records each tie stage that narrows equally scored contenders", () => {
    const rows = [
      a,
      { ...a, instanceId: instance("z") },
      { ...a, model: "z" },
      { ...b, metrics: metrics(20), driver: driver("claudeAgent") },
    ];
    const decision = routeModel({ mode: "auto", catalog: rows });
    expect(decision.selectionBasis).toMatchObject({
      outcome: "tie",
      tieBreak: ["driver", "instance", "model"],
    });
    expect(decision.reasonCodes).not.toContain("PREFERRED_DEFAULT");
  });
  it("separates incomplete and zero-weight dimensions from selected estimates and ignores exclusions", () => {
    const excluded = {
      ...b,
      instanceId: instance("excluded"),
      availabilityReasons: ["PROVIDER_DISABLED" as const],
      metrics: {
        quality: { status: "unknown" as const },
        costUsd: { status: "unknown" as const },
        latencyMs: { status: "unknown" as const },
      },
    };
    const decision = routeModel({
      mode: "auto",
      catalog: [
        a,
        { ...b, metrics: { ...metrics(100), quality: { status: "unknown" } } },
        excluded,
      ],
      policy: { version: "model-router.v0", qualityWeight: 2, costWeight: 0, latencyWeight: 1 },
    });
    expect(decision.estimatedQuality).toEqual(known(20));
    expect(decision.selectionBasis).toMatchObject({
      outcome: "tie",
      eligibleCount: 2,
      consideredEligibleCount: 2,
      excludedCount: 1,
      tieBreak: ["driver"],
      dimensions: {
        quality: { participation: "incomplete", complete: false, weight: 2 },
        costUsd: { participation: "zero-weight", complete: true, weight: 0 },
        latencyMs: { participation: "weighted", weight: 1 },
      },
    });
    expect(decision.explanation).not.toContain("are unknown");
  });
  it("does not call known zero-weight metrics unknown", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [a, b],
      policy: { version: "model-router.v0", qualityWeight: 0, costWeight: 0, latencyWeight: 0 },
    });
    expect(decision.selectionBasis?.dimensions.quality.participation).toBe("zero-weight");
    expect(decision.reasonCodes).not.toContain("METRICS_UNKNOWN");
  });
  it.each(["single", "none", "manual-accepted", "manual-rejected", "manual-missing"] as const)(
    "records %s independently of automatic scores",
    (outcome) => {
      const manual = outcome.startsWith("manual");
      const decision = routeModel({
        mode: manual ? "manual" : "auto",
        catalog: outcome === "none" ? [] : [a],
        ...(outcome === "manual-missing" ? {} : { manualOverride: a }),
        ...(outcome === "manual-rejected" ? { constraints: { excludedModels: ["a"] } } : {}),
      });
      expect(decision.selectionBasis).toMatchObject({
        outcome,
        selectedScore: null,
        runnerUpScore: null,
        tieBreak: [],
      });
      expect(decision.reasonCodes).not.toContain("POLICY_TIE_BREAK");
      expect(decision.selectionBasis?.selectedTarget).toEqual(decision.selected?.target ?? null);
    },
  );
  it.each(["auto", "manual"] as const)(
    "does not attribute preference to a sole %s selection",
    (mode) => {
      const decision = routeModel({ mode, catalog: [a], preferredTargets: [a], manualOverride: a });
      expect(decision.reasonCodes).not.toContain("PREFERRED_DEFAULT");
      expect(decision.selected?.reasonCodes).not.toContain("PREFERRED_DEFAULT");
      expect(decision.candidates[0]?.preferredDefault).toBe(true);
    },
  );
  it("does not attribute preference to excluded candidates when none remain", () => {
    const decision = routeModel({
      mode: "auto",
      catalog: [a],
      preferredTargets: [a],
      constraints: { excludedModels: [a.model] },
    });
    expect(decision.selectionBasis?.outcome).toBe("none");
    expect(decision.reasonCodes).not.toContain("PREFERRED_DEFAULT");
  });
  it("records incomplete coverage across all eligible rows before the existing candidate cap", () => {
    const rows = Array.from({ length: 33 }, (_, index) => ({
      ...a,
      model: `m${index.toString().padStart(2, "0")}`,
      ...(index === 32
        ? { metrics: { ...metrics(20), quality: { status: "unknown" as const } } }
        : {}),
    }));
    const decision = routeModel({ mode: "auto", catalog: rows });
    expect(decision.candidates).toHaveLength(32);
    expect(decision.selectionBasis).toMatchObject({
      eligibleCount: 33,
      consideredEligibleCount: 32,
      dimensions: { quality: { participation: "incomplete" } },
      outcome: "tie",
      tieBreak: ["model"],
    });
  });
  it("reports unknown decisive basis if the unchanged arithmetic produces NaN", () => {
    const huge = { quality: known(1e308), costUsd: known(1e308), latencyMs: known(0) };
    const decision = routeModel({
      mode: "auto",
      catalog: [
        { ...a, metrics: huge },
        { ...b, metrics: huge },
      ],
      policy: {
        version: "model-router.v0",
        qualityWeight: 1e308,
        costWeight: 1e308,
        latencyWeight: 0,
      },
    });
    expect(decision.selected?.target.model).toBe("a");
    expect(decision.selectionBasis).toMatchObject({
      outcome: "unknown",
      selectedScore: null,
      runnerUpScore: null,
      tieBreak: [],
    });
    expect(decision.explanation).toContain("selection cause is unknown");
  });
  it("reports no selectable candidate when exclusions occupy the existing cap", () => {
    const excluded = Array.from({ length: 32 }, (_, i) => ({
      ...a,
      model: `excluded${i}`,
      availabilityReasons: ["PROVIDER_DISABLED" as const],
    }));
    const decision = routeModel({
      mode: "auto",
      catalog: [...excluded, { ...b, metrics: metrics(0) }],
    });
    expect(decision.selected).toBeNull();
    expect(decision.selectionBasis).toMatchObject({
      outcome: "none",
      eligibleCount: 1,
      consideredEligibleCount: 0,
      excludedCount: 32,
    });
    expect(decision.explanation).toContain("candidate limit");
  });
});
