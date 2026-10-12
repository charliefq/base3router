import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, WorkflowStagePreview as Preview } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext, useLayoutEffect, useRef, useState } from "react";

import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { workflowEnvironment } from "../../state/workflow";
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef({ generation: 0, pending: false });
  useLayoutEffect(
    () => () => {
      request.current.generation++;
    },
    [],
  );
  const reset = () => {
    request.current.generation++;
    request.current.pending = false;
    setPending(false);
    setPreview(null);
    setError(null);
  };
  const load = async () => {
    if (request.current.pending) return;
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
        },
      };
      // Each explicit preview must replace even a waiting RPC from a reset or
      // an earlier catalog revision. Other query runners retain their deduping.
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
      ) {
        setError("The workflow changed. Refresh the workflow, then request a new preview.");
        return;
      }
      setPreview(value);
    } catch (failure) {
      if (request.current.generation !== generation) return;
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
  return (
    <section className="space-y-2" aria-label="Workflow stage preview" aria-busy={pending}>
      <p className="text-xs">
        Project {props.projectId} · Run {props.runId} · Stage {props.stageId} · Attempt{" "}
        {props.attempt}
      </p>
      <p className="text-xs text-muted-foreground">
        Read-only snapshot. Refresh to check current readiness. A preview is not dispatch
        permission; dispatch is unavailable here.
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void load()}
        >
          {pending ? "Loading preview…" : "Preview stage"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          Reset preview
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="space-y-1 text-xs">
          <p>
            Readiness: {preview.route.gate.decision}
            {preview.route.gate.reasonCodes.length
              ? ` · ${preview.route.gate.reasonCodes.join(", ")}`
              : ""}
          </p>
          <p>
            Selected provider instance:{" "}
            {preview.route.selected?.target.instanceId ?? "Unknown / none selected"} · Model:{" "}
            {preview.route.selected?.target.model ?? "Unknown / none selected"}
          </p>
          {preview.route.candidates.map((candidate) => (
            <p
              key={JSON.stringify([
                candidate.fallbackIndex,
                candidate.target.instanceId,
                candidate.target.model,
                candidate.source,
              ])}
            >
              Provider instance: {candidate.target.instanceId} · Model: {candidate.target.model} ·
              Source: {candidate.source} ·{" "}
              {candidate.eligible ? "Eligible in this snapshot" : "Not eligible"}
              {candidate.reasonCodes.length ? ` · ${candidate.reasonCodes.join(", ")}` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
