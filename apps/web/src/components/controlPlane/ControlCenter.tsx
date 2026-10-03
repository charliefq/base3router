import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type {
  ControlCenterModel,
  ControlCenterRouterActions,
  ControlCenterTaskItem,
} from "~/controlPlane/presentControlCenter";
import { Button } from "../ui/button";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OperationalStatusCard, statusTone } from "./OperationalStatusCard";

export function ControlCenter(props: {
  readonly model: ControlCenterModel;
  readonly section?: "overview" | "workflows" | "agents";
  readonly actions?: ControlCenterRouterActions;
}) {
  const section = props.section ?? "overview";
  return (
    <div className="flex h-full min-h-0 flex-col" data-control-plane="control-center">
      <WorkspacePageHeader>
        <div>
          <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Base3Router
          </p>
          <h1 className="text-base font-medium">
            {section === "workflows"
              ? "Workflows"
              : section === "agents"
                ? "Agents / runs"
                : "Control Center"}
          </h1>
        </div>
      </WorkspacePageHeader>
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) pb-8"
        data-workspace-scroll-surface="control-center"
      >
        <div
          className="mx-auto flex w-full max-w-5xl flex-col gap-4 pt-2"
          data-control-center-environment={props.model.selectedEnvironmentId ?? ""}
          data-control-center-surface={props.model.surface}
        >
          <OperationalStatusCard
            title="Environment"
            tone={statusTone(
              props.model.surface === "ready"
                ? "ready"
                : props.model.surface === "loading"
                  ? "loading"
                  : props.model.surface === "offline"
                    ? "offline"
                    : "unavailable",
            )}
            value={
              props.model.surface === "ready"
                ? "Ready"
                : props.model.surface === "loading"
                  ? "Loading"
                  : props.model.surface === "offline"
                    ? "Offline"
                    : "Unpaired"
            }
            detail={
              props.model.environmentLabel ??
              (props.model.selectedEnvironmentId
                ? props.model.selectedEnvironmentId
                : "No environment selected")
            }
          >
            <p className="mt-1 text-2xs text-muted-foreground">
              {props.model.projects.length} projects · {props.model.recentTasks.length} recent tasks
            </p>
          </OperationalStatusCard>
          {props.model.surface === "unpaired" ? (
            <OperationalStatusCard
              title="Offline"
              detail="Pair an environment to see its projects, tasks, and capabilities."
            />
          ) : null}
          {props.model.surface === "offline" ? (
            <OperationalStatusCard
              title="Offline"
              tone="warning"
              detail="The selected environment is offline. Reconnect to restore its projected state."
            />
          ) : null}
          {props.model.surface === "loading" ? (
            <OperationalStatusCard
              title="Loading"
              detail="Waiting for the paired environment snapshot."
            />
          ) : null}
          {props.model.surface === "ready" ? (
            <OperationalStatusCard
              title="Capabilities"
              tone={props.model.capabilityOff ? "warning" : "success"}
              value={props.model.capabilityOff ? "Off" : "On"}
              detail={
                props.model.capabilityOff
                  ? "This environment does not advertise dispatcher, workflow, or Cursor Cloud capabilities. Existing projects and tasks remain usable."
                  : `Dispatcher ${props.model.capabilities.dispatcher ? "on" : "off"} · Workflow ${props.model.capabilities.workflow ? "on" : "off"} · Cursor Cloud ${props.model.capabilities.cursorCloud ? "on" : "off"}`
              }
            />
          ) : null}
          {props.model.routerInsights ? (
            <OperationalStatusCard
              title="Router Insights"
              value={props.model.routerInsights.activePolicy}
              detail={
                props.model.routerInsights.insufficientData
                  ? "Insufficient local observations. Metrics are not shown as reliable."
                  : `${props.model.routerInsights.observationCount} observations`
              }
              tone={props.model.routerInsights.insufficientData ? "warning" : "neutral"}
            >
              <RouterInsightsBody
                model={props.model}
                {...(props.actions !== undefined ? { actions: props.actions } : {})}
              />
            </OperationalStatusCard>
          ) : null}
          {props.model.empty ? (
            <OperationalStatusCard
              title="Empty"
              detail="Create a project to start routing work across local providers and Cursor Cloud."
            />
          ) : null}
          {section === "overview" || section === "workflows" ? (
            <Section title="Projects" empty="No projects are connected.">
              {props.model.projects.map((project) => (
                <div
                  key={`${project.environmentId}:${project.id}`}
                  data-control-center-project={project.id}
                >
                  <OperationalStatusCard
                    title="Project"
                    value={`${project.taskCount} tasks`}
                    detail={project.title}
                  />
                </div>
              ))}
            </Section>
          ) : null}
          {section === "overview" ? (
            <Section title="Recent tasks" empty="No tasks yet.">
              {props.model.recentTasks.map((task) => (
                <TaskCard key={`${task.environmentId}:${task.id}`} task={task} />
              ))}
            </Section>
          ) : null}
          {section === "overview" || section === "agents" ? (
            <Section title="Active runs" empty="No active runs.">
              {props.model.activeRuns.map((task) => (
                <TaskCard key={`${task.environmentId}:${task.id}`} task={task} />
              ))}
            </Section>
          ) : null}
          <Section title="Approvals" empty="Nothing waiting for approval.">
            {props.model.approvals.map((task) => (
              <TaskCard key={`${task.environmentId}:${task.id}`} task={task} />
            ))}
          </Section>
          {section === "overview" || section === "agents" ? (
            <Section title="Failed or cancelled" empty="No failed or cancelled runs.">
              {props.model.failedOrCancelled.map((task) => (
                <TaskCard key={`${task.environmentId}:${task.id}`} task={task} />
              ))}
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RouterInsightsBody(props: {
  readonly model: ControlCenterModel;
  readonly actions?: ControlCenterRouterActions;
}) {
  const insights = props.model.routerInsights;
  if (!insights) return null;
  const canOperate = insights.canOperate === true;
  const actions = props.actions;
  return (
    <div className="mt-1 space-y-1 text-2xs text-muted-foreground" data-router-insights="">
      <p data-router-insights-count="">Observations {insights.observationCount}</p>
      {insights.coverage ? (
        <p data-router-insights-coverage="">Coverage {insights.coverage}</p>
      ) : null}
      {insights.freshness ? (
        <p data-router-insights-freshness="">Freshness {insights.freshness}</p>
      ) : null}
      {insights.candidatePolicy ? (
        <p data-router-insights-candidate="">
          {insights.candidatePolicyState === "shadow" ? "Shadow" : "Candidate"}{" "}
          {insights.candidatePolicy}
        </p>
      ) : null}
      <p>Explicit feedback {insights.explicitFeedback}</p>
      <p>Rework proxies {insights.reworkProxies}</p>
      {insights.verification ? (
        <p data-router-insights-verification="">Verification {insights.verification}</p>
      ) : null}
      {insights.latency ? <p data-router-insights-latency="">Latency {insights.latency}</p> : null}
      {insights.reportedCost ? (
        <p data-reported-cost="">Reported cost {insights.reportedCost}</p>
      ) : null}
      {insights.estimatedCost ? (
        <p data-estimated-cost="">Estimated cost {insights.estimatedCost}</p>
      ) : null}
      {insights.challengerAgreement ? (
        <p data-challenger-agreement="">Challenger agreement {insights.challengerAgreement}</p>
      ) : null}
      {insights.mixedProvenance ? (
        <p data-mixed-provenance="">Reported and estimated cost are labeled separately.</p>
      ) : null}
      {insights.confirmation === "activate" ? (
        <p data-policy-activate-confirm="">
          Activate candidate? This does not happen automatically.
        </p>
      ) : null}
      {insights.confirmation === "shadow" ? (
        <p data-policy-shadow-confirm="">
          Move the candidate into Policy Shadow? Execution stays on the active policy.
        </p>
      ) : null}
      {insights.confirmation === "rollback" ? (
        <p data-policy-rollback-confirm="">Rollback restores the previous policy immediately.</p>
      ) : null}
      {insights.confirmation === "delete" ? (
        <p data-observations-delete-confirm="">
          Delete observations for this environment? Confirmation required.
        </p>
      ) : null}
      {actions?.onExport ? (
        <div className="flex flex-wrap gap-1 pt-1">
          <Button size="xs" variant="outline" data-router-export="" onClick={actions.onExport}>
            Export
          </Button>
        </div>
      ) : null}
      {canOperate && actions?.onFeedback && insights.latestObservationId ? (
        <div className="flex flex-wrap gap-1 pt-1" data-router-feedback="">
          <Button size="xs" variant="outline" onClick={() => actions.onFeedback?.("helpful")}>
            Helpful
          </Button>
          <Button size="xs" variant="outline" onClick={() => actions.onFeedback?.("not_helpful")}>
            Not helpful
          </Button>
          <Button size="xs" variant="outline" onClick={() => actions.onFeedback?.("too_slow")}>
            Too slow
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => actions.onFeedback?.("wrong_model_choice")}
          >
            Wrong model
          </Button>
        </div>
      ) : null}
      {canOperate && actions?.onRequestConfirm ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {insights.candidatePolicyId && insights.candidatePolicyState === "candidate" ? (
            <Button
              size="xs"
              variant="outline"
              data-policy-shadow=""
              onClick={() => actions.onRequestConfirm?.("shadow")}
            >
              Shadow
            </Button>
          ) : null}
          {insights.candidatePolicyId && insights.candidatePolicyState === "shadow" ? (
            <Button
              size="xs"
              variant="outline"
              data-policy-activate=""
              onClick={() => actions.onRequestConfirm?.("activate")}
            >
              Activate
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            data-policy-rollback=""
            onClick={() => actions.onRequestConfirm?.("rollback")}
          >
            Rollback
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            data-observations-delete=""
            onClick={() => actions.onRequestConfirm?.("delete")}
          >
            Delete
          </Button>
        </div>
      ) : null}
      {canOperate && insights.confirmation && actions ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {insights.confirmation === "activate" ? (
            <Button size="xs" variant="default" onClick={actions.onConfirmActivate}>
              Confirm activate
            </Button>
          ) : null}
          {insights.confirmation === "shadow" ? (
            <Button size="xs" variant="default" onClick={actions.onConfirmShadow}>
              Confirm shadow
            </Button>
          ) : null}
          {insights.confirmation === "rollback" ? (
            <Button size="xs" variant="default" onClick={actions.onConfirmRollback}>
              Confirm rollback
            </Button>
          ) : null}
          {insights.confirmation === "delete" ? (
            <Button size="xs" variant="destructive" onClick={actions.onConfirmDelete}>
              Confirm delete
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={actions.onCancelConfirm}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Section(props: {
  readonly title: string;
  readonly empty: string;
  readonly children: ReactNode;
}) {
  const items = Array.isArray(props.children) ? props.children : [props.children];
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground">{props.title}</h2>
      {items.filter(Boolean).length === 0 ? (
        <p className="text-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">{props.children}</div>
      )}
    </section>
  );
}

function TaskCard(props: { readonly task: ControlCenterTaskItem }) {
  return (
    <Link
      data-control-center-thread={props.task.id}
      params={{ environmentId: props.task.environmentId, threadId: props.task.id }}
      to="/$environmentId/$threadId"
    >
      <OperationalStatusCard
        detail={props.task.title}
        title={props.task.projectTitle}
        tone={statusTone(props.task.status)}
        value={props.task.status}
      >
        <p className="mt-1 text-2xs text-muted-foreground">
          {props.task.routeLabel ?? "No bound route"} · {props.task.runnerKind}
        </p>
        <p className="text-2xs text-muted-foreground">Open to inspect this task.</p>
      </OperationalStatusCard>
    </Link>
  );
}
