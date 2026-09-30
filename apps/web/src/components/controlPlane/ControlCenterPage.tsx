import {
  resolveControlCenterEnvironmentId,
  selectControlCenterSource,
} from "~/controlPlane/controlCenterProjection";
import {
  presentControlCenter,
  selectControlCenterInspectorTarget,
} from "~/controlPlane/presentControlCenter";
import {
  useActiveEnvironmentId,
  useEnvironmentShellBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "~/state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { SidebarInset } from "../ui/sidebar";
import { ControlCenter } from "./ControlCenter";
import { OperationalInspectorHost } from "./OperationalInspectorHost";

export function ControlCenterPage(props: {
  readonly section?: "overview" | "workflows" | "agents";
}) {
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { isReady } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  const threads = useThreadShells();
  const selectedEnvironmentId = resolveControlCenterEnvironmentId(
    activeEnvironmentId,
    primaryEnvironmentId,
    projects,
    threads,
  );
  const environment = useEnvironment(selectedEnvironmentId);
  const bootstrapped = useEnvironmentShellBootstrapped(selectedEnvironmentId);
  const serverConfig =
    selectedEnvironmentId === null
      ? null
      : (serverConfigs.get(selectedEnvironmentId) ?? environment?.serverConfig ?? null);
  const model = presentControlCenter(
    selectControlCenterSource({
      activeEnvironmentId,
      primaryEnvironmentId,
      catalogReady: isReady,
      bootstrapped,
      connectionPhase: environment?.connection.phase ?? null,
      serverConfig,
      incomingEnvironmentId: serverConfig?.environment.environmentId ?? selectedEnvironmentId,
      projects,
      threads,
    }),
  );
  const inspector = selectControlCenterInspectorTarget(model);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <div className="flex h-full min-w-0">
        <div className="min-w-0 flex-1">
          <ControlCenter model={model} section={props.section ?? "overview"} />
        </div>
        <OperationalInspectorHost
          environmentId={inspector.environmentId}
          projectId={inspector.projectId}
          threadId={inspector.threadId}
        />
      </div>
    </SidebarInset>
  );
}
