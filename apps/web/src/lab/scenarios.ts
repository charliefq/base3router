import type { ModelRouterMode } from "@t3tools/contracts";

import { LAB_CLAUDE, LAB_CODEX, LAB_CURSOR, labDecision } from "./fixtures";
import { labAdapters, simulateRoutedTurn, type FakeProviderAdapter } from "./fakeProvider";

export const UI_LAB_SCENARIO_IDS = [
  "empty-thread",
  "long-thread",
  "reduced-height",
  "auto-route-preview",
  "manual-selection",
  "auto-success",
  "failover-success",
  "quota-exhausted",
  "no-alternate",
  "bounded-attempts",
  "inspector-attempts",
  "thread-loading",
  "thread-error",
  "thread-failed",
  "thread-completed",
  "narrow-width",
  "standard-width",
] as const;

export type UiLabScenarioId = (typeof UI_LAB_SCENARIO_IDS)[number];

export type LabThreadStatus = "idle" | "loading" | "error" | "failed" | "completed";

export type LabMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
};

export type LabViewportHint = "standard" | "narrow" | "reduced-height";

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
  }
}

export function isUiLabScenarioId(value: string | null | undefined): value is UiLabScenarioId {
  return UI_LAB_SCENARIO_IDS.some((id) => id === value);
}

export const UI_LAB_SCENARIOS: ReadonlyArray<LabScenarioState> = UI_LAB_SCENARIO_IDS.map((id) =>
  createLabScenario(id),
);
