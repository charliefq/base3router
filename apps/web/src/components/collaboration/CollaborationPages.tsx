import {
  type CollaborationAgent,
  type CollaborationCommand,
  type CollaborationSnapshot,
  type CollaborationTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { isElectron } from "../../env";
import { runPrimaryHttp } from "../../lib/runtime";
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The command was not recorded.");
    } finally {
      setPending(false);
    }
  }, []);

  return { snapshot, error, pending, submit };
}

function connectionLabel(agent: CollaborationAgent) {
  if (agent.origin === "external" && agent.connection === "NOT_CONNECTED") return "NOT_CONNECTED";
  if (agent.connection === "SIMULATED") return "simulated transport";
  return agent.availability;
}

function AgentList({
  agents,
  tasks,
  selectedAgentId,
  onSelect,
}: {
  agents: ReadonlyArray<CollaborationAgent>;
  tasks: ReadonlyArray<CollaborationTask>;
  selectedAgentId: string | undefined;
  onSelect: (agentId: string) => void;
}) {
  return (
    <ul>
      {agents.map((agent) => {
        const linked = tasks.filter(
          (task) =>
            task.state !== "completed" &&
            (task.ownerAgentId === agent.id || task.assigneeAgentId === agent.id),
        );
        return (
          <li key={agent.id}>
            <Button
              aria-pressed={selectedAgentId === agent.id}
              onClick={() => onSelect(agent.id)}
              size="sm"
              variant={selectedAgentId === agent.id ? "secondary" : "ghost"}
            >
              {agent.displayName}
            </Button>
            <p>
              {agent.origin} · {agent.role} · {connectionLabel(agent)} · {agent.availability}
            </p>
            <p>{agent.capabilities.join(", ")}</p>
            {linked.length > 0 ? (
              <p>{linked.map((task) => task.title).join(", ")}</p>
            ) : (
              <p>No open tasks.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Transcript({
  snapshot,
  agentId,
  taskId,
}: {
  snapshot: CollaborationSnapshot;
  agentId: string;
  taskId: string | undefined;
}) {
  const agent = snapshot.agents.find((item) => item.id === agentId);
  const messages = snapshot.messages.filter((message) => {
    if (taskId) return message.taskId === taskId;
    return message.senderId === agentId || message.recipientId === agentId;
  });
  if (!agent) return <p>That agent is not in the directory.</p>;
  return (
    <section>
      <h2>{agent.displayName}</h2>
      <p>
        {agent.origin} · {agent.role} · {connectionLabel(agent)}
      </p>
      {agent.origin === "external" ? (
        <p>
          Real Grokbot API: {snapshot.realGrokbot}. A simulated transcript is not a live connection.
        </p>
      ) : null}
      {messages.length === 0 ? (
        <p>
          No messages yet. A provider CLI is not an employee, and this page does not invent one.
        </p>
      ) : (
        <ol>
          {messages.map((message) => (
            <li key={message.id}>
              <p>
                {message.kind} · {message.transport} · does not grant execution
              </p>
              <p>{message.body}</p>
              {message.replyTo ? <p>Reply to {message.replyTo}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function AgentsPage({
  agentId,
  taskId,
}: {
  agentId: string | undefined;
  taskId: string | undefined;
}) {
  const navigate = useNavigate();
  const { snapshot, error, pending, submit } = useCollaboration();
  const projectId = "owner-project";
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1>Agents</h1>
      </WorkspacePageHeader>
      <div>
        {error ? <p>{error}</p> : null}
        {snapshot ? (
          <>
            <p>Real Grokbot: {snapshot.realGrokbot}</p>
            <ul>
              {snapshot.grokbotIntegration.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <AgentList
              agents={snapshot.agents}
              onSelect={(id) => {
                void navigate({ to: "/agents", search: { agent: id } });
              }}
              selectedAgentId={agentId}
              tasks={snapshot.tasks}
            />
            {agentId ? <Transcript agentId={agentId} snapshot={snapshot} taskId={taskId} /> : null}
            <Button
              disabled={pending}
              onClick={() => {
                void submit({
                  type: "scenario.rehearse",
                  commandId: "scenario-a-owner-project",
                  scenario: "A",
                  projectId,
                });
              }}
              variant="outline"
            >
              Rehearse scenario A on a simulated transport
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                void submit({
                  type: "scenario.rehearse",
                  commandId: "scenario-b-owner-project",
                  scenario: "B",
                  projectId,
                });
              }}
              variant="outline"
            >
              Rehearse scenario B on a simulated transport
            </Button>
          </>
        ) : (
          <p>Reading the agent directory.</p>
        )}
      </div>
    </SidebarInset>
  );
}

export function TasksPage({ taskId }: { taskId: string | undefined }) {
  const navigate = useNavigate();
  const { snapshot, error } = useCollaboration();
  const tasks = snapshot?.tasks ?? [];
  const selected = tasks.find((task) => task.id === taskId);
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
                  aria-pressed={task.id === taskId}
                  onClick={() => {
                    void navigate({
                      to: "/agents",
                      search: { agent: task.assigneeAgentId, task: task.id },
                    });
                  }}
                  size="sm"
                  variant={task.id === taskId ? "secondary" : "ghost"}
                >
                  {task.title}
                </Button>
                <p>
                  {task.state} · owner {task.ownerAgentId} · assignee {task.assigneeAgentId}
                </p>
                <p>{task.waitReason ?? "No wait."}</p>
                <p>Acceptance: {task.acceptance}</p>
                <p>Gate {task.gateDecision}. This task does not grant execution.</p>
              </li>
            ))}
          </ul>
        )}
        {snapshot && selected ? (
          <Transcript agentId={selected.assigneeAgentId} snapshot={snapshot} taskId={selected.id} />
        ) : null}
      </div>
    </SidebarInset>
  );
}
