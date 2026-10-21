import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  ThreadId,
  type CollaborationTask,
  type CollaborationSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  taskResultComparison,
  type TaskResultComparison as Comparison,
} from "@t3tools/shared/taskResultComparison";
import { revisionTaskKey, sameRevisionProjection } from "@t3tools/shared/taskRevisionRequest";
import { usePreparedConnection } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readTaskResultEvidence } from "./readTaskResultReview";
import { Button } from "../ui/button";

type Evidence = NonNullable<Awaited<ReturnType<typeof readTaskResultEvidence>>>;
type View = {
  open: boolean;
  evidence: Evidence | null;
  result: Comparison | null;
  notice: string | null;
};
type Recorded = Extract<Comparison, { status: "available" }>["previous"];
function RecordedOutput(props: { title: string; label: string; output: Recorded }) {
  const { output, title, label } = props;
  const id = output.identity;
  return (
    <section className="space-y-2">
      <h4>{title}</h4>
      <p>
        Run {id.runId}; message {id.messageId}; attempt {id.attemptId}; provider thread{" "}
        {id.providerThreadId}; turn {id.providerTurnId}; item {id.itemId}; root {id.rootNodeId};
        node {id.nodeId}.
      </p>
      <p>
        Recorded run selection: {output.runSelection.instanceId} / {output.runSelection.model}.
      </p>
      {output.modelIdentity ? (
        <p>
          Provider-reported requested model: {output.modelIdentity.requested}; resolved model:{" "}
          {output.modelIdentity.resolved ?? "Unknown (not reported)"}.
        </p>
      ) : (
        <p>Provider-reported model resolution: Unknown (not recorded).</p>
      )}
      <p>Criteria from this run's own persisted input, revision {output.contract.revision}.</p>
      <dl>
        <dt>Persisted Goal</dt>
        <dd>{output.contract.goal}</dd>
        <dt>Persisted Redirect</dt>
        <dd>{output.contract.redirect}</dd>
        <dt>Persisted Acceptance criteria</dt>
        <dd>{output.contract.acceptance}</dd>
      </dl>
      <pre aria-label={label} className="whitespace-pre-wrap break-words text-sm">
        {output.text}
      </pre>
    </section>
  );
}

/** This read-only view never supplies facts or authority to task mutation controls. */
export function TaskResultComparison(props: {
  task: CollaborationTask;
  environmentId: EnvironmentId;
  stale: boolean;
  readVersion: number;
  readCollaboration: () => Promise<CollaborationSnapshot>;
  onOpen: () => void;
}) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const readReview = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const key = `${props.environmentId}:${props.readVersion}:${props.stale}:${revisionTaskKey(props.task)}`;
  const [scope, setScope] = useState({ key, session });
  if (scope.key !== key || scope.session !== session) setScope({ key, session });
  const [view, setView] = useState<View>({
    open: false,
    evidence: null,
    result: null,
    notice: null,
  });
  const [busy, setBusy] = useState(false);
  const viewRef = useRef(view),
    currentScope = useRef(scope),
    latest = useRef(props),
    mounted = useRef(true),
    owner = useRef<object | null>(null);
  const detail = useEnvironmentThread(
    props.environmentId,
    view.open && props.task.threadId ? ThreadId.make(props.task.threadId) : null,
  );
  const live = Option.getOrNull(detail.data),
    latestLive = useRef(live),
    observedLive = useRef(live);
  const replace = useCallback(
    (
      open: boolean,
      evidence: Evidence | null,
      result: Comparison | null,
      notice: string | null,
    ) => {
      const next = { open, evidence, result, notice };
      viewRef.current = next;
      owner.current = null;
      setBusy(false);
      setView(next);
    },
    [],
  );
  useLayoutEffect(() => {
    latest.current = props;
    latestLive.current = live;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    currentScope.current = scope;
    replace(false, null, null, null);
    return () => {
      mounted.current = false;
      owner.current = null;
    };
  }, [scope, replace]);
  useLayoutEffect(() => {
    if (view.evidence && live && live !== observedLive.current) {
      observedLive.current = live;
      if (!sameRevisionProjection(view.evidence.projection, live))
        replace(
          true,
          null,
          null,
          "Recorded comparison evidence changed. Reload the pair before reviewing it.",
        );
    }
  }, [live, view.evidence, replace]);
  const current = () =>
    mounted.current &&
    currentScope.current === scope &&
    viewRef.current === view &&
    !latest.current.stale &&
    session !== null;
  const load = async () => {
    if (!current() || owner.current) return;
    replace(true, null, null, null);
    const token = {};
    owner.current = token;
    setBusy(true);
    try {
      const evidence = await readTaskResultEvidence(latest.current, readReview, readProjection);
      if (
        !mounted.current ||
        currentScope.current !== scope ||
        owner.current !== token ||
        latest.current.stale
      )
        return;
      if (!evidence) {
        replace(
          true,
          null,
          null,
          "Comparison unavailable: current scope and paired review/projection reads could not be confirmed.",
        );
        return;
      }
      const observed = latestLive.current;
      if (observed && !sameRevisionProjection(evidence.projection, observed)) {
        replace(
          true,
          null,
          null,
          "Recorded comparison evidence changed during the reads. Reload the pair before reviewing it.",
        );
        return;
      }
      const result = taskResultComparison(
        evidence.task,
        evidence.environmentId,
        evidence.review,
        evidence.projection,
      );
      observedLive.current = observed;
      replace(true, evidence, result, null);
    } catch {
      if (mounted.current && currentScope.current === scope && owner.current === token)
        replace(
          true,
          null,
          null,
          "Comparison unavailable: authoritative recorded evidence could not be read.",
        );
    }
  };
  const result = view.result;
  return (
    <section
      aria-label="Recorded result revision comparison"
      className="space-y-3 rounded-lg border border-border p-3"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.stale || !session || busy}
        onClick={load}
      >
        {view.open ? "Reload result comparison" : "Compare revised result"}
      </Button>
      {busy ? <p role="status">Reading the recorded result pair…</p> : null}
      {view.notice ? <p role="status">{view.notice}</p> : null}
      {view.open ? (
        <>
          {result?.status === "available" ? (
            <>
              <h3>Recorded revision comparison</h3>
              <p>Persisted evidence for review. Acceptance remains a separate explicit decision.</p>
              <p>
                Owner {result.ownerAgentId}; environment {result.environmentId}; project{" "}
                {result.projectId}; task {result.taskId}; thread {result.threadId}.
              </p>
              <RecordedOutput
                title="Previous completed output"
                label="Previous persisted output"
                output={result.previous}
              />
              <section>
                <h4>Persisted requested changes</h4>
                <p>Recorded continuation input for message {result.current.identity.messageId}.</p>
                <pre
                  aria-label="Persisted requested changes"
                  className="whitespace-pre-wrap break-words text-sm"
                >
                  {result.requestedChanges}
                </pre>
              </section>
              <RecordedOutput
                title="Current completed revised output"
                label="Current persisted output"
                output={result.current}
              />
            </>
          ) : result?.status === "unavailable" ? (
            <p role="status">Comparison unavailable: {result.reason}</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (current()) replace(false, null, null, null);
            }}
          >
            Close result comparison
          </Button>
        </>
      ) : (
        <p>Compare one completed revision with its recorded predecessor and requested changes.</p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.stale || !session || !props.task.threadId}
        onClick={() => {
          if (current()) props.onOpen();
        }}
      >
        Open conversation for comparison context
      </Button>
    </section>
  );
}
