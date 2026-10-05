import type {
  EnvironmentId,
  GovernanceSnapshot,
  ProjectId,
  WorkflowCatalog,
  WorkflowRun,
  WorkflowStage,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { useProjects } from "../../state/entities";
import { governanceEnvironment } from "../../state/governance";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowEnvironment } from "../../state/workflow";

function useGovernanceSnapshot(environmentId: EnvironmentId | null, threadId?: string) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : governanceEnvironment.snapshot({
          environmentId,
          input: threadId === undefined ? {} : { threadId },
        }),
  );
}

function pendingDecision(catalog: WorkflowCatalog, run: WorkflowRun) {
  if (run.status !== "active" || run.currentStageId === null) return null;
  const template = catalog.templates.find(
    (entry) => entry.id === run.templateId && entry.version === run.templateVersion,
  );
  const stage = template?.stages.find((entry) => entry.id === run.currentStageId);
  const attempt = run.attempts.findLast((entry) => entry.stageId === run.currentStageId);
  if (stage === undefined || attempt === undefined) return null;
  if (stage.type === "human_gate" && attempt.status === "pending") {
    return { stage, attempt, artifactId: null as string | null };
  }
  if (stage.type === "agent" && attempt.status === "proposed") {
    const artifact = run.artifacts.findLast(
      (entry) => entry.stageId === stage.id && entry.attempt === attempt.attempt,
    );
    return { stage, attempt, artifactId: artifact?.id ?? null };
  }
  return null;
}

function currentStage(catalog: WorkflowCatalog, run: WorkflowRun): WorkflowStage | null {
  if (run.currentStageId === null) return null;
  return (
    catalog.templates
      .find((entry) => entry.id === run.templateId && entry.version === run.templateVersion)
      ?.stages.find((entry) => entry.id === run.currentStageId) ?? null
  );
}

function ProjectWorkflowDecisions(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly refreshTick: number;
}) {
  const catalogQuery = useEnvironmentQuery(
    workflowEnvironment.catalog({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const recordAction = useAtomCommand(workflowEnvironment.action, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    catalogQuery.refresh();
  }, [props.refreshTick]);
  const catalog = catalogQuery.data;
  const activeRun = catalog?.runs.find((run) => run.status === "active") ?? null;
  const decision =
    catalog !== null && activeRun !== null ? pendingDecision(catalog, activeRun) : null;
  const stage = catalog !== null && activeRun !== null ? currentStage(catalog, activeRun) : null;
  const submit = async (input: Parameters<typeof recordAction>[0]["input"]): Promise<void> => {
    setError(null);
    const result = await recordAction({
      environmentId: props.environmentId,
      input,
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message
          : "The workflow action failed.",
      );
    }
  };
  return (
    <article className="rounded-md border border-border/60 p-3" data-workflow-surface="">
      <h3 className="text-xs font-medium">Workflow · {props.projectTitle}</h3>
      {catalogQuery.isPending ? (
        <p className="mt-1 text-xs text-muted-foreground">Loading workflow.</p>
      ) : null}
      {error !== null ? (
        <p className="mt-1 text-xs text-destructive" data-workflow-error="">
          {error}
        </p>
      ) : null}
      {catalogQuery.error !== null ? (
        <p className="mt-1 text-xs text-destructive" data-workflow-error="">
          {catalogQuery.error}
        </p>
      ) : null}
      {catalog === null ? null : activeRun === null ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">No active workflow.</p>
          <div>
            <Button
              size="sm"
              variant="outline"
              type="button"
              data-workflow-start=""
              onClick={() => {
                void submit({
                  type: "run.start",
                  projectId: props.projectId,
                  commandId: `start${crypto.randomUUID().replaceAll("-", "")}`,
                  runId: `run${crypto.randomUUID().replaceAll("-", "")}`,
                  templateId: "saas-production",
                  templateVersion: 1,
                  originatingThreadId: null,
                  originatingMessageId: null,
                });
              }}
            >
              Start SaaS Production
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs" data-workflow-stage={stage?.id ?? ""}>
            {stage?.label ?? activeRun.currentStageId ?? activeRun.status} · {activeRun.status}
            {stage?.type === "human_gate" ? " · human gate" : ""}
          </p>
          {decision === null ? (
            <p className="text-xs text-muted-foreground">
              {stage?.type === "agent" &&
              activeRun.attempts.findLast((entry) => entry.stageId === stage.id)?.status ===
                "pending"
                ? "Waiting for the governed stage dispatch."
                : "No pending human decision."}
            </p>
          ) : (
            <div
              className="flex flex-col gap-2"
              data-workflow-decision=""
              data-workflow-decision-run={activeRun.id}
            >
              <p className="text-xs">
                {decision.stage.label} needs a decision on attempt {decision.attempt.attempt}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="button"
                  data-workflow-approve=""
                  onClick={() => {
                    void submit({
                      type: "decision.record",
                      projectId: props.projectId,
                      commandId: `cmd${activeRun.id}${decision.stage.id}${decision.attempt.attempt}approve`,
                      decisionId: `d${activeRun.id}${decision.stage.id}${decision.attempt.attempt}`,
                      runId: activeRun.id,
                      stageId: decision.stage.id,
                      attempt: decision.attempt.attempt,
                      artifactId: decision.artifactId,
                      value: "approve",
                    });
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  data-workflow-reject=""
                  onClick={() => {
                    void submit({
                      type: "decision.record",
                      projectId: props.projectId,
                      commandId: `cmd${activeRun.id}${decision.stage.id}${decision.attempt.attempt}reject`,
                      decisionId: `d${activeRun.id}${decision.stage.id}${decision.attempt.attempt}`,
                      runId: activeRun.id,
                      stageId: decision.stage.id,
                      attempt: decision.attempt.attempt,
                      artifactId: decision.artifactId,
                      value: "reject",
                    });
                  }}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  data-workflow-cancel=""
                  onClick={() => {
                    void submit({
                      type: "run.cancel",
                      projectId: props.projectId,
                      commandId: `cancel${activeRun.id}`,
                      runId: activeRun.id,
                    });
                  }}
                >
                  Cancel run
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function WorkflowDecisions(props: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshTick: number;
}) {
  const projects = useProjects().filter(
    (project) => props.environmentId !== null && project.environmentId === props.environmentId,
  );
  if (props.environmentId === null) return null;
  return (
    <div className="space-y-3">
      {projects.length === 0 ? (
        <article className="rounded-md border border-border/60 p-3" data-workflow-surface="">
          <h3 className="text-xs font-medium">Workflow decisions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Add a project, then start a workflow to record a human decision.
          </p>
        </article>
      ) : (
        projects.map((project) => (
          <ProjectWorkflowDecisions
            key={project.id}
            environmentId={props.environmentId!}
            projectId={project.id}
            projectTitle={project.title}
            refreshTick={props.refreshTick}
          />
        ))
      )}
    </div>
  );
}

function GovernanceProjectionView(props: {
  readonly surface: "control-center" | "inspector";
  readonly environmentId: EnvironmentId | null;
  readonly snapshot: GovernanceSnapshot | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly refreshTick: number;
}) {
  const snapshot = props.snapshot;
  return (
    <section className="space-y-3" data-governance-surface={props.surface}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            {props.surface === "control-center" ? "Control Center" : "Governance"}
          </h2>
          <p className="text-xs text-muted-foreground">
            Protocol {snapshot?.protocolVersion ?? 2}. Identity comes from the signed-in session.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          data-governance-refresh=""
          onClick={props.onRefresh}
        >
          Refresh
        </Button>
      </div>
      {props.pending ? <p className="text-xs text-muted-foreground">Loading governance.</p> : null}
      {props.error !== null ? (
        <p className="text-xs text-destructive" data-governance-error="">
          {props.error}
        </p>
      ) : null}
      {snapshot === null ? null : (
        <div className="grid gap-3 md:grid-cols-2">
          <article className="rounded-md border border-border/60 p-3" data-governance-routes="">
            <h3 className="text-xs font-medium">Route bindings</h3>
            {snapshot.routes.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No bound routes.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.routes.map((route) => (
                  <li key={`${route.threadId}:${route.messageId}`}>
                    {route.mode} · {route.model ?? "unselected"} ·{" "}
                    {route.instanceId ?? "no instance"}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="rounded-md border border-border/60 p-3" data-governance-leases="">
            <h3 className="text-xs font-medium">Capacity</h3>
            {snapshot.leases.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No active leases.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.leases.map((lease) => (
                  <li key={lease.leaseId} data-governance-lease={lease.leaseId}>
                    {lease.workloadClass} · {lease.occupied ? "occupied" : "free"}
                    {lease.interruptRequested ? " · interrupt requested" : ""}
                    {lease.disconnectUnconfirmed ? " · disconnect unconfirmed" : ""}
                    {lease.runStatus !== null ? ` · run ${lease.runStatus}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="rounded-md border border-border/60 p-3" data-governance-approvals="">
            <h3 className="text-xs font-medium">Approvals</h3>
            {snapshot.approvals.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No approvals.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.approvals.map((approval) => (
                  <li key={approval.approvalId}>
                    {approval.status}
                    {approval.consumedAt !== null ? " · consumed" : ""}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="rounded-md border border-border/60 p-3" data-governance-memory="">
            <h3 className="text-xs font-medium">Memory</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {snapshot.deletedSourceCount} deleted sources stay deleted.
            </p>
            {snapshot.memories.length === 0 ? null : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.memories.map((memory) => (
                  <li key={memory.memoryId}>
                    {memory.status} · {memory.scopeKind}
                    {memory.contentPresent ? "" : " · content absent"}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      )}
      <WorkflowDecisions environmentId={props.environmentId} refreshTick={props.refreshTick} />
    </section>
  );
}

export function GovernanceControlCenter(props: { readonly environmentId: EnvironmentId | null }) {
  const query = useGovernanceSnapshot(props.environmentId);
  const [refreshTick, setRefreshTick] = useState(0);
  return (
    <GovernanceProjectionView
      surface="control-center"
      environmentId={props.environmentId}
      snapshot={query.data}
      pending={query.isPending}
      error={query.error}
      refreshTick={refreshTick}
      onRefresh={() => {
        query.refresh();
        setRefreshTick((tick) => tick + 1);
      }}
    />
  );
}

export function GovernanceInspector(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const query = useGovernanceSnapshot(props.environmentId, props.threadId);
  const [refreshTick, setRefreshTick] = useState(0);
  return (
    <GovernanceProjectionView
      surface="inspector"
      environmentId={props.environmentId}
      snapshot={query.data}
      pending={query.isPending}
      error={query.error}
      refreshTick={refreshTick}
      onRefresh={() => {
        query.refresh();
        setRefreshTick((tick) => tick + 1);
      }}
    />
  );
}
