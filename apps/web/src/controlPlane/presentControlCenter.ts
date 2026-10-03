import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId, ThreadId, WorkflowCatalog } from "@t3tools/contracts";

import type { ControlCenterSurface } from "./controlCenterProjection";
import { sanitizeDisplayText } from "./sanitizeDisplayText";

export type ControlCenterItemStatus =
  | "active"
  | "idle"
  | "approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "unavailable";

export type ControlCenterTaskItem = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly projectTitle: string;
  readonly status: ControlCenterItemStatus;
  readonly routeLabel: string | null;
  readonly runnerKind: "local" | "cursor-cloud" | "unknown";
};

export type ControlCenterProjectItem = {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly taskCount: number;
};

export type ControlCenterCapabilities = {
  readonly dispatcher: boolean;
  readonly workflow: boolean;
  readonly cursorCloud: boolean;
};

export type ControlCenterModel = {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly surface: ControlCenterSurface;
  readonly capabilities: ControlCenterCapabilities;
  readonly projects: ReadonlyArray<ControlCenterProjectItem>;
  readonly recentTasks: ReadonlyArray<ControlCenterTaskItem>;
  readonly activeRuns: ReadonlyArray<ControlCenterTaskItem>;
  readonly approvals: ReadonlyArray<ControlCenterTaskItem>;
  readonly failedOrCancelled: ReadonlyArray<ControlCenterTaskItem>;
  readonly empty: boolean;
  readonly capabilityOff: boolean;
  readonly environmentLabel: string | null;
  readonly routerInsights?: {
    readonly observationCount: number;
    readonly activePolicy: string;
    readonly candidatePolicy: string | null;
    readonly insufficientData: boolean;
    readonly mixedProvenance: boolean;
    readonly explicitFeedback: string;
    readonly reworkProxies: string;
    readonly confirmation?: "activate" | "rollback" | "delete" | null;
  } | null;
};

export type ControlCenterInput = {
  readonly selectedEnvironmentId?: EnvironmentId | null;
  readonly surface?: ControlCenterSurface;
  readonly capabilities: ControlCenterCapabilities;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly catalogs?: ReadonlyArray<WorkflowCatalog>;
  readonly environmentLabel?: string | null;
  readonly routerInsights?: ControlCenterModel["routerInsights"];
};

export type ControlCenterInspectorTarget = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
};

function threadStatus(thread: EnvironmentThreadShell): ControlCenterItemStatus {
  if (thread.hasPendingApprovals) return "approval";
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "running" || sessionStatus === "starting") return "active";
  if (sessionStatus === "error") return "failed";
  if (sessionStatus === "interrupted" || sessionStatus === "stopped") return "cancelled";
  if (thread.settledAt !== null || thread.archivedAt !== null) return "completed";
  return "idle";
}

function routeLabel(thread: EnvironmentThreadShell): string | null {
  const binding = thread.latestRoute?.binding;
  if (!binding) return null;
  return `${binding.target.instanceId} · ${binding.target.model}`;
}

function runnerKindForThread(
  thread: EnvironmentThreadShell,
  catalogs: ReadonlyArray<WorkflowCatalog> | undefined,
): ControlCenterTaskItem["runnerKind"] {
  const run = catalogs
    ?.flatMap((catalog) => catalog.runs)
    .find(
      (entry) =>
        entry.originatingThreadId === thread.id ||
        entry.attempts.some((attempt) => attempt.destinationThreadId === thread.id),
    );
  const attempt = run?.attempts.findLast(
    (entry) => entry.destinationThreadId === thread.id || entry.sourceThreadId === thread.id,
  );
  if (attempt?.runnerBinding?.runnerKind === "cursor-cloud") return "cursor-cloud";
  if (thread.latestRoute) return "local";
  return "unknown";
}

function toTaskItem(
  thread: EnvironmentThreadShell,
  projects: ReadonlyArray<EnvironmentProject>,
  catalogs: ReadonlyArray<WorkflowCatalog> | undefined,
): ControlCenterTaskItem {
  const project = projects.find(
    (entry) => entry.id === thread.projectId && entry.environmentId === thread.environmentId,
  );
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    title: sanitizeDisplayText(thread.title) ?? thread.title,
    projectTitle: sanitizeDisplayText(project?.title) ?? "Unassigned project",
    status: threadStatus(thread),
    routeLabel: sanitizeDisplayText(routeLabel(thread)),
    runnerKind: runnerKindForThread(thread, catalogs),
  };
}

export function presentControlCenter(input: ControlCenterInput): ControlCenterModel {
  const surface = input.surface ?? "ready";
  const selectedEnvironmentId = input.selectedEnvironmentId ?? null;
  const tasks = input.threads
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => toTaskItem(thread, input.projects, input.catalogs));

  const projects = input.projects
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((project) => ({
      id: project.id,
      environmentId: project.environmentId,
      title: sanitizeDisplayText(project.title) ?? project.title,
      taskCount: input.threads.filter(
        (thread) =>
          thread.projectId === project.id && thread.environmentId === project.environmentId,
      ).length,
    }));

  const ready = surface === "ready";
  const capabilityOff =
    ready &&
    !input.capabilities.dispatcher &&
    !input.capabilities.workflow &&
    !input.capabilities.cursorCloud;

  return {
    selectedEnvironmentId,
    surface,
    capabilities: input.capabilities,
    projects,
    recentTasks: tasks.slice(0, 12),
    activeRuns: tasks.filter((task) => task.status === "active"),
    approvals: tasks.filter((task) => task.status === "approval"),
    failedOrCancelled: tasks.filter(
      (task) => task.status === "failed" || task.status === "cancelled",
    ),
    empty: ready && projects.length === 0 && tasks.length === 0,
    capabilityOff,
    environmentLabel: sanitizeDisplayText(input.environmentLabel ?? null),
    ...(input.routerInsights !== undefined ? { routerInsights: input.routerInsights } : {}),
  };
}

export function selectControlCenterInspectorTarget(
  model: ControlCenterModel,
): ControlCenterInspectorTarget {
  if (model.surface !== "ready" || model.selectedEnvironmentId === null) {
    return { environmentId: null, projectId: null, threadId: null };
  }
  const task = model.recentTasks[0] ?? null;
  const project =
    task === null
      ? (model.projects[0] ?? null)
      : (model.projects.find(
          (entry) => entry.id === task.projectId && entry.environmentId === task.environmentId,
        ) ??
        model.projects[0] ??
        null);
  return {
    environmentId: model.selectedEnvironmentId,
    projectId: task?.projectId ?? project?.id ?? null,
    threadId: task?.id ?? null,
  };
}
