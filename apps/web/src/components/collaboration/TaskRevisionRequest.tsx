import { useTaskResultReview } from "./TaskResultReview";
import { readTaskResultReview } from "./readTaskResultReview";
import { completeResultText } from "@t3tools/shared/taskRevisionRequest";
import { useTaskInboxDraft } from "./TaskInboxDrafts";
import { useTaskFirstLaunch } from "./useTaskFirstLaunch";
import { continuationResult } from "./taskRevisionRequest";
import {
  ThreadId,
  type CollaborationTask,
  type CollaborationSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { fillEmptyComposerDraftByRef } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import {
  hasRevisionOutput,
  revisionTaskKey,
  sameRevisionFacts,
  type RevisionRequestFacts,
} from "./taskRevisionRequest";

export function TaskRevisionRequest(props: {
  readonly task: CollaborationTask;
  readonly environmentId: EnvironmentId;
  readonly stale: boolean;
  readonly readVersion: number;
  readonly readCollaboration: () => Promise<CollaborationSnapshot>;
  readonly onOpen: () => void;
}) {
  const resultReview = useTaskResultReview();
  const readReview = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const [review, setReview] = useState<RevisionRequestFacts | null>(null);
  const draftScope = JSON.stringify([
    props.environmentId,
    props.task.projectId,
    props.task.id,
    props.task.threadId,
  ]);
  const [drafts, setDrafts] = useTaskInboxDraft<ReadonlyMap<string, string>>(
    "requested-revision",
    props,
    new Map(),
  );
  const changes = drafts.get(draftScope) ?? "";
  const currentDraftScope = useRef(draftScope);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(props),
    reviewRef = useRef<RevisionRequestFacts | null>(null),
    changesRef = useRef(""),
    owner = useRef<object | null>(null),
    epoch = useRef(0),
    mounted = useRef(true);
  const key = `${props.environmentId}:${props.readVersion}:${props.stale}:${revisionTaskKey(props.task)}:${resultReview?.version ?? 0}`;
  const context = useRef({ key, session });
  useLayoutEffect(() => {
    latest.current = props;
    currentDraftScope.current = draftScope;
    changesRef.current = changes;
  }, [props, draftScope, changes]);
  const updateChanges = (value: string) => {
    if (currentDraftScope.current !== draftScope) return;
    changesRef.current = value;
    setDrafts((previous) => new Map(previous).set(draftScope, value));
  };
  const retire = useCallback(() => {
    epoch.current++;
    owner.current = null;
    reviewRef.current = null;
    setReview(null);
    setBusy(false);
  }, []);
  useLayoutEffect(() => {
    if (context.current.key !== key || context.current.session !== session) {
      context.current = { key, session };
      retire();
      setNotice(null);
    }
  }, [key, session, retire]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      owner.current = null;
      reviewRef.current = null;
    };
  }, []);
  const continuation = useTaskFirstLaunch({
    environmentId: props.environmentId,
    task: props.task,
    facts: review?.review ?? null,
    thread: review?.projection.thread ?? null,
    text: changes,
    stale: props.stale,
    onOpen: props.onOpen,
    resultBound: true,
    reviewIsCurrent: resultReview?.isCurrent,
    priorResult: review ? continuationResult(review) : null,
  });
  const available = !props.stale && session !== null && hasRevisionOutput(props.task);
  const current = (generation: number, token: object) =>
    mounted.current &&
    epoch.current === generation &&
    owner.current === token &&
    !latest.current.stale &&
    context.current.session !== null;
  const read = () => readTaskResultReview(latest.current, readReview, readProjection, "revision");
  const prepare = async () => {
    if (!available || owner.current || reviewRef.current) return;
    const token = {};
    owner.current = token;
    setBusy(true);
    setNotice(null);
    const generation = epoch.current;
    try {
      const facts = await read();
      if (!current(generation, token)) return;
      if (!facts) {
        setNotice(
          "Current owned completed output could not be confirmed. Refresh tasks or open the conversation.",
        );
        return;
      }
      if (resultReview && !resultReview.matches(facts)) return;
      reviewRef.current = facts;
      setReview(facts);
    } catch {
      if (current(generation, token))
        setNotice(
          "Result reads failed. No draft was changed. Refresh tasks or open the conversation.",
        );
    } finally {
      if (owner.current === token) {
        owner.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const apply = async () => {
    const observed = review;
    if (
      reviewRef.current !== observed ||
      !available ||
      (resultReview && !resultReview.isCurrent()) ||
      !observed ||
      observed !== review ||
      owner.current ||
      !changesRef.current.trim()
    )
      return;
    const token = {};
    owner.current = token;
    setBusy(true);
    setNotice(null);
    const generation = epoch.current,
      proposed = changesRef.current;
    try {
      const facts = await read();
      if (
        !current(generation, token) ||
        reviewRef.current !== observed ||
        (resultReview && !resultReview.isCurrent())
      )
        return;
      if (changesRef.current !== proposed) {
        setNotice(
          "Requested changes changed during the reads. Review them again; no draft was changed.",
        );
        return;
      }
      if (!facts || !sameRevisionFacts(observed, facts)) {
        reviewRef.current = null;
        setReview(null);
        setNotice(
          "Task or latest result changed. Refresh and review fresh facts; no draft was changed.",
        );
        return;
      }
      const target = scopeThreadRef(props.environmentId, ThreadId.make(facts.task.threadId!));
      if (!fillEmptyComposerDraftByRef(target, proposed)) {
        reviewRef.current = null;
        setReview(null);
        setNotice(
          "Existing draft content or queued editing was preserved. Open conversation to continue editing it.",
        );
        return;
      }
      reviewRef.current = null;
      setReview(null);
      setNotice(
        "Prepared a local revision draft only. Edit it, choose Manual/Auto and press Send separately. No work started.",
      );
      if (current(generation, token)) props.onOpen();
    } catch {
      if (current(generation, token) && reviewRef.current === observed) {
        reviewRef.current = null;
        setReview(null);
        setNotice("Fresh result reads failed. No draft was changed.");
      }
    } finally {
      if (owner.current === token) {
        owner.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const retainedDraft =
    review === null && changes ? (
      <section aria-label="Retained revision draft">
        <p>Requested changes draft retained. Review fresh task and result facts before using it.</p>
        <pre className="whitespace-pre-wrap break-all text-sm">{changes}</pre>
        <Button
          type="button"
          variant="outline"
          disabled={busy || continuation.busy}
          onClick={() => {
            updateChanges("");
          }}
        >
          Discard requested changes
        </Button>
      </section>
    ) : null;
  if (!hasRevisionOutput(props.task))
    return (
      <>
        {retainedDraft}
        {continuation.recovery}
      </>
    );
  return (
    <div>
      {retainedDraft}
      {review === null ? continuation.recovery : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!available || busy || review !== null}
        onClick={() => void prepare()}
      >
        Prepare revision request
      </Button>
      {notice ? <p role="status">{notice}</p> : null}
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && review && reviewRef.current === review) retire();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Review revision request</AlertDialogTitle>
            <AlertDialogDescription>
              Write the changes you want for this completed output, choose Manual/Auto and review
              before explicit Start. Preparation starts no work and does not judge acceptance. The
              separate draft-only fallback remains available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {review ? (
            <>
              <dl>
                <dt>Current Goal</dt>
                <dd>{review.review.contract.goal}</dd>
                <dt>Current Redirect</dt>
                <dd>{review.review.contract.redirect}</dd>
                <dt>Current Acceptance</dt>
                <dd>{review.review.contract.acceptance}</dd>
              </dl>
              <p>Complete attributable persisted assistant output (not owner acceptance)</p>
              <pre className="whitespace-pre-wrap break-all text-sm">
                {completeResultText(review)}
              </pre>
              <p>
                Run {review.result.runId}; message {review.result.messageId}; attempt{" "}
                {review.result.attemptId}; turn {review.result.providerTurnId}; item{" "}
                {review.result.content.itemId}.
              </p>
              <Textarea
                aria-label="Requested changes"
                value={changes}
                disabled={busy || continuation.busy}
                onChange={(e) => {
                  if (!review || reviewRef.current !== review) return;
                  updateChanges(e.target.value);
                }}
              />
              {continuation.recovery}
              {continuation.controls}
            </>
          ) : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (review && reviewRef.current === review) retire();
              }}
            >
              Cancel revision preparation
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!review || reviewRef.current !== review) return;
                retire();
                props.onOpen();
              }}
            >
              Open conversation for full context
            </Button>
            <Button
              type="button"
              disabled={
                busy ||
                continuation.busy ||
                continuation.reviewed ||
                continuation.hasOriginal ||
                !changes.trim()
              }
              onClick={() => void apply()}
            >
              Fill empty draft and open
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
