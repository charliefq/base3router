import { useMemo } from "react";

import { presentControlCenter } from "~/controlPlane/presentControlCenter";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { SidebarInset } from "../ui/sidebar";
import { ControlCenter } from "./ControlCenter";
import { OperationalInspectorHost } from "./OperationalInspectorHost";

export function ControlCenterPage(props: {
  readonly section?: "overview" | "workflows" | "agents";
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const capabilities = useMemo(() => {
    const advertised = environments.map(
      (environment) => environment.serverConfig?.environment.capabilities,
    );
    return {
      dispatcher: advertised.some((entry) => entry?.dispatcherRoutePreview === true),
      workflow: advertised.some((entry) => entry?.workflowOs === true),
      cursorCloud: advertised.some((entry) => entry?.cursorCloudRunner === true),
    };
  }, [environments]);
  const model = presentControlCenter({ capabilities, projects, threads });

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <div className="flex h-full min-w-0">
        <div className="min-w-0 flex-1">
          <ControlCenter model={model} section={props.section} />
        </div>
        <OperationalInspectorHost environmentId={null} projectId={null} threadId={null} />
      </div>
    </SidebarInset>
  );
}
