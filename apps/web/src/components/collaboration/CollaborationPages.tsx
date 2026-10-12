import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type CollaborationAgent,
  type CollaborationCommand,
  type CollaborationSnapshot,
  type CollaborationTask,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { isElectron } from "../../env";
import { newThreadId, randomUUID } from "../../lib/utils";
import { runPrimaryHttp } from "../../lib/runtime";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useProjects } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

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

function useCollaboration(environmentId: EnvironmentId | null) {
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId;
    snapshot: CollaborationSnapshot;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const currentEnvironment = useRef(environmentId);
  useLayoutEffect(() => {
    currentEnvironment.current = environmentId;
    return () => {
      currentEnvironment.current = null;
    };
  }, [environmentId]);

  useEffect(() => {
    if (!environmentId) return;
    let active = true;
    void loadSnapshot().then(
      (snapshot) => {
        if (!active) return;
        setLoaded({ environmentId, snapshot });
        setError(null);
      },
      (cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "The agent directory could not be read.");
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId]);

  const submit = useCallback(
    async (command: CollaborationCommand) => {
      setPending(true);
      try {
        const result = await sendCommand(command);
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
    snapshot: loaded?.environmentId === environmentId ? loaded.snapshot : null,
    error,
    pending,
    submit,
  };
}

const providerExecutable = (provider: ServerProvider) =>
  provider.installed &&
  provider.enabled &&
  provider.status === "ready" &&
  isProviderAvailable(provider) &&
  isProviderTextGenerationCapable(provider) &&
  provider.models.length > 0;

function connectionLabel(
  agent: CollaborationAgent | undefined,
  provider: ServerProvider | undefined,
) {
  if (!provider && agent?.origin === "external") return "NOT_CONNECTED";
  if (!provider) return agent?.availability ?? "unknown";
  if (!providerExecutable(provider)) return provider.status;
  return agent?.availability ?? "unknown";
}

export function AgentsPage() {
  const navigate = useNavigate();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const { snapshot, error, pending, submit } = useCollaboration(environmentId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  // Retain request identity after an uncertain response. Retrying the operation must
  // recover the same create/bind receipts, not allocate another project thread.
  const openings = useRef(
    new Map<
      string,
      {
        request: Parameters<typeof createThread>[0];
        binding: CollaborationCommand;
        created: boolean;
        bound: boolean;
      }
    >(),
  );
  const selectedProject =
    projects.length === 1 ? projects[0] : projects.find((project) => project.id === projectId);
  const selectedProjectId = selectedProject?.id;
  const context = useRef({ environmentId, projectId: selectedProjectId, mounted: true });
  useLayoutEffect(() => {
    context.current = { environmentId, projectId: selectedProjectId, mounted: true };
    return () => {
      context.current.mounted = false;
    };
  }, [context, environmentId, selectedProjectId]);

  const openThread = (threadId: string) => {
    if (!environmentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const openAgent = async (agentId: string) => {
    // A ref closes the same-render double-click window before React updates disabled.
    if (openingRef.current || !snapshot || !environmentId || !selectedProject) return;
    setNotice(null);
    const bound = snapshot?.agents.find((agent) => agent.id === agentId);
    if (agentId === "grokbot" || bound?.origin === "external") {
      return;
    }
    if (bound && bound.projectId !== selectedProject.id) {
      setNotice(
        "This agent is linked to a different project. Select that project to open its conversation.",
      );
      return;
    }
    if (bound?.threadId) {
      openThread(bound.threadId);
      return;
    }
    const provider = providers.find((item) => item.instanceId === agentId);
    if (!provider || !providerExecutable(provider)) return;
    if (!environmentId || !selectedProject) return;
    const model = provider.models.find((item) => item.isDefault) ?? provider.models[0];
    if (!model) return;
    const key = JSON.stringify([environmentId, agentId]);
    let operation = openings.current.get(key);
    if (operation && operation.request.input.projectId !== selectedProject.id) {
      setNotice(
        "This agent has an unfinished or linked conversation in a different project. Select that project to continue.",
      );
      return;
    }
    if (!operation) {
      const threadId = newThreadId();
      const title = `Chat with ${provider.displayName ?? provider.driver}`;
      operation = {
        request: {
          environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            threadId,
            projectId: selectedProject.id,
            title,
            modelSelection: { instanceId: provider.instanceId, model: model.slug },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        },
        binding: {
          type: "thread.bind",
          commandId: randomUUID(),
          projectId: selectedProject.id,
          threadId,
          agentId: provider.instanceId,
          title,
        },
        created: false,
        bound: false,
      };
      openings.current.set(key, operation);
    }
    openingRef.current = true;
    setOpening(true);
    try {
      if (!operation.created) {
        const created = await createThread(operation.request);
        if (created._tag === "Failure") {
          setNotice(
            "The thread creation could not be confirmed. Retry to recover the same conversation.",
          );
          return;
        }
        operation.created = true;
      }
      if (!context.current.mounted || context.current.environmentId !== environmentId) return;
      if (!operation.bound) {
        const linked = await submit(operation.binding);
        if (!linked || linked.outcome === "rejected") {
          setNotice(
            "The conversation was created but could not be linked. Retry in this project to link the same conversation.",
          );
          return;
        }
        operation.bound = true;
      }
      if (
        context.current.mounted &&
        context.current.environmentId === environmentId &&
        context.current.projectId === selectedProject.id
      ) {
        openThread(operation.request.input.threadId);
      }
    } catch {
      setNotice(
        "The conversation could not be confirmed. Retry in this project to recover the same request.",
      );
    } finally {
      openingRef.current = false;
      if (context.current.mounted) setOpening(false);
    }
  };

  const grokbot = snapshot?.agents.find((agent) => agent.id === "grokbot");
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1>Agents</h1>
      </WorkspacePageHeader>
      <div>
        {error ? <p>{error}</p> : null}
        {notice ? <p>{notice}</p> : null}
        {!environmentId ? <p>No primary environment is connected.</p> : null}
        {projects.length === 0 ? (
          <p>No project is open on this environment. An agent thread needs a real project.</p>
        ) : null}
        {projects.length > 1 ? (
          <label>
            Project
            <select
              disabled={opening}
              value={projectId ?? ""}
              onChange={(event) => setProjectId(event.target.value || null)}
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {snapshot ? (
          <>
            <p>Real Grokbot: {snapshot.realGrokbot}</p>
            <ul>
              {snapshot.grokbotIntegration.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>Reading the agent directory.</p>
        )}
        <ul>
          {grokbot ? (
            <li>
              <Button aria-pressed={false} disabled size="sm" variant="ghost">
                {grokbot.displayName}
              </Button>
              <p>
                {grokbot.origin} · {grokbot.role} · {connectionLabel(grokbot, undefined)} ·{" "}
                {grokbot.availability}
              </p>
              <p>Grokbot is NOT_CONNECTED. No chat was opened.</p>
            </li>
          ) : null}
          {providers.map((provider) => {
            const bound = snapshot?.agents.find((agent) => agent.id === provider.instanceId);
            const ready = providerExecutable(provider);
            const tasks =
              snapshot?.tasks.filter(
                (task) =>
                  task.state !== "completed" &&
                  (task.assigneeAgentId === provider.instanceId ||
                    task.ownerAgentId === provider.instanceId),
              ) ?? [];
            return (
              <li key={provider.instanceId}>
                <Button
                  disabled={opening || pending || !snapshot || !ready || !selectedProject}
                  onClick={() => {
                    void openAgent(provider.instanceId);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {provider.displayName ?? provider.driver}
                </Button>
                <p>
                  internal · provider · {connectionLabel(bound, provider)} ·{" "}
                  {bound?.availability ?? (ready ? "unknown" : "offline")}
                </p>
                <p>
                  {ready
                    ? provider.models.map((model) => model.slug).join(", ") || "No model"
                    : "This provider is not ready. No conversation was fabricated."}
                </p>
                {tasks.length > 0 ? (
                  <p>{tasks.map((task) => task.title).join(", ")}</p>
                ) : (
                  <p>No open tasks.</p>
                )}
              </li>
            );
          })}
        </ul>
        {providers.length === 0 ? (
          <p>No provider is configured. A provider CLI is not an employee.</p>
        ) : null}
      </div>
    </SidebarInset>
  );
}

export function TasksPage() {
  const navigate = useNavigate();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const { snapshot, error } = useCollaboration(environmentId);
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
        <h1>Tasks</h1>
      </WorkspacePageHeader>
      <div>
        {error ? <p>{error}</p> : null}
        {tasks.length === 0 ? (
          <p>No cross-agent tasks yet.</p>
        ) : (
          <ul>
            {tasks.map((task) => (
              <li key={task.id}>
                <Button
                  disabled={!task.threadId || !environmentId}
                  onClick={() => openTask(task)}
                  size="sm"
                  variant="ghost"
                >
                  {task.title}
                </Button>
                <p>
                  {task.state} · owner {task.ownerAgentId} · assignee {task.assigneeAgentId}
                </p>
                <p>{task.waitReason ?? "No wait."}</p>
                <p>Acceptance: {task.acceptance}</p>
                <p>Gate {task.gateDecision}. This task does not grant execution.</p>
                <p>
                  {task.threadId
                    ? "Opening this task returns to its project thread."
                    : "This task has no project thread."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SidebarInset>
  );
}
