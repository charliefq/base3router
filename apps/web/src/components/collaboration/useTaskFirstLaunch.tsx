import { useLayoutEffect, useRef, useState, useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type CollaborationTask,
  type TaskContractReviewState,
  type OrchestrationV2AppThread,
  type TaskFirstLaunch,
  type TaskContinuationResult,
  type ModelSelection,
  type TaskFirstLaunchStatus,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { primaryServerProvidersAtom } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { randomUUID } from "../../lib/utils";
import { providerExecutable } from "./agentDirectory";
import { Button } from "../ui/button";
import {
  readFirstLaunchAttempt,
  writeFirstLaunchAttempt,
  clearRejectedFirstLaunchAttempt,
  firstLaunchStorageKey,
  continuationStorageKey,
  retireCompletedContinuationAttempt,
  type FirstLaunchAttempt,
} from "./taskFirstLaunchAttempt";
type Review = Extract<TaskContractReviewState, { status: "available" }>;
type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

/** Ordinary chat launch and durable, read-only reconciliation; capability review owns its own action. */
export function useTaskFirstLaunch(props: {
  environmentId: EnvironmentId;
  task: CollaborationTask;
  facts: Review | null;
  thread: OrchestrationV2AppThread | null;
  text: string;
  stale: boolean;
  onOpen: () => void;
  resultBound?: boolean;
  priorResult?: TaskContinuationResult | null;
}) {
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const readStatus = useAtomCommand(
    props.resultBound
      ? threadEnvironment.readResultContinuationStatus
      : threadEnvironment.readFirstLaunchStatus,
    {
      reportFailure: false,
    },
  );
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const providers = useAtomValue(primaryServerProvidersAtom);
  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const options = useMemo(() => new Map(entries.map((e) => [e.instanceId, e.models])), [entries]);
  const key = (props.resultBound ? continuationStorageKey : firstLaunchStorageKey)(
    props.environmentId,
    props.task.threadId ?? "missing",
  );
  const [saved, setSaved] = useState(() => readFirstLaunchAttempt(key));
  const [mode, setMode] = useState<"manual" | "auto" | null>(null);
  const [manualChoice, setManual] = useState<ModelSelection | null>(null);
  const manual = manualChoice ?? props.thread?.modelSelection ?? null;
  type LaunchReview = TaskFirstLaunch & { readonly priorResult?: TaskContinuationResult };
  const [reviewed, setReviewed] = useState<{ key: string; value: LaunchReview } | null>(null);
  const [status, setStatus] = useState<TaskFirstLaunchStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(false);
  const latest = useRef(props);
  const context = useRef({ key, session });
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      pending.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (context.current.key !== key || context.current.session !== session) {
      const changedScope = context.current.key !== key;
      context.current = { key, session };
      epoch.current++;
      pending.current = false;
      setBusy(false);
      setReviewed(null);
      setStatus(null);
      setNotice(null);
      const retained = readFirstLaunchAttempt(key);
      setSaved(
        retained.attempt
          ? {
              ...retained,
              attempt: {
                ...retained.attempt,
                status: retained.attempt.status === "rejected" ? "rejected" : "unknown",
              },
            }
          : retained,
      );
      if (changedScope) {
        setMode(null);
        setManual(null);
      }
    }
  }, [key, session]);
  const reviewKey = JSON.stringify([
    key,
    props.text,
    mode,
    manual,
    props.facts?.reference,
    props.facts?.contract,
    props.stale,
    props.priorResult,
  ]);
  const review = reviewed?.key === reviewKey ? reviewed.value : null;
  const setReview = (value: LaunchReview | null) =>
    setReviewed(value === null ? null : { key: reviewKey, value });
  const current = (generation: number) =>
    mounted.current &&
    epoch.current === generation &&
    context.current.key === key &&
    context.current.session === session &&
    session !== null;
  const store = (attempt: FirstLaunchAttempt) => {
    writeFirstLaunchAttempt(key, attempt);
    setSaved({ attempt, error: null });
  };
  const reconcile = async (command: Dispatch, generation: number, open: boolean) => {
    const result = await readStatus({ environmentId: props.environmentId, input: { command } });
    if (!current(generation)) return;
    const proof: TaskFirstLaunchStatus =
      result._tag === "Success"
        ? result.value
        : { status: "unknown", reason: "Admission outcome could not be read. Do not resend." };
    setStatus(proof);
    const next: FirstLaunchAttempt = {
      command,
      status:
        proof.status === "admitted"
          ? "admitted"
          : proof.status === "rejected"
            ? "rejected"
            : "unknown",
    };
    try {
      store(next);
    } catch {
      setSaved({
        attempt: next,
        error:
          "Original identity retained in memory; recovery storage could not be updated. No resend.",
      });
    }
    if (proof.status === "admitted") {
      setNotice("Original launch admitted. Admission is not model completion or task acceptance.");
      if (open && !props.resultBound) latest.current.onOpen();
    } else setNotice(proof.reason);
  };
  const submit = async () => {
    if (
      !review ||
      pending.current ||
      session === null ||
      props.stale ||
      (props.resultBound && !review.priorResult)
    )
      return;
    const existing = readFirstLaunchAttempt(key);
    if (existing.error || existing.attempt) {
      setSaved(existing);
      setNotice(
        existing.error ??
          "An original launch identity is retained. Read its status; no replacement was allocated.",
      );
      setReview(null);
      return;
    }
    const command: Dispatch = {
      type: "message.dispatch",
      commandId: review.commandId,
      threadId: review.threadId,
      messageId: review.messageId,
      text: review.text,
      attachments: [],
      modelSelection: review.modelSelection,
      routingMode: review.routingMode,
      ...(props.resultBound && review.priorResult
        ? { taskResultContinuation: { ...review, priorResult: review.priorResult } }
        : { taskFirstLaunch: review }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    };
    try {
      store({ status: "pending", command });
    } catch {
      setNotice("Recovery storage could not retain the original command. Nothing was sent.");
      return;
    }
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    setReview(null);
    setNotice(null);
    try {
      await start({
        environmentId: props.environmentId,
        input: {
          commandId: command.commandId,
          threadId: command.threadId,
          message: {
            messageId: command.messageId,
            role: "user",
            text: command.text,
            attachments: [],
          },
          modelSelection: review.modelSelection,
          routingMode: review.routingMode,
          dispatchMode: "start",
          runtimeMode: review.runtimeMode,
          interactionMode: review.interactionMode,
          ...(command.taskResultContinuation
            ? { taskResultContinuation: command.taskResultContinuation }
            : { taskFirstLaunch: review }),
        },
      });
      if (current(generation)) await reconcile(command, generation, false);
    } catch {
      if (current(generation)) {
        const next: FirstLaunchAttempt = { command, status: "unknown" };
        try {
          store(next);
        } catch {
          setSaved({ attempt: next, error: "Recovery storage unavailable; do not resend." });
        }
        setNotice(
          "Launch outcome UNKNOWN. Read original launch status; no automatic retry or replacement identity was sent.",
        );
      }
    } finally {
      if (current(generation)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const recover = async () => {
    const retained = readFirstLaunchAttempt(key);
    if (retained.error || !retained.attempt || pending.current || session === null) {
      setSaved(retained);
      return;
    }
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    try {
      await reconcile(retained.attempt.command, generation, false);
    } catch {
      if (current(generation)) setNotice("Original launch remains UNKNOWN. No resend was sent.");
    } finally {
      if (current(generation)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const selected = manual ? providers.find((p) => p.instanceId === manual.instanceId) : undefined;
  const manualReady =
    manual !== null &&
    selected !== undefined &&
    providerExecutable(selected) &&
    selected.models.some((m) => m.slug === manual.model);
  const available =
    (!props.resultBound || (props.priorResult !== null && props.priorResult !== undefined)) &&
    props.facts !== null &&
    props.thread !== null &&
    !props.stale &&
    session !== null &&
    !saved.error &&
    !saved.attempt;
  const recovery = (
    <section aria-label="Original task launch">
      {saved.error ? <p role="alert">{saved.error}</p> : null}
      {saved.attempt ? (
        <>
          <p>
            Original command {saved.attempt.command.commandId}; message{" "}
            {saved.attempt.command.messageId}. Outcome:{" "}
            {status?.status ?? "UNKNOWN until reconciled"}. No automatic resend.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || session === null}
            onClick={() => void recover()}
          >
            {props.resultBound
              ? "Read original continuation status"
              : "Read original launch status"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || session === null}
            onClick={props.onOpen}
          >
            Open original conversation and results
          </Button>
          {status?.status === "admitted" ? (
            <p>
              Run {status.runId}; attempt {status.attemptId}; model{" "}
              {status.actualModelSelection.instanceId} / {status.actualModelSelection.model}; run
              status {status.runStatus}. {status.resultPreview}
            </p>
          ) : null}
          {props.resultBound &&
          status?.status === "admitted" &&
          status.runStatus === "completed" &&
          props.priorResult?.runId === status.runId &&
          props.facts &&
          !props.stale ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || session === null}
              onClick={() => {
                try {
                  retireCompletedContinuationAttempt(key, saved.attempt!.command.commandId);
                  setSaved({ attempt: null, error: null });
                  setStatus(null);
                  setReview(null);
                  setMode(null);
                  setManual(null);
                  setNotice(
                    "Original completed continuation retained in task history. Review another request explicitly.",
                  );
                } catch {
                  setNotice("Original continuation could not be retired safely.");
                }
              }}
            >
              Review changes on latest result
            </Button>
          ) : null}
          {saved.attempt.status === "rejected" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  clearRejectedFirstLaunchAttempt(key);
                  setSaved({ attempt: null, error: null });
                  setStatus(null);
                  setReview(null);
                  setNotice(
                    "Original rejected identity retired. Prepare and review a new launch explicitly.",
                  );
                } catch {
                  setNotice("Unresolved identity cannot be replaced.");
                }
              }}
            >
              Review a new launch after rejection
            </Button>
          ) : null}
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
  const controls = (
    <section aria-label="Ordinary governed task launch">
      <p>
        {props.resultBound
          ? "Ordinary requested changes on the exact completed result. No contract, acceptance, configuration or capability mutation."
          : "Ordinary model turn — choose and review separately from the saved-PR operation below. Unsupported saved-PR suggestions never start this path automatically."}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!available || busy}
          onClick={() => setMode("manual")}
        >
          Choose Manual
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!available || busy}
          onClick={() => setMode("auto")}
        >
          Choose Auto
        </Button>
      </div>
      {manual && mode ? (
        <ProviderModelPicker
          activeInstanceId={manual.instanceId}
          model={manual.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          routingMode={mode}
          onRoutingModeChange={setMode}
          disabled={!available || busy}
          onInstanceModelChange={(instanceId, model) => {
            setManual((previous) =>
              previous?.instanceId === instanceId && previous.model === model
                ? previous
                : { instanceId, model },
            );
            setMode("manual");
          }}
        />
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={
          !available ||
          busy ||
          !mode ||
          !manual ||
          !props.text.trim() ||
          (mode === "manual" && !manualReady)
        }
        onClick={() => {
          if (!available || !props.facts || !props.thread || !mode || !manual) return;
          const commandId = CommandId.make(randomUUID());
          const messageId = MessageId.make(randomUUID());
          setReview({
            commandId,
            messageId,
            threadId: props.thread.id,
            reference: props.facts.reference,
            contract: props.facts.contract,
            text: props.text,
            routingMode: mode,
            modelSelection: manual,
            runtimeMode: props.thread.runtimeMode,
            interactionMode: props.thread.interactionMode,
            ...(props.resultBound && props.priorResult ? { priorResult: props.priorResult } : {}),
          });
        }}
      >
        {props.resultBound ? "Review result continuation" : "Review ordinary task launch"}
      </Button>
      {review ? (
        <div aria-label="Reviewed ordinary task launch">
          <p>Exact instructions: {review.text}</p>
          <p>
            Task {review.reference.taskId}; project {review.reference.projectId}; environment{" "}
            {review.reference.environmentId}; contract revision {review.contract.revision}. Goal:{" "}
            {review.contract.goal}. Redirect: {review.contract.redirect}. Acceptance:{" "}
            {review.contract.acceptance}.
          </p>
          <p>
            Mode: {review.routingMode}.{" "}
            {review.routingMode === "manual"
              ? `Explicit provider/model: ${review.modelSelection.instanceId} / ${review.modelSelection.model}`
              : "Auto recalculates its authoritative route at dispatch; any preview is advisory, not a locked target or optimality guarantee."}
          </p>
          <p>
            Provider start cap {review.contract.brake.maxProviderStarts}; token cap{" "}
            {review.contract.brake.maxTokens ?? "not declared"}; cost cap{" "}
            {review.contract.brake.maxCostUsd ?? "not declared"}; deadline{" "}
            {review.contract.brake.deadlineAt ?? "not declared"}; stop conditions{" "}
            {review.contract.brake.stopConditions}. No contract acceptance or capability guarantee.
          </p>
          <Button
            size="sm"
            disabled={!available || busy || (review.routingMode === "manual" && !manualReady)}
            onClick={() => void submit()}
          >
            {props.resultBound
              ? "Start reviewed result continuation"
              : "Start reviewed ordinary task"}
          </Button>
        </div>
      ) : null}
    </section>
  );
  return {
    controls,
    recovery,
    busy,
    reviewed: review !== null,
    hasOriginal: saved.attempt !== null || saved.error !== null,
  };
}
