import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  ModelRouterConstraints,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRouterMetrics,
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
      hash: "e2922b04f8acbc518607b641522b1ffcc21f4c60f0185ef23c8bcadf3d11ae4c",
    },
    {
      mode: "manual" as const,
      hash: "6a15747d47c116b98bb2b2a873f354ba6340b103b2a07f8db2d2f77a3e94656d",
    },
  ])(
    "preserves the starting full serialized $mode decision when limits are absent",
    ({ mode, hash }) => {
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
      expect(NodeCrypto.createHash("sha256").update(JSON.stringify(decision)).digest("hex")).toBe(
        hash,
      );
      expect(routeModel({ ...input, constraints: {} })).toEqual(decision);
    },
  );
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
