import { createFileRoute } from "@tanstack/react-router";

import { ControlCenterPage } from "../components/controlPlane/ControlCenterPage";

export const Route = createFileRoute("/_chat/control-center")({
  validateSearch: (search: Record<string, unknown>) => ({
    section:
      search.section === "workflows" || search.section === "agents" ? search.section : undefined,
  }),
  component: ControlCenterRoute,
});

function ControlCenterRoute() {
  const { section } = Route.useSearch();
  return <ControlCenterPage section={section ?? "overview"} />;
}
