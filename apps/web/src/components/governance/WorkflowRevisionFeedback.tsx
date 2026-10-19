import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  WORKFLOW_REVISION_FEEDBACK_MAX_CHARS,
  type EnvironmentId,
  type ProjectId,
  type WorkflowActionInput,
  type WorkflowArtifact,
  type WorkflowDecision,
  type WorkflowRun,
  type WorkflowStage,
} from "@t3tools/contracts";
import { workflowArtifactExcerpt, workflowRevisionSource } from "@t3tools/shared/workflowRevision";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const draftStorageKey = (scope: string) => `t3:workflow-revision-draft:v1:${scope}`;
function readDraft(scope: string) {
  try {
    const value = globalThis.sessionStorage?.getItem(draftStorageKey(scope));
    return value && value.length <= WORKFLOW_REVISION_FEEDBACK_MAX_CHARS ? value : "";
  } catch {
    return "";
  }
}

export function WorkflowDecisionHistory({ decisions }: { decisions: WorkflowRun["decisions"] }) {
  return (
    <section aria-label="Workflow decision history" className="space-y-2">
      {decisions.map((decision: WorkflowDecision) => (
        <article key={decision.id}>
          <p>
            Decision {decision.id} · Run {decision.runId} · Stage {decision.stageId} · Attempt{" "}
            {decision.attempt} · {decision.value}
          </p>
          {decision.value === "request_revision" ? (
            decision.revisionFeedback ? (
              <>
                <p>Saved requested changes</p>
                <pre className="whitespace-pre-wrap break-all text-sm">
                  {decision.revisionFeedback.text}
                </pre>
                <p>
                  Source workflow {decision.revisionFeedback.source.runId} · stage{" "}
                  {decision.revisionFeedback.source.stageId} · attempt{" "}
                  {decision.revisionFeedback.source.attempt} · artifact{" "}
                  {decision.revisionFeedback.source.artifactId}
                </p>
              </>
            ) : (
              <p>Historical revision feedback and source provenance unavailable.</p>
            )
          ) : null}
        </article>
      ))}
    </section>
  );
}
export function WorkflowRevisionFeedbackForm(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  run: WorkflowRun;
  stage: WorkflowStage;
  attempt: number;
  source: WorkflowArtifact | null;
  fresh: boolean;
  exhausted: boolean;
  submit: (input: WorkflowActionInput) => Promise<void>;
}) {
  const scope = JSON.stringify([
    props.environmentId,
    props.projectId,
    props.run.id,
    props.stage.id,
    props.attempt,
  ]);
  const facts = JSON.stringify([
    scope,
    props.attempt,
    props.run.status,
    props.run.currentStageId,
    props.run.templateVersion,
    props.run.updatedAt,
    props.run.attempts.map((a) => [a.stageId, a.attempt, a.status]),
    props.run.decisions.map((d) => [d.id, d.stageId, d.attempt]),
    props.stage,
    props.source,
    props.fresh,
  ]);
  // Primitive facts key an identity fence; A-B-A must create a new owner, without mutating data.
  // eslint-disable-next-line react/preserve-manual-memoization
  const token = useMemo(() => Symbol(facts), [facts]);
  const latest = useRef({ props, token });
  useLayoutEffect(() => {
    latest.current = { props, token };
  });
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  // Only inert text is retained across navigation; confirmation identities are mount-local.
  const text = drafts.get(scope) ?? readDraft(scope);
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null);
  type Prepared = { token: symbol; commandId: string; decisionId: string };
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const current = useRef<Prepared | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const owner = token;
    current.current = null;
    pending.current = false;
    // Synchronize executable form ownership to current external workflow facts, retaining text.
    // eslint-disable-next-line react/set-state-in-effect
    setPrepared(null);
    setBusy(false);
    return () => {
      if (current.current?.token === owner) current.current = null;
    };
  }, [token]);
  const available =
    props.fresh &&
    props.run.projectId === props.projectId &&
    !props.exhausted &&
    props.source !== null;
  const prepare = () => {
    if (
      latest.current.token !== token ||
      !available ||
      !latest.current.props.fresh ||
      pending.current
    )
      return;
    const value = {
      token,
      commandId: `wf_revision_${randomUUID().replaceAll("-", "")}`,
      decisionId: `wf_decision_${randomUUID().replaceAll("-", "")}`,
    };
    current.current = value;
    setPrepared(value);
  };
  const confirm = async () => {
    if (
      !prepared ||
      current.current !== prepared ||
      latest.current.token !== prepared.token ||
      !available ||
      !latest.current.props.fresh ||
      pending.current ||
      !props.source ||
      !text.trim() ||
      text.length > WORKFLOW_REVISION_FEEDBACK_MAX_CHARS
    )
      return;
    pending.current = true;
    setBusy(true);
    try {
      await props.submit({
        type: "decision.record",
        projectId: props.projectId,
        commandId: prepared.commandId,
        decisionId: prepared.decisionId,
        runId: props.run.id,
        stageId: props.stage.id,
        attempt: props.attempt,
        artifactId: props.stage.type === "agent" ? props.source.id : null,
        value: "request_revision",
        revisionFeedback: { text, source: workflowRevisionSource(props.source) },
      });
    } finally {
      if (current.current === prepared) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const excerpt = props.source ? workflowArtifactExcerpt(props.source) : null;
  return (
    <section aria-label="Workflow revision feedback" className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!available || busy || prepared !== null}
        onClick={prepare}
      >
        Request revision
      </Button>
      {!props.source ? (
        <p>The exact current source artifact is unavailable. Refresh workflow evidence.</p>
      ) : props.exhausted ? (
        <p>Revision attempt limit reached.</p>
      ) : null}
      {!prepared && text ? (
        <p>Requested changes draft retained. Review the current source again before recording.</p>
      ) : null}
      {draftStorageError ? <p>{draftStorageError}</p> : null}
      {prepared ? (
        <>
          <p>
            Review requested changes · Run {props.run.id} · Stage {props.stage.id} · Attempt{" "}
            {props.attempt}
          </p>
          <p>
            Source workflow {props.source?.runId} · Stage {props.source?.stageId} · Attempt{" "}
            {props.source?.attempt} · Artifact {props.source?.id} · Outcome{" "}
            {props.source?.sourceOutcome ?? "Unknown (legacy record)"}
          </p>
          <p>
            Native source run/turn {props.source?.sourceTurnId ?? "Unknown"} · Thread{" "}
            {props.source?.sourceThreadId ?? "Unknown"} · User message{" "}
            {props.source?.sourceMessageId ?? "Unknown"} · Output message{" "}
            {props.source?.outputMessageId ?? "Unknown"}
          </p>
          <pre className="whitespace-pre-wrap break-all text-sm">{excerpt?.text}</pre>
          <p>
            {excerpt?.truncated
              ? "Artifact excerpt truncated to 2000 characters; full artifact remains in history."
              : "Artifact excerpt complete."}
          </p>
          <Textarea
            aria-label="Workflow requested changes"
            maxLength={WORKFLOW_REVISION_FEEDBACK_MAX_CHARS}
            value={text}
            disabled={busy || !props.fresh}
            onChange={(event) => {
              if (
                latest.current.token === token &&
                current.current === prepared &&
                !pending.current
              ) {
                const value = event.target.value;
                setDrafts((prior) => new Map(prior).set(scope, value));
                try {
                  if (!globalThis.sessionStorage) throw new Error("No session storage");
                  if (value.length <= WORKFLOW_REVISION_FEEDBACK_MAX_CHARS)
                    globalThis.sessionStorage.setItem(draftStorageKey(scope), value);
                  setDraftStorageError(null);
                } catch {
                  setDraftStorageError(
                    "Draft kept in this view only; browser session storage is unavailable.",
                  );
                }
              }
            }}
          />
          <p>
            {text.length}/{WORKFLOW_REVISION_FEEDBACK_MAX_CHARS}. Saved feedback applies only to the
            directly resulting revision attempt. Additional instruction stays separate.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={
              !available ||
              busy ||
              !text.trim() ||
              text.length > WORKFLOW_REVISION_FEEDBACK_MAX_CHARS
            }
            onClick={() => void confirm()}
          >
            Record requested revision
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              current.current = null;
              setPrepared(null);
            }}
          >
            Cancel revision review
          </Button>
          <p>
            Recording creates a pending attempt only. Fresh exact-model review and explicit Start
            are required; no work starts here.
          </p>
        </>
      ) : null}
    </section>
  );
}
