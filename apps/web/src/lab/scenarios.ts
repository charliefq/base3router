import type { ModelRouterMode } from "@t3tools/contracts";
import type { ControlCenterModel } from "~/controlPlane/presentControlCenter";
import type {
  InspectorHybridModel,
  InspectorOpenRouterModel,
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
  }
}

export function isUiLabScenarioId(value: string | null | undefined): value is UiLabScenarioId {
  return UI_LAB_SCENARIO_IDS.some((id) => id === value);
}

export const UI_LAB_SCENARIOS: ReadonlyArray<LabScenarioState> = UI_LAB_SCENARIO_IDS.map((id) =>
  createLabScenario(id),
);
