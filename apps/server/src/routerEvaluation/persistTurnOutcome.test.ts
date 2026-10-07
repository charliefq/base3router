import {
  EnvironmentId,
  HYBRID_ROUTER_POLICY_VERSION,
  MessageId,
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_POLICY_VERSION,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type DispatcherTaskRouteBinding,
  type ModelRouterDecision,
  type OrchestrationV2ProviderTurn,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTurnOutcomeObservation,
  detectReworkProxy,
  runtimeEventFromV2ProviderTurn,
} from "./persistTurnOutcome.ts";

const environmentId = EnvironmentId.make("lab-environment");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");

const modelRoute = (overrides: Partial<ModelRouterDecision> = {}): ModelRouterDecision => ({
  policyVersion: MODEL_ROUTER_POLICY_VERSION,
  mode: "auto",
  task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
  policy: MODEL_ROUTER_DEFAULT_POLICY,
  selected: null,
  fallbacks: [],
  candidates: [],
  reasonCodes: ["SELECTED"],
  explanation: "Router V0 selected the default.",
  estimatedCostUsd: { status: "unknown" },
  estimatedLatencyMs: { status: "unknown" },
  estimatedQuality: { status: "unknown" },
  executionStatus: "bound",
  attemptBudget: 3,
  attempts: [],
  ...overrides,
});

const binding = (extras: Partial<DispatcherTaskRouteBinding> = {}): DispatcherTaskRouteBinding => ({
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "gpt",
  fallbackIndex: 0,
  source: "provider-default",
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
  modelRoute: extras.modelRoute ?? modelRoute(),
  ...extras,
});

const completed = (
  payload: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"],
): ProviderRuntimeEvent =>
  ({
    type: "turn.completed",
    eventId: "evt-1",
    threadId,
    createdAt: "2026-10-03T00:00:01.000Z",
    provider: "codex",
    payload,
  }) as ProviderRuntimeEvent;

const aborted = (reason: string): ProviderRuntimeEvent =>
  ({
    type: "turn.aborted",
    eventId: "evt-abort",
    threadId,
    createdAt: "2026-10-03T00:00:01.000Z",
    provider: "codex",
    payload: { reason },
  }) as ProviderRuntimeEvent;

const build = (
  event: ProviderRuntimeEvent,
  route = binding(),
  timing?: Parameters<typeof buildTurnOutcomeObservation>[0]["timing"],
) =>
  buildTurnOutcomeObservation({
    environmentId,
    threadId,
    messageId,
    event,
    binding: route,
    nowMs: Date.parse("2026-10-03T00:00:01.000Z"),
    nowIso: "2026-10-03T00:00:01.000Z",
    ...(timing !== undefined ? { timing } : {}),
  });

describe("buildTurnOutcomeObservation", () => {
  it("classifies completed success, failed, interrupted, cancelled, and timeout", () => {
    expect(build(completed({ state: "completed", stopReason: "end_turn" })).terminalCategory).toBe(
      "success",
    );
    expect(build(completed({ state: "failed" })).terminalCategory).toBe("provider_failure");
    expect(build(completed({ state: "interrupted" })).terminalCategory).toBe(
      "infrastructure_failure",
    );
    expect(build(completed({ state: "cancelled", stopReason: "cancelled" })).terminalCategory).toBe(
      "cancelled",
    );
    expect(
      build(completed({ state: "failed", errorMessage: "request timed out" })).terminalCategory,
    ).toBe("timeout");
    expect(build(aborted("Interrupted by user.")).terminalCategory).toBe("cancelled");
    expect(build(aborted("Prompt timed out.")).terminalCategory).toBe("timeout");
  });

  it("never counts OpenRouter policy violations as success", () => {
    const observation = build(
      completed({
        state: "failed",
        failureCategory: "non_retryable_request",
        openRouter: {
          version: "openrouter-observation.v0",
          policyVersion: "openrouter-guidance.v0",
          guidanceMode: "teacher",
          status: "policy_violation",
          errorCategory: "policy_violation",
          taskProfile: {
            version: "openrouter-task-profile.v0",
            macroCategory: "unknown",
            source: "unknown",
          },
          allowedModels: [],
          costTier: "medium",
          privacyPolicy: "zdr_deny_collection",
          agreement: "unknown",
          nestedFallbacks: [],
        },
      }),
    );
    expect(observation.terminalCategory).toBe("provider_failure");
    expect(observation.finishReason).toBe("content_filter");
  });

  it("attributes Hybrid ranking and V0 fallback separately from Policy Shadow", () => {
    const hybrid = build(
      completed({ state: "completed" }),
      binding({
        hybrid: {
          policyVersion: HYBRID_ROUTER_POLICY_VERSION,
          usedHybridRanking: true,
          fallbackToV0: false,
          selected: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
          eligibleCount: 2,
          components: [],
          explanation: "Hybrid ranked Claude.",
        },
        modelRoute: modelRoute({
          policyVersion: HYBRID_ROUTER_POLICY_VERSION as ModelRouterDecision["policyVersion"],
          reasonCodes: ["HYBRID_RANKED"],
          explanation: "Hybrid ranked Claude.",
        }),
      }),
    );
    expect(hybrid.policyVersion).toBe(HYBRID_ROUTER_POLICY_VERSION);
    const fallback = build(
      completed({ state: "completed" }),
      binding({
        hybrid: {
          policyVersion: HYBRID_ROUTER_POLICY_VERSION,
          usedHybridRanking: false,
          fallbackToV0: true,
          selected: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
          eligibleCount: 2,
          components: [],
          explanation: "Insufficient local evidence; Router V0 was used.",
        },
      }),
    );
    expect(fallback.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
    const shadow = build(
      completed({ state: "completed" }),
      binding({
        hybrid: {
          policyVersion: HYBRID_ROUTER_POLICY_VERSION,
          usedHybridRanking: false,
          fallbackToV0: false,
          selected: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
          eligibleCount: 2,
          components: [],
          explanation: "Policy Shadow recorded.",
          challenger: {
            kind: "policy_shadow",
            selected: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-sonnet-4-6",
            },
            agreement: "disagreement",
          },
        },
      }),
    );
    expect(shadow.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
    expect(shadow.hybrid?.challenger?.agreement).toBe("disagreement");
    const manual = build(
      completed({ state: "completed" }),
      binding({
        modelRoute: modelRoute({
          mode: "manual",
          reasonCodes: ["MANUAL_OVERRIDE"],
          explanation: "Manual selection.",
        }),
      }),
    );
    expect(manual.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
    expect(manual.routingMode).toBe("manual");
    const missingPolicy = build(
      completed({ state: "completed" }),
      binding({ modelRoute: undefined }),
    );
    expect(missingPolicy.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
  });

  it("records monotonic timing when first output exists and leaves TTFT unknown otherwise", () => {
    const timed = build(completed({ state: "completed" }), binding(), {
      routeStartNanos: 1_000_000_000n,
      providerRequestStartNanos: 1_000_000_000n,
      firstOutputNanos: 1_050_000_000n,
      terminalNanos: 1_400_000_000n,
      routeStartMs: 1_000,
      providerRequestStartMs: 1_000,
      firstOutputMs: 1_050,
      terminalMs: 1_400,
    });
    expect(timed.timing.clock).toBe("monotonic_nanos");
    expect(timed.timing.timeToFirstTokenMs.status).toBe("known");
    if (timed.timing.timeToFirstTokenMs.status === "known") {
      expect(timed.timing.timeToFirstTokenMs.value).toBe(50);
    }
    expect(timed.timing.totalDurationMs.status).toBe("known");
    const failedBeforeOutput = build(completed({ state: "failed" }), binding(), {
      routeStartNanos: 1_000_000_000n,
      providerRequestStartNanos: 1_000_000_000n,
      terminalNanos: 1_200_000_000n,
      routeStartMs: 1_000,
      providerRequestStartMs: 1_000,
      terminalMs: 1_200,
    });
    expect(failedBeforeOutput.timing.timeToFirstTokenMs.status).toBe("unknown");
    expect(failedBeforeOutput.timing.totalDurationMs.status).toBe("known");
  });

  it("maps generic complete token usage for each shared runtime provider path", () => {
    for (const provider of [
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
      "openrouter",
    ] as const) {
      const observation = build(
        completed({
          state: "completed",
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 4,
            outputTokens: 2,
          },
        }),
        binding({ driver: ProviderDriverKind.make(provider) }),
      );
      expect(observation.usage.promptTokens.status).toBe("known");
      expect(observation.driver).toBe(provider);
    }
  });

  it("maps generic complete usage and keeps interrupted streams unknown", () => {
    const success = build(
      completed({
        state: "completed",
        tokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 11,
          outputTokens: 7,
        },
        totalCostUsd: 0.02,
      }),
    );
    expect(success.usage.promptTokens.status).toBe("known");
    expect(success.cost.reportedUsd.status).toBe("known");
    const interrupted = build(
      completed({
        state: "interrupted",
        tokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 11,
          outputTokens: 7,
        },
        totalCostUsd: 0.02,
      }),
    );
    expect(interrupted.usage.promptTokens.status).toBe("unknown");
    expect(interrupted.cost.reportedUsd.status).toBe("unknown");
  });

  it("preserves OpenRouter BYOK cost source", () => {
    const observation = build(
      completed({
        state: "completed",
        openRouter: {
          version: "openrouter-observation.v0",
          policyVersion: "openrouter-guidance.v0",
          guidanceMode: "teacher",
          status: "observed",
          taskProfile: {
            version: "openrouter-task-profile.v0",
            macroCategory: "coding",
            source: "openrouter_auto",
          },
          allowedModels: [],
          costTier: "medium",
          privacyPolicy: "zdr_deny_collection",
          agreement: "agreement",
          nestedFallbacks: [],
          promptTokens: { status: "known", value: 20 },
          completionTokens: { status: "known", value: 5 },
          reportedCostUsd: { status: "known", value: 0.004 },
          routingMetadata: { isByok: true, nestedAttempts: [] },
        },
      }),
    );
    expect(observation.usage.promptTokens.status).toBe("known");
    expect(observation.cost.reportedSource).toBe("openrouter_upstream_byok");
  });
});

describe("detectReworkProxy", () => {
  it("labels retry after failure and auto-to-manual without storing prompts", () => {
    const failed = build(completed({ state: "failed" }));
    const next = build(completed({ state: "completed" }));
    const retry = detectReworkProxy({
      previous: failed,
      next,
      nowMs: Date.parse("2026-10-03T00:00:30.000Z"),
    });
    expect(retry?.kind).toBe("retry_after_failure");
    expect(retry?.labeledAs).toBe("proxy");
    const auto = build(completed({ state: "completed" }));
    const manual = build(
      completed({ state: "completed" }),
      binding({
        modelRoute: modelRoute({
          mode: "manual",
          reasonCodes: ["MANUAL_OVERRIDE"],
          explanation: "Manual selection.",
        }),
      }),
    );
    expect(
      detectReworkProxy({
        previous: auto,
        next: manual,
        nowMs: Date.parse("2026-10-03T00:00:30.000Z"),
      })?.kind,
    ).toBe("auto_to_manual_switch");
    const switched = build(
      completed({ state: "completed" }),
      binding({
        target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
        modelRoute: modelRoute({
          mode: "manual",
          reasonCodes: ["MANUAL_OVERRIDE"],
          explanation: "Manual selection.",
        }),
      }),
    );
    expect(
      detectReworkProxy({
        previous: { ...manual, routingMode: "manual", model: "gpt-5.5" },
        next: switched,
        nowMs: Date.parse("2026-10-03T00:00:30.000Z"),
      })?.kind,
    ).toBe("manual_model_switch");
    expect(
      detectReworkProxy({
        previous: build(completed({ state: "completed" })),
        next: build(completed({ state: "completed" })),
        nowMs: Date.parse("2026-10-03T00:00:10.000Z"),
      })?.kind,
    ).toBe("regenerate");
  });
});

describe("runtimeEventFromV2ProviderTurn", () => {
  const providerTurn = (
    status: OrchestrationV2ProviderTurn["status"],
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make("turn-v2-1"),
    providerThreadId: ProviderThreadId.make("provider-thread-1"),
    nodeId: NodeId.make("node-1"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status,
    startedAt: null,
    completedAt: null,
  });

  it("maps terminal V2 statuses and ignores in-flight turns", () => {
    const eventFor = (status: Parameters<typeof providerTurn>[0]) =>
      runtimeEventFromV2ProviderTurn({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        providerTurn: providerTurn(status),
      });
    expect(eventFor("running")).toBeUndefined();
    expect(eventFor("pending")).toBeUndefined();
    expect(eventFor("completed")?.type).toBe("turn.completed");
    expect(
      eventFor("completed") && "payload" in eventFor("completed")!
        ? eventFor("completed")!.payload
        : undefined,
    ).toEqual({ state: "completed" });
    expect(
      eventFor("failed") && "payload" in eventFor("failed")!
        ? eventFor("failed")!.payload
        : undefined,
    ).toEqual({
      state: "failed",
    });
    expect(
      eventFor("interrupted") && "payload" in eventFor("interrupted")!
        ? eventFor("interrupted")!.payload
        : undefined,
    ).toEqual({ state: "interrupted" });
    expect(
      eventFor("cancelled") && "payload" in eventFor("cancelled")!
        ? eventFor("cancelled")!.payload
        : undefined,
    ).toEqual({ state: "cancelled" });
    const completedEvent = eventFor("completed");
    expect(
      completedEvent !== undefined &&
        completedEvent.type === "turn.completed" &&
        !("totalCostUsd" in completedEvent.payload),
    ).toBe(true);
  });
});
