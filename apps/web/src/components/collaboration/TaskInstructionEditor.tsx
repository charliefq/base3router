import type { TaskContract } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
export type TaskInstructionDraft = Pick<TaskContract, "goal" | "redirect" | "acceptance">;
export function TaskInstructionEditor(props: {
  readonly contract: TaskContract;
  readonly draft: TaskInstructionDraft;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly onChange: (draft: TaskInstructionDraft) => void;
  readonly onPreview: () => void;
  readonly onCancel: () => void;
}) {
  const proposed = {
    goal: props.draft.goal.trim(),
    redirect: props.draft.redirect.trim(),
    acceptance: props.draft.acceptance.trim(),
  };
  const valid = Object.values(proposed).every((value) => value.length > 0);
  const changed =
    proposed.goal !== props.contract.goal ||
    proposed.redirect !== props.contract.redirect ||
    proposed.acceptance !== props.contract.acceptance;
  return (
    <section data-task-instruction-editor="">
      <h3>Revise paused instructions</h3>
      <p>
        Editing revision {props.contract.revision}. Saving keeps the task paused; Resume remains a
        separate decision.
      </p>
      <fieldset disabled={props.busy || props.blocked} className="space-y-2">
        {(["goal", "redirect", "acceptance"] as const).map((field) => (
          <label key={field} className="block space-y-1">
            {field === "goal" ? "Goal" : field === "redirect" ? "Redirect" : "Acceptance"}
            <Textarea
              aria-label={`${field} instruction`}
              value={props.draft[field]}
              onChange={(event) => props.onChange({ ...props.draft, [field]: event.target.value })}
            />
          </label>
        ))}
      </fieldset>
      <p>Brake is read-only and stays unchanged.</p>
      <dl>
        <dt>Provider starts</dt>
        <dd>{props.contract.brake.maxProviderStarts}</dd>
        <dt>Stop conditions</dt>
        <dd>{props.contract.brake.stopConditions}</dd>
        {props.contract.brake.maxTokens !== undefined ? (
          <>
            <dt>Token cap</dt>
            <dd>{props.contract.brake.maxTokens}</dd>
          </>
        ) : null}
        {props.contract.brake.maxCostUsd !== undefined ? (
          <>
            <dt>Cost cap (USD)</dt>
            <dd>{props.contract.brake.maxCostUsd}</dd>
          </>
        ) : null}
        {props.contract.brake.deadlineAt !== undefined ? (
          <>
            <dt>Deadline</dt>
            <dd>{props.contract.brake.deadlineAt}</dd>
          </>
        ) : null}
      </dl>
      {!valid ? (
        <p role="alert">Goal, Redirect and Acceptance must be nonblank.</p>
      ) : !changed ? (
        <p>No instruction changes yet.</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={!valid || !changed || props.busy || props.blocked}
          onClick={props.onPreview}
        >
          Preview instruction changes
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel editing
        </Button>
      </div>
    </section>
  );
}
