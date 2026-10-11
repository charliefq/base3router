import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "../components/collaboration/CollaborationPages";

export const Route = createFileRoute("/_chat/agents")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.agent === "string" && raw.agent.trim() ? { agent: raw.agent } : {}),
    ...(typeof raw.task === "string" && raw.task.trim() ? { task: raw.task } : {}),
  }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { agent, task } = Route.useSearch();
  return <AgentsPage agentId={agent} taskId={task} />;
}
