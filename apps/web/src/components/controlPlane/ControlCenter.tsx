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
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--workspace-gutter-start)] pr-[var(--workspace-gutter-end)] pb-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 pt-2">
          {props.model.capabilityOff ? (
            <OperationalStatusCard
              title="Capabilities"
              tone="warning"
              value="Off"
              detail="This environment does not advertise dispatcher, workflow, or Cursor Cloud capabilities. Existing projects and tasks remain usable."
            />
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
                <OperationalStatusCard
                  key={`${project.environmentId}:${project.id}`}
                  title="Project"
                  value={`${project.taskCount} tasks`}
                  detail={project.title}
                />
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
      </OperationalStatusCard>
    </Link>
  );
}
