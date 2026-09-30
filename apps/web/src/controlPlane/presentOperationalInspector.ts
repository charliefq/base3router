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
  ServerProvider,
  WorkflowRun,
  WorkflowTemplate,
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
  readonly error: string | null;
  readonly emptyReason: InspectorEmptyReason;
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
    };
  }
  return {
    policyVersion: modelRoute.policyVersion,
    mode: modelRoute.mode,
    reasonCodes: modelRoute.reasonCodes,
    estimatedCostUsd: modelRoute.estimatedCostUsd,
    estimatedLatencyMs: modelRoute.estimatedLatencyMs,
    estimatedQuality: modelRoute.estimatedQuality,
    executionStatus: executionStatusFromSession(sessionStatus, bound) ?? modelRoute.executionStatus,
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
    error: sanitizeDisplayText(input.sessionError),
    emptyReason: resolveEmptyReason(input),
  };
}
