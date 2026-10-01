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
  type ModelRouterReasonCode,
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
  readonly reasonCodes?: ReadonlyArray<ModelRouterReasonCode>;
}): ModelRouterCandidate {
  const reasonCodes: ReadonlyArray<ModelRouterReasonCode> =
    input.reasonCodes ??
    (input.eligible === false
      ? ["REQUIRED_CAPABILITY_MISSING"]
      : input.fallbackIndex === 0
        ? ["SELECTED", "METRICS_UNKNOWN"]
        : []);
  return {
    fallbackIndex: input.fallbackIndex,
    target: { instanceId: instance(input.instanceId), model: input.model },
    driver: driver(input.driver ?? input.instanceId),
    capabilities: ["code", "tools"],
    eligible: input.eligible ?? true,
    reasonCodes,
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
  readonly empty?: boolean;
  readonly projectTitle?: string;
  readonly taskObjective?: string;
}): OperationalInspectorModel {
  if (input.empty === true) {
    return {
      projectTitle: null,
      taskObjective: null,
      gitBranch: null,
      sessionStatus: null,
      capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
      route: {
        kind: "none",
        provider: null,
        model: null,
        source: null,
        reason: "No route is selected yet.",
        fallbacks: [],
        gateDecision: "unavailable",
        gateReasons: [],
        policyVersion: null,
        mode: null,
        reasonCodes: [],
        estimatedCostUsd: null,
        estimatedLatencyMs: null,
        estimatedQuality: null,
        executionStatus: null,
        attemptBudget: null,
        initialProvider: null,
        initialModel: null,
        executedProvider: null,
        executedModel: null,
        rerouted: false,
        attempts: [],
        eligibleCount: null,
        filteredCount: null,
        filteredReasonCodes: [],
      },
      runnerKind: "unknown",
      workflowName: null,
      workflowStatus: null,
      stages: [],
      cursorCloud: null,
      error: null,
      emptyReason: "no-selection",
    };
  }
  const initial = input.decision.selected?.target ?? null;
  const executed = input.decision.executed?.target ?? initial;
  const rerouted =
    initial !== null &&
    executed !== null &&
    (initial.instanceId !== executed.instanceId || initial.model !== executed.model);
  return {
    projectTitle: input.projectTitle ?? UI_LAB_PROJECT_TITLE,
    taskObjective: input.taskObjective ?? UI_LAB_THREAD_TITLE,
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
      eligibleCount: input.decision.candidates.filter((candidate) => candidate.eligible).length,
      filteredCount: input.decision.candidates.filter((candidate) => !candidate.eligible).length,
      filteredReasonCodes: [
        ...new Set(
          input.decision.candidates.flatMap((candidate) =>
            candidate.eligible ? [] : candidate.reasonCodes,
          ),
        ),
      ],
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

export function labControlCenterModel(input?: {
  readonly surface?: ControlCenterModel["surface"];
  readonly empty?: boolean;
  readonly environmentLabel?: string;
  readonly longNames?: boolean;
}): ControlCenterModel {
  const environmentId = EnvironmentId.make("lab-environment");
  const projectId = ProjectId.make("lab-project");
  const empty = input?.empty === true;
  const longNames = input?.longNames === true;
  const projectTitle = longNames
    ? "Very-long-environment-project-name-that-must-truncate-without-overflow"
    : UI_LAB_PROJECT_TITLE;
  return {
    selectedEnvironmentId: empty ? null : environmentId,
    surface: input?.surface ?? (empty ? "unpaired" : "ready"),
    capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
    projects: empty ? [] : [{ id: projectId, environmentId, title: projectTitle, taskCount: 3 }],
    recentTasks: empty
      ? []
      : [
          {
            id: ThreadId.make("lab-thread-active"),
            environmentId,
            projectId,
            title: longNames
              ? "A-unusually-long-thread-title-for-Control-Center-truncation-checks"
              : "Active Auto Route task",
            projectTitle,
            status: "active",
            routeLabel: longNames
              ? "very-long-provider-instance · very-long-model-slug-name"
              : "codex · gpt-5.5",
            runnerKind: "local",
          },
        ],
    activeRuns: empty
      ? []
      : [
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
    failedOrCancelled: empty
      ? []
      : [
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
    empty,
    capabilityOff: false,
    environmentLabel: input?.environmentLabel ?? (empty ? null : "UI Lab environment"),
  };
}

export const LAB_CODEX = CODEX;
export const LAB_CLAUDE = CLAUDE;
export const LAB_CURSOR = CURSOR;
export const LAB_INELIGIBLE = labCandidate({
  instanceId: "cursor",
  model: "composer-2",
  fallbackIndex: 0,
  driver: "cursor",
  eligible: false,
  reasonCodes: ["REQUIRED_CAPABILITY_MISSING"],
});
export const LAB_UNAVAILABLE = labCandidate({
  instanceId: "codex",
  model: "gpt-5.5",
  fallbackIndex: 0,
  eligible: false,
  reasonCodes: ["PROVIDER_UNAVAILABLE"],
});
export const LAB_LONG_NAME = labCandidate({
  instanceId: "very-long-provider-instance",
  model: "very-long-model-slug-name-for-truncation",
  fallbackIndex: 0,
});
