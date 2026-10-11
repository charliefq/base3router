import { createFileRoute } from "@tanstack/react-router";

import { TasksPage } from "../components/collaboration/CollaborationPages";

export const Route = createFileRoute("/_chat/tasks")({
  component: TasksPage,
});
