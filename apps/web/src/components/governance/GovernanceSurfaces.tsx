import { WorkflowRevisionFeedbackForm, WorkflowDecisionHistory } from "./WorkflowRevisionFeedback";
import { workflowRevisionArtifact } from "@t3tools/shared/workflowRevision";
import type {
  ActionApprovalId,
  EnvironmentId,
  GovernanceSnapshot,
  MemoryId,
  ProjectId,
  ThreadId,
  WorkflowCatalog,
  WorkflowRun,
  WorkflowStage,
  WorkflowArtifact,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { WorkflowStagePreview } from "./WorkflowStagePreview";
import { TaskContractReadout } from "../chat/TaskContractPanel";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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

function ArtifactReview(props: { readonly artifact: WorkflowArtifact }) {
  const artifact = props.artifact;
  return (
    <article className="space-y-1 border-t pt-2" aria-label={`Artifact ${artifact.id}`}>
      <p className="text-xs">
        {artifact.kind} · {artifact.status} · Stage {artifact.stageId} · Attempt {artifact.attempt}
      </p>
      <p className="text-xs">
        Source outcome: {artifact.sourceOutcome ?? "Unknown (legacy record)"} · Run{" "}
        {artifact.sourceTurnId ?? "Unknown"}
      </p>
      <p className="text-xs">
        Thread {artifact.sourceThreadId ?? "Unknown"} · User message{" "}
        {artifact.sourceMessageId ?? "Unknown"} · Output message{" "}
        {artifact.outputMessageId ?? "Unknown"}
      </p>
      <p className="text-xs">
        Redactions: {artifact.redacted ? "present" : "none recorded"} · Missing sections:{" "}
        {artifact.missingSections.join(", ") || "none"}
      </p>
      {artifact.sections.map((section) => (
        <section key={section.label}>
          <h4 className="text-xs font-medium">
            {section.label}
            {section.missing ? " · Unknown" : ""}
          </h4>
          <p className="whitespace-pre-wrap text-xs">
            {section.missing ? "Unknown" : section.content}
          </p>
        </section>
      ))}
    </article>
  );
}

export function ProjectWorkflowDecisions(props: {
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
  const proposeArtifact = useAtomCommand(workflowEnvironment.proposeArtifact, {
    reportFailure: false,
  });
  const operation = useRef({ pending: false, generation: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    catalogQuery.refresh();
  }, [props.refreshTick]);
  const catalog = catalogQuery.data;
  const activeRun =
    catalog?.runs.find((run) => run.status === "active" || run.status === "paused") ?? null;
  const decision =
    catalog !== null && activeRun !== null ? pendingDecision(catalog, activeRun) : null;
  const stage = catalog !== null && activeRun !== null ? currentStage(catalog, activeRun) : null;
  const attempt = activeRun?.attempts.findLast((entry) => entry.stageId === stage?.id);
  const revisionTemplate = catalog?.templates.find(
    (t) => t.id === activeRun?.templateId && t.version === activeRun?.templateVersion,
  );
  const revisionTarget =
    decision?.stage.type === "human_gate"
      ? revisionTemplate?.stages[
          revisionTemplate.stages.findIndex((s) => s.id === decision.stage.id) - 1
        ]
      : decision?.stage;
  const revisionSource =
    activeRun && decision && revisionTemplate
      ? workflowRevisionArtifact(
          activeRun,
          revisionTemplate,
          decision.stage.id,
          decision.attempt.attempt,
        )
      : null;
  const revisionExhausted =
    !revisionTarget ||
    (decision?.stage.type === "human_gate" &&
      decision.attempt.attempt >= decision.stage.maxAttempts) ||
    (activeRun?.attempts.findLast((a) => a.stageId === revisionTarget.id)?.attempt ?? 0) >=
      revisionTarget.maxAttempts;
  const operationContext = JSON.stringify([
    props.environmentId,
    props.projectId,
    activeRun?.id,
    activeRun?.updatedAt,
    stage?.id,
    attempt?.attempt,
  ]);
  const observedContext = useRef(operationContext);
  useLayoutEffect(() => {
    if (observedContext.current !== operationContext) {
      observedContext.current = operationContext;
      operation.current.pending = false;
      setBusy(false);
    }
    return () => {
      operation.current.generation++;
    };
  }, [operationContext, observedContext]);
  const submitOperation = async (run: () => Promise<{ readonly _tag: string }>): Promise<void> => {
    if (operation.current.pending || catalogQuery.isPending || !catalogQuery.isSuccess) return;
    operation.current.pending = true;
    const generation = ++operation.current.generation;
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (operation.current.generation !== generation) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result as never);
    } catch (failure) {
      if (operation.current.generation === generation)
        setError(failure instanceof Error ? failure.message : "The workflow action failed.");
    } finally {
      if (operation.current.generation === generation) {
        operation.current.pending = false;
        setBusy(false);
      }
    }
  };
  const submit = (input: Parameters<typeof recordAction>[0]["input"]) =>
    submitOperation(() => recordAction({ environmentId: props.environmentId, input }));
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
              disabled={busy || catalogQuery.isPending || !catalogQuery.isSuccess}
              size="sm"
              variant="outline"
              type="button"
              data-workflow-start=""
              onClick={() => {
                void submit({
                  type: "run.start",
                  projectId: props.projectId,
                  commandId: `start${Date.now().toString(36)}`,
                  runId: `run${Date.now().toString(36)}`,
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
          {activeRun.status === "active" &&
          stage?.type === "agent" &&
          attempt?.status === "pending" &&
          catalogQuery.isSuccess &&
          !catalogQuery.isPending ? (
            <WorkflowStagePreview
              key={JSON.stringify([
                props.environmentId,
                props.projectId,
                activeRun.id,
                stage.id,
                attempt.attempt,
                activeRun.updatedAt,
                catalogQuery.dataUpdatedAt,
                props.refreshTick,
              ])}
              environmentId={props.environmentId}
              projectId={props.projectId}
              runId={activeRun.id}
              stageId={stage.id}
              attempt={attempt.attempt}
            />
          ) : null}
          {attempt?.destinationThreadId ? (
            <div className="space-y-1 text-xs">
              <a
                href={`/${encodeURIComponent(props.environmentId)}/${encodeURIComponent(attempt.destinationThreadId)}`}
              >
                Open stage conversation and native Stop
              </a>
              <p>
                Dispatch acceptance is not completion. Workflow pause/cancel only changes the
                workflow ledger; use Stop in the conversation to interrupt native work.
              </p>
              {activeRun.status === "active" && attempt.status === "dispatched" ? (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy || catalogQuery.isPending || !catalogQuery.isSuccess}
                  onClick={() =>
                    void submitOperation(() =>
                      proposeArtifact({
                        environmentId: props.environmentId,
                        input: {
                          projectId: props.projectId,
                          runId: activeRun.id,
                          artifactId: `artifact_${activeRun.id}_${attempt.stageId}_${attempt.attempt}`,
                          commandId: `propose_${activeRun.id}_${attempt.stageId}_${attempt.attempt}`,
                        },
                      }),
                    )
                  }
                >
                  Inspect settled output
                </Button>
              ) : null}
            </div>
          ) : null}
          {activeRun.artifacts.map((artifact) => (
            <ArtifactReview key={artifact.id} artifact={artifact} />
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={busy || catalogQuery.isPending || !catalogQuery.isSuccess}
              onClick={() =>
                void submit({
                  type: activeRun.status === "paused" ? "run.resume" : "run.pause",
                  projectId: props.projectId,
                  commandId: `workflow_${randomUUID().replaceAll("-", "")}`,
                  runId: activeRun.id,
                })
              }
            >
              {activeRun.status === "paused" ? "Resume workflow ledger" : "Pause workflow ledger"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={busy || catalogQuery.isPending || !catalogQuery.isSuccess}
              onClick={() =>
                void submit({
                  type: "run.cancel",
                  projectId: props.projectId,
                  commandId: `cancel${activeRun.id}`,
                  runId: activeRun.id,
                })
              }
            >
              Cancel workflow ledger
            </Button>
          </div>
          <WorkflowDecisionHistory decisions={activeRun.decisions} />
          {attempt?.revisionDecisionId ? (
            <p>
              Current revision attempt is bound to decision {attempt.revisionDecisionId}. Review its
              saved feedback before explicit Start.
            </p>
          ) : null}
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
              {catalog?.revisionFeedbackVersion !== 1 ? (
                <p>Revision feedback is unavailable on this server.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="button"
                  data-workflow-approve=""
                  disabled={
                    busy ||
                    catalogQuery.isPending ||
                    !catalogQuery.isSuccess ||
                    (decision.stage.type === "agent" &&
                      activeRun.artifacts.find((entry) => entry.id === decision.artifactId)
                        ?.sourceOutcome !== "completed")
                  }
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
                  disabled={busy || catalogQuery.isPending || !catalogQuery.isSuccess}
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
                <WorkflowRevisionFeedbackForm
                  environmentId={props.environmentId}
                  projectId={props.projectId}
                  run={activeRun}
                  stage={decision.stage}
                  attempt={decision.attempt.attempt}
                  source={revisionSource}
                  fresh={
                    catalog?.revisionFeedbackVersion === 1 &&
                    !busy &&
                    !catalogQuery.isPending &&
                    catalogQuery.isSuccess &&
                    catalogQuery.error === null
                  }
                  exhausted={revisionExhausted}
                  submit={submit}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  data-workflow-cancel=""
                  disabled={busy || catalogQuery.isPending || !catalogQuery.isSuccess}
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
      {catalog?.runs
        .filter((run) => run !== activeRun)
        .map((run) => (
          <details key={run.id}>
            <summary>
              Workflow {run.id} · {run.status}
            </summary>
            <p className="text-xs">
              {run.attempts.length} attempts · {run.decisions.length} decisions
            </p>
            {run.attempts
              .filter((entry) => entry.destinationThreadId !== null)
              .map((entry) => (
                <p key={`${entry.stageId}:${entry.attempt}`} className="text-xs">
                  <a
                    href={`/${encodeURIComponent(props.environmentId)}/${encodeURIComponent(entry.destinationThreadId!)}`}
                  >
                    Open {entry.stageId} attempt {entry.attempt} conversation and native Stop
                  </a>
                </p>
              ))}
            <WorkflowDecisionHistory decisions={run.decisions} />
            {run.artifacts.map((artifact) => (
              <ArtifactReview key={artifact.id} artifact={artifact} />
            ))}
          </details>
        ))}
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
                  <li
                    key={`${route.threadId}:${route.messageId}`}
                    data-governance-route={`${route.threadId}:${route.messageId}`}
                    data-route-mode={route.mode}
                    data-route-source={route.source ?? ""}
                    data-route-fallback={route.fallbackIndex ?? ""}
                  >
                    {route.mode} · {route.model ?? "unselected"} ·{" "}
                    {route.instanceId ?? "no instance"}
                    {route.source !== null ? ` · ${route.source}` : ""}
                    {route.fallbackIndex !== null ? ` · fallback ${route.fallbackIndex}` : ""}
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
                  <li
                    key={approval.approvalId}
                    data-approval-id={approval.approvalId}
                    data-approval-status={approval.status}
                  >
                    {approval.status}
                    {approval.consumedAt !== null ? " · consumed" : ""}
                  </li>
                ))}
              </ul>
            )}
          </article>
          {snapshot.taskContract === undefined ? null : (
            <TaskContractReadout
              goal={snapshot.taskContract.goal}
              redirect={snapshot.taskContract.redirect}
              acceptance={snapshot.taskContract.acceptance}
              maxProviderStarts={snapshot.taskContract.maxProviderStarts}
              stopConditions={snapshot.taskContract.stopConditions}
              revision={snapshot.taskContract.revision}
              phase={snapshot.taskContract.phase}
              acceptedRevision={snapshot.taskContract.acceptedRevision}
            />
          )}
          <article className="rounded-md border border-border/60 p-3" data-governance-memory="">
            <h3 className="text-xs font-medium">Memory</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {snapshot.deletedSourceCount} deleted sources stay deleted.
            </p>
            {snapshot.memories.length === 0 ? null : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.memories.map((memory) => (
                  <li
                    key={memory.memoryId}
                    data-memory-id={memory.memoryId}
                    data-memory-status={memory.status}
                  >
                    {memory.status} · {memory.scopeKind}
                    {memory.contentPresent ? "" : " · content absent"}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      )}
      <ActionGateAndMemoryControls
        environmentId={props.environmentId}
        snapshot={snapshot}
        onRefresh={props.onRefresh}
      />
      <WorkflowDecisions environmentId={props.environmentId} refreshTick={props.refreshTick} />
    </section>
  );
}

function ActionGateAndMemoryControls(props: {
  readonly environmentId: EnvironmentId | null;
  readonly snapshot: GovernanceSnapshot | null;
  readonly onRefresh: () => void;
}) {
  const environmentId = props.environmentId;
  const authorizeTool = useAtomCommand(governanceEnvironment.authorizeTool, {
    reportFailure: false,
  });
  const respondApproval = useAtomCommand(governanceEnvironment.respondApproval, {
    reportFailure: false,
  });
  const saveMemory = useAtomCommand(governanceEnvironment.saveMemory, { reportFailure: false });
  const deleteMemory = useAtomCommand(governanceEnvironment.deleteMemory, { reportFailure: false });
  const enqueueEligible = useAtomCommand(governanceEnvironment.enqueueEligible, {
    reportFailure: false,
  });
  const updateSettings = useUpdateEnvironmentSettings(
    environmentId ?? ("unbound" as EnvironmentId),
  );
  const [error, setError] = useState<string | null>(null);
  if (environmentId === null) return null;
  const threadId = (props.snapshot?.routes[0]?.threadId ??
    props.snapshot?.leases[0]?.threadId ??
    "governance-ask") as ThreadId;
  const pending = props.snapshot?.approvals.find((approval) => approval.status === "pending");
  const decided = props.snapshot?.approvals.find((approval) => approval.status !== "pending");
  const activeMemory = props.snapshot?.memories.find((memory) => memory.status !== "deleted");
  const submit = async (run: () => Promise<{ _tag: string }>) => {
    setError(null);
    const result = await run();
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result as never);
      setError(cause instanceof Error ? cause.message : "Governance mutation failed.");
    }
    props.onRefresh();
  };
  return (
    <div className="space-y-3">
      <article className="rounded-md border border-border/60 p-3" data-action-gate-surface="">
        <h3 className="text-xs font-medium">ActionGate</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          ASK is a one-time exact-action approval. Grant executes once. Deny, cancel, and expiry
          execute zero times.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            className="h-7 min-w-48 rounded-md border border-border/60 bg-transparent px-2 text-xs"
            data-action-gate-url=""
            defaultValue="https://example.invalid/ask"
            aria-label="ASK tool URL"
          />
          <Button
            size="sm"
            type="button"
            data-action-gate-authorize=""
            onClick={() => {
              const urlInput = document.querySelector<HTMLInputElement>("[data-action-gate-url]");
              const url = urlInput?.value.trim() || "https://example.invalid/ask";
              void submit(() =>
                authorizeTool({
                  environmentId,
                  input: {
                    toolName: "preview_open",
                    args: { url },
                    threadId,
                  },
                }),
              );
            }}
          >
            Request ASK
          </Button>
          <Button
            size="sm"
            type="button"
            data-action-gate-grant=""
            disabled={pending === undefined}
            onClick={() => {
              if (pending === undefined) return;
              void submit(() =>
                respondApproval({
                  environmentId,
                  input: { approvalId: pending.approvalId as ActionApprovalId, decision: "grant" },
                }),
              );
            }}
          >
            Grant
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            data-action-gate-deny=""
            disabled={pending === undefined}
            onClick={() => {
              if (pending === undefined) return;
              void submit(() =>
                respondApproval({
                  environmentId,
                  input: { approvalId: pending.approvalId as ActionApprovalId, decision: "deny" },
                }),
              );
            }}
          >
            Deny
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            data-action-gate-cancel=""
            disabled={pending === undefined}
            onClick={() => {
              if (pending === undefined) return;
              void submit(() =>
                respondApproval({
                  environmentId,
                  input: { approvalId: pending.approvalId as ActionApprovalId, decision: "cancel" },
                }),
              );
            }}
          >
            Cancel
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-action-gate-state="">
          {pending !== undefined
            ? `Pending ${pending.approvalId}`
            : decided !== undefined
              ? `${decided.status} ${decided.approvalId}`
              : "No ActionGate approval."}
        </p>
      </article>
      <article className="rounded-md border border-border/60 p-3" data-memory-surface="">
        <h3 className="text-xs font-medium">Dream Memory</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Memory is data, never authority. Capture off creates no new memory from eligible activity.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            type="button"
            data-memory-save=""
            onClick={() => {
              void submit(() =>
                saveMemory({
                  environmentId,
                  input: {
                    content: "browser-memory-preference",
                    kind: "explicit-user-preference",
                    scopeKind: "personal",
                  },
                }),
              );
            }}
          >
            Save memory
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            data-memory-enqueue=""
            onClick={() => {
              void submit(() =>
                enqueueEligible({
                  environmentId,
                  input: {
                    turnText: "Prefer using the production browser harness for governance proofs.",
                    threadId,
                  },
                }),
              );
            }}
          >
            Enqueue eligible
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            data-memory-capture-off=""
            onClick={() => {
              updateSettings({ dreamMemory: { captureMode: "off" } });
              props.onRefresh();
            }}
          >
            Disable capture
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            data-memory-delete=""
            disabled={activeMemory === undefined}
            onClick={() => {
              if (activeMemory === undefined) return;
              void submit(() =>
                deleteMemory({
                  environmentId,
                  input: { memoryId: activeMemory.memoryId as MemoryId },
                }),
              );
            }}
          >
            Delete memory
          </Button>
        </div>
      </article>
      <article className="rounded-md border border-border/60 p-3" data-provider-disclosure="">
        <h3 className="text-xs font-medium">Provider capabilities</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          OpenRouter (text) has an executable driver when its provider is configured and ready.
          Guidance, Teacher, and Shadow are separate routing features. Cursor Cloud REST execution
          is unavailable for authenticated product sessions and is not a second engine.
        </p>
      </article>
      {error !== null ? (
        <p className="text-xs text-destructive" data-governance-mutation-error="">
          {error}
        </p>
      ) : null}
    </div>
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
