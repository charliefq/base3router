import {
  presentBoundDispatcherRoute,
  presentDispatcherDecision,
  type DispatcherPreviewState,
} from "@t3tools/client-runtime/dispatcher";
import {
  cursorCloudCancelDisabled,
  cursorCloudFollowUpDisabled,
  presentCursorCloudBinding,
} from "@t3tools/client-runtime/cursor-cloud";
import type {
  CursorCloudRunnerBinding,
  DispatcherTaskRouteBinding,
  ModelRouterDecision,
  ModelRouterExecutionStatus,
  ModelRouterMetricValue,
  ModelRouterMode,
  ModelRouterRouteAttempt,
  OpenRouterTeacherObservationV0,
  ServerProvider,
  WorkflowRun,
  WorkflowTemplate,
  HybridRouteDecisionV1,
} from "@t3tools/contracts";

import { sanitizeDisplayText } from "./sanitizeDisplayText";

export type InspectorRouteKind = "provisional" | "bound" | "unavailable" | "none";
export type InspectorRunnerKind = "local" | "cursor-cloud" | "unavailable" | "unknown";
export type InspectorGateDecision = "ALLOW" | "DENY" | "unavailable";
export type InspectorEmptyReason = "no-selection" | "capability-off" | "unavailable" | null;

export type InspectorCapabilities = {
  readonly dispatcher: boolean;
  readonly workflow: boolean;
  readonly cursorCloud: boolean;
};

export type InspectorStageModel = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly current: boolean;
};

export type InspectorRouteModel = {
  readonly kind: InspectorRouteKind;
  readonly provider: string | null;
  readonly model: string | null;
  readonly source: string | null;
  readonly reason: string;
  readonly fallbacks: ReadonlyArray<{ readonly provider: string; readonly model: string }>;
  readonly gateDecision: InspectorGateDecision;
  readonly gateReasons: ReadonlyArray<string>;
  readonly policyVersion: string | null;
  readonly mode: ModelRouterMode | null;
  readonly reasonCodes: ReadonlyArray<string>;
  readonly estimatedCostUsd: ModelRouterMetricValue | null;
  readonly estimatedLatencyMs: ModelRouterMetricValue | null;
  readonly estimatedQuality: ModelRouterMetricValue | null;
  readonly executionStatus: ModelRouterExecutionStatus | null;
  readonly attemptBudget: number | null;
  readonly initialProvider: string | null;
  readonly initialModel: string | null;
  readonly executedProvider: string | null;
  readonly executedModel: string | null;
  readonly rerouted: boolean;
  readonly attempts: ReadonlyArray<ModelRouterRouteAttempt>;
  readonly eligibleCount: number | null;
  readonly filteredCount: number | null;
  readonly filteredReasonCodes: ReadonlyArray<string>;
};

export type InspectorCursorCloudModel = {
  readonly status: string;
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly repository: string | null;
  readonly startingRef: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly pullRequestUrl: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly followUpEnabled: boolean;
  readonly cancelEnabled: boolean;
  readonly refreshEnabled: boolean;
};

export type InspectorHybridModel = {
  readonly policyVersion: string;
  readonly usedHybridRanking: boolean;
  readonly fallbackToV0: boolean;
  readonly fallbackReason: string | null;
  readonly selected: string | null;
  readonly explanation: string;
  readonly components: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly sampleSize: number;
    readonly status: string;
    readonly provenance: string;
  }>;
  readonly challenger: {
    readonly selected: string | null;
    readonly agreement: string;
  } | null;
  readonly insufficient: boolean;
};

export type InspectorOpenRouterModel = {
  readonly mode: string;
  readonly status: string;
  readonly connection: string | null;
  readonly privacyPolicy: string;
  readonly taskTag: string | null;
  readonly taskSource: string;
  readonly base3Model: string | null;
  readonly openRouterModel: string | null;
  readonly requestedRouterTarget: string | null;
  readonly actualModel: string | null;
  readonly agreement: string;
  readonly skipReason: string | null;
  readonly errorCategory: string | null;
  readonly nestedFallbacks: ReadonlyArray<string>;
  readonly freshness: string | null;
  readonly asOf: string | null;
};

export type OperationalInspectorModel = {
  readonly projectTitle: string | null;
  readonly taskObjective: string | null;
  readonly gitBranch: string | null;
  readonly sessionStatus: string | null;
  readonly capabilities: InspectorCapabilities;
  readonly route: InspectorRouteModel;
  readonly runnerKind: InspectorRunnerKind;
  readonly workflowName: string | null;
  readonly workflowStatus: string | null;
  readonly stages: ReadonlyArray<InspectorStageModel>;
  readonly cursorCloud: InspectorCursorCloudModel | null;
  readonly openRouter: InspectorOpenRouterModel | null;
  readonly hybrid: InspectorHybridModel | null;
  readonly skillRoute: InspectorSkillRouteModel | null;
  readonly mcpRoute: InspectorMcpRouteModel | null;
  readonly executionPlan: InspectorPlanModel | null;
  readonly actionGate: InspectorSideEffectGateModel | null;
  readonly approval: InspectorApprovalModel | null;
  readonly toolExecution: InspectorToolExecutionModel | null;
  readonly outcome: InspectorOutcomeModel | null;
  readonly error: string | null;
  readonly emptyReason: InspectorEmptyReason;
};

export type InspectorSkillRouteModel = {
  readonly policyVersion: string;
  readonly selected: string | null;
  readonly mode: string;
  readonly reasonCodes: ReadonlyArray<string>;
  readonly filteredReasonCodes: ReadonlyArray<string>;
  readonly eligibleCount: number;
  readonly explanation: string;
  readonly tieBreak: string;
};

export type InspectorMcpRouteModel = {
  readonly policyVersion: string;
  readonly selected: string | null;
  readonly server: string | null;
  readonly mode: string;
  readonly reasonCodes: ReadonlyArray<string>;
  readonly filteredReasonCodes: ReadonlyArray<string>;
  readonly eligibleCount: number;
  readonly explanation: string;
  readonly tieBreak: string;
};

export type InspectorPlanModel = {
  readonly planId: string;
  readonly actionCount: number;
  readonly policyVersions: string;
  readonly expiresAt: string | null;
};

export type InspectorSideEffectGateModel = {
  readonly decision: string;
  readonly riskClass: string;
  readonly reasonCodes: ReadonlyArray<string>;
  readonly fingerprint: string;
};

export type InspectorApprovalModel = {
  readonly status: string;
  readonly reuse: string;
  readonly expiresAt: string | null;
  readonly oneTime: boolean;
  readonly actionType: string;
  readonly destination: string;
  readonly argumentSummary: string;
};

export type InspectorToolExecutionModel = {
  readonly status: string;
  readonly retry: string;
  readonly circuit: string;
  readonly fallback: string;
};

export type InspectorOutcomeModel = {
  readonly classification: string;
  readonly evidence: string;
};

export type OperationalInspectorInput = {
  readonly selected: boolean;
  readonly projectTitle: string | null;
  readonly taskObjective: string | null;
  readonly gitBranch: string | null;
  readonly sessionStatus: string | null;
  readonly sessionError: string | null;
  readonly capabilities: InspectorCapabilities;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly preview: DispatcherPreviewState | null;
  readonly boundRoute: DispatcherTaskRouteBinding | null;
  readonly workflowRun: WorkflowRun | null;
  readonly workflowTemplate: WorkflowTemplate | null;
  readonly cursorCloudBinding: CursorCloudRunnerBinding | null;
  readonly openRouterPriors?: {
    readonly freshness: string;
    readonly asOf: string | null;
  };
  readonly hybrid?: InspectorHybridModel | null;
  readonly skillRoute?: InspectorSkillRouteModel | null;
  readonly mcpRoute?: InspectorMcpRouteModel | null;
  readonly executionPlan?: InspectorPlanModel | null;
  readonly actionGate?: InspectorSideEffectGateModel | null;
  readonly approval?: InspectorApprovalModel | null;
  readonly toolExecution?: InspectorToolExecutionModel | null;
  readonly outcome?: InspectorOutcomeModel | null;
};

const EMPTY_ROUTE: InspectorRouteModel = {
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
};

function executionStatusFromSession(
  sessionStatus: string | null,
  bound: boolean,
): ModelRouterExecutionStatus | null {
  if (sessionStatus === "error") return "failed";
  if (sessionStatus === "running" || sessionStatus === "starting") return "running";
  if (sessionStatus === "ready" || sessionStatus === "stopped" || sessionStatus === "interrupted") {
    return "completed";
  }
  if (bound) return "bound";
  return null;
}

function presentModelRouteTrace(
  modelRoute: ModelRouterDecision | undefined,
  sessionStatus: string | null,
  bound: boolean,
): Pick<
  InspectorRouteModel,
  | "policyVersion"
  | "mode"
  | "reasonCodes"
  | "estimatedCostUsd"
  | "estimatedLatencyMs"
  | "estimatedQuality"
  | "executionStatus"
  | "attemptBudget"
  | "initialProvider"
  | "initialModel"
  | "executedProvider"
  | "executedModel"
  | "rerouted"
  | "attempts"
  | "eligibleCount"
  | "filteredCount"
  | "filteredReasonCodes"
> {
  if (modelRoute === undefined) {
    return {
      policyVersion: null,
      mode: null,
      reasonCodes: [],
      estimatedCostUsd: null,
      estimatedLatencyMs: null,
      estimatedQuality: null,
      executionStatus: executionStatusFromSession(sessionStatus, bound),
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
    };
  }
  const initial = modelRoute.selected?.target ?? null;
  const executed = modelRoute.executed?.target ?? initial;
  const rerouted =
    initial !== null &&
    executed !== null &&
    (initial.instanceId !== executed.instanceId || initial.model !== executed.model);
  return {
    policyVersion: modelRoute.policyVersion,
    mode: modelRoute.mode,
    reasonCodes: modelRoute.reasonCodes,
    estimatedCostUsd: modelRoute.estimatedCostUsd,
    estimatedLatencyMs: modelRoute.estimatedLatencyMs,
    estimatedQuality: modelRoute.estimatedQuality,
    executionStatus: executionStatusFromSession(sessionStatus, bound) ?? modelRoute.executionStatus,
    attemptBudget: modelRoute.attemptBudget ?? null,
    initialProvider: initial?.instanceId ?? null,
    initialModel: initial?.model ?? null,
    executedProvider: executed?.instanceId ?? null,
    executedModel: executed?.model ?? null,
    rerouted,
    attempts: modelRoute.attempts ?? [],
    eligibleCount: modelRoute.candidates.filter((candidate) => candidate.eligible).length,
    filteredCount: modelRoute.candidates.filter((candidate) => !candidate.eligible).length,
    filteredReasonCodes: [
      ...new Set(
        modelRoute.candidates.flatMap((candidate) =>
          candidate.eligible ? [] : candidate.reasonCodes,
        ),
      ),
    ],
  };
}

function presentRoute(input: OperationalInspectorInput): InspectorRouteModel {
  if (input.boundRoute) {
    const presented = presentBoundDispatcherRoute(input.boundRoute, input.providers);
    const fallbacks =
      input.boundRoute.modelRoute?.fallbacks.map((candidate) => ({
        provider: candidate.target.instanceId,
        model: candidate.target.model,
      })) ?? [];
    return {
      kind: "bound",
      provider: presented.provider,
      model: presented.model,
      source: input.boundRoute.source,
      reason: sanitizeDisplayText(input.boundRoute.modelRoute?.explanation) ?? presented.reason,
      fallbacks,
      gateDecision: input.boundRoute.gate.decision,
      gateReasons: input.boundRoute.gate.reasonCodes,
      ...presentModelRouteTrace(input.boundRoute.modelRoute, input.sessionStatus, true),
    };
  }

  if (!input.capabilities.dispatcher) {
    return {
      ...EMPTY_ROUTE,
      kind: "unavailable",
      reason: "Route preview is unavailable on this server.",
    };
  }

  const preview = input.preview;
  if (preview?.status === "success") {
    const presented = presentDispatcherDecision(preview.decision, input.providers);
    return {
      kind: presented ? "provisional" : "unavailable",
      provider: presented?.provider ?? null,
      model: presented?.model ?? null,
      source: preview.decision.selected?.source ?? null,
      reason: presented?.reason ?? "Automatic routing could not select a route.",
      fallbacks: presented?.fallbacks ?? [],
      gateDecision: preview.decision.gate.decision,
      gateReasons: preview.decision.gate.reasonCodes,
      ...presentModelRouteTrace(undefined, input.sessionStatus, false),
    };
  }

  if (preview?.status === "error") {
    return {
      ...EMPTY_ROUTE,
      kind: "unavailable",
      reason:
        preview.kind === "unavailable"
          ? "The dispatcher is unavailable."
          : preview.kind === "unauthorized"
            ? "Route preview is not authorized for this connection."
            : "Route preview failed.",
    };
  }

  return EMPTY_ROUTE;
}

function presentStages(
  run: WorkflowRun | null,
  template: WorkflowTemplate | null,
): ReadonlyArray<InspectorStageModel> {
  if (run === null || template === null) return [];
  return template.stages.map((stage) => {
    const attempt = run.attempts.findLast((entry) => entry.stageId === stage.id);
    return {
      id: stage.id,
      label: stage.label,
      status: attempt?.status ?? "waiting",
      current: run.currentStageId === stage.id,
    };
  });
}

function presentCursorCloud(
  binding: CursorCloudRunnerBinding | null,
  cursorCloudAvailable: boolean,
): InspectorCursorCloudModel | null {
  if (binding === null) {
    return cursorCloudAvailable
      ? {
          status: "idle",
          agentId: null,
          runId: null,
          repository: null,
          startingRef: null,
          branch: null,
          commit: null,
          pullRequestUrl: null,
          result: null,
          error: null,
          followUpEnabled: false,
          cancelEnabled: false,
          refreshEnabled: false,
        }
      : null;
  }

  const presented = presentCursorCloudBinding(binding);
  return {
    status: presented.status,
    agentId: sanitizeDisplayText(presented.agentId),
    runId: sanitizeDisplayText(presented.runId),
    repository: sanitizeDisplayText(presented.repository),
    startingRef: sanitizeDisplayText(presented.startingRef),
    branch: sanitizeDisplayText(presented.outputBranch),
    commit: sanitizeDisplayText(presented.outputCommit),
    pullRequestUrl: sanitizeDisplayText(presented.pullRequestUrl),
    result: sanitizeDisplayText(presented.result),
    error: sanitizeDisplayText(presented.error),
    followUpEnabled: !cursorCloudFollowUpDisabled(binding),
    cancelEnabled: !cursorCloudCancelDisabled(binding),
    refreshEnabled: true,
  };
}

function resolveRunnerKind(input: OperationalInspectorInput): InspectorRunnerKind {
  if (input.cursorCloudBinding) return "cursor-cloud";
  if (!input.capabilities.dispatcher && input.boundRoute === null) return "unavailable";
  if (input.boundRoute || input.preview?.status === "success") return "local";
  return "unknown";
}

function resolveEmptyReason(input: OperationalInspectorInput): InspectorEmptyReason {
  if (!input.selected) return "no-selection";
  if (!input.capabilities.dispatcher && !input.capabilities.workflow && input.boundRoute === null) {
    return "capability-off";
  }
  return null;
}

function presentOpenRouter(
  observation: OpenRouterTeacherObservationV0 | undefined,
  priors?: OperationalInspectorInput["openRouterPriors"],
): InspectorOpenRouterModel | null {
  if (observation === undefined) return null;
  return {
    mode: observation.guidanceMode,
    status: observation.status,
    connection: null,
    privacyPolicy: observation.privacyPolicy,
    taskTag: observation.taskProfile.rawExternalTag ?? null,
    taskSource: observation.taskProfile.source,
    base3Model: observation.base3Selected?.model ?? null,
    openRouterModel: observation.openRouterSuggested ?? null,
    requestedRouterTarget: observation.requestedRouterTarget ?? null,
    actualModel: observation.actualExecutionModel ?? null,
    agreement: observation.agreement,
    skipReason: observation.skipReason ?? null,
    errorCategory: observation.errorCategory ?? null,
    nestedFallbacks: observation.nestedFallbacks.map((attempt) =>
      [attempt.origin, attempt.provider, attempt.model, attempt.status]
        .filter((part) => part !== undefined)
        .join(" · "),
    ),
    freshness: priors?.freshness ?? null,
    asOf: priors?.asOf ?? observation.observedAt ?? null,
  };
}

function presentHybrid(decision: HybridRouteDecisionV1 | undefined): InspectorHybridModel | null {
  if (decision === undefined) return null;
  return {
    policyVersion: decision.policyVersion,
    usedHybridRanking: decision.usedHybridRanking,
    fallbackToV0: decision.fallbackToV0,
    fallbackReason: decision.fallbackReason ?? null,
    selected: decision.selected
      ? `${decision.selected.instanceId} · ${decision.selected.model}`
      : null,
    explanation: decision.explanation,
    components: decision.components.map((entry) => ({
      id: entry.id,
      label: entry.label,
      sampleSize: entry.sampleSize,
      status: entry.status,
      provenance: entry.provenance,
    })),
    challenger:
      decision.challenger === undefined
        ? null
        : {
            selected: decision.challenger.selected
              ? `${decision.challenger.selected.instanceId} · ${decision.challenger.selected.model}`
              : null,
            agreement: decision.challenger.agreement,
          },
    insufficient: decision.fallbackToV0,
  };
}

function presentSkillRoute(
  decision: import("@t3tools/contracts").SkillRouterDecision | undefined,
  override: InspectorSkillRouteModel | null | undefined,
): InspectorSkillRouteModel | null {
  if (override !== undefined) return override;
  if (decision === undefined) return null;
  return {
    policyVersion: decision.policyVersion,
    selected: decision.selected?.skillId ?? null,
    mode: decision.mode,
    reasonCodes: [...decision.reasonCodes],
    filteredReasonCodes: [
      ...new Set(decision.filtered.flatMap((candidate) => candidate.reasonCodes)),
    ],
    eligibleCount: decision.eligible.length,
    explanation: sanitizeDisplayText(decision.explanation) ?? decision.explanation,
    tieBreak: decision.tieBreak,
  };
}

function presentMcpRoute(
  decision: import("@t3tools/contracts").McpRouterDecision | undefined,
  override: InspectorMcpRouteModel | null | undefined,
): InspectorMcpRouteModel | null {
  if (override !== undefined) return override;
  if (decision === undefined) return null;
  return {
    policyVersion: decision.policyVersion,
    selected: decision.selected?.toolId ?? null,
    server: decision.selected?.serverId ?? null,
    mode: decision.mode,
    reasonCodes: [...decision.reasonCodes],
    filteredReasonCodes: [
      ...new Set(decision.filtered.flatMap((candidate) => candidate.reasonCodes)),
    ],
    eligibleCount: decision.eligible.length,
    explanation: sanitizeDisplayText(decision.explanation) ?? decision.explanation,
    tieBreak: decision.tieBreak,
  };
}

function presentPlan(
  plan: import("@t3tools/contracts").ExecutionPlanV0 | undefined,
  override: InspectorPlanModel | null | undefined,
): InspectorPlanModel | null {
  if (override !== undefined) return override;
  if (plan === undefined) return null;
  return {
    planId: plan.planId,
    actionCount: plan.actions.length,
    policyVersions: plan.policyVersions.join(" · "),
    expiresAt: plan.expiresAt ?? null,
  };
}

function presentActionGate(
  plan: import("@t3tools/contracts").ExecutionPlanV0 | undefined,
  override: InspectorSideEffectGateModel | null | undefined,
): InspectorSideEffectGateModel | null {
  if (override !== undefined) return override;
  const action = plan?.actions[0];
  if (action === undefined) return null;
  return {
    decision: action.requiresApproval ? "ASK" : "ALLOW",
    riskClass: action.riskClass,
    reasonCodes: action.requiresApproval ? ["APPROVAL_REQUIRED"] : ["ACTION_ALLOWED"],
    fingerprint: action.fingerprint.slice(0, 12),
  };
}

export function presentOperationalInspector(
  input: OperationalInspectorInput,
): OperationalInspectorModel {
  const route = presentRoute(input);
  return {
    projectTitle: sanitizeDisplayText(input.projectTitle),
    taskObjective: sanitizeDisplayText(input.taskObjective),
    gitBranch: sanitizeDisplayText(input.gitBranch),
    sessionStatus: input.sessionStatus,
    capabilities: input.capabilities,
    route,
    runnerKind: resolveRunnerKind(input),
    workflowName: sanitizeDisplayText(input.workflowTemplate?.displayName ?? null),
    workflowStatus: input.workflowRun?.status ?? null,
    stages: presentStages(input.workflowRun, input.workflowTemplate),
    cursorCloud: presentCursorCloud(input.cursorCloudBinding, input.capabilities.cursorCloud),
    openRouter: presentOpenRouter(input.boundRoute?.openRouter, input.openRouterPriors),
    hybrid: input.hybrid ?? presentHybrid(input.boundRoute?.hybrid),
    skillRoute: presentSkillRoute(input.boundRoute?.skillRoute, input.skillRoute),
    mcpRoute: presentMcpRoute(input.boundRoute?.mcpRoute, input.mcpRoute),
    executionPlan: presentPlan(input.boundRoute?.executionPlan, input.executionPlan),
    actionGate: presentActionGate(input.boundRoute?.executionPlan, input.actionGate),
    approval: input.approval ?? null,
    toolExecution: input.toolExecution ?? null,
    outcome: input.outcome ?? null,
    error: sanitizeDisplayText(input.sessionError),
    emptyReason: resolveEmptyReason(input),
  };
}
