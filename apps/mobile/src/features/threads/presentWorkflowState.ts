import type { WorkflowCatalog, WorkflowRun } from "@t3tools/contracts";

const SECRET_SHAPED = /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|CURSOR_API_KEY\s*=/i;

export type MobileWorkflowStateModel = {
  readonly title: string;
  readonly status: string;
  readonly currentStage: string;
  readonly boundRoute: string | null;
  readonly runnerKind: "local" | "cursor-cloud" | "unknown";
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly readOnly: true;
};

function sanitize(value: string | null | undefined): string | null {
  if (value == null || value.length === 0) return value ?? null;
  return SECRET_SHAPED.test(value) ? "[redacted]" : value;
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
  const runnerKind =
    threadAttempt?.runnerBinding?.runnerKind === "cursor-cloud" ? "cursor-cloud" : "local";
  return {
    title: sanitize(template?.displayName ?? run.templateId) ?? run.templateId,
    status: run.status,
    currentStage: current?.label ?? "Finished",
    boundRoute: threadAttempt?.routeBinding
      ? `${threadAttempt.routeBinding.target.instanceId} · ${threadAttempt.routeBinding.target.model}`
      : null,
    runnerKind,
    agentId: sanitize(threadAttempt?.runnerBinding?.cursorAgentId ?? null),
    runId: sanitize(threadAttempt?.runnerBinding?.cursorRunId ?? null),
    readOnly: true,
  };
}
