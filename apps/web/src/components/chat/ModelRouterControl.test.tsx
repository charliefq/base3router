import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import {
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_UNKNOWN_METRICS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRouterDecision,
} from "@t3tools/contracts";

import { ModelRouterControl } from "./ModelRouterControl";

const decision: ModelRouterDecision = {
  policyVersion: "model-router.v0",
  mode: "auto",
  task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
  policy: MODEL_ROUTER_DEFAULT_POLICY,
  selected: {
    fallbackIndex: 0,
    target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    driver: ProviderDriverKind.make("codex"),
    capabilities: ["code", "tools"],
    eligible: true,
    reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
    preferredDefault: false,
    metrics: MODEL_ROUTER_UNKNOWN_METRICS,
  },
  fallbacks: [
    {
      fallbackIndex: 1,
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ["code", "tools"],
      eligible: true,
      reasonCodes: [],
      preferredDefault: false,
      metrics: MODEL_ROUTER_UNKNOWN_METRICS,
    },
  ],
  candidates: [],
  reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
  explanation:
    "Auto Route selected codex · gpt-5.4 by policy model-router.v0 tie-break. Quality, cost, and latency are unknown.",
  estimatedCostUsd: { status: "unknown" },
  estimatedLatencyMs: { status: "unknown" },
  estimatedQuality: { status: "unknown" },
  executionStatus: "not-started",
};

it("renders Auto Route with the selected model and why-this-model control", () => {
  const markup = renderToStaticMarkup(
    <ModelRouterControl decision={decision} mode="auto" onModeChange={() => {}} />,
  );
  expect(markup).toContain("Auto Route");
  expect(markup).toContain("gpt-5.4");
  expect(markup).toContain("Why this model?");
  expect(markup).toContain("alternate provider");
  expect(markup).not.toContain("sk-");
});

it("shows the executed model when Auto Route failsover", () => {
  const claude = {
    fallbackIndex: 1,
    target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
    driver: ProviderDriverKind.make("claudeAgent"),
    capabilities: ["code", "tools"] as const,
    eligible: true,
    reasonCodes: [] as const,
    preferredDefault: false,
    metrics: MODEL_ROUTER_UNKNOWN_METRICS,
  };
  const markup = renderToStaticMarkup(
    <ModelRouterControl
      decision={{
        ...decision,
        executed: claude,
        reasonCodes: ["SELECTED", "FALLBACK_ATTEMPTED"],
      }}
      mode="auto"
      onModeChange={() => {}}
    />,
  );
  expect(markup).toContain("gpt-5.4 → claude-sonnet-4-6");
  expect(markup).toContain('data-model-router-rerouted="true"');
});

it("shows a compact OpenRouter indicator only when guidance is configured", () => {
  const hidden = renderToStaticMarkup(
    <ModelRouterControl
      decision={decision}
      mode="auto"
      onModeChange={() => {}}
      openRouter={{ mode: "off", connectionStatus: "not_configured" }}
    />,
  );
  expect(hidden).not.toContain("data-openrouter-guidance");
  const shown = renderToStaticMarkup(
    <ModelRouterControl
      decision={decision}
      mode="auto"
      onModeChange={() => {}}
      openRouter={{ mode: "shadow", connectionStatus: "connected" }}
    />,
  );
  expect(shown).toContain("OR shadow");
  expect(shown).not.toContain("sk-");
});
