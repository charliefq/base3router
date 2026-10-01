import { createFileRoute } from "@tanstack/react-router";

import { ControlCenterPage } from "../components/controlPlane/ControlCenterPage";

type ControlCenterSearch = {
  readonly section?: "workflows" | "agents";
};

export const Route = createFileRoute("/_chat/control-center")({
  validateSearch: (search: Record<string, unknown>): ControlCenterSearch => {
    if (search.section === "workflows" || search.section === "agents") {
      return { section: search.section };
    }
    return {};
  },
  component: ControlCenterRoute,
});

function ControlCenterRoute() {
  const { section } = Route.useSearch();
  return <ControlCenterPage section={section ?? "overview"} />;
}
