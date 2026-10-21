import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { revisionTaskKey } from "@t3tools/shared/taskRevisionRequest";
import { usePreparedConnection } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readTaskResultEvidence } from "./readTaskResultReview";
import { Button } from "../ui/button";
import { comparisonLiveEvidenceAgrees } from "./comparisonLiveEvidence";
import { taskResultComparisonObservation } from "./taskResultComparisonObservation";

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
  const observe = useAtomCommand(taskResultComparisonObservation, { reportFailure: false });
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
    owner = useRef<object | null>(null),
    observer = useRef<AbortController | null>(null);
  const detail = useEnvironmentThread(
    props.environmentId,
    view.open && props.task.threadId ? ThreadId.make(props.task.threadId) : null,
  );
  const live = Option.getOrNull(detail.data);
  const detailError = Option.getOrNull(detail.error);
  const hasLive = live !== null;
  const detailFresh = detail.status === "live" && detailError === null && hasLive;
  // Detail lifecycle identity retires callbacks even when cached data keeps the same object.
  const observation = useMemo(
    () => ({ status: detail.status, error: detailError, hasLive }),
    [detail.status, detailError, hasLive],
  );
  const latestLive = useRef(live),
    observedLive = useRef(live),
    latestDetailFresh = useRef(detailFresh),
    currentObservation = useRef(observation),
    wasDetailFresh = useRef(false);
  const detailNotice =
    "Thread detail is not current. Reload the comparison after its live connection is restored.";
  const replace = useCallback(
    (
      open: boolean,
      evidence: Evidence | null,
      result: Comparison | null,
      notice: string | null,
      keepObserver = false,
    ) => {
      if (!keepObserver) {
        observer.current?.abort();
        observer.current = null;
      }
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
    latestDetailFresh.current = detailFresh;
    currentObservation.current = observation;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    currentScope.current = scope;
    replace(false, null, null, null);
    return () => {
      mounted.current = false;
      owner.current = null;
      observer.current?.abort();
      observer.current = null;
    };
  }, [scope, replace]);
  useLayoutEffect(() => {
    if (
      view.open &&
      !detailFresh &&
      (wasDetailFresh.current || detailError !== null || detail.status === "deleted")
    ) {
      if (viewRef.current.notice !== detailNotice || owner.current || viewRef.current.evidence)
        replace(true, null, null, detailNotice);
    }
    wasDetailFresh.current = view.open && detailFresh;
    if (
      view.evidence &&
      view.result?.status === "available" &&
      detailFresh &&
      live &&
      live !== observedLive.current
    ) {
      observedLive.current = live;
      if (!comparisonLiveEvidenceAgrees(view.evidence.projection, live, view.result))
        replace(
          true,
          null,
          null,
          "Recorded comparison evidence changed. Reload the pair before reviewing it.",
        );
    }
  }, [
    detail.status,
    detailError,
    detailFresh,
    live,
    view.open,
    view.evidence,
    view.result,
    replace,
  ]);
  const scopeCurrent = () =>
    mounted.current &&
    currentScope.current === scope &&
    viewRef.current === view &&
    !latest.current.stale &&
    session !== null;
  const current = () =>
    scopeCurrent() &&
    (!view.open || (latestDetailFresh.current && currentObservation.current === observation));
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
      if (!latestDetailFresh.current) {
        replace(true, null, null, detailNotice);
        return;
      }
      const observed = latestLive.current;
      const result = taskResultComparison(
        evidence.task,
        evidence.environmentId,
        evidence.review,
        evidence.projection,
      );
      if (
        result.status === "available" &&
        (!observed || !comparisonLiveEvidenceAgrees(evidence.projection, observed, result))
      ) {
        replace(
          true,
          null,
          null,
          "Recorded comparison evidence changed during the reads. Reload the pair before reviewing it.",
        );
        return;
      }
      observedLive.current = observed;
      if (result.status !== "available") {
        replace(true, null, result, null);
        return;
      }
      const sequence = evidence.projection.eventSequence;
      if (sequence === undefined) {
        replace(
          true,
          null,
          null,
          "Comparison unavailable: the recorded read has no stream cursor for gap-free observation.",
        );
        return;
      }
      const controller = new AbortController();
      observer.current = controller;
      const ready = await new Promise<boolean>((resolve) => {
        const stop = () => resolve(false);
        controller.signal.addEventListener("abort", stop, { once: true });
        const report = (state: "ready" | "changed" | "unavailable") => {
          if (
            observer.current !== controller ||
            controller.signal.aborted ||
            !mounted.current ||
            currentScope.current !== scope
          )
            return;
          controller.signal.removeEventListener("abort", stop);
          resolve(state === "ready");
          if (state !== "ready") {
            replace(
              true,
              null,
              null,
              state === "changed"
                ? "Recorded comparison evidence changed during observation. Reload the pair before reviewing it."
                : "Comparison unavailable: a current completion-marker stream could not be confirmed. Reload after its connection is restored.",
            );
          }
        };
        void observe({
          environmentId: evidence.environmentId,
          threadId: ThreadId.make(evidence.task.threadId!),
          afterSequence: sequence,
          signal: controller.signal,
          report,
        }).then(
          () => {
            if (!controller.signal.aborted) report("unavailable");
          },
          () => report("unavailable"),
        );
      });
      if (
        !ready ||
        !mounted.current ||
        currentScope.current !== scope ||
        owner.current !== token ||
        observer.current !== controller ||
        latest.current.stale
      )
        return;
      // Detail can change while the raw subscription catches up.
      const caughtUp = latestLive.current;
      if (
        !latestDetailFresh.current ||
        !caughtUp ||
        !comparisonLiveEvidenceAgrees(evidence.projection, caughtUp, result)
      ) {
        replace(
          true,
          null,
          null,
          "Recorded comparison evidence changed during the reads. Reload the pair before reviewing it.",
        );
        return;
      }
      observedLive.current = caughtUp;
      replace(true, evidence, result, null, true);
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
        disabled={props.stale || !session || busy || (view.open && !detailFresh)}
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
              if (scopeCurrent()) replace(false, null, null, null);
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
          if (scopeCurrent()) props.onOpen();
        }}
      >
        Open conversation for comparison context
      </Button>
    </section>
  );
}
