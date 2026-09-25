import {
  createDispatcherPreviewController,
  dispatcherPreviewStatusLabel,
  presentBoundDispatcherRoute,
  presentDispatcherDecision,
  shouldShowDispatcherRoute,
  type DispatcherPreviewState,
} from "@t3tools/client-runtime/dispatcher";
import type {
  DispatcherRoutePreviewRequest,
  DispatcherTaskRouteSnapshot,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { dispatcherEnvironment } from "../../state/dispatcher";
import { useAtomCommand } from "../../state/use-atom-command";

const IDLE_STATE: DispatcherPreviewState = { status: "idle" };
const LOADING_STATE: DispatcherPreviewState = { status: "loading" };

export function DispatcherRouteStatus(props: {
  readonly projectTitle: string;
  readonly state: DispatcherPreviewState;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly boundRoute?: DispatcherTaskRouteSnapshot | null | undefined;
}) {
  const boundRoute = props.boundRoute ?? null;
  const route =
    boundRoute === null
      ? props.state.status === "success"
        ? presentDispatcherDecision(props.state.decision, props.providers)
        : null
      : presentBoundDispatcherRoute(boundRoute.binding, props.providers);
  const fallbacks = route?.fallbacks
    .map((entry) => `${entry.provider} · ${entry.model}`)
    .join(", ");

  return (
    <View
      accessibilityLabel={boundRoute === null ? "Provisional dispatcher route" : "Bound route"}
      className="mx-1 mb-2 rounded-2xl border border-composer-border bg-composer-surface px-3 py-2"
    >
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Text className="text-xs font-t3-bold text-foreground">
          {boundRoute === null ? "Provisional route" : "Bound route"}
        </Text>
        <Text className="text-xs text-foreground-muted">Project: {props.projectTitle}</Text>
      </View>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {route === null
          ? dispatcherPreviewStatusLabel(props.state)
          : `${boundRoute === null ? "Automatic · " : ""}${route.provider} · ${route.model} · ${route.reason}`}
      </Text>
      {boundRoute === null && fallbacks ? (
        <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
          Pre-start fallbacks: {fallbacks}
        </Text>
      ) : null}
    </View>
  );
}

export function DispatcherRoutePreview(props: {
  readonly available: boolean;
  readonly environmentId: EnvironmentId;
  readonly project: { readonly id: ProjectId; readonly title: string } | null;
  readonly preferredRoute: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly boundRoute?: DispatcherTaskRouteSnapshot | null | undefined;
}) {
  const { available, boundRoute, environmentId, preferredRoute, project } = props;
  const projectId = project?.id ?? null;
  const preferredInstanceId = preferredRoute.instanceId;
  const preferredModel = preferredRoute.model;
  const runPreview = useAtomCommand(dispatcherEnvironment.previewRoute, {
    reportFailure: false,
    reportDefect: false,
  });
  const input = useMemo<DispatcherRoutePreviewRequest | null>(
    () =>
      available && projectId !== null
        ? {
            environmentId,
            projectId,
            preferredRoute: {
              instanceId: preferredInstanceId,
              model: preferredModel,
            },
            actionKind: "workspace-write",
          }
        : null,
    [available, environmentId, preferredInstanceId, preferredModel, projectId],
  );
  const inputKey = input === null ? null : JSON.stringify(input);
  const [preview, setPreview] = useState<{
    readonly inputKey: string | null;
    readonly state: DispatcherPreviewState;
  }>({ inputKey: null, state: IDLE_STATE });
  const state = preview.inputKey === inputKey ? preview.state : LOADING_STATE;

  useEffect(() => {
    if (boundRoute !== null && boundRoute !== undefined) return;
    const controller = createDispatcherPreviewController({
      request: async (request) => {
        const result = await runPreview({ environmentId, input: request });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        return result.value;
      },
      onChange: (nextState) => setPreview({ inputKey, state: nextState }),
    });
    controller.update(input);
    return () => controller.dispose();
  }, [boundRoute, environmentId, input, inputKey, runPreview]);

  if (project === null) return null;
  if (
    !shouldShowDispatcherRoute({
      capabilityAvailable: available,
      hasProject: true,
      hasBoundRoute: boundRoute !== null && boundRoute !== undefined,
    })
  ) {
    return null;
  }
  return (
    <DispatcherRouteStatus
      projectTitle={project.title}
      state={state}
      providers={props.providers}
      boundRoute={boundRoute}
    />
  );
}
