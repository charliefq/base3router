import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRouterCatalogEntry,
  type ModelRouterMetrics,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  MODEL_ROUTER_SECRET_REDACTION,
  modelRouterCatalogFromProviders,
  modelRouterDecisionOmitsSecrets,
  routeModel,
} from "./modelRouter.ts";

const instance = (id: string) => ProviderInstanceId.make(id);
const driver = (id: string) => ProviderDriverKind.make(id);

const entry = (
  input: Partial<ModelRouterCatalogEntry> & { readonly instanceId: string; readonly model: string },
): ModelRouterCatalogEntry => ({
  instanceId: instance(input.instanceId),
  driver: input.driver ?? driver(input.instanceId),
  model: input.model,
  isDefault: input.isDefault ?? false,
  capabilities: input.capabilities ?? ["code", "tools"],
  availabilityReasons: input.availabilityReasons ?? [],
  ...(input.metrics ? { metrics: input.metrics } : {}),
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
});
