import { createFileRoute } from "@tanstack/react-router";

import { TasksPage } from "../components/collaboration/CollaborationPages";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.task === "string" && raw.task.trim() ? { task: raw.task } : {}),
  }),
  component: TasksRoute,
});

function TasksRoute() {
  const { task } = Route.useSearch();
  return <TasksPage taskId={task} />;
}
