import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CollaborationTaskResultReadout,
  TaskContractReviewReference,
  TaskResultFeedbackState,
  type TaskResultFeedbackInput,
  type TaskResultFeedbackSubmit,
  type CollaborationTask,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "../ui/alert-dialog";

type Facts = Extract<TaskResultFeedbackState, { status: "available" }>;
const validFeedback = Schema.is(TaskResultFeedbackState);
const sameResult = Schema.toEquivalence(CollaborationTaskResultReadout);
const sameReference = Schema.toEquivalence(TaskContractReviewReference);
const judgmentLabel = (kind: string) =>
  kind === "helpful" ? "Helpful" : kind === "not_helpful" ? "Not helpful" : kind;
const readFeedback = (payload: TaskResultFeedbackInput) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.taskResultFeedback.readTaskResultFeedback({ headers: {}, payload }),
      ),
    ),
  );
const submitFeedback = (payload: TaskResultFeedbackSubmit) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.taskResultFeedback.submitTaskResultFeedback({ headers: {}, payload }),
      ),
    ),
  );

export function TaskResultFeedback(props: {
  task: CollaborationTask;
  environmentId: EnvironmentId;
  stale: boolean;
  readVersion: number;
}) {
  const connection = Option.getOrNull(usePreparedConnection(props.environmentId));
  const key = JSON.stringify([props.environmentId, props.task, props.readVersion, props.stale]);
  const [loaded, setLoaded] = useState<{
    key: string;
    connection: typeof connection;
    state: TaskResultFeedbackState;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    key: string;
    connection: typeof connection;
    generation: number;
    facts: Facts;
    kind: "helpful" | "not_helpful";
  } | null>(null);
  const [notice, setNoticeState] = useState<{
    key: string;
    connection: typeof connection;
    text: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const blocked = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const latest = useRef({ props, key, connection });
  useLayoutEffect(() => {
    latest.current = { props, key, connection };
  }, [props, key, connection]);
  const identityRef = useRef({ key, connection });
  const setNotice = (value: string | null) =>
    setNoticeState(
      value === null
        ? null
        : { key: latest.current.key, connection: latest.current.connection, text: value },
    );
  useLayoutEffect(() => {
    if (identityRef.current.key === key && identityRef.current.connection === connection) return;
    identityRef.current = { key, connection };
    generation.current++;
    blocked.current = false;
  }, [key, connection]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const targetFor = (current: typeof props): TaskResultFeedbackInput | null => {
    const t = current.task;
    if (
      current.stale ||
      !t.threadId ||
      !t.review ||
      t.contractReadout?.status !== "available" ||
      t.resultReadout?.status !== "available" ||
      t.resultReadout.content.status !== "output"
    )
      return null;
    return {
      environmentId: current.environmentId,
      taskId: t.id,
      projectId: t.projectId,
      threadId: t.threadId,
      revision: t.contractReadout.contract.revision,
    };
  };
  const target = () => targetFor(latest.current.props);
  const matches = (facts: TaskResultFeedbackState): facts is Facts => {
    const p = latest.current.props,
      t = p.task,
      input = target();
    return (
      validFeedback(facts) &&
      facts.status === "available" &&
      input !== null &&
      facts.target.environmentId === input.environmentId &&
      facts.target.taskId === input.taskId &&
      facts.target.projectId === input.projectId &&
      facts.target.threadId === input.threadId &&
      facts.target.revision === input.revision &&
      t.review !== undefined &&
      sameReference(facts.reference, t.review.reference) &&
      t.resultReadout !== undefined &&
      sameResult(facts.result, t.resultReadout)
    );
  };
  const current = (g: number, capturedKey: string, capturedConnection: typeof connection) =>
    mounted.current &&
    generation.current === g &&
    latest.current.key === capturedKey &&
    latest.current.connection === capturedConnection &&
    !latest.current.props.stale;
  const refresh = async () => {
    if (
      key !== latest.current.key ||
      connection !== latest.current.connection ||
      pendingRef.current
    )
      return;
    const input = target();
    if (!input) return;
    pendingRef.current = true;
    setPending(true);
    const g = generation.current,
      k = latest.current.key,
      c = latest.current.connection;
    try {
      const result = await readFeedback(input);
      if (!current(g, k, c)) return;
      if (!matches(result)) {
        setLoaded({
          key: k,
          connection: c,
          state: { status: "unavailable", reason: "fresh-result-required" },
        });
        setNotice("Feedback is unavailable for this result. Refresh Tasks before continuing.");
        return;
      }
      setLoaded({ key: k, connection: c, state: result });
      blocked.current = false;
      setNotice(null);
    } catch {
      if (current(g, k, c)) {
        blocked.current = true;
        setLoaded(null);
        setNotice("Feedback could not be read. Refresh feedback to try again.");
      }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  useEffect(() => {
    if (!pending && !blocked.current && (loaded?.key !== key || loaded.connection !== connection))
      void refresh();
  }, [key, connection, pending, loaded, refresh]);
  const choose = async (kind: "helpful" | "not_helpful") => {
    if (
      key !== latest.current.key ||
      connection !== latest.current.connection ||
      pendingRef.current ||
      blocked.current
    )
      return;
    const input = target();
    if (!input) return;
    pendingRef.current = true;
    setPending(true);
    const g = generation.current,
      k = latest.current.key,
      c = latest.current.connection;
    try {
      const facts = await readFeedback(input);
      if (!current(g, k, c)) return;
      if (!matches(facts)) {
        blocked.current = true;
        setLoaded(null);
        setNotice("The result or session changed. Refresh Tasks before rating it.");
        return;
      }
      setLoaded({ key: k, connection: c, state: facts });
      if (facts.feedback.length > 0) return;
      setConfirmation({ key: k, connection: c, generation: g, facts, kind });
      setNotice(null);
    } catch {
      if (current(g, k, c))
        setNotice("The result could not be checked. Refresh feedback before continuing.");
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const confirm = async () => {
    if (
      pendingRef.current ||
      blocked.current ||
      !confirmation ||
      confirmation.key !== latest.current.key ||
      confirmation.connection !== latest.current.connection ||
      confirmation.generation !== generation.current ||
      !matches(confirmation.facts)
    )
      return;
    // A ref closes the same-render double-click window before any request is awaited.
    pendingRef.current = true;
    setPending(true);
    const chosen = confirmation,
      g = generation.current,
      k = latest.current.key,
      c = latest.current.connection;
    setConfirmation(null);
    try {
      const response = await submitFeedback({
        ...chosen.facts.target,
        reference: chosen.facts.reference,
        fingerprint: chosen.facts.fingerprint,
        contextKey: chosen.facts.contextKey,
        kind: chosen.kind,
        confirm: true,
      });
      if (!current(g, k, c)) return;
      if (!matches(response) || response.feedback.length === 0) {
        blocked.current = true;
        setLoaded(null);
        setNotice("The result or session changed. Refresh Tasks before continuing.");
        return;
      }
      setLoaded({ key: k, connection: c, state: response });
      setNotice(null);
    } catch {
      if (current(g, k, c)) {
        blocked.current = true;
        setLoaded(null);
        setNotice(
          "Recording outcome unknown. Refresh feedback to recover the saved choice; the request will not be retried.",
        );
      }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const facts =
    loaded?.key === key &&
    loaded.connection === connection &&
    loaded.state.status === "available" &&
    !props.stale
      ? loaded.state
      : null;
  const dialog =
    confirmation?.key === key && confirmation.connection === connection && !props.stale
      ? confirmation
      : null;
  const visibleNotice =
    notice?.key === key && notice.connection === connection ? notice.text : null;
  if (!targetFor(props)) return null;
  return (
    <div className="mt-4 space-y-2" aria-label="Task result feedback">
      <p className="text-xs text-muted-foreground">
        Feedback records your judgment of this result. It does not accept the task or start
        execution; one vote does not establish a routing improvement.
      </p>
      {facts?.feedback.length ? (
        <p>{`${facts.feedbackForResult ? "Recorded" : "Existing feedback for another or unverified result"}: ${facts.feedback.map((f) => judgmentLabel(f.kind)).join(", ")}`}</p>
      ) : facts ? (
        <div className="flex gap-2">
          <Button variant="outline" disabled={pending} onClick={() => choose("helpful")}>
            Helpful
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => choose("not_helpful")}>
            Not helpful
          </Button>
        </div>
      ) : null}
      <Button variant="ghost" disabled={pending || props.stale} onClick={refresh}>
        Refresh feedback
      </Button>
      {visibleNotice ? <p role="status">{visibleNotice}</p> : null}
      <AlertDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) setConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Record {dialog ? judgmentLabel(dialog.kind) : "feedback"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This records one immutable result judgment. It does not accept the task, send a
              message, start execution, or activate routing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialog ? (
            <div className="space-y-2">
              <p>Task: {dialog.facts.title}</p>
              <p>Environment: {dialog.facts.target.environmentId}</p>
              <p>
                Model: {dialog.facts.model.instanceId} / {dialog.facts.model.model}
              </p>
              {dialog.facts.result.status === "available" &&
              dialog.facts.result.content.status === "output" ? (
                <>
                  <p>
                    Result: {dialog.facts.result.runId} / {dialog.facts.result.content.itemId}
                  </p>
                  <blockquote className="whitespace-pre-wrap">
                    {dialog.facts.result.content.preview}
                  </blockquote>
                  {dialog.facts.result.content.truncated ? (
                    <p>
                      Result preview is truncated. The complete persisted result is checked before
                      recording.
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)} disabled={pending}>
              Cancel feedback
            </Button>
            <Button onClick={confirm} disabled={pending}>
              Confirm feedback
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
