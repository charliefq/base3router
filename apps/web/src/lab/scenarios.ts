import type { ModelRouterMode } from "@t3tools/contracts";
import type { ControlCenterModel } from "~/controlPlane/presentControlCenter";
import type {
  InspectorApprovalModel,
  InspectorHybridModel,
  InspectorMcpRouteModel,
  InspectorOpenRouterModel,
  InspectorOutcomeModel,
  InspectorPlanModel,
  InspectorSideEffectGateModel,
  InspectorSkillRouteModel,
  InspectorToolExecutionModel,
} from "~/controlPlane/presentOperationalInspector";

import {
  LAB_CLAUDE,
  LAB_CODEX,
  LAB_CURSOR,
  LAB_INELIGIBLE,
  LAB_LONG_NAME,
  labDecision,
} from "./fixtures";
import { labAdapters, simulateRoutedTurn, type FakeProviderAdapter } from "./fakeProvider";

export const UI_LAB_SCENARIO_IDS = [
  "empty-thread",
  "empty-workspace",
  "long-thread",
  "long-names",
  "reduced-height",
  "compact-height",
  "auto-route-preview",
  "manual-selection",
  "auto-success",
  "failover-success",
  "quota-exhausted",
  "no-alternate",
  "bounded-attempts",
  "capability-filtered",
  "provider-unavailable",
  "inspector-empty",
  "inspector-attempts",
  "inspector-success",
  "inspector-failure",
  "disconnected",
  "thread-loading",
  "thread-error",
  "thread-failed",
  "thread-completed",
  "narrow-width",
  "standard-width",
  "light-appearance",
  "dark-appearance",
  "openrouter-not-configured",
  "openrouter-off",
  "openrouter-shadow-warning",
  "openrouter-shadow-agreement",
  "openrouter-shadow-disagreement",
  "openrouter-shadow-privacy",
  "openrouter-shadow-failure",
  "openrouter-teacher",
  "openrouter-teacher-actual-differs",
  "openrouter-teacher-unavailable",
  "openrouter-teacher-policy-violation",
  "openrouter-shadow-cancelled",
  "openrouter-stale-priors",
  "openrouter-unknown-priors",
  "openrouter-unknown-task",
  "openrouter-nested-fallback",
  "openrouter-long-names",
  "openrouter-compact-height",
  "eval-no-observations",
  "eval-insufficient-data",
  "eval-measured-outcome",
  "eval-estimated-cost",
  "eval-explicit-positive",
  "eval-explicit-negative",
  "eval-rework-proxy",
  "eval-verification-passed",
  "eval-verification-failed",
  "eval-active-v0",
  "eval-hybrid-candidate",
  "eval-challenger-agrees",
  "eval-challenger-disagrees",
  "eval-activate-confirm",
  "eval-rollback",
  "eval-stale-market-prior",
  "eval-mixed-provenance",
  "eval-export-delete",
  "eval-compact-height",
  "eval-long-names",
  "skill-none",
  "mcp-none",
  "skill-selected",
  "skill-capability-filtered",
  "mcp-selected",
  "skill-mcp-incompatible",
  "mcp-untrusted",
  "action-readonly-allow",
  "action-requires-approval",
  "approval-granted",
  "approval-denied",
  "approval-expired",
  "approval-cancelled",
  "approval-args-changed",
  "approval-replay",
  "approval-concurrent",
  "tool-success",
  "tool-failure",
  "tool-interrupted",
  "tool-timeout",
  "tool-retry",
  "tool-circuit-breaker",
  "tool-fallback-authorized",
  "tool-fallback-new-approval",
  "mcp-prompt-injection",
  "phase12-long-names",
  "phase12-narrow-width",
  "phase12-compact-height",
  "phase12-light",
  "phase12-dark",
  "phase12-inspector",
  "control-center-action-governance",
] as const;

export type UiLabScenarioId = (typeof UI_LAB_SCENARIO_IDS)[number];

export type LabThreadStatus = "idle" | "loading" | "error" | "failed" | "completed";

export type LabMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
};

export type LabViewportHint = "standard" | "narrow" | "reduced-height" | "compact-height";

export type LabAppearance = "light" | "dark";

export type LabView = "thread" | "control-center";

export type LabScenarioState = {
  readonly id: UiLabScenarioId;
  readonly label: string;
  readonly description: string;
  readonly mode: ModelRouterMode;
  readonly decision: ReturnType<typeof labDecision>;
  readonly threadStatus: LabThreadStatus;
  readonly error: string | null;
  readonly messages: ReadonlyArray<LabMessage>;
  readonly prompt: string;
  readonly adapters: ReadonlyArray<FakeProviderAdapter>;
  readonly viewport: LabViewportHint;
  readonly inspectorCollapsed: boolean;
  readonly appearance: LabAppearance;
  readonly view: LabView;
  readonly inspectorEmpty: boolean;
  readonly longNames: boolean;
  readonly openRouter?: InspectorOpenRouterModel | null;
  readonly hybrid?: InspectorHybridModel | null;
  readonly routerInsights?: ControlCenterModel["routerInsights"];
  readonly skillRoute?: InspectorSkillRouteModel | null;
  readonly mcpRoute?: InspectorMcpRouteModel | null;
  readonly executionPlan?: InspectorPlanModel | null;
  readonly actionGate?: InspectorSideEffectGateModel | null;
  readonly approval?: InspectorApprovalModel | null;
  readonly toolExecution?: InspectorToolExecutionModel | null;
  readonly outcome?: InspectorOutcomeModel | null;
  readonly actionGovernance?: ControlCenterModel["actionGovernance"];
  readonly openRouterControl?: {
    readonly mode: "off" | "shadow" | "teacher";
    readonly connectionStatus: "not_configured" | "connected" | "unavailable";
  };
};

const LONG_THREAD_MESSAGES: ReadonlyArray<LabMessage> = Array.from({ length: 48 }, (_, index) => ({
  id: `lab-msg-${index + 1}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text:
    index % 2 === 0
      ? `Lab user turn ${index / 2 + 1}: scroll this independent conversation surface.`
      : `Lab assistant turn ${Math.ceil(index / 2)}: keep the composer visible while this list overflows.`,
}));

const SIDEBAR_THREADS: ReadonlyArray<LabMessage> = Array.from({ length: 24 }, (_, index) => ({
  id: `lab-sidebar-${index + 1}`,
  role: "user",
  text: `Independent sidebar row ${index + 1}`,
}));

export const LAB_SIDEBAR_THREADS = SIDEBAR_THREADS;

export const LAB_LONG_SIDEBAR_THREADS: ReadonlyArray<LabMessage> = Array.from(
  { length: 12 },
  (_, index) => ({
    id: `lab-long-name-${index + 1}`,
    role: "user",
    text: `Very-long-project-and-thread-name-that-must-truncate-without-horizontal-overflow-${index + 1}`,
  }),
);

function labOpenRouter(
  input: Partial<InspectorOpenRouterModel> & { readonly mode: string },
): InspectorOpenRouterModel {
  return {
    status: "observed",
    connection: "connected",
    privacyPolicy: "zdr_deny_collection",
    taskTag: "code:general_impl",
    taskSource: "openrouter_auto",
    base3Model: "gpt-5.5",
    openRouterModel: "anthropic/claude-sonnet-4.5",
    requestedRouterTarget: "openrouter/auto",
    actualModel: "anthropic/claude-sonnet-4.5",
    agreement: "disagreement",
    skipReason: null,
    errorCategory: null,
    nestedFallbacks: [],
    freshness: "fresh",
    asOf: "2026-06-17",
    ...input,
  };
}

function labHybrid(input: Partial<InspectorHybridModel> = {}): InspectorHybridModel {
  return {
    policyVersion: "hybrid-router.v1.0.0",
    usedHybridRanking: false,
    fallbackToV0: true,
    fallbackReason: "Insufficient local evidence; Router V0 was used.",
    selected: "codex · gpt-5.5",
    explanation: "Selected codex · gpt-5.5. Hybrid evidence is insufficient; Router V0 was used.",
    components: [],
    challenger: null,
    insufficient: true,
    ...input,
  };
}

function labInsights(
  input: Partial<NonNullable<ControlCenterModel["routerInsights"]>> = {},
): NonNullable<ControlCenterModel["routerInsights"]> {
  return {
    observationCount: 0,
    activePolicy: "model-router.v0",
    candidatePolicy: "hybrid-router.v1.0.0",
    insufficientData: true,
    mixedProvenance: false,
    explicitFeedback: "none recorded",
    reworkProxies: "none recorded",
    confirmation: null,
    ...input,
  };
}

function labSkillRoute(input: Partial<InspectorSkillRouteModel> = {}): InspectorSkillRouteModel {
  return {
    policyVersion: "skill-router.v0",
    selected: "fake-lab:review",
    mode: "auto",
    reasonCodes: ["SELECTED"],
    filteredReasonCodes: [],
    eligibleCount: 2,
    explanation: "Selected fake-lab:review by skill-router.v0 tie-break.",
    tieBreak: "skillId lexicographic. Display names and discovery order are ignored.",
    ...input,
  };
}

function labMcpRoute(input: Partial<InspectorMcpRouteModel> = {}): InspectorMcpRouteModel {
  return {
    policyVersion: "mcp-router.v0",
    selected: "t3-preview/preview_status",
    server: "t3-preview",
    mode: "auto",
    reasonCodes: ["SELECTED"],
    filteredReasonCodes: [],
    eligibleCount: 3,
    explanation: "Selected t3-preview/preview_status by mcp-router.v0 tie-break.",
    tieBreak: "ascending risk class, then namespaced toolId lexicographic.",
    ...input,
  };
}

function labPlan(input: Partial<InspectorPlanModel> = {}): InspectorPlanModel {
  return {
    planId: "plan-lab-1",
    actionCount: 1,
    policyVersions: "skill-router.v0 · mcp-router.v0 · action-gate.v0",
    expiresAt: "2026-10-03T00:05:00.000Z",
    ...input,
  };
}

function labGate(input: Partial<InspectorSideEffectGateModel> = {}): InspectorSideEffectGateModel {
  return {
    decision: "ALLOW",
    riskClass: "read-only-local",
    reasonCodes: ["ACTION_ALLOWED"],
    fingerprint: "a1b2c3d4e5f6",
    ...input,
  };
}

function labApproval(input: Partial<InspectorApprovalModel> = {}): InspectorApprovalModel {
  return {
    status: "pending",
    reuse: "one-time",
    expiresAt: "2026-10-03T00:05:00.000Z",
    oneTime: true,
    actionType: "preview_evaluate",
    destination: "t3-preview / preview_evaluate",
    argumentSummary: "expression=1, token=[redacted]",
    ...input,
  };
}

function labTool(input: Partial<InspectorToolExecutionModel> = {}): InspectorToolExecutionModel {
  return {
    status: "idle",
    retry: "none",
    circuit: "closed",
    fallback: "none",
    ...input,
  };
}

function labOutcome(input: Partial<InspectorOutcomeModel> = {}): InspectorOutcomeModel {
  return {
    classification: "success",
    evidence: "Measured local tool outcome. Unknown cost remains unknown.",
    ...input,
  };
}

function labGovernance(
  input: Partial<NonNullable<ControlCenterModel["actionGovernance"]>> = {},
): NonNullable<ControlCenterModel["actionGovernance"]> {
  return {
    configuredSkills: "1/2 skills enabled",
    configuredMcp: "3/3 MCP servers enabled (0 degraded)",
    pendingApprovals: "0 pending approvals",
    deniedExpired: "0 denied · 0 expired",
    recentOutcomes: "No recent action outcomes",
    costExposure: "Known unknown · estimated unknown",
    compliance: "compliant",
    ...input,
  };
}

function applyTurn(
  base: Omit<LabScenarioState, "decision" | "error" | "threadStatus" | "messages"> & {
    readonly messages?: ReadonlyArray<LabMessage>;
  },
  prompt: string,
): Pick<LabScenarioState, "decision" | "error" | "threadStatus" | "messages"> {
  const result = simulateRoutedTurn({
    decision: labDecision({ mode: base.mode }),
    adapters: base.adapters,
    prompt,
  });
  return {
    decision: result.decision,
    error: result.error,
    threadStatus: result.status === "completed" ? "completed" : "failed",
    messages: [
      ...(base.messages ?? []),
      { id: "lab-user-1", role: "user", text: prompt },
      ...(result.assistantText
        ? [{ id: "lab-assistant-1", role: "assistant" as const, text: result.assistantText }]
        : []),
    ],
  };
}

export function createLabScenario(id: UiLabScenarioId): LabScenarioState {
  const defaults = {
    id,
    prompt: "",
    viewport: "standard" as const,
    inspectorCollapsed: false,
    adapters: labAdapters({}),
    mode: "auto" as const,
    appearance: "dark" as const,
    view: "thread" as const,
    inspectorEmpty: false,
    longNames: false,
  };

  switch (id) {
    case "empty-thread":
      return {
        ...defaults,
        label: "Empty / new thread",
        description: "New thread with Auto Route preview and an empty conversation.",
        decision: labDecision({ executionStatus: "not-started" }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "empty-workspace":
      return {
        ...defaults,
        view: "control-center",
        inspectorEmpty: true,
        label: "Empty workspace",
        description: "Control Center with no projects or tasks in the selected environment.",
        decision: labDecision({ executionStatus: "not-started", selected: null }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "long-thread":
      return {
        ...defaults,
        label: "Long thread",
        description: "Overflowing conversation, sidebar, and Inspector for independent scroll.",
        decision: labDecision({ executionStatus: "completed", executed: LAB_CODEX }),
        threadStatus: "completed",
        error: null,
        messages: LONG_THREAD_MESSAGES,
      };
    case "reduced-height":
      return {
        ...defaults,
        viewport: "reduced-height",
        label: "Reduced height",
        description: "Short window: composer stays visible while conversation scrolls.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: LONG_THREAD_MESSAGES.slice(0, 20),
      };
    case "compact-height":
      return {
        ...defaults,
        viewport: "compact-height",
        label: "Compact height",
        description: "360px-class height. Composer, rail, and Inspector remain reachable.",
        decision: labDecision({ executionStatus: "not-started" }),
        threadStatus: "idle",
        error: null,
        messages: LONG_THREAD_MESSAGES.slice(0, 8),
      };
    case "long-names":
      return {
        ...defaults,
        longNames: true,
        label: "Long names",
        description: "Long project, thread, provider, and model names without page overflow.",
        decision: labDecision({
          selected: LAB_LONG_NAME,
          executed: LAB_LONG_NAME,
          fallbacks: [LAB_CLAUDE],
          candidates: [LAB_LONG_NAME, LAB_CLAUDE],
          explanation:
            "Auto Route selected very-long-provider-instance · very-long-model-slug-name-for-truncation by policy model-router.v0 tie-break.",
        }),
        threadStatus: "idle",
        error: null,
        messages: [
          {
            id: "lab-long-user",
            role: "user",
            text: "Use the long provider and model names without clipping the composer.",
          },
        ],
      };
    case "auto-route-preview":
      return {
        ...defaults,
        label: "Auto Route preview",
        description: "Auto Route selected model and alternate-provider count before send.",
        decision: labDecision({ executionStatus: "not-started" }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "manual-selection":
      return {
        ...defaults,
        mode: "manual",
        label: "Manual selection",
        description: "Manual routing mode. Failover is disabled.",
        decision: labDecision({
          mode: "manual",
          executionStatus: "not-started",
          explanation: "Manual selection kept Codex · gpt-5.5.",
        }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "auto-success": {
      const turned = applyTurn(
        { ...defaults, label: "", description: "", adapters: labAdapters({ codex: "success" }) },
        "Route this harmless lab prompt.",
      );
      return {
        ...defaults,
        label: "Successful Auto routing",
        description: "Auto Route selected Codex and completed without failover.",
        adapters: labAdapters({ codex: "success" }),
        ...turned,
      };
    }
    case "failover-success": {
      const turned = applyTurn(
        {
          ...defaults,
          label: "",
          description: "",
          adapters: labAdapters({ codex: "quota_exhaustion", claude: "success" }),
        },
        "Failover from exhausted Codex to Claude.",
      );
      return {
        ...defaults,
        label: "Failover then success",
        description: "Initial Codex quota failure, then a successful Claude fallback.",
        adapters: labAdapters({ codex: "quota_exhaustion", claude: "success" }),
        ...turned,
      };
    }
    case "quota-exhausted": {
      const turned = applyTurn(
        {
          ...defaults,
          label: "",
          description: "",
          adapters: labAdapters({
            codex: "quota_exhaustion",
            claude: "quota_exhaustion",
            cursor: "quota_exhaustion",
          }),
        },
        "Every authorized instance is quota exhausted.",
      );
      return {
        ...defaults,
        label: "Quota exhausted instance",
        description: "Instance-scoped quota cooldown. Inspector records each attempt.",
        adapters: labAdapters({
          codex: "quota_exhaustion",
          claude: "quota_exhaustion",
          cursor: "quota_exhaustion",
        }),
        ...turned,
      };
    }
    case "no-alternate": {
      const decision = labDecision({
        fallbacks: [],
        candidates: [LAB_CODEX],
        executionStatus: "not-started",
      });
      const result = simulateRoutedTurn({
        decision,
        adapters: labAdapters({ codex: "quota_exhaustion" }),
        prompt: "No eligible alternate provider.",
      });
      return {
        ...defaults,
        label: "No eligible alternate",
        description: "Codex is exhausted and no other authorized provider exists.",
        adapters: labAdapters({ codex: "quota_exhaustion" }),
        decision: result.decision,
        error: result.error,
        threadStatus: "failed",
        messages: [{ id: "lab-user-1", role: "user", text: "No eligible alternate provider." }],
      };
    }
    case "bounded-attempts": {
      const decision = labDecision({
        fallbacks: [LAB_CLAUDE, LAB_CURSOR],
        candidates: [LAB_CODEX, LAB_CLAUDE, LAB_CURSOR],
      });
      const result = simulateRoutedTurn({
        decision,
        adapters: labAdapters({
          codex: "transient_transport",
          claude: "transient_transport",
          cursor: "transient_transport",
        }),
        prompt: "Bound Auto Route to three attempts.",
      });
      return {
        ...defaults,
        label: "Bounded fallback attempts",
        description: "Auto Route stops after the attempt budget of three.",
        adapters: labAdapters({
          codex: "transient_transport",
          claude: "transient_transport",
          cursor: "transient_transport",
        }),
        decision: result.decision,
        error: result.error,
        threadStatus: "failed",
        messages: [{ id: "lab-user-1", role: "user", text: "Bound Auto Route to three attempts." }],
      };
    }
    case "inspector-attempts": {
      const failover = createLabScenario("failover-success");
      return {
        ...failover,
        id: "inspector-attempts",
        label: "Inspector attempt history",
        description: "Operational Inspector lists each Auto Route attempt.",
      };
    }
    case "capability-filtered":
      return {
        ...defaults,
        label: "Capability filtered",
        description: "A candidate was ineligible because it lacked required capabilities.",
        decision: labDecision({
          selected: LAB_CODEX,
          fallbacks: [LAB_CLAUDE],
          candidates: [LAB_INELIGIBLE, LAB_CODEX, LAB_CLAUDE],
          explanation:
            "Auto Route selected Codex after filtering candidates that lacked required capabilities.",
        }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "provider-unavailable": {
      const result = simulateRoutedTurn({
        decision: labDecision({
          selected: LAB_CODEX,
          fallbacks: [LAB_CLAUDE],
          candidates: [LAB_CODEX, LAB_CLAUDE],
        }),
        adapters: labAdapters({ codex: "quota_exhaustion", claude: "success" }),
        prompt: "Codex is unavailable; failover to Claude.",
      });
      return {
        ...defaults,
        label: "Provider unavailable",
        description: "Initial instance unavailable, then a successful fallback.",
        adapters: labAdapters({ codex: "quota_exhaustion", claude: "success" }),
        decision: result.decision,
        error: result.error,
        threadStatus: result.status === "completed" ? "completed" : "failed",
        messages: [
          { id: "lab-user-1", role: "user", text: "Codex is unavailable; failover to Claude." },
        ],
      };
    }
    case "inspector-empty":
      return {
        ...defaults,
        inspectorEmpty: true,
        label: "Inspector empty",
        description: "Inspector before a route exists.",
        decision: labDecision({ executionStatus: "not-started", selected: null }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "inspector-success":
      return {
        ...createLabScenario("auto-success"),
        id: "inspector-success",
        label: "Inspector success",
        description: "Inspector after a successful Auto Route turn.",
      };
    case "inspector-failure":
      return {
        ...createLabScenario("no-alternate"),
        id: "inspector-failure",
        label: "Inspector failure",
        description: "Inspector after Auto Route exhausted every alternate.",
      };
    case "disconnected":
      return {
        ...defaults,
        view: "control-center",
        inspectorEmpty: true,
        label: "Disconnected environment",
        description: "Control Center while the selected environment is offline.",
        decision: labDecision({ executionStatus: "not-started", selected: null }),
        threadStatus: "idle",
        error: null,
        messages: [],
      };
    case "light-appearance":
      return {
        ...createLabScenario("auto-route-preview"),
        id: "light-appearance",
        appearance: "light",
        label: "Light appearance",
        description: "Control-plane tokens in light appearance.",
      };
    case "dark-appearance":
      return {
        ...createLabScenario("auto-route-preview"),
        id: "dark-appearance",
        appearance: "dark",
        label: "Dark appearance",
        description: "Control-plane tokens in dark appearance.",
      };
    case "thread-loading":
      return {
        ...defaults,
        label: "Loading thread",
        description: "Turn is running. Composer stays mounted.",
        decision: labDecision({ executionStatus: "running" }),
        threadStatus: "loading",
        error: null,
        messages: [{ id: "lab-user-1", role: "user", text: "Loading this lab turn." }],
      };
    case "thread-error":
      return {
        ...defaults,
        label: "Error thread",
        description: "Recoverable thread error with the production banner.",
        decision: labDecision({ executionStatus: "failed" }),
        threadStatus: "error",
        error: "Lab thread error. Open Provider settings if no eligible alternate provider exists.",
        messages: [{ id: "lab-user-1", role: "user", text: "Trigger a lab error." }],
      };
    case "thread-failed": {
      const noAlternate = createLabScenario("no-alternate");
      return {
        ...noAlternate,
        id: "thread-failed",
        label: "Failed thread",
        description: "Terminal Auto Route failure after runtime failover.",
      };
    }
    case "thread-completed":
      return {
        ...defaults,
        label: "Completed thread",
        description: "Successful Auto Route turn in the completed state.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [
          { id: "lab-user-1", role: "user", text: "Ship the lab acceptance prompt." },
          {
            id: "lab-assistant-1",
            role: "assistant",
            text: "Lab reply via codex · gpt-5.5: Ship the lab acceptance prompt.",
          },
        ],
      };
    case "narrow-width":
      return {
        ...createLabScenario("long-thread"),
        id: "narrow-width",
        label: "Narrow desktop",
        description: "900px-class desktop width with independent panes.",
        viewport: "narrow",
      };
    case "standard-width":
      return {
        ...createLabScenario("auto-route-preview"),
        id: "standard-width",
        label: "Standard desktop",
        description: "1440px-class desktop width.",
        viewport: "standard",
      };
    case "openrouter-not-configured":
      return {
        ...defaults,
        label: "OpenRouter not configured",
        description: "Auto Route without OpenRouter guidance.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouterControl: { mode: "off", connectionStatus: "not_configured" },
      };
    case "openrouter-off":
      return {
        ...defaults,
        label: "OpenRouter Off",
        description: "Guidance Off while a key is present.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "off",
          status: "not_requested",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "off", connectionStatus: "connected" },
      };
    case "openrouter-shadow-warning":
      return {
        ...defaults,
        label: "Shadow warning",
        description: "Shadow consent warning before activation.",
        decision: labDecision({ executionStatus: "not-started" }),
        threadStatus: "idle",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          status: "skipped",
          skipReason: "consent_required",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-shadow-agreement":
      return {
        ...defaults,
        label: "Shadow agreement",
        description: "Shadow observation agrees with Base3Router.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [{ id: "lab-user-1", role: "user", text: "Implement the helper." }],
        openRouter: labOpenRouter({
          mode: "shadow",
          agreement: "agreement",
          openRouterModel: "gpt-5.5",
          actualModel: "gpt-5.5",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-shadow-disagreement":
      return {
        ...defaults,
        label: "Shadow disagreement",
        description: "Shadow suggested a different model. Execution stays Base3Router.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [{ id: "lab-user-1", role: "user", text: "Implement the helper." }],
        openRouter: labOpenRouter({ mode: "shadow", agreement: "disagreement" }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-shadow-privacy":
      return {
        ...defaults,
        label: "Shadow skipped for privacy",
        description: "Likely credentials skipped the Shadow request.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          status: "skipped",
          skipReason: "likely_credentials",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-shadow-failure":
      return {
        ...defaults,
        label: "Shadow provider failure",
        description: "Shadow failed. The real turn still completed.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          status: "failed",
          errorCategory: "rate_limited",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-teacher":
      return {
        ...defaults,
        label: "Teacher selected",
        description: "Teacher executed OpenRouter Auto inside the eligible set.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [{ id: "lab-user-1", role: "user", text: "Plan then execute." }],
        openRouter: labOpenRouter({ mode: "teacher", agreement: "inapplicable" }),
        openRouterControl: { mode: "teacher", connectionStatus: "connected" },
      };
    case "openrouter-teacher-actual-differs":
      return {
        ...defaults,
        label: "Teacher actual model differs",
        description: "Requested openrouter/auto; actual model is shown separately.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "teacher",
          requestedRouterTarget: "openrouter/auto",
          actualModel: "anthropic/claude-sonnet-4.5",
        }),
        openRouterControl: { mode: "teacher", connectionStatus: "connected" },
      };
    case "openrouter-teacher-unavailable":
      return {
        ...defaults,
        label: "Teacher unavailable",
        description: "Teacher could not run. Fallback stays Auto Route when allowed.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "teacher",
          status: "failed",
          errorCategory: "missing_api_key",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "teacher", connectionStatus: "unavailable" },
      };
    case "openrouter-teacher-policy-violation":
      return {
        ...defaults,
        label: "Teacher policy violation",
        description: "Out-of-policy actual model failed closed with no completion content.",
        decision: labDecision({ executionStatus: "failed" }),
        threadStatus: "failed",
        error: "OpenRouter returned a model outside the allowed set.",
        messages: [],
        openRouter: labOpenRouter({
          mode: "teacher",
          status: "policy_violation",
          errorCategory: "policy_violation",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "teacher", connectionStatus: "connected" },
      };
    case "openrouter-shadow-cancelled":
      return {
        ...defaults,
        label: "Shadow cancelled with the turn",
        description: "Stopping the turn cancelled Shadow. The live route is unchanged.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          status: "skipped",
          skipReason: "cancelled",
          agreement: "inapplicable",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-stale-priors":
      return {
        ...defaults,
        label: "Stale market priors",
        description: "Market-prior snapshot is stale. Scores stay unknown when missing.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          freshness: "stale",
          asOf: "2026-06-17",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-unknown-priors":
      return {
        ...defaults,
        label: "Unknown market priors",
        description: "No last-known-good catalog snapshot. Freshness stays unknown, not zero.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          freshness: "unknown",
          asOf: null,
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-unknown-task":
      return {
        ...defaults,
        label: "Unknown task type",
        description: "Missing OpenRouter task type stays unknown.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "shadow",
          taskTag: null,
          taskSource: "unknown",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "openrouter-nested-fallback":
      return {
        ...defaults,
        label: "Nested OpenRouter fallback",
        description:
          "Internal OpenRouter attempts are nested evidence, not extra Auto Route attempts.",
        decision: labDecision({ executionStatus: "completed" }),
        threadStatus: "completed",
        error: null,
        messages: [],
        openRouter: labOpenRouter({
          mode: "teacher",
          nestedFallbacks: [
            "openrouter_internal · Anthropic · anthropic/claude-sonnet-4.5 · 429",
            "openrouter_internal · Anthropic · anthropic/claude-sonnet-4.5 · 200",
          ],
        }),
        openRouterControl: { mode: "teacher", connectionStatus: "connected" },
      };
    case "openrouter-long-names":
      return {
        ...createLabScenario("long-names"),
        id: "openrouter-long-names",
        label: "Long OpenRouter names",
        description: "Long OpenRouter model names truncate in the Inspector.",
        openRouter: labOpenRouter({
          mode: "teacher",
          openRouterModel: "very-long-openrouter-provider/very-long-model-slug-name-for-truncation",
          actualModel: "very-long-openrouter-provider/very-long-model-slug-name-for-truncation",
        }),
        openRouterControl: { mode: "teacher", connectionStatus: "connected" },
      };
    case "openrouter-compact-height":
      return {
        ...createLabScenario("compact-height"),
        id: "openrouter-compact-height",
        label: "Compact OpenRouter guidance",
        description: "Guidance indicator at compact composer height.",
        viewport: "compact-height",
        openRouter: labOpenRouter({
          mode: "shadow",
          agreement: "agreement",
          openRouterModel: "gpt-5.5",
          actualModel: "gpt-5.5",
        }),
        openRouterControl: { mode: "shadow", connectionStatus: "connected" },
      };
    case "eval-no-observations":
      return {
        ...createLabScenario("empty-workspace"),
        id: "eval-no-observations",
        label: "No observations",
        description: "Router Insights with an empty local observation store.",
        view: "control-center",
        routerInsights: labInsights(),
        hybrid: labHybrid(),
      };
    case "eval-insufficient-data":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-insufficient-data",
        label: "Insufficient Hybrid evidence",
        description: "Hybrid falls back to Router V0 when n is below threshold.",
        hybrid: labHybrid(),
        routerInsights: labInsights({ observationCount: 3 }),
      };
    case "eval-measured-outcome":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-measured-outcome",
        label: "Measured outcome",
        description: "Inspector shows measured latency with a sample size.",
        hybrid: labHybrid({
          usedHybridRanking: true,
          fallbackToV0: false,
          fallbackReason: null,
          insufficient: false,
          explanation:
            "Selected claude · claude-sonnet-4-6. Passed all hard constraints. Median latency: measured, n=24. Policy: hybrid-router.v1.0.0.",
          selected: "claude · claude-sonnet-4-6",
          components: [
            {
              id: "latency",
              label: "Median latency (measured)",
              sampleSize: 24,
              status: "used",
              provenance: "observed",
            },
          ],
        }),
      };
    case "eval-estimated-cost":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-estimated-cost",
        label: "Estimated cost",
        description: "Catalog estimate is labeled estimated and does not overwrite reported cost.",
        hybrid: labHybrid({
          usedHybridRanking: true,
          fallbackToV0: false,
          insufficient: false,
          fallbackReason: null,
          components: [
            {
              id: "cost",
              label: "Median cost (catalog_estimate)",
              sampleSize: 12,
              status: "used",
              provenance: "estimated",
            },
          ],
        }),
        routerInsights: labInsights({
          mixedProvenance: true,
          observationCount: 12,
          insufficientData: false,
        }),
      };
    case "eval-explicit-positive":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-explicit-positive",
        label: "Explicit positive feedback",
        description: "Helpful is explicit feedback, not inferred from silence.",
        hybrid: labHybrid({
          components: [
            {
              id: "explicit_positive",
              label: "Explicit positive feedback",
              sampleSize: 9,
              status: "used",
              provenance: "observed",
            },
          ],
        }),
      };
    case "eval-explicit-negative":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-explicit-negative",
        label: "Explicit negative feedback",
        description: "Not helpful is explicit negative feedback.",
        hybrid: labHybrid({
          components: [
            {
              id: "explicit_negative",
              label: "Explicit negative feedback",
              sampleSize: 9,
              status: "used",
              provenance: "observed",
            },
          ],
        }),
      };
    case "eval-rework-proxy":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-rework-proxy",
        label: "Rework proxy",
        description: "Regenerate is a proxy, not proof of poor quality.",
        hybrid: labHybrid({
          components: [
            {
              id: "rework_proxy",
              label: "Rework proxy rate (proxy, not quality)",
              sampleSize: 19,
              status: "used",
              provenance: "observed",
            },
          ],
        }),
      };
    case "eval-verification-passed":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-verification-passed",
        label: "Verification passed",
        description: "Coding verification evidence from a real command.",
        hybrid: labHybrid({
          usedHybridRanking: true,
          fallbackToV0: false,
          insufficient: false,
          fallbackReason: null,
          components: [
            {
              id: "verification",
              label: "Coding verification pass rate",
              sampleSize: 21,
              status: "used",
              provenance: "observed",
            },
          ],
        }),
      };
    case "eval-verification-failed":
      return {
        ...createLabScenario("inspector-failure"),
        id: "eval-verification-failed",
        label: "Verification failed",
        description: "Failed verification is recorded as failed, never fabricated.",
        hybrid: labHybrid({
          components: [
            {
              id: "verification",
              label: "Coding verification pass rate",
              sampleSize: 8,
              status: "used",
              provenance: "observed",
            },
          ],
        }),
      };
    case "eval-active-v0":
      return {
        ...createLabScenario("auto-success"),
        id: "eval-active-v0",
        label: "Active Router V0",
        description: "Baseline policy remains active until an explicit activation.",
        view: "control-center",
        routerInsights: labInsights({ observationCount: 24, insufficientData: false }),
        hybrid: labHybrid(),
      };
    case "eval-hybrid-candidate":
      return {
        ...createLabScenario("auto-success"),
        id: "eval-hybrid-candidate",
        label: "Hybrid candidate",
        description: "A Hybrid candidate is inspectable and not self-activating.",
        view: "control-center",
        routerInsights: labInsights({
          observationCount: 24,
          insufficientData: false,
          candidatePolicy: "hybrid-router.v1.0.0",
        }),
      };
    case "eval-challenger-agrees":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-challenger-agrees",
        label: "Policy Shadow agrees",
        description: "Policy Shadow is distinct from OpenRouter Shadow.",
        hybrid: labHybrid({
          challenger: { selected: "codex · gpt-5.5", agreement: "agreement" },
        }),
      };
    case "eval-challenger-disagrees":
      return {
        ...createLabScenario("inspector-success"),
        id: "eval-challenger-disagrees",
        label: "Policy Shadow disagrees",
        description: "Disagreement does not change the live execution target.",
        hybrid: labHybrid({
          challenger: { selected: "claude · claude-sonnet-4-6", agreement: "disagreement" },
        }),
      };
    case "eval-activate-confirm":
      return {
        ...createLabScenario("auto-success"),
        id: "eval-activate-confirm",
        label: "Activate candidate confirmation",
        description: "Activation requires an explicit confirmation.",
        view: "control-center",
        routerInsights: labInsights({
          observationCount: 24,
          insufficientData: false,
          confirmation: "activate",
        }),
      };
    case "eval-rollback":
      return {
        ...createLabScenario("auto-success"),
        id: "eval-rollback",
        label: "Policy rollback",
        description: "Rollback restores the previous policy immediately.",
        view: "control-center",
        routerInsights: labInsights({
          confirmation: "rollback",
          observationCount: 24,
          insufficientData: false,
        }),
      };
    case "eval-stale-market-prior":
      return {
        ...createLabScenario("openrouter-stale-priors"),
        id: "eval-stale-market-prior",
        label: "Stale market prior",
        description: "Market popularity is a prior, not objective quality.",
        hybrid: labHybrid({
          components: [
            {
              id: "market_prior",
              label: "OpenRouter 7-day sampled spend share (prior, not quality)",
              sampleSize: 1,
              status: "used",
              provenance: "estimated",
            },
          ],
        }),
      };
    case "eval-mixed-provenance":
      return {
        ...createLabScenario("eval-estimated-cost"),
        id: "eval-mixed-provenance",
        label: "Mixed cost provenance",
        description: "Reported and estimated cost are never compared unlabeled.",
        view: "control-center",
        routerInsights: labInsights({
          mixedProvenance: true,
          observationCount: 20,
          insufficientData: false,
        }),
      };
    case "eval-export-delete":
      return {
        ...createLabScenario("auto-success"),
        id: "eval-export-delete",
        label: "Export and delete controls",
        description: "Deletion is environment-scoped and requires confirmation.",
        view: "control-center",
        routerInsights: labInsights({
          confirmation: "delete",
          observationCount: 12,
          insufficientData: false,
        }),
      };
    case "eval-compact-height":
      return {
        ...createLabScenario("compact-height"),
        id: "eval-compact-height",
        label: "Compact Router Insights",
        description: "Router Insights remain readable at compact height.",
        view: "control-center",
        viewport: "compact-height",
        routerInsights: labInsights({ observationCount: 24, insufficientData: false }),
      };
    case "eval-long-names":
      return {
        ...createLabScenario("long-names"),
        id: "eval-long-names",
        label: "Long Hybrid policy names",
        description: "Long model and policy names truncate without overflow.",
        hybrid: labHybrid({
          selected: "very-long-provider-instance · very-long-hybrid-model-slug-name-for-truncation",
          explanation:
            "Selected very-long-provider-instance · very-long-hybrid-model-slug-name-for-truncation. Policy: hybrid-router.v1.0.0.",
        }),
        routerInsights: labInsights({
          activePolicy: "hybrid-router.v1.0.0-very-long-policy-name-for-truncation",
          candidatePolicy: "hybrid-router.v1.0.0-another-very-long-candidate-name",
          observationCount: 24,
          insufficientData: false,
        }),
      };
    case "skill-none":
      return {
        ...createLabScenario("auto-success"),
        id: "skill-none",
        label: "No skills configured",
        description: "Skill Router continues without a skill when none are configured.",
        skillRoute: labSkillRoute({
          selected: null,
          reasonCodes: ["NO_SKILLS_CONFIGURED"],
          eligibleCount: 0,
          explanation: "No skills are configured. Continuing without a skill.",
        }),
        executionPlan: labPlan({ actionCount: 0, policyVersions: "skill-router.v0" }),
      };
    case "mcp-none":
      return {
        ...createLabScenario("auto-success"),
        id: "mcp-none",
        label: "No MCP configured",
        description: "MCP Router continues without a tool when none are configured.",
        mcpRoute: labMcpRoute({
          selected: null,
          server: null,
          reasonCodes: ["NO_MCP_CONFIGURED"],
          eligibleCount: 0,
          explanation: "No MCP servers are configured. Continuing without a tool.",
        }),
        executionPlan: labPlan({ actionCount: 0, policyVersions: "mcp-router.v0" }),
      };
    case "skill-selected":
      return {
        ...createLabScenario("auto-success"),
        id: "skill-selected",
        label: "Skill selected",
        description: "Eligible skill candidates with a selected trusted skill.",
        skillRoute: labSkillRoute(),
        executionPlan: labPlan(),
      };
    case "skill-capability-filtered":
      return {
        ...createLabScenario("capability-filtered"),
        id: "skill-capability-filtered",
        label: "Skill capability filtered",
        description: "Skills missing required capabilities stay filtered.",
        skillRoute: labSkillRoute({
          selected: null,
          reasonCodes: ["NO_ELIGIBLE_CANDIDATES"],
          filteredReasonCodes: ["REQUIRED_CAPABILITY_MISSING"],
          eligibleCount: 0,
          explanation: "No eligible skill. Required capability is missing.",
        }),
      };
    case "mcp-selected":
      return {
        ...createLabScenario("auto-success"),
        id: "mcp-selected",
        label: "MCP tool selected",
        description: "Eligible MCP candidates with a selected first-party tool.",
        mcpRoute: labMcpRoute(),
        executionPlan: labPlan(),
        actionGate: labGate(),
      };
    case "skill-mcp-incompatible":
      return {
        ...createLabScenario("capability-filtered"),
        id: "skill-mcp-incompatible",
        label: "Incompatible model/skill/tool",
        description: "Model, skill, and MCP compatibility filters remain independent.",
        skillRoute: labSkillRoute({
          selected: null,
          filteredReasonCodes: ["PROVIDER_MODEL_INCOMPATIBLE"],
          eligibleCount: 0,
          explanation: "Skill is incompatible with the selected model capabilities.",
        }),
        mcpRoute: labMcpRoute({
          selected: null,
          server: null,
          filteredReasonCodes: ["MODEL_SKILL_INCOMPATIBLE"],
          eligibleCount: 0,
          explanation: "MCP tool is incompatible with the selected model and skill.",
        }),
      };
    case "mcp-untrusted":
      return {
        ...createLabScenario("auto-success"),
        id: "mcp-untrusted",
        label: "Untrusted MCP server",
        description: "Untrusted or unavailable MCP servers are filtered.",
        mcpRoute: labMcpRoute({
          selected: null,
          server: "fake-untrusted",
          reasonCodes: ["NO_ELIGIBLE_CANDIDATES"],
          filteredReasonCodes: ["FILTERED_UNTRUSTED", "NOT_CONNECTED"],
          eligibleCount: 0,
          explanation: "Untrusted and disconnected MCP servers are not selected.",
        }),
      };
    case "action-readonly-allow":
      return {
        ...createLabScenario("auto-success"),
        id: "action-readonly-allow",
        label: "Read-only action allowed",
        description: "Trusted read-only local inspection can ALLOW without an approval.",
        skillRoute: labSkillRoute(),
        mcpRoute: labMcpRoute(),
        executionPlan: labPlan(),
        actionGate: labGate(),
        toolExecution: labTool({ status: "succeeded" }),
        outcome: labOutcome(),
      };
    case "action-requires-approval":
      return {
        ...createLabScenario("auto-success"),
        id: "action-requires-approval",
        label: "Action requires approval",
        description: "ASK pauses before adapter execution and is not implicit approval.",
        mcpRoute: labMcpRoute({
          selected: "t3-preview/preview_evaluate",
        }),
        executionPlan: labPlan(),
        actionGate: labGate({
          decision: "ASK",
          riskClass: "destructive",
          reasonCodes: ["APPROVAL_REQUIRED", "HIGH_RISK_DEFAULT"],
        }),
        approval: labApproval(),
        toolExecution: labTool({ status: "paused" }),
        outcome: labOutcome({
          classification: "interrupted",
          evidence: "Waiting on one-time exact-action approval.",
        }),
      };
    case "approval-granted":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "approval-granted",
        label: "Approval granted",
        description: "Granted one-time approval is bound to the exact action fingerprint.",
        actionGate: labGate({
          decision: "ALLOW",
          riskClass: "destructive",
          reasonCodes: ["ACTION_ALLOWED"],
        }),
        approval: labApproval({ status: "granted" }),
        toolExecution: labTool({ status: "running" }),
      };
    case "approval-denied":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "approval-denied",
        label: "Approval denied",
        description: "Denied approvals never execute the planned action.",
        actionGate: labGate({
          decision: "DENY",
          riskClass: "destructive",
          reasonCodes: ["APPROVAL_DENIED"],
        }),
        approval: labApproval({ status: "denied" }),
        toolExecution: labTool({ status: "blocked" }),
        outcome: labOutcome({
          classification: "denied",
          evidence: "Approval denied. Action did not execute.",
        }),
      };
    case "approval-expired":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "approval-expired",
        label: "Approval expired",
        description: "Expired approvals cannot be reused.",
        actionGate: labGate({
          decision: "DENY",
          riskClass: "destructive",
          reasonCodes: ["APPROVAL_EXPIRED"],
        }),
        approval: labApproval({
          status: "expired",
          expiresAt: "2026-10-02T00:00:00.000Z",
        }),
        outcome: labOutcome({
          classification: "denied",
          evidence: "Approval expired before execution.",
        }),
      };
    case "approval-cancelled":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "approval-cancelled",
        label: "Approval cancelled",
        description: "Cancelled approvals are terminal and do not execute.",
        actionGate: labGate({
          decision: "DENY",
          riskClass: "destructive",
          reasonCodes: ["APPROVAL_CANCELLED"],
        }),
        approval: labApproval({ status: "cancelled" }),
        outcome: labOutcome({
          classification: "cancelled",
          evidence: "Approval cancelled before execution.",
        }),
      };
    case "approval-args-changed":
      return {
        ...createLabScenario("approval-granted"),
        id: "approval-args-changed",
        label: "Arguments changed after approval",
        description: "Changed arguments invalidate the previous approval fingerprint.",
        actionGate: labGate({
          decision: "DENY",
          riskClass: "destructive",
          reasonCodes: ["PLAN_MUTATED", "FINGERPRINT_MISMATCH"],
        }),
        approval: labApproval({
          status: "invalidated",
          argumentSummary: "expression=2, token=[redacted]",
        }),
        outcome: labOutcome({
          classification: "denied",
          evidence: "Plan mutated after approval. A new approval is required.",
        }),
      };
    case "approval-replay":
      return {
        ...createLabScenario("approval-granted"),
        id: "approval-replay",
        label: "Approval replay attempt",
        description: "Consumed one-time approvals reject replay.",
        actionGate: labGate({
          decision: "DENY",
          riskClass: "destructive",
          reasonCodes: ["REPLAY_REJECTED", "APPROVAL_CONSUMED"],
        }),
        approval: labApproval({ status: "consumed" }),
        outcome: labOutcome({
          classification: "denied",
          evidence: "One-time approval already consumed.",
        }),
      };
    case "approval-concurrent":
      return {
        ...createLabScenario("approval-granted"),
        id: "approval-concurrent",
        label: "Concurrent one-time consumption",
        description: "A race cannot execute the same one-time approval twice.",
        actionGate: labGate({
          decision: "DENY",
          riskClass: "destructive",
          reasonCodes: ["CONCURRENT_CONSUME_REJECTED"],
        }),
        approval: labApproval({ status: "consumed" }),
        outcome: labOutcome({
          classification: "denied",
          evidence: "Concurrent one-time consumption was rejected.",
        }),
      };
    case "tool-success":
      return {
        ...createLabScenario("action-readonly-allow"),
        id: "tool-success",
        label: "Tool success",
        description: "Authorized tool success is recorded as a sanitized success outcome.",
        toolExecution: labTool({ status: "succeeded" }),
        outcome: labOutcome({ classification: "success" }),
      };
    case "tool-failure":
      return {
        ...createLabScenario("mcp-selected"),
        id: "tool-failure",
        label: "Tool failure",
        description: "Tool failure stays failure in Phase 11 outcome storage.",
        toolExecution: labTool({ status: "failed" }),
        outcome: labOutcome({
          classification: "failure",
          evidence: "Tool failed. Failure is not rewritten as success.",
        }),
      };
    case "tool-interrupted":
      return {
        ...createLabScenario("mcp-selected"),
        id: "tool-interrupted",
        label: "Interrupted tool",
        description: "Turn cancellation interrupts the tool without treating it as success.",
        toolExecution: labTool({ status: "interrupted" }),
        outcome: labOutcome({
          classification: "interrupted",
          evidence: "Cancelled from the originating turn.",
        }),
      };
    case "tool-timeout":
      return {
        ...createLabScenario("mcp-selected"),
        id: "tool-timeout",
        label: "Tool timeout",
        description: "Bounded timeout is a terminal timeout, not a success.",
        toolExecution: labTool({ status: "timeout" }),
        outcome: labOutcome({
          classification: "timeout",
          evidence: "Timed out after 15000ms.",
        }),
      };
    case "tool-retry":
      return {
        ...createLabScenario("mcp-selected"),
        id: "tool-retry",
        label: "Safe bounded retry",
        description: "Transient transport can retry once; policy denial cannot.",
        toolExecution: labTool({ status: "retrying", retry: "1/2 transient_transport" }),
        outcome: labOutcome({
          classification: "failure",
          evidence: "Retrying a retry-safe transport failure.",
        }),
      };
    case "tool-circuit-breaker":
      return {
        ...createLabScenario("mcp-selected"),
        id: "tool-circuit-breaker",
        label: "Circuit breaker",
        description: "Repeated transport failure opens a cooldown circuit.",
        toolExecution: labTool({
          status: "blocked",
          retry: "exhausted",
          circuit: "open",
        }),
        outcome: labOutcome({
          classification: "circuit_open",
          evidence: "Circuit open after repeated transport failure.",
        }),
      };
    case "tool-fallback-authorized":
      return {
        ...createLabScenario("mcp-selected"),
        id: "tool-fallback-authorized",
        label: "Authorized fallback",
        description: "Fallback uses a new bound plan and a compatible authorized tool.",
        mcpRoute: labMcpRoute({
          selected: "t3-preview/preview_snapshot",
        }),
        executionPlan: labPlan({ planId: "plan-lab-fallback" }),
        actionGate: labGate(),
        toolExecution: labTool({
          status: "succeeded",
          fallback: "preview_snapshot authorized",
        }),
        outcome: labOutcome({
          classification: "success",
          evidence: "Authorized fallback succeeded on a new plan.",
        }),
      };
    case "tool-fallback-new-approval":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "tool-fallback-new-approval",
        label: "Fallback requires new approval",
        description: "Approvals never transfer to a materially different fallback action.",
        mcpRoute: labMcpRoute({ selected: "t3-preview/preview_open" }),
        executionPlan: labPlan({ planId: "plan-lab-fallback-2" }),
        actionGate: labGate({
          decision: "ASK",
          riskClass: "network-access",
          reasonCodes: ["APPROVAL_REQUIRED"],
        }),
        approval: labApproval({
          status: "pending",
          actionType: "preview_open",
          destination: "t3-preview / preview_open",
        }),
        toolExecution: labTool({
          status: "paused",
          fallback: "new approval required",
        }),
      };
    case "mcp-prompt-injection":
      return {
        ...createLabScenario("auto-success"),
        id: "mcp-prompt-injection",
        label: "Prompt-injection-shaped MCP metadata",
        description:
          "Injection-shaped tool descriptions stay untrusted metadata, not instructions.",
        mcpRoute: labMcpRoute({
          selected: null,
          server: "fake-injected",
          filteredReasonCodes: ["PROMPT_INJECTION_SHAPED"],
          eligibleCount: 0,
          explanation:
            "Filtered prompt-injection-shaped MCP metadata. Descriptions are not instructions.",
        }),
        outcome: labOutcome({
          classification: "denied",
          evidence: "Untrusted MCP metadata was not inserted into system instructions.",
        }),
      };
    case "phase12-long-names":
      return {
        ...createLabScenario("long-names"),
        id: "phase12-long-names",
        label: "Phase 12 long names",
        description: "Long skill, server, and tool names truncate without overflow.",
        skillRoute: labSkillRoute({
          selected: "fake-lab:very-long-skill-name-that-must-truncate-without-overflow",
          explanation:
            "Selected fake-lab:very-long-skill-name-that-must-truncate-without-overflow.",
        }),
        mcpRoute: labMcpRoute({
          selected: "very-long-server/very-long-tool-name-that-must-truncate",
          server: "very-long-server-identity-for-truncation",
        }),
        approval: labApproval({
          destination:
            "very-long-server-identity-for-truncation / very-long-tool-name-that-must-truncate",
        }),
      };
    case "phase12-narrow-width":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "phase12-narrow-width",
        label: "Phase 12 narrow width",
        description: "Skill, MCP, and ActionGate cards remain readable at narrow width.",
        viewport: "narrow",
      };
    case "phase12-compact-height":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "phase12-compact-height",
        label: "Phase 12 compact height",
        description: "Inspector Phase 12 cards remain independently scrollable at 360px.",
        viewport: "compact-height",
      };
    case "phase12-light":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "phase12-light",
        label: "Phase 12 light appearance",
        description: "ActionGate and approval cards in light appearance.",
        appearance: "light",
      };
    case "phase12-dark":
      return {
        ...createLabScenario("action-requires-approval"),
        id: "phase12-dark",
        label: "Phase 12 dark appearance",
        description: "ActionGate and approval cards in dark appearance.",
        appearance: "dark",
      };
    case "phase12-inspector":
      return {
        ...createLabScenario("auto-success"),
        id: "phase12-inspector",
        label: "Phase 12 Inspector projection",
        description: "Inspector shows plan, skill, MCP, ActionGate, approval, tool, and outcome.",
        skillRoute: labSkillRoute(),
        mcpRoute: labMcpRoute(),
        executionPlan: labPlan(),
        actionGate: labGate({ decision: "ASK", riskClass: "network-access" }),
        approval: labApproval(),
        toolExecution: labTool({ status: "paused" }),
        outcome: labOutcome({
          classification: "interrupted",
          evidence: "Paused for one-time approval.",
        }),
      };
    case "control-center-action-governance":
      return {
        ...createLabScenario("eval-active-v0"),
        id: "control-center-action-governance",
        label: "Control Center action governance",
        description: "Control Center projects skill, MCP, approval, and cost-exposure summaries.",
        view: "control-center",
        actionGovernance: labGovernance({
          pendingApprovals: "2 pending approvals",
          deniedExpired: "1 denied · 1 expired",
          recentOutcomes: "denied, timeout, success",
          compliance: "attention",
        }),
      };
  }
}

export function isUiLabScenarioId(value: string | null | undefined): value is UiLabScenarioId {
  return UI_LAB_SCENARIO_IDS.some((id) => id === value);
}

export const UI_LAB_SCENARIOS: ReadonlyArray<LabScenarioState> = UI_LAB_SCENARIO_IDS.map((id) =>
  createLabScenario(id),
);
