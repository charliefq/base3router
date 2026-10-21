import { createFileRoute } from "@tanstack/react-router";

import { CollaborationRoutePage } from "../components/collaboration/CollaborationRoutePage";
import { validateCollaborationScope } from "../components/collaboration/collaborationScope";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: validateCollaborationScope,
  component: () => <CollaborationRoutePage page="tasks" />,
});
