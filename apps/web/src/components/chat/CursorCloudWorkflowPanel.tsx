import type {
  CursorCloudDispatchPreview,
  CursorCloudExecutionTarget,
  CursorCloudRunnerBinding,
} from "@t3tools/contracts";
import {
  cursorCloudCancelDisabled,
  cursorCloudDispatchAllowed,
  cursorCloudFollowUpDisabled,
  presentCursorCloudBinding,
  presentCursorCloudPayload,
  presentCursorCloudTarget,
  type CursorCloudTargetDraft,
} from "@t3tools/client-runtime/cursor-cloud";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const Field = (props: { readonly label: string; readonly value: string | null }) =>
  props.value ? (
    <div>
      <span className="text-muted-foreground">{props.label}: </span>
      <span className="break-all">{props.value}</span>
    </div>
  ) : null;

export function CursorCloudTargetFields(props: {
  readonly draft: CursorCloudTargetDraft;
  readonly onChange: (update: (current: CursorCloudTargetDraft) => CursorCloudTargetDraft) => void;
}) {
  const update = (patch: Partial<CursorCloudTargetDraft>) =>
    props.onChange((current) => ({ ...current, ...patch }));
  return (
    <div className="space-y-2">
      <select
        aria-label="Cursor Cloud target mode"
        className="h-8 rounded-md border border-input bg-background px-2"
        value={props.draft.mode}
        onChange={(event) => update({ mode: event.target.value as CursorCloudTargetDraft["mode"] })}
      >
        <option value="repository">GitHub repository</option>
        <option value="named-environment">Named cloud environment</option>
      </select>
      {props.draft.mode === "repository" ? (
        <>
          <Input
            aria-label="GitHub repository URL"
            placeholder="https://github.com/org/repo"
            value={props.draft.repositoryUrl}
            onChange={(event) => update({ repositoryUrl: event.target.value })}
          />
          <Input
            aria-label="Exact starting commit SHA"
            placeholder="40-character commit SHA"
            value={props.draft.startingRef}
            onChange={(event) => update({ startingRef: event.target.value })}
          />
          <p className="text-muted-foreground">
            Cursor Cloud starts from this exact SHA. Branch names such as main are rejected.
          </p>
        </>
      ) : (
        <Input
          aria-label="Named cloud environment"
          placeholder="environment-name"
          value={props.draft.environmentName}
          onChange={(event) => update({ environmentName: event.target.value })}
        />
      )}
    </div>
  );
}

export function CursorCloudDispatchReview(props: {
  readonly preview: CursorCloudDispatchPreview | undefined;
  readonly target: CursorCloudExecutionTarget | null;
}) {
  const payload = props.preview?.payload;
  const presented = payload
    ? presentCursorCloudPayload(payload)
    : props.target
      ? presentCursorCloudTarget(props.target)
      : null;
  return (
    <div className="space-y-1 rounded-md border border-border p-2">
      <div className="font-medium">Cursor Cloud dispatch</div>
      {presented ? (
        <>
          <Field label="Runner" value={presented.runner} />
          {"provider" in presented ? (
            <Field label="Provider / model" value={`${presented.provider} · ${presented.model}`} />
          ) : null}
          <Field label="Repository" value={presented.repository} />
          <Field label="Starting ref" value={presented.startingRef} />
          <Field label="Expected environment" value={presented.expectedEnvironment} />
          <Field label="Expected build" value={presented.expectedBuild} />
          <Field label="Named environment" value={presented.environmentName} />
          {"workOnCurrentBranch" in presented ? (
            <>
              <Field label="workOnCurrentBranch" value="false" />
              <Field label="autoCreatePR" value="false" />
              <Field label="Credential reference" value="server env" />
            </>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">
          Repository, exact starting SHA, or named environment is required before dispatch.
        </p>
      )}
      {props.preview && props.preview.gate.decision !== "ALLOW" ? (
        <p role="alert" className="text-destructive">
          ActionGate denied this dispatch: {props.preview.gate.reasonCodes.join(", ")}
        </p>
      ) : null}
      {props.preview && !props.preview.configured ? (
        <p className="text-muted-foreground">Cursor Cloud is not configured on this server.</p>
      ) : null}
      {cursorCloudDispatchAllowed(props.preview) ? (
        <p>ActionGate approved this immutable payload. Confirm to create the Cursor agent.</p>
      ) : null}
    </div>
  );
}

export function CursorCloudBindingCard(props: {
  readonly binding: CursorCloudRunnerBinding;
  readonly taskId: string;
  readonly followUp: string;
  readonly busy: boolean;
  readonly onFollowUpChange: (value: string) => void;
  readonly onFollowUp: () => void;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
}) {
  const presented = presentCursorCloudBinding(props.binding);
  const followUpDisabled =
    props.busy || cursorCloudFollowUpDisabled(props.binding) || props.followUp.trim().length === 0;
  const cancelDisabled = props.busy || cursorCloudCancelDisabled(props.binding);
  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="font-medium">Cursor Cloud run</div>
      <Field label="Task" value={props.taskId} />
      <Field label="Runner" value="Cursor Cloud" />
      <Field label="Provider / model" value={`${presented.provider} · ${presented.model}`} />
      <Field label="Agent ID" value={presented.agentId} />
      <Field label="Run ID" value={presented.runId} />
      <Field label="Status" value={presented.status} />
      <Field label="Agent URL" value={presented.agentUrl} />
      <Field label="Repository" value={presented.repository} />
      <Field label="Starting ref" value={presented.startingRef} />
      <Field label="Output branch" value={presented.outputBranch} />
      <Field label="Final commit" value={presented.outputCommit} />
      <Field label="Pull request" value={presented.pullRequestUrl} />
      <Field label="Result" value={presented.result} />
      <Field label="Error" value={presented.error} />
      <Field label="Created" value={presented.createdAt} />
      <Field label="Updated" value={presented.updatedAt} />
      {cursorCloudFollowUpDisabled(props.binding) ? (
        <p role="status">Follow-up is disabled while the Cursor run is active.</p>
      ) : (
        <p className="text-muted-foreground">
          Follow-up and cancellation require ActionGate approval.
        </p>
      )}
      <Textarea
        aria-label="Cursor Cloud follow-up"
        value={props.followUp}
        maxLength={16_000}
        onChange={(event) => props.onFollowUpChange(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={followUpDisabled} onClick={props.onFollowUp}>
          Send follow-up
        </Button>
        <Button size="sm" variant="outline" disabled={cancelDisabled} onClick={props.onCancel}>
          Cancel Cursor run
        </Button>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onRefresh}>
          Refresh Cursor status
        </Button>
      </div>
    </div>
  );
}
