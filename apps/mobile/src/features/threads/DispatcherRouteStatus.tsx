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
  ModelSelection,
  OrchestrationThreadShell,
  ProjectId,
  ServerProvider,
} from "@t3tools/contracts";
import { MessageId } from "@t3tools/contracts";
import { dispatcherHandoffTargetOptions } from "@t3tools/client-runtime/handoff";
import * as Cause from "effect/Cause";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { dispatcherEnvironment } from "../../state/dispatcher";
import { threadEnvironment } from "../../state/threads";
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
  readonly handoffAvailable?: boolean;
  readonly thread?: Pick<
    OrchestrationThreadShell,
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

function DispatcherHandoffControl(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly thread: Pick<
    OrchestrationThreadShell,
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState<DispatcherHandoffPreview | null>(null);
  const [packetText, setPacketText] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const submitInFlight = useRef(false);
  const runPreview = useAtomCommand(dispatcherEnvironment.previewHandoff, {
    reportFailure: false,
    reportDefect: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const selected = options[selectedIndex];

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
      <View className="mx-1 mb-2 rounded-2xl border border-composer-border bg-composer-surface px-3 py-2">
        <Text className="text-xs font-t3-bold text-foreground">
          {handoff.status === "creating"
            ? "Creating provider continuation…"
            : handoff.status === "continued"
              ? "Continued with another provider"
              : "Provider continuation failed"}
        </Text>
        <Text className="text-xs text-foreground-muted">{label}</Text>
        {handoff.failureReason ? (
          <Text className="text-xs text-warning-foreground">{handoff.failureReason}</Text>
        ) : null}
      </View>
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
      <Pressable
        accessibilityRole="button"
        className="mx-1 mb-2 rounded-2xl border border-composer-border bg-composer-surface px-3 py-2"
        onPress={() => setOpen(true)}
      >
        <Text className="text-xs font-t3-bold text-foreground">Continue with another provider</Text>
        <Text className="text-xs text-foreground-muted">Continue this same task explicitly.</Text>
      </Pressable>
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
    setCreating(true);
    setError(null);
    const createdAt = new Date().toISOString();
    const result = await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.thread.id,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: packetText,
          attachments: [],
        },
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
    setCreating(false);
    if (result._tag === "Failure") {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : "Could not create the handoff.");
    }
  };

  return (
    <View className="mx-1 mb-2 gap-2 rounded-2xl border border-composer-border bg-composer-surface px-3 py-3">
      <Text className="text-xs font-t3-bold text-foreground">Continue with another provider</Text>
      <Text className="text-xs text-foreground-muted">
        Preview only. The route is not bound until you continue.
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        {options.map((option, index) => (
          <Pressable
            key={`${option.target.instanceId}:${option.target.model}`}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedIndex === index }}
            className={`rounded-full border px-3 py-2 ${
              selectedIndex === index ? "border-accent-focus bg-accent" : "border-composer-border"
            }`}
            disabled={creating}
            onPress={() => setSelectedIndex(index)}
          >
            <Text className="text-xs text-foreground">
              {option.providerLabel} · {option.modelLabel}
            </Text>
            {!option.available ? (
              <Text className="text-2xs text-foreground-muted">{option.unavailableReason}</Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
      {options.length === 0 ? (
        <Text className="text-xs text-warning-foreground">No other runner is configured.</Text>
      ) : null}
      {loading ? (
        <Text className="text-xs text-foreground-muted">Preparing verified context…</Text>
      ) : null}
      {preview?.availability.status === "unavailable" ? (
        <Text className="text-xs text-warning-foreground">{preview.availability.reason}</Text>
      ) : null}
      {preview ? (
        <TextInput
          accessibilityLabel="Editable handoff packet"
          multiline
          value={packetText}
          onChangeText={setPacketText}
          editable={!creating}
          className="min-h-48 text-sm"
        />
      ) : null}
      {error ? <Text className="text-xs text-warning-foreground">{error}</Text> : null}
      <View className="flex-row justify-end gap-2">
        <Pressable
          className="rounded-full px-3 py-2"
          disabled={creating}
          onPress={() => setOpen(false)}
        >
          <Text className="text-xs text-foreground-muted">Cancel</Text>
        </Pressable>
        <Pressable
          className="rounded-full bg-accent px-3 py-2 disabled:opacity-50"
          disabled={
            creating || preview?.availability.status !== "ready" || packetText.trim().length === 0
          }
          onPress={() => void submit()}
        >
          <Text className="text-xs font-t3-bold text-foreground">
            {creating ? "Creating…" : "Continue and bind route"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
