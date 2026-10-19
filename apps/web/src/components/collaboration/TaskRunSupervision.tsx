import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  CommandId,
  ThreadId,
  OrchestrationV2Command,
  type CollaborationTask,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";

type StopCommand = Extract<OrchestrationV2Command, { type: "run.interrupt" }>;
const recordSchema = Schema.Struct({
  command: OrchestrationV2Command,
  status: Schema.Literals(["unknown", "requested"]),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(recordSchema));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(recordSchema));
type StopRecord = { command: StopCommand; status: "unknown" | "requested" };
const active = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";
const stamp = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.toEpochMillis(value) : null;
function evidenceKey(projection: OrchestrationV2ThreadProjection | null) {
  if (!projection) return "missing";
  const run = projection.runs.at(-1);
  const turn = projection.providerTurns.at(-1);
  const message = projection.messages.findLast(
    (item) => item.runId === run?.id && item.role === "assistant" && !item.streaming,
  );
  const item = projection.turnItems.findLast(
    (item) =>
      item.runId === run?.id &&
      (item.type === "error" || (item.type === "assistant_message" && !item.streaming)),
  );
  return JSON.stringify([
    projection.thread.id,
    projection.thread.projectId,
    projection.thread.deletedAt,
    run?.id,
    run?.activeAttemptId,
    run?.status,
    stamp(run?.completedAt),
    turn?.id,
    turn?.status,
    turn?.terminationConfirmed,
    projection.attempts
      .filter((attempt) => attempt.runId === run?.id)
      .map((attempt) => [attempt.id, attempt.status, stamp(attempt.completedAt)]),
    projection.nodes
      .filter(
        (node) =>
          node.runId === run?.id &&
          (node.kind === "root_turn" || node.kind === "assistant_message"),
      )
      .map((node) => [node.id, node.status, stamp(node.startedAt), stamp(node.completedAt)]),
    message?.id,
    stamp(message?.updatedAt),
    item?.id,
    stamp(item?.updatedAt),
  ]);
}
function readRecord(
  key: string,
  scope: string,
  exactTarget = false,
): { record: StopRecord | null; error: string | null } {
  try {
    if (!globalThis.localStorage)
      return {
        record: null,
        error:
          "Recovery storage is unavailable. Stop outcome UNKNOWN; no new Stop will be submitted.",
      };
    const raw = globalThis.localStorage.getItem(key);
    if (!raw) return { record: null, error: null };
    const value = decodeRecord(raw);
    if (
      Option.isNone(value) ||
      value.value.command.type !== "run.interrupt" ||
      !value.value.command.expectedAttemptId ||
      (exactTarget &&
        key !==
          `task-stop-v1:${scope}:${value.value.command.runId}:${value.value.command.expectedAttemptId}`) ||
      (Option.isSome(value) && value.value.command.threadId !== JSON.parse(scope)[3])
    )
      return { record: null, error: "Original Stop identity is unreadable. No resend is allowed." };
    return { record: { ...value.value, command: value.value.command }, error: null };
  } catch {
    return {
      record: null,
      error: "Original Stop recovery storage could not be read. No resend is allowed.",
    };
  }
}
function targetOutcome(
  record: StopRecord,
  projection: OrchestrationV2ThreadProjection | null,
  live: boolean,
) {
  if (!live || !projection) return "Stop outcome UNKNOWN while the shared projection is stale.";
  const command = record.command;
  const run = projection.runs.find((run) => run.id === command.runId);
  const attempt = projection.attempts.find(
    (attempt) => attempt.id === command.expectedAttemptId && attempt.runId === command.runId,
  );
  const latest = projection.attempts.findLast((attempt) => attempt.runId === command.runId);
  if (
    !run ||
    !attempt ||
    latest?.id !== attempt.id ||
    (run.activeAttemptId !== null && run.activeAttemptId !== attempt.id)
  )
    return "Original target is missing or superseded. Stop outcome UNKNOWN; no newer attempt was targeted.";
  if (run.status === "completed")
    return "Target run completed. Completion won; this is not Stop confirmation or owner acceptance.";
  if (run.status === "failed")
    return "Target run failed. This is the actual outcome, not Stop confirmation or owner acceptance.";
  if (run.status === "interrupted" || run.status === "cancelled") {
    const turn = projection.providerTurns.findLast((turn) => turn.runAttemptId === attempt.id);
    if (!turn)
      return "Target run is terminal with no provider-turn start available. Native termination remains UNKNOWN; owner acceptance is unchanged.";
    if (
      (turn.status === "interrupted" || turn.status === "cancelled") &&
      turn.terminationConfirmed === true
    )
      return "Matching target interruption confirmed. Owner acceptance is unchanged.";
    return "Target run is terminal; native termination remains UNKNOWN.";
  }
  return record.status === "requested"
    ? "Stop requested. Matching terminal interruption is not confirmed."
    : "Stop outcome UNKNOWN. Reconcile the original target; do not resend.";
}

export function TaskRunSupervision(props: {
  task: CollaborationTask;
  environmentId: EnvironmentId;
  enabled: boolean;
  live: boolean;
  stale: boolean;
  changed: () => void;
  observe: (node: Element | null, id: string, previous: Element | null) => void;
}) {
  const threadId = props.task.threadId ? ThreadId.make(props.task.threadId) : null;
  const state = useEnvironmentThread(
    props.enabled ? props.environmentId : null,
    props.enabled ? threadId : null,
  );
  const projection = Option.getOrNull(state.data);
  const detailLive = props.live && state.status === "live" && Option.isNone(state.error);
  const signature = `${state.status}:${Option.getOrNull(state.error)}:${evidenceKey(projection)}`;
  const changed = props.changed;
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current !== signature) {
      previous.current = signature;
      changed();
    }
  }, [signature, changed]);
  const node = useRef<Element | null>(null);
  const observe = props.observe;
  const attach = useCallback(
    (element: HTMLElement | null) => {
      if (threadId) observe(element, threadId, node.current);
      node.current = element;
    },
    [observe, threadId],
  );
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const selectedRun =
    projection?.runs.findLast((run) => active(run.status)) ??
    projection?.runs.findLast((run) => run.status !== "queued");
  const selectedAttempt =
    selectedRun?.activeAttemptId ??
    projection?.attempts.findLast((attempt) => attempt.runId === selectedRun?.id)?.id;
  const scope = JSON.stringify([
    props.environmentId,
    props.task.projectId,
    props.task.id,
    threadId,
  ]);
  const key = `task-stop-v1:${scope}:${selectedRun?.id ?? "missing"}:${selectedAttempt ?? "missing"}`;
  const recoveryKey = `task-stop-latest-v1:${scope}`;
  const token = useMemo(() => ({ key, session }), [key, session]);
  const [saved, setSaved] = useState<{ record: StopRecord | null; error: string | null }>({
    record: null,
    error: null,
  });
  const [last, setLast] = useState<StopRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef({ epoch: 0, pending: false, sent: false, key, scope, session });
  const latest = useRef({ props, detailLive, projection, key, session, token });
  useLayoutEffect(() => {
    latest.current = { props, detailLive, projection, key, session, token };
  });
  useLayoutEffect(() => {
    const current = operation.current;
    current.epoch++;
    current.pending = false;
    if (current.scope !== scope) setLast(null);
    current.key = key;
    current.scope = scope;
    current.session = session;
    const value = readRecord(key, scope, true);
    const prior = readRecord(recoveryKey, scope);
    current.sent = value.record !== null || value.error !== null;
    // Synchronize the durable identity when an external session/target changes.
    // eslint-disable-next-line react/set-state-in-effect
    setSaved({ record: value.record, error: value.error ?? prior.error });
    current.sent ||= prior.error !== null;
    if (value.record ?? prior.record) setLast(value.record ?? prior.record);
    setBusy(false);
    setNotice(null);
    return () => {
      current.epoch++;
    };
  }, [key, scope, session, recoveryKey]);
  const writable =
    props.task.review?.reference.environmentId === props.environmentId &&
    props.task.review.supportsExpectedRunInterrupt === true;
  const matchingAttempt = projection?.attempts.find(
    (attempt) => attempt.id === selectedAttempt && attempt.runId === selectedRun?.id,
  );
  const matchingTurn = projection?.providerTurns.findLast(
    (turn) => turn.runAttemptId === selectedAttempt,
  );
  const eligible =
    detailLive &&
    !props.stale &&
    session !== null &&
    writable &&
    projection?.thread.id === threadId &&
    projection.thread.projectId === props.task.projectId &&
    projection.thread.taskGovernance === "required" &&
    projection.thread.deletedAt === null &&
    projection.thread.archivedAt === null &&
    selectedRun &&
    active(selectedRun.status) &&
    selectedAttempt &&
    matchingAttempt &&
    (matchingTurn ? matchingTurn.status === "running" : selectedRun.status !== "running");
  const persist = (record: StopRecord) => {
    const encoded = encodeRecord(record);
    globalThis.localStorage.setItem(key, encoded);
    globalThis.localStorage.setItem(recoveryKey, encoded);
    if (
      globalThis.localStorage.getItem(key) !== encoded ||
      globalThis.localStorage.getItem(recoveryKey) !== encoded
    )
      throw new Error("Original Stop identity was not retained");
    setSaved({ record, error: null });
    setLast(record);
  };
  const owns = (epoch: number) =>
    operation.current.epoch === epoch &&
    operation.current.key === key &&
    operation.current.session === session;
  const stop = async () => {
    if (
      latest.current.token !== token ||
      latest.current.session !== session ||
      latest.current.props.task.review?.reference.environmentId !== props.environmentId ||
      latest.current.props.task.review.supportsExpectedRunInterrupt !== true ||
      !eligible ||
      !selectedRun ||
      !selectedAttempt ||
      !threadId ||
      operation.current.pending ||
      operation.current.sent ||
      latest.current.key !== key ||
      !latest.current.detailLive ||
      latest.current.props.stale
    )
      return;
    operation.current.pending = true;
    setBusy(true);
    setNotice(null);
    const epoch = ++operation.current.epoch;
    const command: StopCommand = {
      type: "run.interrupt",
      commandId: CommandId.make(`task_stop_${randomUUID().replaceAll("-", "")}`),
      threadId,
      runId: selectedRun.id,
      expectedAttemptId: selectedAttempt,
      holdQueue: true,
    };
    try {
      persist({ command, status: "unknown" });
      operation.current.sent = true;
      const result = await interrupt({
        environmentId: props.environmentId,
        input: {
          commandId: command.commandId,
          threadId,
          runId: command.runId,
          expectedAttemptId: command.expectedAttemptId!,
        },
      });
      if (!owns(epoch)) return;
      if (result._tag === "Success") persist({ command, status: "requested" });
      else setNotice("Stop outcome UNKNOWN or rejected. Original identity retained; no resend.");
      props.changed();
    } catch {
      if (owns(epoch))
        setNotice(
          operation.current.sent
            ? "Stop outcome UNKNOWN. Original identity retained; no resend."
            : "Recovery storage failed before submission. No Stop was sent.",
        );
    } finally {
      if (owns(epoch)) {
        operation.current.pending = false;
        setBusy(false);
      }
    }
  };
  const reconcile = async () => {
    if (
      latest.current.token !== token ||
      !latest.current.props.live ||
      !last ||
      !props.live ||
      session === null ||
      operation.current.pending
    )
      return;
    operation.current.pending = true;
    setBusy(true);
    const epoch = ++operation.current.epoch;
    try {
      const result = await readProjection({
        environmentId: props.environmentId,
        input: { threadId: last.command.threadId },
      });
      if (!owns(epoch)) return;
      setNotice(
        result._tag === "Success"
          ? targetOutcome(last, result.value, true)
          : "Stop outcome UNKNOWN. Projection read failed; no resend.",
      );
      props.changed();
    } catch {
      if (owns(epoch)) setNotice("Stop outcome UNKNOWN. Projection read failed; no resend.");
    } finally {
      if (owns(epoch)) {
        operation.current.pending = false;
        setBusy(false);
      }
    }
  };
  return (
    <section ref={attach} aria-label="Task live supervision" className="mt-4 space-y-2 text-sm">
      <h3 className="font-medium">Live task supervision</h3>
      <p>
        {!props.enabled
          ? "Scroll this task into view to supervise its run."
          : !detailLive
            ? "Stale / UNKNOWN while the linked thread synchronizes. Unsafe controls are disabled."
            : `Observed run: ${selectedRun?.id ?? "none"} · ${selectedRun?.status ?? "idle"} · attempt ${selectedAttempt ?? "not recorded"}`}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={!eligible || busy || Boolean(saved.record || saved.error)}
        onClick={() => void stop()}
      >
        Stop task run
      </Button>
      {props.task.review && !props.task.review.supportsExpectedRunInterrupt ? (
        <p>
          This server has not advertised guarded Stop support. Open conversation for available
          controls.
        </p>
      ) : null}
      {saved.error ? <p role="alert">{saved.error}</p> : null}
      {last ? (
        <>
          <p>
            Original Stop {last.command.commandId} · run {last.command.runId} · attempt{" "}
            {last.command.expectedAttemptId}
          </p>
          <p role="status">{targetOutcome(last, projection, detailLive)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !props.live || session === null}
            onClick={() => void reconcile()}
          >
            Reconcile original Stop
          </Button>
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <p className="text-xs text-muted-foreground">
        Stop requests interruption of this target. It does not accept or pause the contract, clear
        or resume the queue. Open conversation remains available.
      </p>
    </section>
  );
}
