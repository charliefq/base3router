import { useAtomValue } from "@effect/atom-react";
import {
  type CollaborationCommand,
  type CollaborationCommandResult,
  type CollaborationOpenThreadInput,
  type CollaborationSnapshot,
  type CollaborationTask,
  type CollaborationTaskRoutingReadout,
  type CollaborationTaskResultReadout,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { buildAgentDirectory, providerExecutable } from "./agentDirectory";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { isElectron } from "../../env";
import { runPrimaryHttp } from "../../lib/runtime";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useProjects } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { TaskContractReadout } from "../chat/TaskContractPanel";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const routingUnknownReason = (reason: string | null) => {
  switch (reason) {
    case "route_only":
      return "No correlated runtime run is recorded.";
    case "missing_attempt":
      return "No active run attempt is recorded.";
    case "missing_provider_turn":
      return "No matching provider turn is recorded.";
    case "provider_turn_pending":
      return "The matching provider turn is still pending.";
    case "provider_turn_not_started":
      return "The matching provider turn has no valid start evidence.";
    default:
      return "Persisted evidence is missing or inconsistent.";
  }
};

function TaskRoutingReadout({ readout }: { readout: CollaborationTaskRoutingReadout | undefined }) {
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border/50 p-3">
      <h3 className="text-sm font-medium">Routing evidence</h3>
      {readout?.status === "available" ? (
        <>
          <dl className="space-y-2 text-sm">
            <div>
              <dt>Mode</dt>
              <dd>
                {readout.mode === null
                  ? "Mode not recorded"
                  : readout.mode === "auto"
                    ? "Auto"
                    : "Manual"}
              </dd>
            </div>
            <div>
              <dt>Selected model</dt>
              <dd>
                {readout.selected
                  ? `${readout.selected.model} (${readout.selected.instanceId})`
                  : "Unknown — no valid route for this message"}
              </dd>
            </div>
            <div>
              <dt>Routing source</dt>
              <dd>{readout.source ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Routing reason</dt>
              <dd>
                {readout.explanation ??
                  (readout.reasons.length ? readout.reasons.join(", ") : "Not recorded")}
              </dd>
            </div>
            <div>
              <dt>Runtime model (configured)</dt>
              <dd>
                {readout.configuredModel
                  ? `${readout.configuredModel.model} (${readout.configuredModel.instanceId})`
                  : "Unknown"}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            The configured runtime model is not provider-attested.
          </p>
          <p className="text-sm">
            Execution evidence:{" "}
            {readout.execution.status === "observed" ? "Provider-turn start recorded" : "Unknown"}
          </p>
          {readout.execution.status === "observed" ? (
            <p className="break-all text-xs text-muted-foreground">
              Turn {readout.execution.providerTurnId}; status {readout.execution.providerStatus};
              started {readout.execution.startedAt}.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {routingUnknownReason(readout.execution.reason)}
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            Message {readout.messageId}; run {readout.runId ?? "not recorded"}.
          </p>
          <p className="text-xs text-muted-foreground">
            Terminal execution is not owner acceptance.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Routing evidence is unavailable; no valid persisted dispatch evidence can be confirmed.
        </p>
      )}
    </div>
  );
}

const resultUnknownReason = (reason: string) => {
  switch (reason) {
    case "run_turn_disagreement":
      return "The persisted run, attempt and turn states differ; completion is not confirmed.";
    case "provider_turn_not_started":
      return "A matching provider-turn start is not recorded.";
    case "no_completed_result":
      return "The matched run and turn do not have confirmed completion evidence.";
    case "result_not_complete_or_retry":
      return "The latest item is unfinished, streaming, empty or a retry record.";
    case "no_attributable_output":
      return "No matching assistant output or terminal-failure record is stored.";
    default:
      return "Matching persisted evidence is missing or inconsistent.";
  }
};

function TaskResultReadout({ readout }: { readout: CollaborationTaskResultReadout | undefined }) {
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border/50 p-3">
      <h3 className="text-sm font-medium">Result evidence</h3>
      {readout?.status === "available" ? (
        <>
          <p className="text-sm">Latest persisted run status: {readout.runStatus}</p>
          <p className="text-sm">
            Correlated provider-turn status: {readout.providerTurnStatus ?? "Unknown"}
          </p>
          {readout.content.status === "output" ? (
            <>
              <h4 className="text-sm font-medium">Latest persisted assistant output</h4>
              <pre className="whitespace-pre-wrap break-all text-sm">{readout.content.preview}</pre>
            </>
          ) : readout.content.status === "failure" ? (
            <>
              <h4 className="text-sm font-medium">Persisted terminal failure</h4>
              <p className="text-xs text-muted-foreground">
                Class: {readout.content.failure.class}; code:{" "}
                {readout.content.failure.code ?? "not recorded"}
              </p>
              <pre className="whitespace-pre-wrap break-all text-sm">
                {readout.content.failure.message}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No attributable completed output or terminal failure is confirmed.{" "}
              {resultUnknownReason(readout.content.reason)}
            </p>
          )}
          {readout.content.status !== "unknown" && readout.content.truncated ? (
            <p className="text-xs text-muted-foreground">
              Preview truncated; inspect the conversation for more context.
            </p>
          ) : null}
          <p className="break-all text-xs text-muted-foreground">
            Run {readout.runId}; message {readout.messageId}; attempt{" "}
            {readout.attemptId ?? "not confirmed"}; turn {readout.providerTurnId ?? "not confirmed"}
            {readout.content.status !== "unknown" ? `; item ${readout.content.itemId}` : ""}.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No validated persisted result evidence is available in this snapshot.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Persisted status and output do not establish a final answer or owner acceptance. Opening the
        conversation grants no execution.
      </p>
    </div>
  );
}

const loadSnapshot = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.snapshot({ headers: {} })),
    ),
  );

const sendCommand = (payload: CollaborationCommand) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.command({ headers: {}, payload })),
    ),
  );

const recoverThread = (payload: CollaborationOpenThreadInput) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.openThread({ headers: {}, payload })),
    ),
  );

function useCollaboration(environmentId: EnvironmentId | null) {
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId;
    snapshot: CollaborationSnapshot;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const currentEnvironment = useRef(environmentId);
  const readGeneration = useRef(0);
  useLayoutEffect(() => {
    readGeneration.current += 1;
    currentEnvironment.current = environmentId;
    return () => {
      readGeneration.current += 1;
      currentEnvironment.current = null;
    };
  }, [environmentId]);

  const read = useCallback(() => {
    if (!environmentId || currentEnvironment.current !== environmentId) return;
    const generation = ++readGeneration.current;
    const isCurrent = () =>
      generation === readGeneration.current && currentEnvironment.current === environmentId;
    return loadSnapshot()
      .then(
        (snapshot) => {
          if (isCurrent()) {
            setLoaded({ environmentId, snapshot });
            setError(null);
          }
        },
        (cause) => {
          if (isCurrent())
            setError(
              cause instanceof Error ? cause.message : "The agent directory could not be read.",
            );
        },
      )
      .finally(() => {
        if (isCurrent()) setRefreshing(false);
      });
  }, [environmentId]);

  useEffect(() => {
    void read();
  }, [read]);

  const execute = useCallback(
    async (request: () => Promise<CollaborationCommandResult>) => {
      setPending(true);
      try {
        const result = await request();
        if (environmentId && currentEnvironment.current === environmentId) {
          setLoaded({ environmentId, snapshot: result.snapshot });
          setError(result.outcome === "rejected" ? result.detail : null);
        }
        return result;
      } catch (cause) {
        if (currentEnvironment.current === environmentId)
          setError(cause instanceof Error ? cause.message : "The command was not recorded.");
        return null;
      } finally {
        setPending(false);
      }
    },
    [environmentId],
  );

  return {
    refresh: () => {
      if (!environmentId || currentEnvironment.current !== environmentId) return;
      setRefreshing(true);
      return read();
    },
    refreshing,
    snapshot: loaded?.environmentId === environmentId ? loaded.snapshot : null,
    error,
    pending,
    submit: (command: CollaborationCommand) => execute(() => sendCommand(command)),
    open: (input: CollaborationOpenThreadInput) => execute(() => recoverThread(input)),
  };
}

export function AgentsPage() {
  const navigate = useNavigate();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { snapshot, error, pending, open } = useCollaboration(environmentId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    environmentId: EnvironmentId;
    projectId: string;
    message: string;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const selectedProject =
    projects.length === 1 ? projects[0] : projects.find((project) => project.id === projectId);
  const selectedProjectId = selectedProject?.id;
  const context = useRef({ environmentId, projectId: selectedProjectId, mounted: true, providers });
  useLayoutEffect(() => {
    context.current = { environmentId, projectId: selectedProjectId, mounted: true, providers };
    return () => {
      context.current.mounted = false;
    };
  }, [context, environmentId, selectedProjectId, providers]);

  const openThread = (threadId: string) => {
    if (!environmentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const openAgent = async (agentId: string) => {
    // A ref closes the same-render double-click window before React updates disabled.
    if (
      openingRef.current ||
      !snapshot ||
      !environmentId ||
      !selectedProject ||
      !context.current.mounted ||
      context.current.environmentId !== environmentId ||
      context.current.projectId !== selectedProject.id
    )
      return;
    setNotice(null);
    const showNotice = (message: string) => {
      if (!context.current.mounted) return;
      setNotice({ environmentId, projectId: selectedProject.id, message });
    };
    const bound = snapshot.agents.find(
      (agent) => agent.id === agentId && agent.projectId === selectedProject.id,
    );
    if (agentId === "grokbot" || bound?.origin === "external") return;
    const provider = context.current.providers.find((item) => item.instanceId === agentId);
    if (!provider || !providerExecutable(provider)) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const linked = await open({ projectId: selectedProject.id, providerId: agentId });
      if (!linked || linked.outcome === "rejected") {
        showNotice(
          linked?.detail ??
            "The conversation could not be confirmed. Retry this project to recover it.",
        );
        return;
      }
      const threadId = linked.snapshot.agents.find(
        (agent) => agent.id === agentId && agent.projectId === selectedProject.id,
      )?.threadId;
      if (!threadId) {
        showNotice("The conversation has no valid thread link. Explicit repair is required.");
        return;
      }
      if (
        context.current.mounted &&
        context.current.environmentId === environmentId &&
        context.current.projectId === selectedProject.id &&
        context.current.providers.some(
          (item) => item.instanceId === agentId && providerExecutable(item),
        )
      )
        openThread(threadId);
    } catch {
      showNotice(
        "The conversation could not be confirmed. Retry in this project to recover the same request.",
      );
    } finally {
      openingRef.current = false;
      if (context.current.mounted) setOpening(false);
    }
  };

  const directory = buildAgentDirectory({
    environmentId,
    projectId: selectedProjectId ?? null,
    source: { environmentId, providers, snapshot },
  });
  const grokbot = snapshot?.agents.find((agent) => agent.id === "grokbot");
  const visibleNotice =
    notice?.environmentId === environmentId && notice.projectId === selectedProjectId
      ? notice.message
      : null;
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Agents</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1">
        <ScrollArea radius="none">
          <WorkspacePageContainer width="wide">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                Internal providers and external agents. Open a conversation in its project; opening
                a conversation does not start execution.
              </p>
              {projects.length > 1 ? (
                <div className="flex w-full flex-col gap-2 sm:w-64 sm:shrink-0">
                  <label htmlFor="agents-project" className="text-sm font-medium">
                    Project
                  </label>
                  <Select
                    disabled={opening}
                    value={projectId ?? ""}
                    items={[
                      { value: "", label: "Select a project" },
                      ...projects.map((project) => ({ value: project.id, label: project.title })),
                    ]}
                    onValueChange={(value) => setProjectId(value || null)}
                  >
                    <SelectTrigger id="agents-project">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">Select a project</SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : selectedProject ? (
                <div className="text-sm text-muted-foreground">
                  Project:{" "}
                  <span className="font-medium text-foreground">{selectedProject.title}</span>
                </div>
              ) : null}
            </div>
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {visibleNotice ? (
              <Alert variant="warning">
                <AlertDescription>{visibleNotice}</AlertDescription>
              </Alert>
            ) : null}
            {!environmentId ? (
              <Alert variant="info">
                <AlertDescription>No primary environment is connected.</AlertDescription>
              </Alert>
            ) : projects.length === 0 ? (
              <Alert variant="info">
                <AlertDescription>
                  No project is open on this environment. An agent thread needs a real project.
                </AlertDescription>
              </Alert>
            ) : !selectedProject ? (
              <Alert variant="info">
                <AlertDescription>
                  Select a project to open or recover its agent conversations.
                </AlertDescription>
              </Alert>
            ) : null}
            {environmentId && !snapshot && !error ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reading the agent directory.
              </p>
            ) : null}
            <ul aria-label="Agent directory" className="grid min-w-0 gap-4 md:grid-cols-2">
              {grokbot ? (
                <li className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-5 shadow-xs/5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h2 className="wrap-anywhere text-base font-medium">{grokbot.displayName}</h2>
                      <p className="text-xs text-muted-foreground">
                        {grokbot.origin} · {grokbot.role}
                      </p>
                    </div>
                    <Badge variant="secondary">NOT_CONNECTED</Badge>
                  </div>
                  <div className="mt-4 space-y-3 text-sm leading-relaxed">
                    <p className="text-muted-foreground">Availability: {grokbot.availability}</p>
                    <p className="wrap-anywhere text-muted-foreground">
                      Capabilities:{" "}
                      {grokbot.capabilities.join(", ") || "No advertised capabilities."}
                    </p>
                    <p>Grokbot is NOT_CONNECTED. No chat was opened.</p>
                    {snapshot?.grokbotIntegration.length ? (
                      <details className="text-muted-foreground">
                        <summary className="cursor-pointer text-foreground">
                          Connection requirements
                        </summary>
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          {snapshot.grokbotIntegration.map((item) => (
                            <li key={item} className="wrap-anywhere">
                              {item}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <Button aria-pressed={false} disabled size="sm" variant="outline">
                      Open conversation
                    </Button>
                  </div>
                </li>
              ) : null}
              {directory.map((entry) => {
                const { provider, saved: bound, tasks } = entry;
                const ready = entry.readiness === "ready";
                return (
                  <li
                    key={entry.id}
                    data-agent-id={entry.id}
                    className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-5 shadow-xs/5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h2 className="wrap-anywhere text-base font-medium">{entry.displayName}</h2>
                        <p className="text-xs text-muted-foreground">internal · provider</p>
                      </div>
                      <Badge variant="secondary">
                        {ready ? "Provider ready" : "Provider unavailable"}
                      </Badge>
                    </div>
                    <div className="mt-4 space-y-3 text-sm leading-relaxed">
                      <p className="text-muted-foreground">
                        Provider readiness: {ready ? "ready" : "unavailable"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Saved ledger availability: {bound?.availability ?? "not recorded"}. Ledger
                        state does not confirm provider execution or owner acceptance.
                      </p>
                      {!provider ? (
                        <p className="text-muted-foreground">
                          Provider configuration is missing. The saved identity and task records
                          remain available.
                        </p>
                      ) : null}
                      <p className="wrap-anywhere text-muted-foreground">
                        Capabilities:{" "}
                        {bound?.capabilities.join(", ") || "No advertised capabilities."}
                      </p>
                      <p className="wrap-anywhere">
                        {ready
                          ? provider?.models.map((model) => model.slug).join(", ") || "No model"
                          : "This provider is not ready. No conversation was fabricated."}
                      </p>
                      <div className="space-y-1 border-t border-border/50 pt-3">
                        <h3 className="text-xs font-medium text-muted-foreground">Task ledger</h3>
                        {tasks.length ? (
                          <ul className="space-y-1">
                            {tasks.map((task) => (
                              <li key={`${task.projectId}:${task.id}`} className="wrap-anywhere">
                                {task.title} — ledger {task.state}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-muted-foreground">
                            {selectedProject
                              ? "No recorded tasks."
                              : "Select a project to view its tasks."}
                          </p>
                        )}
                      </div>
                      <Button
                        disabled={opening || pending || !snapshot || !ready || !selectedProject}
                        onClick={() => {
                          void openAgent(entry.id);
                        }}
                        size="sm"
                        variant="outline"
                        aria-label={`Open ${entry.displayName} conversation`}
                      >
                        Open conversation
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {providers.length === 0 && snapshot ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm leading-relaxed text-muted-foreground">
                No provider is configured. A provider CLI is not an employee.
              </div>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

export function TasksPage() {
  const navigate = useNavigate();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const { snapshot, error, refresh, refreshing } = useCollaboration(environmentId);
  const tasks = snapshot?.tasks ?? [];

  const openTask = (task: CollaborationTask) => {
    if (!environmentId || !task.threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: task.threadId },
    });
  };

  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Tasks</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1">
        <ScrollArea radius="none">
          <WorkspacePageContainer width="wide">
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Cross-agent work, its owners and acceptance criteria. Return to a task's conversation
              to inspect its evidence; opening a task does not grant execution.
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={!environmentId || refreshing}
                onClick={() => {
                  void refresh();
                }}
              >
                {refreshing ? "Refreshing tasks…" : "Refresh tasks"}
              </Button>
            </div>
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
                {snapshot ? (
                  <AlertDescription>
                    Task data may be stale. The read failed; showing the last successful task data.
                  </AlertDescription>
                ) : null}
              </Alert>
            ) : null}
            {!environmentId ? (
              <Alert variant="info">
                <AlertDescription>No primary environment is connected.</AlertDescription>
              </Alert>
            ) : !snapshot && !error ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reading cross-agent tasks.
              </p>
            ) : snapshot && tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                No cross-agent tasks yet.
              </div>
            ) : null}
            {tasks.length > 0 ? (
              <ul aria-label="Cross-agent tasks" className="space-y-4">
                {tasks.map((task) => (
                  <li
                    key={`${task.projectId}:${task.id}`}
                    className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-5 shadow-xs/5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h2 className="min-w-0 wrap-anywhere text-base font-medium">{task.title}</h2>
                      <Badge variant="secondary">Command ledger: {task.state}</Badge>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      Provider activity and terminal outcomes, plus owner/reviewer acceptance,
                      require separate evidence. Contract phase and accepted revision are separate
                      contract records.
                    </p>
                    <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Owner</dt>
                        <dd className="wrap-anywhere">{task.ownerAgentId}</dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Assignee</dt>
                        <dd className="wrap-anywhere">{task.assigneeAgentId}</dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Wait reason</dt>
                        <dd className="wrap-anywhere leading-relaxed">
                          {task.waitReason ?? "No wait."}
                        </dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Task note</dt>
                        <dd className="wrap-anywhere leading-relaxed">{task.acceptance}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 space-y-2">
                      {task.contractReadout?.status === "available" ? (
                        <>
                          <TaskContractReadout
                            goal={task.contractReadout.contract.goal}
                            redirect={task.contractReadout.contract.redirect}
                            acceptance={task.contractReadout.contract.acceptance}
                            maxProviderStarts={
                              task.contractReadout.contract.brake.maxProviderStarts
                            }
                            stopConditions={task.contractReadout.contract.brake.stopConditions}
                            revision={task.contractReadout.contract.revision}
                            phase={task.contractReadout.phase ?? "phase not persisted"}
                            acceptedRevision={task.contractReadout.acceptedRevision}
                          />
                          <dl className="space-y-1 text-xs text-muted-foreground">
                            {task.contractReadout.contract.brake.maxTokens !== undefined ? (
                              <div>
                                <dt>Declared token cap</dt>
                                <dd>{task.contractReadout.contract.brake.maxTokens}</dd>
                              </div>
                            ) : null}
                            {task.contractReadout.contract.brake.maxCostUsd !== undefined ? (
                              <div>
                                <dt>Declared cost cap (USD)</dt>
                                <dd>{task.contractReadout.contract.brake.maxCostUsd}</dd>
                              </div>
                            ) : null}
                            {task.contractReadout.contract.brake.deadlineAt !== undefined ? (
                              <div>
                                <dt>Declared deadline</dt>
                                <dd>{task.contractReadout.contract.brake.deadlineAt}</dd>
                              </div>
                            ) : null}
                          </dl>
                          <p className="text-xs text-muted-foreground">
                            Stop conditions are recorded for human review; this card does not
                            enforce natural-language conditions.
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {task.contractReadout === undefined
                            ? "Persisted contract readout is unavailable in this snapshot."
                            : task.contractReadout.reason === "ordinary_chat"
                              ? "Ordinary chat has no persisted task contract."
                              : task.contractReadout.reason === "missing_contract"
                                ? "The governed thread has no complete persisted contract."
                                : task.contractReadout.reason === "invalid_contract"
                                  ? "The stored contract is incomplete or unreadable; its fields cannot be confirmed."
                                  : "No valid linked conversation is available to read a persisted contract."}
                        </p>
                      )}
                    </div>
                    <TaskRoutingReadout readout={task.routingReadout} />
                    <TaskResultReadout readout={task.resultReadout} />
                    <div className="mt-4 flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                        <p>Gate {task.gateDecision}. This task does not grant execution.</p>
                        <p>
                          {task.threadId
                            ? "Opening this task returns to its project thread."
                            : "This task has no project thread."}
                        </p>
                      </div>
                      <div className="shrink-0">
                        <Button
                          disabled={!task.threadId || !environmentId}
                          onClick={() => openTask(task)}
                          size="sm"
                          variant="outline"
                        >
                          Open conversation
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
