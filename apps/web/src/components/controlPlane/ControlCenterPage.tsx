import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type ExplicitFeedbackKind,
  ObservationId,
  RouterPolicyId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import {
  resolveControlCenterEnvironmentId,
  selectControlCenterSource,
} from "~/controlPlane/controlCenterProjection";
import {
  presentControlCenter,
  presentRouterInsights,
  selectControlCenterInspectorTarget,
  type ControlCenterRouterInsights,
} from "~/controlPlane/presentControlCenter";
import { useEnvironmentQuery } from "~/state/query";
import {
  useActiveEnvironmentId,
  useEnvironmentShellBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "~/state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { ControlCenter } from "./ControlCenter";
import { OperationalInspectorHost } from "./OperationalInspectorHost";
import { WorkspaceScrollPane } from "./workspaceScrollLayout";

const EMPTY_SESSION_STATE_ATOM = Atom.make<AuthSessionState | null>(null).pipe(
  Atom.withLabel("web-control-center-session-empty"),
);

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
  const capability = serverConfig?.environment.capabilities.routerEvaluation;
  const insightsQuery = useEnvironmentQuery(
    selectedEnvironmentId === null || capability === undefined
      ? null
      : serverEnvironment.routerInsights({ environmentId: selectedEnvironmentId, input: {} }),
  );
  const session = useAtomValue(
    selectedEnvironmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateValueAtom(selectedEnvironmentId),
  );
  const canOperate =
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const [confirmation, setConfirmation] =
    useState<ControlCenterRouterInsights["confirmation"]>(null);
  const submitFeedback = useAtomCommand(serverEnvironment.routerSubmitFeedback, {
    reportFailure: true,
  });
  const activatePolicy = useAtomCommand(serverEnvironment.routerActivatePolicy, {
    reportFailure: true,
  });
  const shadowPolicy = useAtomCommand(serverEnvironment.routerShadowPolicy, {
    reportFailure: true,
  });
  const rollbackPolicy = useAtomCommand(serverEnvironment.routerRollbackPolicy, {
    reportFailure: true,
  });
  const exportObservations = useAtomCommand(serverEnvironment.routerExportObservations, {
    reportFailure: true,
  });
  const deleteObservations = useAtomCommand(serverEnvironment.routerDeleteObservations, {
    reportFailure: true,
  });

  const routerInsights = useMemo(() => {
    if (insightsQuery.data !== null) {
      return presentRouterInsights(insightsQuery.data, {
        canOperate,
        confirmation,
      });
    }
    if (capability === undefined) return undefined;
    return {
      observationCount: capability.observationCount,
      activePolicy: capability.activePolicyVersion,
      candidatePolicy: null,
      insufficientData: capability.observationCount < 8,
      mixedProvenance: false,
      explicitFeedback: "unknown",
      reworkProxies: "unknown",
      canOperate,
      confirmation: confirmation ?? null,
    } satisfies ControlCenterRouterInsights;
  }, [canOperate, capability, confirmation, insightsQuery.data]);

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
    ...(routerInsights !== undefined ? { routerInsights } : {}),
  });
  const inspector = selectControlCenterInspectorTarget(model);

  const refreshInsights = () => {
    insightsQuery.refresh();
    setConfirmation(null);
  };

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
      <ControlCenter
        model={model}
        section={props.section ?? "overview"}
        {...(selectedEnvironmentId !== null && routerInsights !== undefined
          ? {
              actions: {
                onRequestConfirm: setConfirmation,
                onCancelConfirm: () => setConfirmation(null),
                onExport: () => {
                  void exportObservations({
                    environmentId: selectedEnvironmentId,
                    input: {},
                  }).then((result) => {
                    if (result._tag !== "Success") return;
                    const blob = new Blob([JSON.stringify(result.value, null, 2)], {
                      type: "application/json",
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = "router-observations.json";
                    link.click();
                    URL.revokeObjectURL(url);
                  });
                },
                onFeedback: (kind: ExplicitFeedbackKind) => {
                  const observationId = routerInsights.latestObservationId;
                  if (observationId === undefined) return;
                  void submitFeedback({
                    environmentId: selectedEnvironmentId,
                    input: { observationId: ObservationId.make(observationId), kind },
                  }).then((result) => {
                    if (result._tag === "Success") refreshInsights();
                  });
                },
                onConfirmActivate: () => {
                  const policyId = routerInsights.candidatePolicyId;
                  if (policyId === undefined || policyId === null) return;
                  void activatePolicy({
                    environmentId: selectedEnvironmentId,
                    input: {
                      policyId: RouterPolicyId.make(policyId),
                      confirmActivation: true,
                    },
                  }).then((result) => {
                    if (result._tag === "Success") refreshInsights();
                  });
                },
                onConfirmShadow: () => {
                  const policyId = routerInsights.candidatePolicyId;
                  if (policyId === undefined || policyId === null) return;
                  void shadowPolicy({
                    environmentId: selectedEnvironmentId,
                    input: {
                      policyId: RouterPolicyId.make(policyId),
                      confirmShadow: true,
                    },
                  }).then((result) => {
                    if (result._tag === "Success") refreshInsights();
                  });
                },
                onConfirmRollback: () => {
                  void rollbackPolicy({
                    environmentId: selectedEnvironmentId,
                    input: { confirmRollback: true },
                  }).then((result) => {
                    if (result._tag === "Success") refreshInsights();
                  });
                },
                onConfirmDelete: () => {
                  void deleteObservations({
                    environmentId: selectedEnvironmentId,
                    input: { confirmDelete: true, scope: "environment" },
                  }).then((result) => {
                    if (result._tag === "Success") refreshInsights();
                  });
                },
              },
            }
          : {})}
      />
    </WorkspaceScrollPane>
  );
}
