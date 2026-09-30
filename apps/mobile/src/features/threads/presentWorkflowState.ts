import {
  presentCursorCloudBinding,
  textOmitsCursorSecrets,
} from "@t3tools/client-runtime/cursor-cloud";
import { isCursorCloudRunTerminal } from "@t3tools/contracts";
import type { WorkflowCatalog, WorkflowRun } from "@t3tools/contracts";

export type MobileWorkflowStagePresentation = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
};

export type MobileWorkflowArtifactPresentation = {
  readonly kind: string;
  readonly status: "accepted" | "proposed";
  readonly missingSections: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<{ readonly label: string; readonly content: string }>;
};

export type MobileWorkflowStateModel = {
  readonly title: string;
  readonly templateVersion: number;
  readonly status: string;
  readonly currentStage: string;
  readonly boundRoute: string | null;
  readonly runnerKind: "local" | "cursor-cloud" | "unknown";
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly cursorCloudStatus: string | null;
  readonly cancelled: boolean;
  readonly error: boolean;
  readonly terminal: boolean;
  readonly readOnly: true;
  readonly stages: ReadonlyArray<MobileWorkflowStagePresentation>;
  readonly artifact: MobileWorkflowArtifactPresentation | null;
};

function sanitize(value: string | null | undefined): string | null {
  if (value == null || value.length === 0) return value ?? null;
  return textOmitsCursorSecrets(value) ? value : "[redacted]";
}

export function presentMobileWorkflowState(input: {
  readonly catalog: WorkflowCatalog | null;
  readonly threadId: string;
}): MobileWorkflowStateModel | null {
  const run = input.catalog?.runs.find((entry) =>
    entry.attempts.some((attempt) => attempt.destinationThreadId === input.threadId),
  );
  if (!run) return null;
  return presentMobileWorkflowRun(run, input.catalog, input.threadId);
}

export function presentMobileWorkflowRun(
  run: WorkflowRun,
  catalog: WorkflowCatalog | null | undefined,
  threadId: string,
): MobileWorkflowStateModel {
  const template = catalog?.templates.find(
    (entry) => entry.id === run.templateId && entry.version === run.templateVersion,
  );
  const current = template?.stages.find((entry) => entry.id === run.currentStageId);
  const threadAttempt = run.attempts.findLast((entry) => entry.destinationThreadId === threadId);
  const runnerBinding = threadAttempt?.runnerBinding;
  const presentedBinding = runnerBinding ? presentCursorCloudBinding(runnerBinding) : null;
  const runnerKind = runnerBinding?.runnerKind === "cursor-cloud" ? "cursor-cloud" : "local";
  const artifact =
    run.artifacts.findLast((entry) => entry.stageId === current?.id) ?? run.artifacts.at(-1);
  const cancelled =
    run.status === "cancelled" ||
    runnerBinding?.status === "cancelled" ||
    runnerBinding?.cursorRunStatus === "CANCELLED";
  const error =
    run.status === "rejected" ||
    runnerBinding?.status === "error" ||
    runnerBinding?.cursorRunStatus === "ERROR";
  const terminal =
    run.status === "cancelled" ||
    run.status === "completed" ||
    run.status === "rejected" ||
    isCursorCloudRunTerminal(runnerBinding?.cursorRunStatus);

  return {
    title: sanitize(template?.displayName ?? run.templateId) ?? run.templateId,
    templateVersion: run.templateVersion,
    status: run.status,
    currentStage: current?.label ?? "Finished",
    boundRoute: threadAttempt?.routeBinding
      ? `${threadAttempt.routeBinding.target.instanceId} · ${threadAttempt.routeBinding.target.model}`
      : null,
    runnerKind,
    agentId: sanitize(presentedBinding?.agentId ?? runnerBinding?.cursorAgentId ?? null),
    runId: sanitize(presentedBinding?.runId ?? runnerBinding?.cursorRunId ?? null),
    cursorCloudStatus: presentedBinding?.status ?? null,
    cancelled,
    error,
    terminal,
    readOnly: true,
    stages: (template?.stages ?? []).map((stage) => {
      const attempt = run.attempts.findLast((entry) => entry.stageId === stage.id);
      return {
        id: stage.id,
        label: stage.label,
        status: attempt?.status ?? "waiting",
      };
    }),
    artifact: artifact
      ? {
          kind: artifact.kind,
          status: artifact.status === "accepted" ? "accepted" : "proposed",
          missingSections: artifact.missingSections,
          sections: artifact.sections.map((section) => ({
            label: section.label,
            content: sanitize(section.content) ?? "",
          })),
        }
      : null,
  };
}
