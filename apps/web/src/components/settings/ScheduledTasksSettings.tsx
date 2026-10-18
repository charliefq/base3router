import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  Clock3Icon,
  MoreHorizontalIcon,
  MessageSquareIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import {
  CommandId,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "../../lib/utils";
import {
  readScheduledTaskCreationAttempt,
  retainScheduledTaskCreationAttempt,
  clearScheduledTaskCreationAttempt,
  matchesScheduledTaskCreation,
  type ScheduledTaskCreationAttempt,
} from "./scheduledTaskCreationAttempt";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  matchesScheduledTaskScope,
  scheduledTaskDefaultModel,
  scheduledTaskRunPresentation,
  taskToDraft,
  type DraftState,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "../ui/empty";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  useRelativeTimeTick,
} from "./settingsLayout";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
};

/** Labelled field: a caption sitting above its control. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for a run timestamp. `formatRelativeTime` only handles the
 * past, and `nextRunAt` is a future instant — render "in 5m" style labels
 * for upcoming runs instead of a misleading "just now".
 */
export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
    token: string;
  } | null>(null);
  const [creation, setCreation] = useState(readScheduledTaskCreationAttempt);
  const [recovering, setRecovering] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creationNotice, setCreationNotice] = useState<string | null>(null);
  const readTasks = useAtomCommand(serverEnvironment.readScheduledTasks, { reportFailure: false });
  const recoveryEnvironment = useEnvironment(creation.attempt?.environmentId ?? null);
  const mounted = useRef(false);
  const recoveryOwner = useRef<object | null>(null);
  const inFlight = useRef<ScheduledTaskCreationAttempt | null>(null);
  const editorOwner = useRef<string | null>(null);
  const currentRecoveryEnvironment = useRef(recoveryEnvironment);
  const recoveryPhase = recoveryEnvironment?.connection.phase;
  const previousRecoveryPhase = useRef(recoveryPhase);
  useLayoutEffect(() => {
    currentRecoveryEnvironment.current = recoveryEnvironment;
  }, [recoveryEnvironment]);
  useLayoutEffect(() => {
    if (previousRecoveryPhase.current !== recoveryPhase && recoveryOwner.current) {
      recoveryOwner.current = null;
      setRecovering(false);
    }
    previousRecoveryPhase.current = recoveryPhase;
  }, [recoveryPhase]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryOwner.current = null;
    };
  }, []);
  const closeEditor = (token: string) => {
    if (mounted.current && editorOwner.current === token) {
      editorOwner.current = null;
      setEditor(null);
    }
  };
  const beginCreation = (environmentId: EnvironmentId, input: ScheduledTaskUpsertInput) => {
    const retained = readScheduledTaskCreationAttempt();
    if (retained.error || retained.attempt)
      throw new Error(retained.error ?? "Recover the original scheduled task first.");
    const attempt = retainScheduledTaskCreationAttempt({
      environmentId,
      input: { ...input, commandId: CommandId.make(randomUUID()) },
    });
    inFlight.current = attempt;
    setCreating(true);
    setCreation({ attempt, error: null });
    setCreationNotice(null);
    return attempt;
  };
  const settleCreation = (attempt: ScheduledTaskCreationAttempt, saved?: ScheduledTask) => {
    if (inFlight.current === attempt) inFlight.current = null;
    if (!mounted.current) return false;
    setCreating(false);
    try {
      if (saved && matchesScheduledTaskCreation(attempt, saved)) {
        clearScheduledTaskCreationAttempt(attempt);
        setCreation({ attempt: null, error: null });
        return true;
      }
    } catch {
      /* Retain the original identity if recovery storage cannot be updated. */
    }
    setCreationNotice(
      "Scheduled task creation outcome is uncertain. Recover the original identity before creating another task. No retry will be sent.",
    );
    return false;
  };
  const recoverCreation = async () => {
    const saved = readScheduledTaskCreationAttempt();
    const attempt = saved.attempt;
    if (
      saved.error ||
      !attempt ||
      inFlight.current ||
      recoveryOwner.current ||
      currentRecoveryEnvironment.current?.connection.phase !== "connected" ||
      currentRecoveryEnvironment.current.environmentId !== attempt.environmentId
    )
      return;
    const owner = {};
    recoveryOwner.current = owner;
    setRecovering(true);
    try {
      const result = await readTasks({ environmentId: attempt.environmentId, input: {} });
      if (!mounted.current || recoveryOwner.current !== owner) return;
      if (result._tag === "Failure") {
        setCreationNotice(
          "Could not read the original environment. Creation outcome is uncertain; no retry was sent.",
        );
        return;
      }
      const task = result.value.tasks.find(
        (entry) => entry.id === `scheduled-task:${attempt.input.commandId}`,
      );
      if (!task || !matchesScheduledTaskCreation(attempt, task)) {
        setCreationNotice(
          task
            ? "The original scheduled task exists with later changes. It was not overwritten. Creation remains unresolved."
            : "The original scheduled task was not found. It may have been deleted or not committed. Creation remains unresolved; it will not be recreated.",
        );
        return;
      }
      clearScheduledTaskCreationAttempt(attempt);
      setCreation({ attempt: null, error: null });
      setCreationNotice("Scheduled task creation recovered. No schedule was changed.");
    } catch {
      if (mounted.current && recoveryOwner.current === owner)
        setCreationNotice("Creation outcome is uncertain. Recovery failed; no retry was sent.");
    } finally {
      if (mounted.current && recoveryOwner.current === owner) {
        recoveryOwner.current = null;
        setRecovering(false);
      }
    }
  };
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    const token = randomUUID();
    editorOwner.current = token;
    setEditor({ environmentId, task, token });
  }, []);
  const creationRecovery =
    creation.error || creation.attempt || creationNotice ? (
      <div role="status" className="space-y-2">
        <p>
          {creation.error ??
            (creating
              ? "Saving scheduled task…"
              : (creationNotice ??
                "Scheduled task creation outcome is uncertain. Recover the original identity before creating another task."))}
        </p>
        {creation.attempt ? (
          <>
            <p>
              {creation.attempt.input.title} · {creation.attempt.environmentId}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={
                recovering || creating || recoveryEnvironment?.connection.phase !== "connected"
              }
              onClick={() => void recoverCreation()}
            >
              Recover scheduled task
            </Button>
          </>
        ) : null}
      </div>
    ) : null;
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Scheduled tasks"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment || creation.attempt !== null || creation.error !== null}
            onClick={() => {
              const saved = readScheduledTaskCreationAttempt();
              if (!defaultEnvironment || saved.attempt || saved.error) return;
              const token = randomUUID();
              editorOwner.current = token;
              setEditor({ environmentId: defaultEnvironment.environmentId, task: null, token });
            }}
          >
            <PlusIcon className="size-3" />
            New task
          </Button>
        }
      >
        {editor ? null : creationRecovery}
        {scope.kind === "unavailable" ? (
          <SettingsSection title="Unavailable selection">
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to manage scheduled tasks.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={`${entry.environmentId}:${target.taskId ?? ""}`}
                environment={entry}
                showEnvironmentHeading={environments.length > 1}
                taskId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  entry.environmentId
                    ? target.taskId
                    : undefined
                }
                onEdit={openForEdit}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {editor ? (
        <ScheduledTaskEditorDialog
          key={editor.token}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          onClose={() => closeEditor(editor.token)}
          beginCreation={beginCreation}
          settleCreation={settleCreation}
          creationRecovery={creationRecovery}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  showEnvironmentHeading,
  taskId,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  useRelativeTimeTick(60_000);
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to view its scheduled tasks.`}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load scheduled tasks" description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title="Loading scheduled tasks…" role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title="Task unavailable"
              description="This task no longer exists or is outside the selected project scope."
              role="status"
            />
          ) : null}
          {tasks.length === 0 ? (
            <SettingsRow
              title="No scheduled tasks"
              description="No tasks match this environment and project selection."
            />
          ) : (
            tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const navigate = useNavigate();
  const occurrenceThreadId = task.lastOccurrence?.threadId;
  const openLatestRun = () => {
    if (!occurrenceThreadId) return;
    const threadRef = scopeThreadRef(environmentId, occurrenceThreadId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      state: { scheduledTaskInspection: threadRef },
    });
  };
  const runPresentation = scheduledTaskRunPresentation(task);
  const [busy, setBusy] = useState(false);
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update scheduled task",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {scheduleLabel(task.schedule)} ·{" "}
            {task.enabled
              ? task.nextRunAt
                ? `Next run ${relativeLabel(task.nextRunAt)}`
                : "Not scheduled"
              : "Paused"}
          </span>
          {runPresentation.label ? (
            <Badge variant={runPresentation.variant}>{runPresentation.label}</Badge>
          ) : null}
          {runPresentation.reason ? (
            <span className={runPresentation.variant === "error" ? "text-destructive" : undefined}>
              {runPresentation.reason}
            </span>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy}
            aria-label={`Enable ${task.title}`}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${task.title}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {occurrenceThreadId ? (
                <MenuItem onClick={openLatestRun}>
                  <MessageSquareIcon />
                  Open latest run conversation
                </MenuItem>
              ) : null}
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem onClick={() => void act("run")}>
                <PlayIcon />
                Run now
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  onClose,
  beginCreation,
  settleCreation,
  creationRecovery,
}: {
  readonly creationRecovery: ReactNode;
  readonly beginCreation: (
    environmentId: EnvironmentId,
    input: ScheduledTaskUpsertInput,
  ) => ScheduledTaskCreationAttempt;
  readonly settleCreation: (
    attempt: ScheduledTaskCreationAttempt,
    saved?: ScheduledTask,
  ) => boolean;
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onClose: () => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId, project.id),
      ),
    [allProjects, environmentId, scope],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" },
  );
  const [saving, setSaving] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const submissionPending = useRef(false);
  const editorActive = useRef(false);
  const currentDraft = useRef({ draft, environmentId });
  useLayoutEffect(() => {
    currentDraft.current = { draft, environmentId };
  }, [draft, environmentId]);
  useLayoutEffect(() => {
    editorActive.current = true;
    return () => {
      editorActive.current = false;
    };
  }, []);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const activeSelection = draft.modelKey
    ? splitModelKey(draft.modelKey)
    : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !editorActive.current ||
      currentDraft.current.draft !== draft ||
      currentDraft.current.environmentId !== environmentId ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure("Scheduled task is incomplete", "Add a title, prompt, project, and model.");
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    // Keep the original selection object (with provider options) when the
    // picker still points at the same instance+model.
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      projectId: selectedProjectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    let attempt: ScheduledTaskCreationAttempt | null = null;
    try {
      if (!draft.editingId) attempt = beginCreation(environmentId, input);
    } catch (error) {
      submissionPending.current = false;
      setSaving(false);
      reportFailure("Could not retain scheduled task identity", error);
      return;
    }
    let result;
    try {
      result = await upsertTask(attempt ?? { environmentId, input });
    } catch (error) {
      if (attempt) {
        settleCreation(attempt);
        setCreationUncertain(true);
      } else submissionPending.current = false;
      setSaving(false);
      reportFailure("Could not save scheduled task", error);
      return;
    }
    setSaving(false);
    if (attempt) {
      if (settleCreation(attempt, result._tag === "Success" ? result.value.task : undefined))
        onClose();
      else setCreationUncertain(true);
      return;
    }
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save scheduled task", squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Run a prompt automatically — on an interval or at a fixed time.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {creationRecovery}
          {creationRecovery ? (
            <p className="text-sm text-muted-foreground">
              Closing this dialog does not cancel creation. An unresolved task remains available for
              recovery.
            </p>
          ) : null}
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            <Field label="Runs on" htmlFor="scheduled-task-environment">
              <Select
                value={environmentId}
                disabled={task !== null || saving}
                onValueChange={(id) => {
                  if (submissionPending.current) return;
                  const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  setDraft((current) => ({
                    ...current,
                    projectId: "",
                    modelKey: "",
                    baseModelSelection: null,
                    baseRef: "main",
                    startFromOrigin: true,
                    existingWorktreePath: "",
                  }));
                }}
              >
                <SelectTrigger id="scheduled-task-environment" size="sm">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                        className="size-4"
                      />
                      {environment?.label ?? "Unavailable environment"}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                        className="size-4"
                      />
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {tasksQuery.error ? (
              <p className="text-sm text-destructive" role="status">
                {tasksQuery.error}
              </p>
            ) : null}
            {editingTaskMissing ? (
              <p className="text-xs text-destructive" role="status">
                This scheduled task no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" htmlFor="scheduled-task-project">
                <Select
                  value={selectedProjectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-project">
                    <SelectValue placeholder="Select a project">
                      {selectedProject?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              <Field label="Workspace" htmlFor="scheduled-task-workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-workspace">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the project checkout</SelectItem>
                    <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            {draft.workspaceMode === "worktree" ? (
              <Field label="Base branch" htmlFor="scheduled-task-base-ref">
                <WorktreeBaseBranchPicker
                  key={`${environmentId}:${selectedProjectId}`}
                  id="scheduled-task-base-ref"
                  environmentId={environmentId}
                  cwd={selectedProject?.workspaceRoot ?? null}
                  value={draft.baseRef}
                  onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                  startFromOrigin={draft.startFromOrigin}
                  onStartFromOriginChange={(startFromOrigin) =>
                    setDraft((current) => ({ ...current, startFromOrigin }))
                  }
                  disabled={saving || !connected}
                />
              </Field>
            ) : null}
            {draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                className="max-h-64 overflow-y-auto"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <Field label="Model">
              <ProviderModelPicker
                disabled={saving || !connected}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                }
              />
            </Field>

            <div className="space-y-3">
              {task?.schedule.type === "interval" &&
              task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
                <p className="text-sm text-muted-foreground" role="status">
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Label>Schedule</Label>
                <ToggleGroup
                  aria-label="Schedule type"
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0];
                    if (mode === "fixed" || mode === "interval")
                      setDraft((current) => ({ ...current, scheduleMode: mode }));
                  }}
                >
                  <Toggle value="fixed">At a time</Toggle>
                  <Toggle value="interval">Every interval</Toggle>
                </ToggleGroup>
              </div>

              {draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="scheduled-task-time">Run at</Label>
                    <Input
                      type="time"
                      id="scheduled-task-time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label="Days to run"
                    value={[...draft.weekdays].map(String)}
                    onValueChange={(values) => {
                      if (values.length === 0) return;
                      setDraft((current) => ({
                        ...current,
                        weekdays: new Set(values.map(Number)),
                      }));
                    }}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                        {WEEKDAY_SHORT[day]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-interval">Run every</Label>
                  <Input
                    type="number"
                    id="scheduled-task-interval"
                    nativeInput
                    min={1}
                    step="any"
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="scheduled-task-enabled">Enabled</Label>
                <p
                  id="scheduled-task-enabled-description"
                  className="text-sm text-muted-foreground"
                >
                  Disabled tasks stay saved but do not run.
                </p>
              </div>
              <Switch
                id="scheduled-task-enabled"
                aria-describedby="scheduled-task-enabled-description"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            {creationRecovery ? "Close" : "Cancel"}
          </DialogClose>
          <Button
            size="sm"
            disabled={
              saving || creationUncertain || editingTaskMissing || !connected || !tasksQuery.data
            }
            onClick={() => void submit()}
          >
            {draft.editingId ? "Save task" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
