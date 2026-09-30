import {
  createDispatcherPreviewController,
  dispatcherPreviewStatusLabel,
  presentBoundDispatcherRoute,
  presentDispatcherDecision,
  shouldShowDispatcherRoute,
  type DispatcherPreviewState,
} from "@t3tools/client-runtime/dispatcher";
import type {
  DispatcherHandoffPreview,
  DispatcherRoutePreviewRequest,
  DispatcherTaskRouteSnapshot,
  EnvironmentId,
  OrchestrationThread,
  ModelSelection,
  ProjectId,
  ServerProvider,
} from "@t3tools/contracts";
import { dispatcherHandoffTargetOptions } from "@t3tools/client-runtime/handoff";
import * as Cause from "effect/Cause";
import { ArrowRightLeftIcon, LockIcon, RouteIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { dispatcherEnvironment } from "~/state/dispatcher";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { newMessageId } from "~/lib/utils";
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
  readonly handoffAvailable?: boolean;
  readonly thread?: Pick<
    OrchestrationThread,
    "id" | "latestTurn" | "latestRoute" | "latestHandoff" | "runtimeMode" | "interactionMode"
  > | null;
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
    <>
      <DispatcherRouteStatus
        projectTitle={project.title}
        state={state}
        providers={props.providers}
        boundRoute={boundRoute}
      />
      {props.handoffAvailable === true && props.thread ? (
        <DispatcherHandoffControl
          environmentId={environmentId}
          providers={props.providers}
          thread={props.thread}
        />
      ) : null}
    </>
  );
}

export function DispatcherHandoffControl(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly thread: Pick<
    OrchestrationThread,
    "id" | "latestTurn" | "latestRoute" | "latestHandoff" | "runtimeMode" | "interactionMode"
  >;
}) {
  const sourceTurn = props.thread.latestTurn;
  const sourceRoute = props.thread.latestRoute;
  const handoff = props.thread.latestHandoff ?? null;
  const options = useMemo(
    () =>
      sourceRoute
        ? dispatcherHandoffTargetOptions(props.providers, sourceRoute.binding.target.instanceId)
        : [],
    [props.providers, sourceRoute],
  );
  const [open, setOpen] = useState(false);
  const [targetKey, setTargetKey] = useState("");
  const [preview, setPreview] = useState<DispatcherHandoffPreview | null>(null);
  const [packetText, setPacketText] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "creating" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const submitInFlight = useRef(false);
  const runPreview = useAtomCommand(dispatcherEnvironment.previewHandoff, {
    reportFailure: false,
    reportDefect: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
    reportDefect: false,
  });
  const selected = options.find(
    (option) => `${option.target.instanceId}\u0000${option.target.model}` === targetKey,
  );
  const firstOptionKey = options[0]
    ? `${options[0].target.instanceId}\u0000${options[0].target.model}`
    : "";

  useEffect(() => {
    if (!open || selected === undefined || sourceTurn === null) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setPreview(null);
    setError(null);
    void runPreview({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        threadId: props.thread.id,
        sourceTurnId: sourceTurn.turnId,
        target: selected.target,
      },
    }).then((result) => {
      if (requestGeneration.current !== generation) return;
      setLoading(false);
      if (result._tag === "Failure") {
        const failure = Cause.squash(result.cause);
        setError(failure instanceof Error ? failure.message : "Handoff preview is unavailable.");
        return;
      }
      setPreview(result.value);
      setPacketText(result.value.packetText);
    });
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [open, props.environmentId, props.thread.id, runPreview, selected, sourceTurn]);

  if (handoff !== null) {
    const route = options.find(
      (option) =>
        option.target.instanceId === handoff.target.instanceId &&
        option.target.model === handoff.target.model,
    );
    const label = route
      ? `${route.providerLabel} · ${route.modelLabel}`
      : `${handoff.target.instanceId} · ${handoff.target.model}`;
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant={handoff.status === "failed" ? "warning" : "info"}>
          <ComposerBanner.Row>
            <ComposerBanner.Icon>
              <ArrowRightLeftIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="flex min-w-0 flex-col py-0.5">
                <span className="font-medium text-foreground">
                  {handoff.status === "creating"
                    ? "Creating provider continuation…"
                    : handoff.status === "continued"
                      ? "Continued with another provider"
                      : "Provider continuation failed"}
                </span>
                <span className="truncate text-muted-foreground">{label}</span>
                {handoff.failureReason ? (
                  <span className="text-muted-foreground">{handoff.failureReason}</span>
                ) : null}
              </span>
            </ComposerBanner.Content>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  if (
    sourceTurn === null ||
    sourceRoute === null ||
    sourceRoute === undefined ||
    sourceTurn.state === "running"
  ) {
    return null;
  }

  if (!open) {
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root>
          <ComposerBanner.Row>
            <ComposerBanner.Icon>
              <ArrowRightLeftIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              Continue this task with another provider.
            </ComposerBanner.Content>
            <Button
              size="sm-multiline"
              variant="outline"
              onClick={() => {
                setTargetKey(firstOptionKey);
                setOpen(true);
              }}
            >
              Continue with another provider
            </Button>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  const submit = async () => {
    if (
      submitInFlight.current ||
      selected === undefined ||
      preview?.availability.status !== "ready" ||
      packetText.trim().length === 0
    ) {
      return;
    }
    submitInFlight.current = true;
    setSubmitState("creating");
    setError(null);
    const createdAt = new Date().toISOString();
    const messageId = newMessageId();
    const result = await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.thread.id,
        message: { messageId, role: "user", text: packetText, attachments: [] },
        modelSelection: selected.target,
        runtimeMode: props.thread.runtimeMode,
        interactionMode: props.thread.interactionMode,
        handoffRequest: {
          handoffId: preview.handoffId,
          sourceTurnId: sourceTurn.turnId,
          target: selected.target,
          packetText,
        },
        createdAt,
      },
    });
    submitInFlight.current = false;
    if (result._tag === "Failure") {
      setSubmitState("failed");
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : "Could not create the handoff.");
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant={error ? "warning" : "info"} density="spacious">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <ArrowRightLeftIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
              <div>
                <div className="font-medium text-foreground">Continue with another provider</div>
                <div className="text-muted-foreground">
                  Preview only. The destination route is not bound until you continue.
                </div>
              </div>
              <select
                aria-label="Destination provider and model"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                value={targetKey}
                onChange={(event) => setTargetKey(event.target.value)}
                disabled={submitState === "creating"}
              >
                {options.length === 0 ? <option value="">No other runner configured</option> : null}
                {options.map((option) => {
                  const key = `${option.target.instanceId}\u0000${option.target.model}`;
                  return (
                    <option key={key} value={key}>
                      {option.providerLabel} · {option.modelLabel}
                      {option.available ? "" : ` — ${option.unavailableReason}`}
                    </option>
                  );
                })}
              </select>
              {loading ? (
                <div className="text-muted-foreground">Preparing verified context…</div>
              ) : null}
              {preview?.availability.status === "unavailable" ? (
                <div className="text-warning-foreground">{preview.availability.reason}</div>
              ) : null}
              {preview ? (
                <Textarea
                  aria-label="Editable handoff packet"
                  value={packetText}
                  onChange={(event) => setPacketText(event.target.value)}
                  disabled={submitState === "creating"}
                />
              ) : null}
              {error ? <div role="alert">{error}</div> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={submitState === "creating"}
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  disabled={
                    submitState === "creating" ||
                    preview?.availability.status !== "ready" ||
                    packetText.trim().length === 0
                  }
                  onClick={() => void submit()}
                >
                  {submitState === "creating" ? "Creating…" : "Continue and bind route"}
                </Button>
              </div>
            </div>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
