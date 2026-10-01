import { describe, expect, it } from "vite-plus/test";
import {
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_SHADOW_MAX_TOKENS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  normalizeOpenRouterHttpStatus,
  normalizeOpenRouterTransportFailure,
} from "./openRouterErrors.ts";
import {
  observationForSkip,
  promptBlocksOpenRouterUpload,
  resolveOpenRouterGuidanceMode,
  shouldSendOpenRouterGuidance,
  applyOpenRouterGuidanceToBinding,
} from "./openRouterGuidance.ts";
import {
  actualModelIsAllowed,
  indexOpenRouterCatalog,
  mapEligibleCandidatesToOpenRouter,
  resolveOpenRouterSlug,
} from "./openRouterIdentity.ts";
import {
  buildOpenRouterMarketPrior,
  knownOrUnknown,
  nextModelsPageOffset,
  normalizeOpenRouterCatalogModel,
} from "./openRouterMarketPriors.ts";
import {
  OPENROUTER_PRIVACY_PROVIDER_PREFERENCES,
  openRouterRequestOmitsPluginsAndTools,
  openRouterShadowRequestBody,
  openRouterTeacherRequestBody,
} from "./openRouterPrivacy.ts";
import { serializedOmitsSecrets, textLooksLikeSecret } from "./openRouterRedaction.ts";
import {
  extractOpenRouterTaskType,
  taskMacroFromOpenRouterTag,
  taskProfileFromLocalHeuristic,
  taskProfileFromOpenRouterTag,
} from "./openRouterTaskProfile.ts";

describe("openrouter shared helpers", () => {
  it("maps known tags and keeps unknown future tags as other", () => {
    expect(taskMacroFromOpenRouterTag("code:debugging")).toBe("debugging");
    expect(taskMacroFromOpenRouterTag("agent:multi_step_planning")).toBe("multi_step_agent");
    expect(taskMacroFromOpenRouterTag("future:unknown_task_kind")).toBe("other");
    const missing = taskProfileFromOpenRouterTag({ tag: undefined });
    expect(missing.macroCategory).toBe("unknown");
    expect(missing.confidence).toBeUndefined();
  });

  it("labels local heuristics and does not invent confidence", () => {
    const debug = taskProfileFromLocalHeuristic("Please debug this stack trace");
    expect(debug.source).toBe("local_heuristic");
    expect(debug.heuristic).toBe(true);
    expect(debug.macroCategory).toBe("debugging");
    expect(debug.confidence).toBeUndefined();
  });

  it("extracts task_type from router metadata and ignores unknown stages", () => {
    expect(
      extractOpenRouterTaskType({
        pipeline: [
          { type: "context_compression", data: { engine: "middle-out" } },
          { type: "router", data: { task_type: "code:debugging" } },
        ],
      }),
    ).toBe("code:debugging");
    expect(extractOpenRouterTaskType({ pipeline: [{ type: "guardrail" }] })).toBeUndefined();
  });

  it("never treats an unresolved slug as eligible", () => {
    const mapped = mapEligibleCandidatesToOpenRouter({
      candidates: [
        {
          eligible: true,
          driver: ProviderDriverKind.make("codex"),
          target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        },
        {
          eligible: true,
          driver: ProviderDriverKind.make("opencode"),
          target: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt-5" },
        },
      ],
      catalog: indexOpenRouterCatalog([
        {
          id: "openai/gpt-5",
          canonicalSlug: "openai/gpt-5",
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportedParameters: [],
        },
      ]),
    });
    expect(mapped.allowedModels).toEqual(["openai/gpt-5"]);
    expect(mapped.unresolved.some((entry) => entry.base3Model === "gpt-5.4")).toBe(true);
    expect(resolveOpenRouterSlug({ driver: "codex", model: "gpt-5.4" }).resolved).toBe(false);
    expect(actualModelIsAllowed("anthropic/claude-sonnet-4.5", ["anthropic/*"])).toBe(true);
    expect(actualModelIsAllowed("openai/gpt-4o", ["anthropic/*"])).toBe(false);
  });

  it("sends ZDR privacy defaults and no third-party plugins", () => {
    const body = openRouterTeacherRequestBody({
      prompt: "Summarize this paragraph",
      allowedModels: ["anthropic/claude-sonnet-4.5"],
      costTier: "medium",
      stream: false,
    });
    expect(body.model).toBe(OPENROUTER_AUTO_SLUG);
    expect(body.provider).toEqual(OPENROUTER_PRIVACY_PROVIDER_PREFERENCES);
    expect(openRouterRequestOmitsPluginsAndTools(body)).toBe(true);
    expect(
      openRouterShadowRequestBody({
        prompt: "Summarize this paragraph",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        costTier: "low",
      }).max_tokens,
    ).toBe(OPENROUTER_SHADOW_MAX_TOKENS);
  });

  it("normalizes provider errors without leaking keys", () => {
    expect(normalizeOpenRouterHttpStatus(401).category).toBe("authentication_failed");
    expect(normalizeOpenRouterHttpStatus(402).failureCategory).toBe("usage_quota_exhausted");
    expect(normalizeOpenRouterHttpStatus(403).category).toBe("forbidden");
    expect(normalizeOpenRouterHttpStatus(404).failureCategory).toBe("model_unavailable");
    expect(normalizeOpenRouterHttpStatus(429).category).toBe("rate_limited");
    expect(normalizeOpenRouterHttpStatus(503).category).toBe("transient_transport");
    expect(normalizeOpenRouterTransportFailure("missing_api_key").category).toBe("missing_api_key");
    expect(textLooksLikeSecret("sk-or-v1-secretvalue")).toBe(true);
    expect(textLooksLikeSecret("OPENROUTER_API_KEY=sk-or-v1-secretvalue")).toBe(true);
    expect(serializedOmitsSecrets({ detail: "ok", Authorization: "Bearer x" })).toBe(false);
  });

  it("keeps Off as no-request and Shadow blocked without consent", () => {
    expect(resolveOpenRouterGuidanceMode({ credentialPresent: true }).mode).toBe("off");
    expect(
      shouldSendOpenRouterGuidance(
        resolveOpenRouterGuidanceMode({
          requested: "shadow",
          credentialPresent: true,
          settings: {
            guidanceMode: "shadow",
            shadowConsent: false,
            teacherEnabled: false,
            teacherFallbackToBase3: true,
            costTier: "medium",
            catalogTtlMs: 1,
          },
        }),
      ),
    ).toBe(false);
    expect(promptBlocksOpenRouterUpload("use sk-or-v1-secretvalue")).toBe("likely_credentials");
    const skipped = observationForSkip({
      guidanceMode: "shadow",
      skipReason: "likely_credentials",
    });
    expect(JSON.stringify(skipped)).not.toMatch(/sk-or-v1-secretvalue/);
    expect(skipped.status).toBe("skipped");
  });

  it("paginates the models catalog and never coerces missing scores to zero", () => {
    expect(nextModelsPageOffset({ offset: 0, limit: 500, pageLength: 500 })).toBe(500);
    expect(nextModelsPageOffset({ offset: 500, limit: 500, pageLength: 12 })).toBeNull();
    expect(knownOrUnknown(undefined)).toEqual({ status: "unknown" });
    expect(knownOrUnknown(null)).toEqual({ status: "unknown" });
    const model = normalizeOpenRouterCatalogModel({
      id: "openai/gpt-4",
      canonical_slug: "openai/gpt-4",
      name: "GPT-4",
      context_length: 8192,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.00003", completion: "0.00006" },
    });
    expect(model?.intelligence).toEqual({ status: "unknown" });
    const prior = buildOpenRouterMarketPrior({
      asOf: "2026-06-17",
      observedAt: "2026-10-01T00:00:00.000Z",
      windowDays: 7,
      freshness: "stale",
      classifications: [
        {
          tag: "code:general_impl",
          display_name: "Code Generation",
          macro_category: "code",
          usage_share: 0.23,
          models: [{ id: "openai/gpt-4.1-mini", tag_usage_share: 0.55 }],
        },
      ],
      catalog: [{ id: "openai/gpt-4" }],
    });
    expect(prior.sampled).toBe(true);
    expect(prior.freshness).toBe("stale");
    expect(prior.classifications[0]?.tokenShare).toEqual({ status: "unknown" });
    expect(prior.citation).toContain("as of 2026-06-17");
  });

  it("keeps Shadow from rewriting the bound target and constrains Teacher", () => {
    const binding = {
      policyVersion: "dispatcher.phase-1a.v1" as const,
      target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
      driver: ProviderDriverKind.make("codex"),
      modelFamily: "gpt",
      fallbackIndex: 0,
      source: "provider-default" as const,
      gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED" as const] },
    };
    const shadow = applyOpenRouterGuidanceToBinding({
      binding,
      requestedMode: "shadow",
      credentialPresent: true,
      openRouterInstanceId: ProviderInstanceId.make("openrouter"),
      settings: {
        guidanceMode: "shadow",
        shadowConsent: true,
        teacherEnabled: false,
        teacherFallbackToBase3: true,
        costTier: "medium",
        catalogTtlMs: 1,
      },
    });
    expect(shadow.executionTarget.model).toBe("gpt-5.5");
    expect(shadow.binding.target.model).toBe("gpt-5.5");
    expect(shadow.binding.openRouter?.guidanceMode).toBe("shadow");

    const teacher = applyOpenRouterGuidanceToBinding({
      binding: {
        ...binding,
        modelRoute: {
          policyVersion: "model-router.v0",
          mode: "auto",
          task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: ["code"] },
          policy: {
            version: "model-router.v0",
            qualityWeight: 1,
            costWeight: 1,
            latencyWeight: 1,
          },
          selected: null,
          fallbacks: [],
          candidates: [
            {
              fallbackIndex: 0,
              target: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt-5" },
              driver: ProviderDriverKind.make("opencode"),
              capabilities: ["code", "tools"],
              eligible: true,
              reasonCodes: ["SELECTED"],
              preferredDefault: false,
              metrics: {
                quality: { status: "unknown" },
                costUsd: { status: "unknown" },
                latencyMs: { status: "unknown" },
              },
            },
          ],
          reasonCodes: [],
          explanation: "eligible",
          estimatedCostUsd: { status: "unknown" },
          estimatedLatencyMs: { status: "unknown" },
          estimatedQuality: { status: "unknown" },
          executionStatus: "bound",
        },
      },
      requestedMode: "teacher",
      credentialPresent: true,
      openRouterInstanceId: ProviderInstanceId.make("openrouter"),
      settings: {
        guidanceMode: "teacher",
        shadowConsent: false,
        teacherEnabled: true,
        teacherFallbackToBase3: true,
        costTier: "medium",
        catalogTtlMs: 1,
      },
    });
    expect(teacher.binding.target.model).toBe(OPENROUTER_AUTO_SLUG);
    expect(teacher.binding.openRouter?.allowedModels).toEqual(["openai/gpt-5"]);

    const manual = applyOpenRouterGuidanceToBinding({
      binding,
      requestedMode: "teacher",
      routingMode: "manual",
      credentialPresent: true,
      openRouterInstanceId: ProviderInstanceId.make("openrouter"),
      settings: {
        guidanceMode: "teacher",
        shadowConsent: false,
        teacherEnabled: true,
        teacherFallbackToBase3: true,
        costTier: "medium",
        catalogTtlMs: 1,
      },
    });
    expect(manual.executionTarget.model).toBe("gpt-5.5");
    expect(manual.binding.target.model).toBe("gpt-5.5");
    expect(manual.binding.openRouter?.skipReason).toBe("manual_selection");
  });
});
