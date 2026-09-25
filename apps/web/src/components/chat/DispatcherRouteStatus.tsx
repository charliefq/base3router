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
import { LockIcon, RouteIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { dispatcherEnvironment } from "~/state/dispatcher";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComposerBanner } from "./ComposerBanner";

const IDLE_STATE: DispatcherPreviewState = { status: "idle" };
const LOADING_STATE: DispatcherPreviewState = { status: "loading" };

interface RouteStatusProps {
  readonly projectTitle: string;
  readonly state: DispatcherPreviewState;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly boundRoute?: DispatcherTaskRouteSnapshot | null | undefined;
}

export function DispatcherRouteStatus({
  projectTitle,
  state,
  providers,
  boundRoute = null,
}: RouteStatusProps) {
  const route =
    boundRoute === null
      ? state.status === "success"
        ? presentDispatcherDecision(state.decision, providers)
        : null
      : presentBoundDispatcherRoute(boundRoute.binding, providers);
  const label = boundRoute === null ? "Provisional route" : "Bound route";
  const detail =
    route === null
      ? dispatcherPreviewStatusLabel(state)
      : `${boundRoute === null ? "Automatic · " : ""}${route.provider} · ${route.model} · ${route.reason}`;
  const fallbacks = route?.fallbacks
    .map((entry) => `${entry.provider} · ${entry.model}`)
    .join(", ");

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        variant={boundRoute === null && state.status === "error" ? "warning" : "info"}
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            {boundRoute === null ? <RouteIcon /> : <LockIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="flex min-w-0 flex-col py-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                <span className="font-medium text-foreground">{label}</span>
                <span className="truncate text-muted-foreground">Project: {projectTitle}</span>
              </span>
              <span className="truncate text-muted-foreground">{detail}</span>
              {boundRoute === null && fallbacks ? (
                <span className="truncate text-muted-foreground/80">
                  Pre-start fallbacks: {fallbacks}
                </span>
              ) : null}
            </span>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
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
