import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ThreadId,
  TaskContractBrake,
  type CollaborationSnapshot,
  type CollaborationTask,
  type EnvironmentId,
  type TaskContractReviewAction,
  type TaskContractReviewState,
} from "@t3tools/contracts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { TaskContractReadout } from "../chat/TaskContractPanel";
import { TaskInstructionEditor, type TaskInstructionDraft } from "./TaskInstructionEditor";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "../ui/alert-dialog";

const sameBrake = Schema.toEquivalence(TaskContractBrake);
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
    action: TaskContractReviewAction | "set";
    proposed?: TaskInstructionDraft;
    facts: AvailableReview;
  } | null>(null);
  const [editor, setEditor] = useState<{
    facts: AvailableReview;
    draft: TaskInstructionDraft;
    key: string;
  } | null>(null);
  const editorRef = useRef(editor);
  const resolveEditor = useRef<((draft: TaskInstructionDraft | null) => void) | null>(null);
  const previewingRef = useRef(false);
  const previewGeneration = useRef(0);
  const [previewing, setPreviewing] = useState(false);
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
    editorRef.current = editor;
  }, [props, editor]);
  useLayoutEffect(() => {
    currentIdentity.current = identity;
    currentFacts.current = factKey;
    resolveConfirmation.current?.(false);
    resolveConfirmation.current = null;
    setConfirmation(null);
    resolveEditor.current?.(null);
    resolveEditor.current = null;
    setEditor(null);
    previewGeneration.current += 1;
    previewingRef.current = false;
    setPreviewing(false);
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
      resolveEditor.current?.(null);
      resolveEditor.current = null;
    };
  }, []);
  const close = (confirmed: boolean) => {
    if (confirmation?.action === "set") {
      setConfirmation(null);
      if (confirmed && confirmation.proposed) {
        const resolve = resolveEditor.current;
        resolveEditor.current = null;
        setEditor(null);
        resolve?.(confirmation.proposed);
      }
      return;
    }
    const resolve = resolveConfirmation.current;
    resolveConfirmation.current = null;
    setConfirmation(null);
    resolve?.(confirmed);
  };
  const run = async (action: TaskContractReviewAction | "set") => {
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
    let mutationSent = false;
    try {
      const read = await readReview({ environmentId: props.environmentId, input: target });
      if (!unchanged()) return;
      if (
        read._tag !== "Success" ||
        read.value.status !== "available" ||
        (action === "set"
          ? read.value.canEditInstructions !== true
          : !read.value.actions.includes(action)) ||
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
      const selection =
        action === "set"
          ? await new Promise<TaskInstructionDraft | null>((resolve) => {
              resolveEditor.current = resolve;
              setEditor({
                facts,
                draft: {
                  goal: facts.contract.goal,
                  redirect: facts.contract.redirect,
                  acceptance: facts.contract.acceptance,
                },
                key: initialFacts,
              });
            })
          : await new Promise<boolean>((resolve) => {
              resolveConfirmation.current = resolve;
              setConfirmation({ action, facts });
            });
      const proposed = typeof selection === "object" ? selection : null;
      const confirmed = action === "set" ? proposed !== null : selection === true;
      if (!confirmed || !unchanged()) return;
      props.invalidateReads();
      mutationSent = true;
      const result = await decide({
        environmentId: props.environmentId,
        input: {
          threadId: ThreadId.make(target.threadId),
          action,
          ...(action === "set"
            ? { expectedRevision: revision, ...proposed!, brake: facts.contract.brake }
            : { revision }),
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
        current.contract.revision !== (action === "set" ? revision + 1 : revision) ||
        (action === "set"
          ? current.phase !== "redirected" ||
            current.acceptedRevision !== null ||
            current.contract.goal !== proposed?.goal ||
            current.contract.redirect !== proposed?.redirect ||
            current.contract.acceptance !== proposed?.acceptance ||
            !sameBrake(current.contract.brake, facts.contract.brake)
          : action === "accept"
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
      setNoticeRevision(action === "set" ? revision + 1 : revision);
      setNotice(
        action === "set"
          ? `Revision ${revision + 1} saved. Task remains paused; Resume needs a separate decision. No provider was started.`
          : action === "accept"
            ? `Acceptance recorded for revision ${revision}.`
            : action === "redirect"
              ? `Revision ${revision} paused for redirect. Cancellation requested; stopping is not confirmed.`
              : `Revision ${revision} is active. No provider was started.`,
      );
    } catch {
      if (isCurrent() && (mutationSent || unchanged())) {
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
  const previewInstructions = async () => {
    const editing = editorRef.current;
    if (!editing || previewingRef.current || blocked || confirmation) return;
    const initialIdentity = identity;
    const proposed = {
      goal: editing.draft.goal.trim(),
      redirect: editing.draft.redirect.trim(),
      acceptance: editing.draft.acceptance.trim(),
    };
    if (
      Object.values(proposed).some((value) => !value) ||
      (proposed.goal === editing.facts.contract.goal &&
        proposed.redirect === editing.facts.contract.redirect &&
        proposed.acceptance === editing.facts.contract.acceptance)
    )
      return;
    const generation = ++previewGeneration.current;
    previewingRef.current = true;
    setPreviewing(true);
    try {
      const read = await readReview({
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          taskId: editing.facts.taskId,
          projectId: editing.facts.projectId,
          threadId: editing.facts.threadId,
          revision: editing.facts.contract.revision,
        },
      });
      if (
        generation !== previewGeneration.current ||
        !mounted.current ||
        currentIdentity.current !== initialIdentity ||
        currentFacts.current !== editing.key ||
        editorRef.current?.facts !== editing.facts ||
        latest.current.stale
      )
        return;
      if (
        read._tag !== "Success" ||
        read.value.status !== "available" ||
        read.value.canEditInstructions !== true ||
        read.value.taskId !== editing.facts.taskId ||
        read.value.threadId !== editing.facts.threadId ||
        read.value.projectId !== editing.facts.projectId ||
        read.value.reference.environmentId !== props.environmentId ||
        read.value.contract.revision !== editing.facts.contract.revision ||
        read.value.reference.threadUpdatedAt !== editing.facts.reference.threadUpdatedAt ||
        read.value.reference.threadSequence !== editing.facts.reference.threadSequence
      ) {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice(
          "Paused instruction facts changed or could not be confirmed. Refresh before saving; no mutation was sent.",
        );
        return;
      }
      setConfirmation({ action: "set", facts: read.value, proposed });
    } catch {
      if (
        generation === previewGeneration.current &&
        mounted.current &&
        currentIdentity.current === initialIdentity &&
        editorRef.current?.facts === editing.facts &&
        currentFacts.current === editing.key &&
        !latest.current.stale
      ) {
        uncertainReadVersion.current = latest.current.readVersion;
        setBlocked(true);
        setNotice(
          "Instruction review could not be confirmed. Refresh task facts; no mutation was sent.",
        );
      }
    } finally {
      if (generation === previewGeneration.current) {
        previewingRef.current = false;
        if (mounted.current && currentIdentity.current === initialIdentity) setPreviewing(false);
      }
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
        onAccept={
          canReview && !pending && hint.actions.includes("accept") ? () => run("accept") : undefined
        }
        onRedirect={
          canReview && !pending && hint.actions.includes("redirect")
            ? () => run("redirect")
            : undefined
        }
        onResume={
          canReview && !pending && hint.actions.includes("resume") ? () => run("resume") : undefined
        }
      />
      {canReview &&
      hint.canEditInstructions === true &&
      readout.phase === "redirected" &&
      readout.acceptedRevision !== readout.contract.revision &&
      !pending ? (
        <Button type="button" variant="outline" onClick={() => void run("set")}>
          Revise paused instructions
        </Button>
      ) : null}
      {editor ? (
        <TaskInstructionEditor
          contract={editor.facts.contract}
          draft={editor.draft}
          busy={previewing || confirmation !== null}
          blocked={blocked}
          onChange={(draft) => {
            if (!previewingRef.current && !confirmation && !blocked)
              setEditor((current) => (current ? { ...current, draft } : null));
          }}
          onPreview={() => void previewInstructions()}
          onCancel={() => {
            const resolve = resolveEditor.current;
            resolveEditor.current = null;
            previewGeneration.current += 1;
            previewingRef.current = false;
            setPreviewing(false);
            setEditor(null);
            setConfirmation(null);
            resolve?.(null);
          }}
        />
      ) : null}
      {pending ? (
        <p role="status">{editor ? "Editing paused instructions…" : "Review decision pending…"}</p>
      ) : null}
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
                ? confirmation.action === "set"
                  ? `Save revision ${confirmation.facts.contract.revision + 1}?`
                  : `${label(confirmation.action)} ${confirmation.facts.contract.revision}`
                : "Review task"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation ? (
                <>
                  Task: {confirmation.facts.title}. Environment:{" "}
                  {confirmation.facts.reference.environmentId}. Displayed revision:{" "}
                  {confirmation.facts.contract.revision}.{" "}
                  {confirmation.action === "set"
                    ? "Goal, Redirect and Acceptance change; Brake stays unchanged. Task remains paused and needs a separate Resume. Saving sends no message and starts no provider work. Cancellation requested does not confirm stopping."
                    : effectText(confirmation.action)}
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmation?.action === "set" && confirmation.proposed ? (
            <dl>
              {(["goal", "redirect", "acceptance"] as const).map((field) => (
                <div key={field}>
                  <dt>Current {field}</dt>
                  <dd>{confirmation.facts.contract[field]}</dd>
                  <dt>Proposed {field}</dt>
                  <dd>{confirmation.proposed![field]}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button onClick={() => close(true)}>
              {confirmation?.action === "set" ? "Save new revision" : "Confirm decision"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
