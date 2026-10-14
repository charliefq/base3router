import {
  TaskContract,
  TaskContractReviewState,
  ThreadId,
  type CollaborationTask,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useLayoutEffect, useRef, useState } from "react";
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

type Review = Extract<TaskContractReviewState, { status: "available" }>;
const sameContract = Schema.toEquivalence(TaskContract);
const sameReview = Schema.toEquivalence(TaskContractReviewState);
const encodeContract = Schema.encodeSync(Schema.fromJsonString(TaskContract));

function eligible(
  task: CollaborationTask,
  environmentId: EnvironmentId,
  facts: Review,
  projection: OrchestrationV2ThreadProjection,
) {
  const t = projection.thread;
  return (
    facts.reference.environmentId === environmentId &&
    facts.reference.taskId === task.id &&
    facts.reference.projectId === task.projectId &&
    facts.taskId === task.id &&
    facts.projectId === task.projectId &&
    facts.threadId === task.threadId &&
    facts.phase === "active" &&
    facts.acceptedRevision === null &&
    facts.actions.includes("accept") &&
    task.contractReadout?.status === "available" &&
    sameContract(facts.contract, task.contractReadout.contract) &&
    task.review?.reference.threadSequence === facts.reference.threadSequence &&
    task.review.reference.threadUpdatedAt === facts.reference.threadUpdatedAt &&
    t.title === facts.title &&
    t.id === task.threadId &&
    t.projectId === task.projectId &&
    t.providerInstanceId === task.assigneeAgentId &&
    t.modelSelection.instanceId === t.providerInstanceId &&
    t.taskGovernance === "required" &&
    t.taskContract !== null &&
    t.taskContract !== undefined &&
    sameContract(facts.contract, t.taskContract) &&
    t.taskContractPhase === "active" &&
    t.taskAcceptedRevision === null &&
    t.lineage.rootThreadId === t.id &&
    t.lineage.parentThreadId === null &&
    t.lineage.relationshipToParent === null &&
    t.forkedFrom === null &&
    t.archivedAt === null &&
    t.deletedAt === null &&
    t.activeProviderThreadId === null &&
    DateTime.formatIso(t.updatedAt) === facts.reference.threadUpdatedAt &&
    projection.messages.length === 0 &&
    projection.runs.length === 0 &&
    projection.attempts.length === 0 &&
    projection.nodes.length === 0 &&
    projection.providerThreads.length === 0 &&
    projection.providerTurns.length === 0 &&
    projection.providerSessions.length === 0 &&
    projection.runtimeRequests.length === 0
  );
}

export function TaskFirstInstructions(props: {
  readonly task: CollaborationTask;
  readonly environmentId: EnvironmentId;
  readonly stale: boolean;
  readonly readVersion: number;
  readonly onOpen: () => void;
}) {
  const readReview = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const [review, setReview] = useState<Review | null>(null);
  const reviewRef = useRef<Review | null>(null);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = useRef<object | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(props);
  const contract =
    props.task.contractReadout?.status === "available" ? props.task.contractReadout : undefined;
  const key = `${props.environmentId}:${props.task.projectId}:${props.task.id}:${props.task.threadId}:${props.readVersion}:${props.stale}:${props.task.ownerAgentId}:${props.task.assigneeAgentId}:${props.task.review?.reference.threadUpdatedAt}:${props.task.review?.reference.threadSequence}:${contract?.phase}:${contract?.acceptedRevision}:${contract ? encodeContract(contract.contract) : "missing"}`;
  const context = useRef({ key, session });
  useLayoutEffect(() => {
    latest.current = props;
  }, [props]);
  useLayoutEffect(() => {
    if (context.current.key !== key || context.current.session !== session) {
      context.current = { key, session };
      epoch.current++;
      owner.current = null;
      reviewRef.current = null;
      setReview(null);
      setBusy(false);
      setNotice(null);
    }
  }, [key, session]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      owner.current = null;
      reviewRef.current = null;
    };
  }, []);
  const available =
    !props.stale &&
    session !== null &&
    props.task.threadId !== null &&
    props.task.threadId !== undefined &&
    contract?.phase === "active" &&
    contract.acceptedRevision === null &&
    props.task.review?.reference.environmentId === props.environmentId &&
    props.task.review.actions.includes("accept");
  const current = (generation: number) =>
    mounted.current &&
    epoch.current === generation &&
    !latest.current.stale &&
    context.current.session !== null;
  const read = async () => {
    const p = latest.current;
    if (!p.task.threadId || p.task.contractReadout?.status !== "available") return null;
    const input = {
      environmentId: p.environmentId,
      taskId: p.task.id,
      projectId: p.task.projectId,
      threadId: p.task.threadId,
      revision: p.task.contractReadout.contract.revision,
    };
    const before = await readReview({ environmentId: p.environmentId, input });
    if (before._tag !== "Success" || before.value.status !== "available") return null;
    const projection = await readProjection({
      environmentId: p.environmentId,
      input: { threadId: ThreadId.make(input.threadId) },
    });
    const after = await readReview({ environmentId: p.environmentId, input });
    if (
      projection._tag !== "Success" ||
      after._tag !== "Success" ||
      after.value.status !== "available" ||
      !sameReview(before.value, after.value) ||
      !eligible(p.task, p.environmentId, after.value, projection.value)
    )
      return null;
    return after.value;
  };
  const prepare = async () => {
    if (!available || owner.current) return;
    const token = {};
    owner.current = token;
    setBusy(true);
    setNotice(null);
    const generation = epoch.current;
    try {
      const facts = await read();
      if (!current(generation)) return;
      if (!facts) {
        setNotice(
          "Current owned empty task facts could not be confirmed. Refresh tasks or open the conversation.",
        );
        return;
      }
      reviewRef.current = facts;
      setReview(facts);
      setPrompt(facts.contract.goal);
    } catch {
      if (current(generation))
        setNotice(
          "Task reads failed. No draft was changed. Refresh tasks before preparing instructions.",
        );
    } finally {
      if (owner.current === token) {
        owner.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const apply = async () => {
    const observed = reviewRef.current;
    if (!observed || observed !== review || owner.current || !prompt.trim() || !available) return;
    const token = {};
    owner.current = token;
    setBusy(true);
    const generation = epoch.current;
    const proposed = prompt;
    try {
      const facts = await read();
      if (!current(generation) || reviewRef.current !== observed) return;
      if (!facts || !sameReview(facts, observed)) {
        reviewRef.current = null;
        setReview(null);
        setNotice(
          "Task facts changed or are unavailable. No draft was changed; review fresh facts again.",
        );
        return;
      }
      const target = scopeThreadRef(props.environmentId, ThreadId.make(facts.threadId));
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
        "Prepared a local draft only. No work started. Edit it, choose existing Manual/Auto and press Send separately.",
      );
      if (current(generation)) props.onOpen();
    } catch {
      if (current(generation)) {
        reviewRef.current = null;
        setReview(null);
        setNotice("Fresh task reads or local draft preparation failed. No instructions were sent.");
      }
    } finally {
      if (owner.current === token) {
        owner.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        type="button"
        disabled={!available || busy}
        onClick={() => void prepare()}
      >
        Prepare first instructions
      </Button>
      {notice ? <p role="status">{notice}</p> : null}
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) {
            epoch.current++;
            owner.current = null;
            reviewRef.current = null;
            setReview(null);
            setBusy(false);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Review first instructions</AlertDialogTitle>
            <AlertDialogDescription>
              Prepare a local draft for this existing conversation. Task facts may change. No
              acceptance, routing or work is started. In the conversation, edit the draft, choose
              existing Manual/Auto and press Send separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {review ? (
            <>
              <p>
                {review.title}. Environment: {props.environmentId}. Project: {review.projectId}.
                Thread: {review.threadId}. Revision: {review.contract.revision}.
              </p>
              <dl>
                <dt>Goal</dt>
                <dd>{review.contract.goal}</dd>
                <dt>Redirect</dt>
                <dd>{review.contract.redirect}</dd>
                <dt>Acceptance</dt>
                <dd>{review.contract.acceptance}</dd>
                <dt>Provider start limit</dt>
                <dd>{review.contract.brake.maxProviderStarts}</dd>
                <dt>Stop conditions</dt>
                <dd>{review.contract.brake.stopConditions}</dd>
                {review.contract.brake.maxTokens !== undefined ? (
                  <>
                    <dt>Declared token cap</dt>
                    <dd>{review.contract.brake.maxTokens}</dd>
                  </>
                ) : null}
                {review.contract.brake.maxCostUsd !== undefined ? (
                  <>
                    <dt>Declared cost cap (USD)</dt>
                    <dd>{review.contract.brake.maxCostUsd}</dd>
                  </>
                ) : null}
                {review.contract.brake.deadlineAt !== undefined ? (
                  <>
                    <dt>Declared deadline</dt>
                    <dd>{review.contract.brake.deadlineAt}</dd>
                  </>
                ) : null}
              </dl>
              <Textarea
                aria-label="Initial instructions"
                value={prompt}
                disabled={busy}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </>
          ) : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                epoch.current++;
                owner.current = null;
                reviewRef.current = null;
                setReview(null);
                setBusy(false);
              }}
            >
              Cancel preparation
            </Button>
            <Button type="button" disabled={busy || !prompt.trim()} onClick={() => void apply()}>
              Fill empty draft and open
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
