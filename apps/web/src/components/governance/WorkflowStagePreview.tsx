import { RegistryContext } from "@effect/atom-react";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ProjectId,
  type WorkflowStagePreview as Preview,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext, useLayoutEffect, useRef, useState } from "react";

import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowEnvironment } from "../../state/workflow";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";

// The parent keys this panel by the current workflow context and catalog revision.
export function WorkflowStagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
}) {
  const registry = useContext(RegistryContext);
  const readPreview = useAtomQueryRunner(workflowEnvironment.stagePreview, {
    reportFailure: false,
  });
  const dispatch = useAtomCommand(workflowEnvironment.dispatchStage, { reportFailure: false });
  const reconcile = useAtomCommand(workflowEnvironment.reconcileDispatch, { reportFailure: false });
  const identityKey = `workflow-dispatch:${JSON.stringify([props.environmentId, props.projectId, props.runId, props.stageId, props.attempt])}`;
  const [submitted, setSubmitted] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(identityKey) ?? null;
    } catch {
      return "unknown";
    }
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [goal, setGoal] = useState("");
  const [redirect, setRedirect] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [stopConditions, setStopConditions] = useState("");
  const [maxTokens, setMaxTokens] = useState("4000");
  const [deadlineAt, setDeadlineAt] = useState(() => new Date(Date.now() + 600_000).toISOString());
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const request = useRef({ generation: 0, pending: false, sent: Boolean(submitted) });
  useLayoutEffect(
    () => () => {
      request.current.generation++;
    },
    [],
  );
  const invalidate = () => {
    request.current.generation++;
    request.current.pending = false;
    setPending(false);
    setPreview((value) => {
      if (!value) return null;
      const { review: _review, ...snapshot } = value;
      return snapshot;
    });
    setError(null);
  };
  const reset = () => {
    invalidate();
    setPreview(null);
  };
  const taskContract = {
    goal,
    redirect,
    acceptance,
    brake: {
      maxProviderStarts: 1,
      maxTokens: Number(maxTokens),
      deadlineAt,
      stopConditions,
    },
  };
  const valid = Boolean(
    instanceId.trim() &&
    model.trim() &&
    goal.trim() &&
    redirect.trim() &&
    acceptance.trim() &&
    stopConditions.trim() &&
    Number.isInteger(Number(maxTokens)) &&
    Number(maxTokens) > 0 &&
    Number(maxTokens) <= 100_000 &&
    Date.parse(deadlineAt) > observedAt,
  );
  const load = async (review = false) => {
    if (request.current.pending || request.current.sent) return;
    setObservedAt(Date.now());
    request.current.pending = true;
    const generation = ++request.current.generation;
    setPending(true);
    setPreview(null);
    setError(null);
    try {
      const target = {
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          projectId: props.projectId,
          runId: props.runId,
          ...(instanceId.trim() && model.trim()
            ? {
                preferredRoute: {
                  instanceId: ProviderInstanceId.make(instanceId.trim()),
                  model: model.trim(),
                },
              }
            : {}),
          ...(review ? { taskContract, additionalInstruction: instruction } : {}),
        },
      };
      registry.refresh(workflowEnvironment.stagePreview(target));
      const result = await readPreview(target);
      if (request.current.generation !== generation) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const value = result.value;
      if (
        value.stage.type !== "agent" ||
        value.stage.id !== props.stageId ||
        value.attempt !== props.attempt ||
        value.route.environmentId !== props.environmentId ||
        value.route.projectResolution.projectId !== props.projectId
      )
        throw new Error("The workflow changed. Refresh the workflow, then request a new preview.");
      setPreview(value);
    } catch (failure) {
      if (request.current.generation === generation)
        setError(
          failure instanceof Error ? failure.message : "Stage preview is unavailable. Try again.",
        );
    } finally {
      if (request.current.generation === generation) {
        request.current.pending = false;
        setPending(false);
      }
    }
  };
  const start = async () => {
    if (request.current.pending || request.current.sent || !preview?.review || !valid) return;
    // oxlint-disable-next-line react/purity -- Clock access belongs to the explicit Start click, not rendering.
    const now = Date.now();
    if (Date.parse(preview.review.expiresAt) <= now || Date.parse(deadlineAt) <= now) {
      invalidate();
      setObservedAt(now);
      setError("The review or deadline expired. Review the stage again before Start.");
      return;
    }
    request.current.pending = true;
    const generation = ++request.current.generation;
    setPending(true);
    setError(null);
    try {
      const dispatchId = `wd_${randomUUID().replaceAll("-", "")}`;
      // Persist identity before invoking the command. Never clear it on a lost reply or Reset.
      if (!globalThis.localStorage)
        throw new Error("Recovery storage is unavailable; Start was not submitted.");
      globalThis.localStorage.setItem(identityKey, dispatchId);
      request.current.sent = true;
      setSubmitted(dispatchId);
      const result = await dispatch({
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          projectId: props.projectId,
          runId: props.runId,
          stageId: props.stageId,
          attempt: props.attempt,
          dispatchId,
          target: { instanceId: ProviderInstanceId.make(instanceId.trim()), model: model.trim() },
          additionalInstruction: instruction,
          review: preview.review,
        },
      });
      if (request.current.generation !== generation) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setNotice(
        `Dispatch accepted for ${result.value.threadId}. Acceptance is not completed work.`,
      );
    } catch (failure) {
      if (request.current.generation === generation)
        setError(
          failure instanceof Error
            ? failure.message
            : "Dispatch outcome UNKNOWN. Reconcile; do not resend.",
        );
    } finally {
      if (request.current.generation === generation) {
        request.current.pending = false;
        setPending(false);
      }
    }
  };
  const recover = async () => {
    if (request.current.pending) return;
    request.current.pending = true;
    const generation = ++request.current.generation;
    setPending(true);
    setError(null);
    try {
      const result = await reconcile({
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          projectId: props.projectId,
          runId: props.runId,
          stageId: props.stageId,
          attempt: props.attempt,
        },
      });
      if (request.current.generation !== generation) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const value = result.value;
      if (value.dispatchId) {
        request.current.sent = true;
        setSubmitted(value.dispatchId);
        globalThis.localStorage?.setItem(identityKey, value.dispatchId);
      }
      setNotice(
        value.status === "accepted"
          ? `Original dispatch accepted for ${value.threadId}. Acceptance is not completed work.`
          : value.status === "not-submitted"
            ? "No persisted dispatch was found. An outstanding response is still uncertain; no resend was attempted."
            : "Dispatch outcome UNKNOWN. No resend was attempted.",
      );
    } catch (failure) {
      if (request.current.generation === generation)
        setError(
          failure instanceof Error ? failure.message : "Recovery unavailable; outcome UNKNOWN.",
        );
    } finally {
      if (request.current.generation === generation) {
        request.current.pending = false;
        setPending(false);
      }
    }
  };
  const change =
    (set: (value: string) => void) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      invalidate();
      set(event.target.value);
    };
  return (
    <section className="space-y-2" aria-label="Workflow stage preview" aria-busy={pending}>
      <p className="text-xs">
        Project {props.projectId} · Run {props.runId} · Stage {props.stageId} · Attempt{" "}
        {props.attempt}
      </p>
      <p className="text-xs text-muted-foreground">
        Preview and review start no work. Start runs only this stage on your exact selected model.
        Every successor needs another explicit Start.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || Boolean(submitted)}
          onClick={() => void load()}
        >
          {pending ? "Loading preview…" : "Preview stage"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={reset}>
          Reset preview
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void recover()}
        >
          Reconcile original dispatch
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs">
          {notice}
        </p>
      ) : null}
      {submitted ? (
        <p className="text-xs">
          Original dispatch {submitted}. UNKNOWN until receipts prove acceptance; Start is locked.
          Reconciliation never sends provider work.
        </p>
      ) : null}
      {preview ? (
        <div className="space-y-1 text-xs">
          <p>
            Readiness: {preview.route.gate.decision} · {preview.route.gate.reasonCodes.join(", ")}
          </p>
          <p>
            Selected provider instance:{" "}
            {preview.route.selected?.target.instanceId ?? "Unknown / none selected"} · Model:{" "}
            {preview.route.selected?.target.model ?? "Unknown / none selected"}
          </p>
          {preview.route.candidates.map((candidate) => (
            <div
              key={`${candidate.target.instanceId}:${candidate.target.model}:${candidate.fallbackIndex}`}
            >
              <p>
                Provider instance: {candidate.target.instanceId} · Model: {candidate.target.model} ·
                Source: {candidate.source} ·{" "}
                {candidate.eligible ? "Eligible in this snapshot" : "Not eligible"} ·{" "}
                {candidate.reasonCodes.join(", ")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || Boolean(submitted) || !candidate.eligible}
                onClick={() => {
                  invalidate();
                  setInstanceId(candidate.target.instanceId);
                  setModel(candidate.target.model);
                }}
              >
                Choose {candidate.target.instanceId} / {candidate.target.model}
              </Button>
            </div>
          ))}
          <details>
            <summary>Stage packet</summary>
            <pre className="whitespace-pre-wrap">{preview.packetText}</pre>
          </details>
        </div>
      ) : null}
      <fieldset disabled={pending || Boolean(submitted)} className="space-y-2 text-xs">
        <legend>Exact model and task contract</legend>
        <label className="block">
          Provider instance
          <input
            aria-label="Provider instance"
            value={instanceId}
            onChange={change(setInstanceId)}
          />
        </label>
        <label className="block">
          Model
          <input aria-label="Model" value={model} onChange={change(setModel)} />
        </label>
        <label className="block">
          Goal
          <textarea aria-label="Goal" value={goal} onChange={change(setGoal)} />
        </label>
        <label className="block">
          Redirect
          <textarea aria-label="Redirect" value={redirect} onChange={change(setRedirect)} />
        </label>
        <label className="block">
          Acceptance
          <textarea aria-label="Acceptance" value={acceptance} onChange={change(setAcceptance)} />
        </label>
        <p>
          Brake: one provider start, no automatic next stage. Stop conditions are recorded for human
          review.
        </p>
        <label className="block">
          Stop conditions
          <textarea
            aria-label="Stop conditions"
            value={stopConditions}
            onChange={change(setStopConditions)}
          />
        </label>
        <label className="block">
          Maximum tokens
          <input
            aria-label="Maximum tokens"
            type="number"
            min="1"
            max="100000"
            value={maxTokens}
            onChange={change(setMaxTokens)}
          />
        </label>
        <label className="block">
          Deadline (UTC)
          <input aria-label="Deadline (UTC)" value={deadlineAt} onChange={change(setDeadlineAt)} />
        </label>
        <label className="block">
          Additional instruction
          <textarea
            aria-label="Additional instruction"
            maxLength={2000}
            value={instruction}
            onChange={change(setInstruction)}
          />
        </label>
      </fieldset>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || Boolean(submitted) || !valid}
          onClick={() => void load(true)}
        >
          Review exact stage
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            pending ||
            Boolean(submitted) ||
            !valid ||
            !preview?.review ||
            Date.parse(preview.review.expiresAt) <= observedAt
          }
          onClick={() => void start()}
        >
          Start reviewed stage
        </Button>
      </div>
      {preview?.review ? (
        <p className="text-xs">
          Review expires {preview.review.expiresAt}. Read the stage packet and contract above before
          Start. Edits invalidate this review.
        </p>
      ) : null}
    </section>
  );
}
