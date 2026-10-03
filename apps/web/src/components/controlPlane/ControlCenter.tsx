import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type {
  ControlCenterModel,
  ControlCenterTaskItem,
} from "~/controlPlane/presentControlCenter";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OperationalStatusCard, statusTone } from "./OperationalStatusCard";

export function ControlCenter(props: {
  readonly model: ControlCenterModel;
  readonly section?: "overview" | "workflows" | "agents";
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
              <div
                className="mt-1 space-y-1 text-2xs text-muted-foreground"
                data-router-insights=""
              >
                <p data-router-insights-count="">
                  Observations {props.model.routerInsights.observationCount}
                </p>
                {props.model.routerInsights.candidatePolicy ? (
                  <p data-router-insights-candidate="">
                    Candidate {props.model.routerInsights.candidatePolicy}
                  </p>
                ) : null}
                <p>Explicit feedback {props.model.routerInsights.explicitFeedback}</p>
                <p>Rework proxies {props.model.routerInsights.reworkProxies}</p>
                {props.model.routerInsights.mixedProvenance ? (
                  <p data-mixed-provenance="">
                    Reported and estimated cost are labeled separately.
                  </p>
                ) : null}
                {props.model.routerInsights.confirmation === "activate" ? (
                  <p data-policy-activate-confirm="">
                    Activate candidate? This does not happen automatically.
                  </p>
                ) : null}
                {props.model.routerInsights.confirmation === "rollback" ? (
                  <p data-policy-rollback-confirm="">
                    Rollback restores the previous policy immediately.
                  </p>
                ) : null}
                {props.model.routerInsights.confirmation === "delete" ? (
                  <p data-observations-delete-confirm="">
                    Delete observations for this environment? Confirmation required.
                  </p>
                ) : null}
              </div>
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
