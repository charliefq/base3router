import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_FUTURE_API_DRIVERS,
  MODEL_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_REASON_CODES,
  ModelRouterDecision,
  ModelRouterMode,
} from "./modelRouter.ts";

const decodeDecision = Schema.decodeUnknownExit(ModelRouterDecision);
const decodeMode = Schema.decodeUnknownExit(ModelRouterMode);

describe("model router contracts", () => {
  it("keeps the V0 policy and reason codes stable", () => {
    expect(MODEL_ROUTER_POLICY_VERSION).toBe("model-router.v0");
    expect(MODEL_ROUTER_DEFAULT_POLICY.version).toBe("model-router.v0");
    expect(MODEL_ROUTER_REASON_CODES).toContain("PROVIDER_USAGE_LIMIT");
    expect(MODEL_ROUTER_FUTURE_API_DRIVERS).toEqual(["qwen", "deepseek", "kimi"]);
    expect(MODEL_ROUTER_REASON_CODES).toContain("METRICS_UNKNOWN");
    expect(Exit.isSuccess(decodeMode("auto"))).toBe(true);
    expect(Exit.isSuccess(decodeMode("manual"))).toBe(true);
  });

  it("decodes a decision without secret-bearing fields", () => {
    const decoded = decodeDecision({
      policyVersion: "model-router.v0",
      mode: "auto",
      task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: ["code"] },
      policy: MODEL_ROUTER_DEFAULT_POLICY,
      selected: {
        fallbackIndex: 0,
        target: { instanceId: "codex", model: "gpt-5.4" },
        driver: "codex",
        capabilities: ["code", "tools"],
        eligible: true,
        reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
        preferredDefault: false,
        metrics: {
          quality: { status: "unknown" },
          costUsd: { status: "unknown" },
          latencyMs: { status: "unknown" },
        },
      },
      fallbacks: [],
      candidates: [],
      reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
      explanation: "Auto Route selected codex · gpt-5.4 by policy model-router.v0 tie-break.",
      estimatedCostUsd: { status: "unknown" },
      estimatedLatencyMs: { status: "unknown" },
      estimatedQuality: { status: "unknown" },
      executionStatus: "bound",
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(JSON.stringify(decoded.value)).not.toMatch(/sk-|Bearer |api[_-]?key/i);
    }
  });

  it("rejects unknown metric fabrication as a number", () => {
    const decoded = decodeDecision({
      policyVersion: "model-router.v0",
      mode: "auto",
      task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
      policy: MODEL_ROUTER_DEFAULT_POLICY,
      selected: null,
      fallbacks: [],
      candidates: [],
      reasonCodes: ["NO_ELIGIBLE_CANDIDATES"],
      explanation: "none",
      estimatedCostUsd: 12.5,
      estimatedLatencyMs: { status: "unknown" },
      estimatedQuality: { status: "unknown" },
      executionStatus: "not-started",
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });
});
