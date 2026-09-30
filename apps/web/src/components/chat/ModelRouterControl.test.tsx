import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_UNKNOWN_METRICS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRouterDecision,
} from "@t3tools/contracts";

import { ModelRouterControl } from "./ModelRouterControl";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON());
}

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

it("renders Auto Route with the selected model and why-this-model control", async () => {
  await act(async () => {
    renderer = create(
      <ModelRouterControl decision={decision} mode="auto" onModeChange={() => {}} />,
    );
  });
  expect(renderedText()).toContain("Auto Route");
  expect(renderedText()).toContain("gpt-5.4");
  expect(renderedText()).toContain("Why this model?");
  expect(renderedText()).toContain("fallback");
  expect(renderedText()).not.toContain("sk-");
});
