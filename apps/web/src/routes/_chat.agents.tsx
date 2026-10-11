import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "../components/collaboration/CollaborationPages";

export const Route = createFileRoute("/_chat/agents")({
  component: AgentsPage,
});
