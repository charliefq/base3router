import {
  EnvironmentId,
  MODEL_ROUTER_ATTEMPT_BUDGET,
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_UNKNOWN_METRICS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelRouterCandidate,
  type ModelRouterDecision,
  type ModelRouterMode,
} from "@t3tools/contracts";

import type { ControlCenterModel } from "~/controlPlane/presentControlCenter";
import type { OperationalInspectorModel } from "~/controlPlane/presentOperationalInspector";

export const UI_LAB_NOW_MS = Date.parse("2026-09-30T00:00:00.000Z");
const UI_LAB_PROJECT_TITLE = "Base3Router Lab";
const UI_LAB_THREAD_TITLE = "UI Lab thread";
const UI_LAB_GIT_BRANCH = "cursor/phase-8-auto-model-router-v0";

const instance = (id: string) => ProviderInstanceId.make(id);
const driver = (id: string) => ProviderDriverKind.make(id);

function labCandidate(input: {
  readonly instanceId: string;
  readonly model: string;
  readonly fallbackIndex: number;
  readonly driver?: string;
  readonly eligible?: boolean;
}): ModelRouterCandidate {
  return {
    fallbackIndex: input.fallbackIndex,
    target: { instanceId: instance(input.instanceId), model: input.model },
    driver: driver(input.driver ?? input.instanceId),
    capabilities: ["code", "tools"],
    eligible: input.eligible ?? true,
    reasonCodes: input.fallbackIndex === 0 ? ["SELECTED", "METRICS_UNKNOWN"] : [],
    preferredDefault: false,
    metrics: MODEL_ROUTER_UNKNOWN_METRICS,
  };
}

const CODEX = labCandidate({ instanceId: "codex", model: "gpt-5.5", fallbackIndex: 0 });
const CLAUDE = labCandidate({
  instanceId: "claude",
  model: "claude-sonnet-4-6",
  fallbackIndex: 1,
  driver: "claudeAgent",
});
const CURSOR = labCandidate({
  instanceId: "cursor",
  model: "composer-2",
  fallbackIndex: 2,
  driver: "cursor",
});

export function labDecision(input?: {
  readonly mode?: ModelRouterMode;
  readonly selected?: ModelRouterCandidate | null;
  readonly fallbacks?: ReadonlyArray<ModelRouterCandidate>;
  readonly candidates?: ReadonlyArray<ModelRouterCandidate>;
  readonly executed?: ModelRouterCandidate | null;
  readonly executionStatus?: ModelRouterDecision["executionStatus"];
  readonly explanation?: string;
  readonly attempts?: ModelRouterDecision["attempts"];
}): ModelRouterDecision {
  const selected = input?.selected === undefined ? CODEX : input.selected;
  return {
    policyVersion: "model-router.v0",
    mode: input?.mode ?? "auto",
    task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
    policy: MODEL_ROUTER_DEFAULT_POLICY,
    selected,
    fallbacks: input?.fallbacks ?? [CLAUDE],
    candidates: input?.candidates ?? [CODEX, CLAUDE, CURSOR],
    reasonCodes: ["SELECTED", "METRICS_UNKNOWN"],
    explanation:
      input?.explanation ??
      (selected
        ? `Auto Route selected ${selected.target.instanceId} · ${selected.target.model} by policy model-router.v0 tie-break.`
        : "Auto Route could not select an eligible model."),
    estimatedCostUsd: { status: "unknown" },
    estimatedLatencyMs: { status: "unknown" },
    estimatedQuality: { status: "unknown" },
    executionStatus: input?.executionStatus ?? "not-started",
    attemptBudget: MODEL_ROUTER_ATTEMPT_BUDGET,
    attempts: input?.attempts ?? [],
    executed: input?.executed === undefined ? selected : input.executed,
  };
}

export function inspectorModelFromLab(input: {
  readonly decision: ModelRouterDecision;
  readonly sessionStatus: string | null;
  readonly error: string | null;
  readonly overflow?: boolean;
}): OperationalInspectorModel {
  const initial = input.decision.selected?.target ?? null;
  const executed = input.decision.executed?.target ?? initial;
  const rerouted =
    initial !== null &&
    executed !== null &&
    (initial.instanceId !== executed.instanceId || initial.model !== executed.model);
  return {
    projectTitle: UI_LAB_PROJECT_TITLE,
    taskObjective: UI_LAB_THREAD_TITLE,
    gitBranch: UI_LAB_GIT_BRANCH,
    sessionStatus: input.sessionStatus,
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    route: {
      kind: input.decision.executionStatus === "not-started" ? "provisional" : "bound",
      provider: executed?.instanceId ?? initial?.instanceId ?? null,
      model: executed?.model ?? initial?.model ?? null,
      source: input.decision.mode === "manual" ? "explicit" : "auto",
      reason: input.decision.explanation,
      fallbacks: input.decision.fallbacks.map((candidate) => ({
        provider: candidate.target.instanceId,
        model: candidate.target.model,
      })),
      gateDecision: "ALLOW",
      gateReasons: ["ACTION_ALLOWED"],
      policyVersion: input.decision.policyVersion,
      mode: input.decision.mode,
      reasonCodes: input.decision.reasonCodes,
      estimatedCostUsd: input.decision.estimatedCostUsd,
      estimatedLatencyMs: input.decision.estimatedLatencyMs,
      estimatedQuality: input.decision.estimatedQuality,
      executionStatus: input.decision.executionStatus,
      attemptBudget: input.decision.attemptBudget ?? MODEL_ROUTER_ATTEMPT_BUDGET,
      initialProvider: initial?.instanceId ?? null,
      initialModel: initial?.model ?? null,
      executedProvider: executed?.instanceId ?? null,
      executedModel: executed?.model ?? null,
      rerouted,
      attempts: input.decision.attempts ?? [],
    },
    runnerKind: "local",
    workflowName: input.overflow === true ? "UI Lab overflow" : null,
    workflowStatus: input.overflow === true ? "running" : null,
    stages:
      input.overflow === true
        ? Array.from({ length: 28 }, (_, index) => ({
            id: `lab-inspector-row-${index + 1}`,
            label: `Independent Inspector row ${index + 1}`,
            status: index === 0 ? "running" : "waiting",
            current: index === 0,
          }))
        : [],
    cursorCloud: null,
    error: input.error,
    emptyReason: null,
  };
}

export function labControlCenterModel(): ControlCenterModel {
  const environmentId = EnvironmentId.make("lab-environment");
  const projectId = ProjectId.make("lab-project");
  return {
    selectedEnvironmentId: environmentId,
    surface: "ready",
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    projects: [{ id: projectId, environmentId, title: UI_LAB_PROJECT_TITLE, taskCount: 3 }],
    recentTasks: [
      {
        id: ThreadId.make("lab-thread-active"),
        environmentId,
        projectId,
        title: "Active Auto Route task",
        projectTitle: UI_LAB_PROJECT_TITLE,
        status: "active",
        routeLabel: "codex · gpt-5.5",
        runnerKind: "local",
      },
    ],
    activeRuns: [
      {
        id: ThreadId.make("lab-thread-running"),
        environmentId,
        projectId,
        title: "Running fallback",
        projectTitle: UI_LAB_PROJECT_TITLE,
        status: "active",
        routeLabel: "claude · claude-sonnet-4-6",
        runnerKind: "local",
      },
    ],
    approvals: [],
    failedOrCancelled: [
      {
        id: ThreadId.make("lab-thread-failed"),
        environmentId,
        projectId,
        title: "Quota exhausted with no alternate",
        projectTitle: UI_LAB_PROJECT_TITLE,
        status: "failed",
        routeLabel: "codex · gpt-5.5",
        runnerKind: "local",
      },
    ],
    empty: false,
    capabilityOff: false,
  };
}

export const LAB_CODEX = CODEX;
export const LAB_CLAUDE = CLAUDE;
export const LAB_CURSOR = CURSOR;
