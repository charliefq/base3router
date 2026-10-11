import { useAtomValue } from "@effect/atom-react";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type CollaborationAgent,
  type CollaborationCommand,
  type CollaborationSnapshot,
  type CollaborationTask,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState } from "react";
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

function useCollaboration() {
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSnapshot(await loadSnapshot());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent directory could not be read.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = useCallback(async (command: CollaborationCommand) => {
    setPending(true);
    try {
      const result = await sendCommand(command);
      setSnapshot(result.snapshot);
      setError(result.outcome === "rejected" ? result.detail : null);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The command was not recorded.");
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  return { snapshot, error, pending, submit };
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
  const { snapshot, error, pending, submit } = useCollaboration();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedProject =
    projects.length === 1 ? projects[0] : projects.find((project) => project.id === projectId);

  const openThread = (threadId: string) => {
    if (!environmentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const openAgent = async (agentId: string) => {
    const bound = snapshot?.agents.find((agent) => agent.id === agentId);
    if (agentId === "grokbot" || bound?.origin === "external") {
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
    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: selectedProject.id,
        title: `Chat with ${provider.displayName ?? provider.driver}`,
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
    });
    if (created._tag === "Failure") {
      setNotice("The project thread was not created.");
      return;
    }
    const linked = await submit({
      type: "thread.bind",
      commandId: randomUUID(),
      projectId: selectedProject.id,
      threadId,
      agentId: provider.instanceId,
      title: `Chat with ${provider.displayName ?? provider.driver}`,
    });
    if (!linked || linked.outcome === "rejected") return;
    openThread(threadId);
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
                  disabled={pending || !ready || (!bound?.threadId && !selectedProject)}
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
  const { snapshot, error } = useCollaboration();
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
