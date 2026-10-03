import { describe, expect, it } from "vite-plus/test";
import { MODEL_ROUTER_ATTEMPT_BUDGET } from "@t3tools/contracts";
import { MODEL_ROUTER_SECRET_REDACTION } from "@t3tools/shared/modelRouter";

import { labDecision, LAB_CODEX } from "./fixtures";
import {
  UI_LAB_BEARER_PROBE,
  UI_LAB_SECRET_PROBE,
  labAdapters,
  labDocumentContainsSecretProbe,
  simulateRoutedTurn,
} from "./fakeProvider";
import { applyLabApprovalDecision } from "./labActionGate";
import { UI_LAB_SCENARIO_IDS, createLabScenario } from "./scenarios";

describe("Base3Router UI Lab fake providers", () => {
  it("succeeds on the selected Codex instance", () => {
    const result = simulateRoutedTurn({
      decision: labDecision(),
      adapters: labAdapters({ codex: "success" }),
      prompt: "harmless lab prompt",
    });
    expect(result.status).toBe("completed");
    expect(result.decision.executed?.target.model).toBe("gpt-5.5");
    expect(result.error).toBeNull();
    expect(result.assistantText).toContain("codex");
  });

  it("failsover from Codex quota exhaustion to Claude", () => {
    const result = simulateRoutedTurn({
      decision: labDecision(),
      adapters: labAdapters({ codex: "quota_exhaustion", claude: "success" }),
      prompt: "failover lab prompt",
    });
    expect(result.status).toBe("completed");
    expect(result.decision.selected?.target.model).toBe("gpt-5.5");
    expect(result.decision.executed?.target.model).toBe("claude-sonnet-4-6");
    expect(
      result.decision.attempts?.some(
        (attempt) => attempt.failureCategory === "usage_quota_exhausted",
      ),
    ).toBe(true);
    expect(result.error).toBeNull();
  });

  it("classifies rate limiting, auth, transport, and before-output failures", () => {
    const isolated = labDecision({ fallbacks: [], candidates: [LAB_CODEX] });
    const rate = simulateRoutedTurn({
      decision: isolated,
      adapters: labAdapters({ codex: "rate_limiting" }),
      prompt: "rate",
    });
    expect(rate.decision.attempts?.[0]?.failureCategory).toBe("rate_limited");

    const auth = simulateRoutedTurn({
      decision: isolated,
      adapters: labAdapters({ codex: "authentication_failure" }),
      prompt: "auth",
    });
    expect(auth.decision.attempts?.[0]?.failureCategory).toBe("authentication_failed");
    expect(auth.error ?? "").not.toContain(UI_LAB_SECRET_PROBE);
    expect(auth.error ?? "").not.toContain(UI_LAB_BEARER_PROBE);
    expect(auth.decision.attempts?.[0]?.detail).toBe(MODEL_ROUTER_SECRET_REDACTION);

    const transport = simulateRoutedTurn({
      decision: isolated,
      adapters: labAdapters({ codex: "transient_transport" }),
      prompt: "transport",
    });
    expect(transport.decision.attempts?.[0]?.failureCategory).toBe("transient_transport");

    const before = simulateRoutedTurn({
      decision: isolated,
      adapters: labAdapters({ codex: "failure_before_output" }),
      prompt: "before",
    });
    expect(before.decision.attempts?.[0]?.failureCategory).toBe("transient_transport");
    expect(before.assistantText).toBeNull();
    expect(before.status).toBe("failed");
  });

  it("does not failover after a side effect starts", () => {
    const result = simulateRoutedTurn({
      decision: labDecision(),
      adapters: labAdapters({ codex: "failure_after_output", claude: "success" }),
      prompt: "side effect",
    });
    expect(result.status).toBe("failed");
    expect(result.decision.executed?.target.model).toBe("gpt-5.5");
    expect(result.assistantText).toContain("Partial lab output");
    expect(result.decision.attempts?.[0]?.failureCategory).toBe("side_effect_started");
  });

  it("stops at the Auto Route attempt budget", () => {
    const result = simulateRoutedTurn({
      decision: labDecision(),
      adapters: labAdapters({
        codex: "transient_transport",
        claude: "transient_transport",
        cursor: "transient_transport",
      }),
      prompt: "budget",
    });
    expect(result.status).toBe("failed");
    expect(result.decision.attempts?.length).toBe(MODEL_ROUTER_ATTEMPT_BUDGET);
    expect(result.error ?? "").toMatch(/attempt budget|alternate provider/i);
  });

  it("never keeps secret-shaped probes in terminal copy", () => {
    const result = simulateRoutedTurn({
      decision: labDecision({ fallbacks: [], candidates: [LAB_CODEX] }),
      adapters: labAdapters({ codex: "authentication_failure" }),
      prompt: "secret",
    });
    expect(labDocumentContainsSecretProbe(result.error ?? "")).toBe(false);
    expect(labDocumentContainsSecretProbe(result.assistantText ?? "")).toBe(false);
    for (const attempt of result.decision.attempts ?? []) {
      expect(labDocumentContainsSecretProbe(attempt.detail ?? "")).toBe(false);
    }
  });

  it("exposes every required UI Lab scenario", () => {
    expect(UI_LAB_SCENARIO_IDS).toContain("empty-thread");
    expect(UI_LAB_SCENARIO_IDS).toContain("inspector-attempts");
    expect(UI_LAB_SCENARIO_IDS).toContain("eval-no-observations");
    expect(UI_LAB_SCENARIO_IDS).toContain("eval-challenger-disagrees");
    expect(UI_LAB_SCENARIO_IDS).toContain("skill-none");
    expect(UI_LAB_SCENARIO_IDS).toContain("action-requires-approval");
    expect(UI_LAB_SCENARIO_IDS).toContain("control-center-action-governance");
    for (const id of UI_LAB_SCENARIO_IDS) {
      const scenario = createLabScenario(id);
      expect(scenario.id).toBe(id);
      expect(scenario.label.length).toBeGreaterThan(0);
    }
    expect(createLabScenario("failover-success").decision.executed?.target.model).toBe(
      "claude-sonnet-4-6",
    );
    expect(createLabScenario("no-alternate").error ?? "").toMatch(/no eligible alternate/i);
    expect(createLabScenario("bounded-attempts").decision.attempts?.length).toBe(3);
    expect(createLabScenario("skill-none").skillRoute?.selected).toBeNull();
    expect(createLabScenario("action-requires-approval").actionGate?.decision).toBe("ASK");
    expect(createLabScenario("approval-granted").approval?.oneTime).toBe(true);
    expect(createLabScenario("mcp-prompt-injection").mcpRoute?.filteredReasonCodes).toContain(
      "PROMPT_INJECTION_SHAPED",
    );
    expect(JSON.stringify(createLabScenario("approval-granted").approval)).not.toMatch(
      /sk-|Bearer /,
    );
    const pending = createLabScenario("action-requires-approval").approval;
    expect(pending).toBeTruthy();
    if (pending) {
      expect(applyLabApprovalDecision(pending, "grant").toolExecutions).toBe(1);
      expect(applyLabApprovalDecision(pending, "deny").toolExecutions).toBe(0);
      expect(applyLabApprovalDecision(pending, "cancel").toolExecutions).toBe(0);
      expect(applyLabApprovalDecision({ ...pending, status: "consumed" }, "grant").error).toMatch(
        /consumed/,
      );
    }
  });
});
