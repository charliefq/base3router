import { useLayoutEffect, useRef, useState } from "react";
import {
  ThreadId,
  type CollaborationSnapshot,
  type CollaborationTask,
  type EnvironmentId,
  type TaskContractReviewAction,
  type TaskContractReviewState,
} from "@t3tools/contracts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { TaskContractReadout } from "../chat/TaskContractPanel";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "../ui/alert-dialog";

type AvailableReview = Extract<TaskContractReviewState, { status: "available" }>;
const effectText = (action: TaskContractReviewAction) =>
  action === "accept"
    ? "Records your acceptance of this displayed revision. Provider completion does not imply acceptance. No work is started."
    : action === "redirect"
      ? "Records the redirected phase and requests cancellation of active work. Cancellation requested is not confirmation that work has stopped."
      : "Restores the active phase under this revision. No message is sent and no provider is started.";
const label = (action: TaskContractReviewAction) =>
  action === "accept"
    ? "Accept revision"
    : action === "redirect"
      ? "Pause for redirect"
      : "Resume revision";

export function TaskReviewControls(props: {
  readonly task: CollaborationTask;
  readonly environmentId: EnvironmentId;
  readonly readVersion: number;
  readonly stale: boolean;
  readonly invalidateReads: () => void;
  readonly refresh: () => Promise<CollaborationSnapshot | undefined>;
}) {
  const readReview = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const decide = useAtomCommand(threadEnvironment.decideTaskContract, { reportFailure: false });
  const [confirmation, setConfirmation] = useState<{
    action: TaskContractReviewAction;
    facts: AvailableReview;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const latest = useRef(props);
  const mounted = useRef(true);
  const pendingRef = useRef(false);
  const resolveConfirmation = useRef<((confirmed: boolean) => void) | null>(null);
  const identity = `${props.environmentId}:${props.task.projectId}:${props.task.id}:${props.task.threadId}`;
  const currentIdentity = useRef(identity);
  const factKey = `${props.readVersion}:${props.task.review?.reference.threadUpdatedAt}:${props.task.review?.reference.threadSequence}:${props.task.contractReadout?.status === "available" ? props.task.contractReadout.contract.revision : "missing"}:${props.stale}`;
  const currentFacts = useRef(factKey);
  const uncertainReadVersion = useRef<number | null>(null);
  const [noticeRevision, setNoticeRevision] = useState<number | null>(null);
  useLayoutEffect(() => {
    latest.current = props;
  }, [props]);
  useLayoutEffect(() => {
    currentIdentity.current = identity;
    currentFacts.current = factKey;
    resolveConfirmation.current?.(false);
    resolveConfirmation.current = null;
    setConfirmation(null);
    if (
      uncertainReadVersion.current !== null &&
      props.readVersion !== uncertainReadVersion.current
    ) {
      uncertainReadVersion.current = null;
      setBlocked(false);
      setNotice(null);
    }
  }, [identity, factKey, props.readVersion]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolveConfirmation.current?.(false);
      resolveConfirmation.current = null;
    };
  }, []);
  const close = (confirmed: boolean) => {
    const resolve = resolveConfirmation.current;
    resolveConfirmation.current = null;
    setConfirmation(null);
    resolve?.(confirmed);
  };
  const run = async (action: TaskContractReviewAction) => {
    if (
      pendingRef.current ||
      blocked ||
      props.stale ||
      !props.task.threadId ||
      props.task.contractReadout?.status !== "available"
    )
      return;
    const initialIdentity = identity;
    const initialFacts = factKey;
    const revision = props.task.contractReadout.contract.revision;
    const target = {
      environmentId: props.environmentId,
      taskId: props.task.id,
      projectId: props.task.projectId,
      threadId: props.task.threadId,
      revision,
    };
    const isCurrent = () => mounted.current && currentIdentity.current === initialIdentity;
    const unchanged = () =>
      isCurrent() && currentFacts.current === initialFacts && !latest.current.stale;
    pendingRef.current = true;
    setNoticeRevision(revision);
    setPending(true);
    setNotice(null);
    try {
      const read = await readReview({ environmentId: props.environmentId, input: target });
      if (!unchanged()) return;
      if (
        read._tag !== "Success" ||
        read.value.status !== "available" ||
        !read.value.actions.includes(action) ||
        read.value.reference.environmentId !== props.environmentId ||
        read.value.taskId !== target.taskId ||
        read.value.threadId !== target.threadId ||
        read.value.projectId !== target.projectId ||
        read.value.contract.revision !== revision
      ) {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice(
          "Current task review eligibility could not be confirmed. Refresh task facts before deciding.",
        );
        return;
      }
      const facts = read.value;
      if (
        facts.reference.threadSequence !== props.task.review?.reference.threadSequence ||
        facts.reference.threadUpdatedAt !== props.task.review?.reference.threadUpdatedAt
      ) {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice("Task facts changed. Refresh before confirming this revision.");
        return;
      }
      const confirmed = await new Promise<boolean>((resolve) => {
        resolveConfirmation.current = resolve;
        setConfirmation({ action, facts });
      });
      if (!confirmed || !unchanged()) return;
      props.invalidateReads();
      const result = await decide({
        environmentId: props.environmentId,
        input: {
          threadId: ThreadId.make(target.threadId),
          action,
          revision,
          reviewTask: facts.reference,
        },
      });
      if (!isCurrent()) return;
      if (result._tag !== "Success") {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice(
          "The decision outcome is uncertain or was rejected. Refresh task facts before another decision; no retry was sent.",
        );
        return;
      }
      const snapshot = await props.refresh();
      if (!isCurrent()) return;
      const fresh = snapshot?.tasks.find(
        (task) =>
          task.id === target.taskId &&
          task.projectId === target.projectId &&
          task.threadId === target.threadId,
      );
      const current = fresh?.contractReadout;
      if (
        !current ||
        current.status !== "available" ||
        current.contract.revision !== revision ||
        (action === "accept"
          ? current.acceptedRevision !== revision
          : current.phase !== (action === "redirect" ? "redirected" : "active"))
      ) {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice(
          "The response arrived, but fresh task facts did not confirm this decision. Refresh before another decision.",
        );
        return;
      }
      setNotice(
        action === "accept"
          ? `Acceptance recorded for revision ${revision}.`
          : action === "redirect"
            ? `Revision ${revision} paused for redirect. Cancellation requested; stopping is not confirmed.`
            : `Revision ${revision} is active. No provider was started.`,
      );
    } catch {
      if (isCurrent()) {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice(
          "The decision outcome could not be confirmed. Refresh task facts; no mutation retry was sent.",
        );
      }
    } finally {
      pendingRef.current = false;
      if (isCurrent()) setPending(false);
    }
  };
  const readout = props.task.contractReadout;
  if (readout?.status !== "available") return null;
  const hint = props.task.review;
  const canReview =
    !props.stale &&
    !blocked &&
    hint?.reference.environmentId === props.environmentId &&
    hint.reference.taskId === props.task.id &&
    hint.reference.projectId === props.task.projectId &&
    hint.revision === readout.contract.revision;
  return (
    <>
      <TaskContractReadout
        goal={readout.contract.goal}
        redirect={readout.contract.redirect}
        acceptance={readout.contract.acceptance}
        maxProviderStarts={readout.contract.brake.maxProviderStarts}
        stopConditions={readout.contract.brake.stopConditions}
        revision={readout.contract.revision}
        phase={readout.phase ?? "phase not persisted"}
        acceptedRevision={readout.acceptedRevision}
        onAccept={canReview && hint.actions.includes("accept") ? () => run("accept") : undefined}
        onRedirect={
          canReview && hint.actions.includes("redirect") ? () => run("redirect") : undefined
        }
        onResume={canReview && hint.actions.includes("resume") ? () => run("resume") : undefined}
      />
      {pending ? <p role="status">Review decision pending…</p> : null}
      {notice !== null && noticeRevision === readout.contract.revision ? (
        <p role={blocked ? "alert" : "status"}>{notice}</p>
      ) : null}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) close(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation
                ? `${label(confirmation.action)} ${confirmation.facts.contract.revision}`
                : "Review task"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation ? (
                <>
                  Task: {confirmation.facts.title}. Environment:{" "}
                  {confirmation.facts.reference.environmentId}. Displayed revision:{" "}
                  {confirmation.facts.contract.revision}. {effectText(confirmation.action)}
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button onClick={() => close(true)}>Confirm decision</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
