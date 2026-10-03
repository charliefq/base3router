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
import { ControlCenter } from "./ControlCenter";
import { OperationalInspectorHost } from "./OperationalInspectorHost";
import { WorkspaceScrollPane } from "./workspaceScrollLayout";

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
  const model = presentControlCenter({
    ...selectControlCenterSource({
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
    environmentLabel: environment?.label ?? selectedEnvironmentId,
    ...(serverConfig?.environment.capabilities.routerEvaluation !== undefined
      ? {
          routerInsights: {
            observationCount:
              serverConfig.environment.capabilities.routerEvaluation.observationCount,
            activePolicy:
              serverConfig.environment.capabilities.routerEvaluation.activePolicyVersion,
            candidatePolicy: null,
            insufficientData:
              serverConfig.environment.capabilities.routerEvaluation.observationCount < 8,
            mixedProvenance: false,
            explicitFeedback: "local, optional",
            reworkProxies: "labeled proxy",
          },
        }
      : {}),
  });
  const inspector = selectControlCenterInspectorTarget(model);

  return (
    <WorkspaceScrollPane
      inspector={
        <OperationalInspectorHost
          environmentId={inspector.environmentId}
          projectId={inspector.projectId}
          threadId={inspector.threadId}
        />
      }
    >
      <ControlCenter model={model} section={props.section ?? "overview"} />
    </WorkspaceScrollPane>
  );
}
