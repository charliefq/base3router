import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import {
  TASK_RESULT_HANDOFF_MAX_CHARS,
  TASK_RESULT_HANDOFF_MAX_BYTES,
  ThreadId,
  type CollaborationTask,
  type EnvironmentId,
  type TaskResultHandoff,
  type TaskResultHandoffDelivery,
  type TaskContractReviewInput,
  type TaskContractReviewState,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  acceptedResultFacts,
  hasAcceptedOutput,
  resultHandoffReference,
} from "@t3tools/shared/taskResultHandoff";
import {
  revisionSnapshotTask,
  sameRevisionTask,
  sameRevisionReview,
  sameRevisionProjection,
} from "@t3tools/shared/taskRevisionRequest";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { usePreparedConnection } from "../../state/session";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";

const readHandoffSnapshot = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.snapshot({ headers: {} })),
    ),
  );
type ReadReview = (input: {
  environmentId: EnvironmentId;
  input: TaskContractReviewInput;
}) => Promise<{ _tag: "Success"; value: TaskContractReviewState } | { _tag: "Failure" }>;
type ReadProjection = (input: {
  environmentId: EnvironmentId;
  input: { threadId: ThreadId };
}) => Promise<{ _tag: "Success"; value: OrchestrationV2ThreadProjection } | { _tag: "Failure" }>;

export async function readFreshHandoff(
  environmentId: EnvironmentId,
  taskId: string,
  readReview: ReadReview,
  readProjection: ReadProjection,
) {
  const before = await readHandoffSnapshot();
  const task = before.tasks.find((t) => t.id === taskId);
  if (!task?.threadId || task.contractReadout?.status !== "available") return null;
  const input = {
    environmentId,
    taskId: task.id,
    projectId: task.projectId,
    threadId: task.threadId,
    revision: task.contractReadout.contract.revision,
  };
  const first = await readReview({ environmentId, input });
  const a = await readProjection({
    environmentId,
    input: { threadId: ThreadId.make(task.threadId) },
  });
  const b = await readProjection({
    environmentId,
    input: { threadId: ThreadId.make(task.threadId) },
  });
  const after = revisionSnapshotTask(await readHandoffSnapshot(), environmentId, task);
  const last = await readReview({ environmentId, input });
  if (
    !after ||
    !sameRevisionTask(task, after) ||
    first._tag !== "Success" ||
    last._tag !== "Success" ||
    a._tag !== "Success" ||
    b._tag !== "Success" ||
    !sameRevisionReview(first.value, last.value) ||
    !sameRevisionProjection(a.value, b.value)
  )
    return null;
  const facts = acceptedResultFacts(after, environmentId, last.value, b.value);
  return facts ? resultHandoffReference(facts) : null;
}

export function TaskOutputHandoff(props: {
  task: CollaborationTask;
  environmentId: EnvironmentId;
  stale: boolean;
  readVersion: number;
  disabled: boolean;
  onSelect: (source: TaskResultHandoff) => void;
}) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const readReview = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const [busyState, setBusyState] = useState<{ key: string; session: typeof session } | null>(null);
  const [noticeState, setNoticeState] = useState<{
    key: string;
    session: typeof session;
    text: string;
  } | null>(null);
  const [verified, setVerified] = useState<{
    key: string;
    session: typeof session;
    token: symbol;
  } | null>(null);
  const generation = useRef(0),
    mounted = useRef(true),
    pending = useRef(false),
    latest = useRef(props);
  const key = JSON.stringify([
    props.task,
    props.environmentId,
    props.stale,
    props.readVersion,
    props.disabled,
  ]);
  const sourceToken = useMemo(
    () => Symbol(`${key}:${session === null ? "disconnected" : "connected"}`),
    [key, session],
  );
  const activeToken = useRef(sourceToken);
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    generation.current++;
    activeToken.current = sourceToken;
  }, [sourceToken]);
  const busy = busyState?.key === key && busyState.session === session;
  const notice =
    noticeState?.key === key && noticeState.session === session ? noticeState.text : null;
  const setNotice = (text: string) => setNoticeState({ key, session, text });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const p = latest.current;
    if (p.stale || p.disabled || !session || !hasAcceptedOutput(p.task)) return;
    const g = generation.current;
    void readFreshHandoff(p.environmentId, p.task.id, readReview, readProjection)
      .then((source) => {
        if (mounted.current && g === generation.current)
          setVerified(source ? { key, session, token: sourceToken } : null);
      })
      .catch(() => {
        if (mounted.current && g === generation.current) setVerified(null);
      });
  }, [key, session, sourceToken, readReview, readProjection]);
  if (
    props.stale ||
    !session ||
    !hasAcceptedOutput(props.task) ||
    verified?.token !== sourceToken ||
    verified?.key !== key ||
    verified.session !== session
  )
    return null;
  return (
    <section aria-label="Accepted output handoff">
      <Button
        disabled={busy || props.disabled}
        onClick={() => {
          if (
            activeToken.current !== sourceToken ||
            verified?.token !== sourceToken ||
            pending.current ||
            latest.current.stale ||
            latest.current.disabled
          )
            return;
          pending.current = true;
          setBusyState({ key, session });
          const g = generation.current;
          void (async () => {
            try {
              const source = await readFreshHandoff(
                props.environmentId,
                props.task.id,
                readReview,
                readProjection,
              );
              if (!mounted.current || g !== generation.current) return;
              if (!source) {
                setNotice(
                  "Current accepted, idle and attributable output could not be verified. Nothing created.",
                );
                return;
              }
              latest.current.onSelect(source);
            } catch {
              if (mounted.current && g === generation.current)
                setNotice("Complete bounded plain-text source unavailable. Nothing created.");
            } finally {
              pending.current = false;
              if (mounted.current && g === generation.current) setBusyState(null);
            }
          })();
        }}
      >
        Use this output in a new task
      </Button>
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}

export function TaskResultHandoffReadout({
  source,
  delivery,
  complete = false,
}: {
  source: TaskResultHandoff | undefined;
  delivery?: TaskResultHandoffDelivery | undefined;
  complete?: boolean;
}) {
  if (!source) return null;
  return (
    <section aria-label="Accepted output reference">
      <p>
        Untrusted reference only. The new task has its own governance; no source permissions, tools,
        budget or approval are inherited.
      </p>
      <p>
        Source:{" "}
        <a
          href={`/${encodeURIComponent(source.reference.environmentId)}/${encodeURIComponent(source.threadId)}`}
        >
          {source.title}
        </a>
        ; task {source.reference.taskId}; thread {source.threadId}; revision {source.revision}; run{" "}
        {source.result.runId}; attempt {source.result.attemptId}; provider thread{" "}
        {source.result.providerThreadId}; turn {source.result.providerTurnId}; output{" "}
        {source.result.itemId}; input message {source.result.messageId}; root{" "}
        {source.result.rootNodeId}; output node {source.result.nodeId}; source event sequence{" "}
        {source.eventSequence}; SHA256 {source.result.outputSha256}.
      </p>
      {complete ? (
        <>
          <p>
            Complete source text (maximum {TASK_RESULT_HANDOFF_MAX_CHARS.toLocaleString("en-US")}{" "}
            UTF-16 code units and {TASK_RESULT_HANDOFF_MAX_BYTES / 1024} KiB UTF-8; oversize
            rejects):
          </p>
          <pre className="whitespace-pre-wrap">{source.text}</pre>
        </>
      ) : (
        <p>
          Native reference delivery: {delivery?.status ?? "Unknown / unconfirmed"}. Delivery is
          separate from admission, provider completion and owner acceptance.
        </p>
      )}
    </section>
  );
}
