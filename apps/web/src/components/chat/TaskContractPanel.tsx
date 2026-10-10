import {
  TASK_CONTRACT_HUMAN_DECISION,
  taskContractFieldErrors,
  type TaskContractFields,
  type TaskUsageSummary,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";

export interface TaskContractDraft {
  readonly enabled: boolean;
  readonly goal: string;
  readonly redirect: string;
  readonly acceptance: string;
  readonly maxProviderStarts: string;
  readonly stopConditions: string;
}

export const EMPTY_TASK_CONTRACT_DRAFT: TaskContractDraft = {
  enabled: false,
  goal: "",
  redirect: "",
  acceptance: "",
  maxProviderStarts: "",
  stopConditions: "",
};

export function taskContractFromDraft(draft: TaskContractDraft): {
  readonly error: string | null;
  readonly contract: TaskContractFields | null;
} {
  if (!draft.enabled) return { error: null, contract: null };
  const maxProviderStarts = Number(draft.maxProviderStarts);
  const errors = taskContractFieldErrors({
    goal: draft.goal,
    redirect: draft.redirect,
    acceptance: draft.acceptance,
    maxProviderStarts: draft.maxProviderStarts.trim() === "" ? null : maxProviderStarts,
    stopConditions: draft.stopConditions,
  });
  if (errors.length > 0) return { error: errors.join(" "), contract: null };
  return {
    error: null,
    contract: {
      goal: draft.goal.trim(),
      redirect: draft.redirect.trim(),
      acceptance: draft.acceptance.trim(),
      brake: {
        maxProviderStarts,
        stopConditions: draft.stopConditions.trim(),
      },
    },
  };
}

export function TaskContractForm(props: {
  readonly draft: TaskContractDraft;
  readonly onChange: (draft: TaskContractDraft) => void;
}) {
  const draft = props.draft;
  return (
    <fieldset
      className="mb-2 space-y-2 rounded-md border border-border/60 p-2 text-xs"
      data-task-contract-form="true"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
    >
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={draft.enabled}
          data-task-contract-toggle=""
          onChange={(event) => props.onChange({ ...draft, enabled: event.target.checked })}
        />
        Governed task
      </label>
      {draft.enabled ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground">{TASK_CONTRACT_HUMAN_DECISION}</p>
          <label className="grid gap-1">
            Goal
            <input
              className="rounded-md border border-border/70 bg-background px-2 py-1"
              data-task-contract-goal=""
              value={draft.goal}
              onChange={(event) => props.onChange({ ...draft, goal: event.target.value })}
            />
          </label>
          <label className="grid gap-1">
            Redirect
            <input
              className="rounded-md border border-border/70 bg-background px-2 py-1"
              data-task-contract-redirect=""
              value={draft.redirect}
              onChange={(event) => props.onChange({ ...draft, redirect: event.target.value })}
            />
          </label>
          <label className="grid gap-1">
            Acceptance
            <input
              className="rounded-md border border-border/70 bg-background px-2 py-1"
              data-task-contract-acceptance=""
              value={draft.acceptance}
              onChange={(event) => props.onChange({ ...draft, acceptance: event.target.value })}
            />
          </label>
          <label className="grid gap-1">
            Brake max provider starts
            <input
              className="rounded-md border border-border/70 bg-background px-2 py-1"
              data-task-contract-max-starts=""
              inputMode="numeric"
              value={draft.maxProviderStarts}
              onChange={(event) =>
                props.onChange({ ...draft, maxProviderStarts: event.target.value })
              }
            />
          </label>
          <label className="grid gap-1">
            Brake stop conditions
            <input
              className="rounded-md border border-border/70 bg-background px-2 py-1"
              data-task-contract-stop=""
              value={draft.stopConditions}
              onChange={(event) => props.onChange({ ...draft, stopConditions: event.target.value })}
            />
          </label>
        </div>
      ) : (
        <p className="text-muted-foreground">Leave this off for ordinary chat.</p>
      )}
    </fieldset>
  );
}

export function TaskContractReadout(props: {
  readonly goal: string | null;
  readonly redirect: string | null;
  readonly acceptance: string | null;
  readonly maxProviderStarts: number | null;
  readonly stopConditions: string | null;
  readonly revision: number | null;
  readonly phase: string;
  readonly acceptedRevision: number | null;
  readonly onAccept?: (() => void) | undefined;
  readonly onRedirect?: (() => void) | undefined;
  readonly onResume?: (() => void) | undefined;
}) {
  const [pending, setPending] = useState(false);
  const accepted = props.acceptedRevision !== null && props.acceptedRevision === props.revision;
  const run = (action: (() => void) | undefined) => {
    if (action === undefined || pending) return;
    setPending(true);
    action();
    setPending(false);
  };
  return (
    <article
      className="rounded-md border border-border/60 p-3 text-xs"
      data-task-contract-inspector=""
    >
      <h3 className="font-medium">Task contract</h3>
      <p className="mt-1 text-muted-foreground" data-task-contract-phase={props.phase}>
        Revision {props.revision ?? "missing"} · {props.phase}
        {props.acceptedRevision !== null ? ` · accepted ${props.acceptedRevision}` : ""}
      </p>
      <dl className="mt-2 space-y-1">
        <div>
          <dt className="text-muted-foreground">Goal</dt>
          <dd data-task-contract-goal-text="">{props.goal ?? "Required before new work."}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Redirect</dt>
          <dd data-task-contract-redirect-text="">
            {props.redirect ?? "Required before new work."}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Acceptance</dt>
          <dd data-task-contract-acceptance-text="">
            {props.acceptance ?? "Required before new work."}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Brake</dt>
          <dd data-task-contract-brake-text="">
            {props.maxProviderStarts === null
              ? "maxProviderStarts required"
              : `${props.maxProviderStarts} provider starts`}
            {props.stopConditions ? ` · ${props.stopConditions}` : ""}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-muted-foreground">{TASK_CONTRACT_HUMAN_DECISION}</p>
      {props.phase === "active" && !accepted && props.onAccept !== undefined ? (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            type="button"
            data-task-contract-accept=""
            disabled={pending}
            onClick={() => run(props.onAccept)}
          >
            Accept result
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            data-task-contract-redirect-action=""
            disabled={pending}
            onClick={() => run(props.onRedirect)}
          >
            Pause for redirect
          </Button>
        </div>
      ) : null}
      {props.phase === "redirected" && props.onResume !== undefined ? (
        <div className="mt-2">
          <Button
            size="sm"
            variant="outline"
            type="button"
            data-task-contract-resume=""
            disabled={pending}
            onClick={() => run(props.onResume)}
          >
            Resume under this contract
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function showUsage(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function TaskUsageReadout(props: {
  readonly summary: TaskUsageSummary | null;
  readonly unavailable: boolean;
}) {
  if (props.summary === null) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-task-usage-summary={props.unavailable ? "unavailable" : "loading"}
      >
        {props.unavailable ? "Task usage is unknown." : "Reading task usage."}
      </p>
    );
  }
  const summary = props.summary;
  return (
    <article
      className="rounded-md border border-border/60 p-3 text-xs"
      data-task-usage-summary="ready"
    >
      <h3 className="font-medium">Task usage</h3>
      <p className="mt-1 text-muted-foreground">
        Provider completion is not acceptance. Missing usage and cost stay unknown.
      </p>
      <dl className="mt-2 space-y-1">
        <div>
          <dt className="text-muted-foreground">Acceptance</dt>
          <dd data-task-usage-acceptance={summary.acceptance}>
            {summary.acceptance} · revision {summary.contractRevision ?? "missing"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Attempts</dt>
          <dd
            data-task-usage-attempts={summary.attempts}
            data-task-usage-children={summary.childCount}
            data-task-usage-retries={summary.retryAttempts}
            data-task-usage-failovers={summary.failoverAttempts}
          >
            {summary.attempts} provider attempts · {summary.childCount} children ·{" "}
            {summary.retryAttempts} retries · {summary.failoverAttempts} failovers
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tokens</dt>
          <dd
            data-task-usage-input={showUsage(summary.reported.inputTokens)}
            data-task-usage-output={showUsage(summary.reported.outputTokens)}
          >
            input {showUsage(summary.reported.inputTokens)} · output{" "}
            {showUsage(summary.reported.outputTokens)} · cache read{" "}
            {showUsage(summary.reported.cachedInputTokens)} · cache write{" "}
            {showUsage(summary.reported.cacheCreationTokens)} · reasoning{" "}
            {showUsage(summary.reported.reasoningTokens)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reported cost</dt>
          <dd data-task-usage-cost={showUsage(summary.reported.reportedCostUsd)}>
            {showUsage(summary.reported.reportedCostUsd)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Coverage</dt>
          <dd
            data-task-usage-coverage={summary.totalsComplete ? "complete" : "partial"}
            data-task-usage-missing-usage={summary.missingUsageAttempts}
            data-task-usage-missing-cost={summary.missingCostAttempts}
          >
            {summary.totalsComplete ? "complete" : "partial"} · missing usage{" "}
            {summary.missingUsageAttempts} · missing cost {summary.missingCostAttempts}
          </dd>
        </div>
      </dl>
    </article>
  );
}
