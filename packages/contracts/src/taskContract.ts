/**
 * Explicit contract for a governed task on the V2 thread.
 * Goal, redirect, acceptance, and brake are user intent. The server does not
 * invent them. Redirect and acceptance text stay human decisions.
 */
import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TaskContractBrake = Schema.Struct({
  /** Provider starts allowed across the task execution tree. Required; no default. */
  maxProviderStarts: PositiveInt,
  /** Natural-language stop conditions. Recorded for a human; not semantically enforced. */
  stopConditions: TrimmedNonEmptyString,
});
export type TaskContractBrake = typeof TaskContractBrake.Type;

export const TaskContractFields = Schema.Struct({
  goal: TrimmedNonEmptyString,
  redirect: TrimmedNonEmptyString,
  acceptance: TrimmedNonEmptyString,
  brake: TaskContractBrake,
});
export type TaskContractFields = typeof TaskContractFields.Type;

export const TaskContract = Schema.Struct({
  revision: PositiveInt,
  goal: TrimmedNonEmptyString,
  redirect: TrimmedNonEmptyString,
  acceptance: TrimmedNonEmptyString,
  brake: TaskContractBrake,
});
export type TaskContract = typeof TaskContract.Type;

export const TaskContractPhase = Schema.Literals(["active", "redirected"]);
export type TaskContractPhase = typeof TaskContractPhase.Type;

export const TaskContractDecision = Schema.Struct({
  kind: Schema.Literals(["set", "accept", "redirect", "resume"]),
  revision: PositiveInt,
  actorId: TrimmedNonEmptyString,
  at: Schema.DateTimeUtc,
});
export type TaskContractDecision = typeof TaskContractDecision.Type;

export const TASK_CONTRACT_HUMAN_DECISION =
  "Redirect and acceptance text are human decisions. Provider completion does not accept the task, and the server does not judge those sentences.";

const MISSING_CONTRACT_FIELDS = [
  "goal",
  "redirect",
  "acceptance",
  "brake maxProviderStarts",
  "brake stop conditions",
] as const;

export function taskContractFieldErrors(input: {
  readonly goal?: string | null;
  readonly redirect?: string | null;
  readonly acceptance?: string | null;
  readonly maxProviderStarts?: number | null;
  readonly stopConditions?: string | null;
}): ReadonlyArray<string> {
  const errors: Array<string> = [];
  if (input.goal === undefined || input.goal === null || input.goal.trim().length === 0) {
    errors.push("Goal is required.");
  }
  if (
    input.redirect === undefined ||
    input.redirect === null ||
    input.redirect.trim().length === 0
  ) {
    errors.push("Redirect is required.");
  }
  if (
    input.acceptance === undefined ||
    input.acceptance === null ||
    input.acceptance.trim().length === 0
  ) {
    errors.push("Acceptance is required.");
  }
  if (
    input.maxProviderStarts === undefined ||
    input.maxProviderStarts === null ||
    !Number.isInteger(input.maxProviderStarts) ||
    input.maxProviderStarts < 1
  ) {
    errors.push(
      "Brake maxProviderStarts must be an explicit positive integer. No default is applied.",
    );
  }
  if (
    input.stopConditions === undefined ||
    input.stopConditions === null ||
    input.stopConditions.trim().length === 0
  ) {
    errors.push("Brake stop conditions are required.");
  }
  return errors;
}

export function incompleteTaskContractMessage(): string {
  return `This task is paused until its contract is completed. Missing ${MISSING_CONTRACT_FIELDS.join(", ")}. Submit them with thread.task-contract.set. ${TASK_CONTRACT_HUMAN_DECISION}`;
}

export function childConstraintConflict(
  parent: TaskContract,
  proposed: TaskContractFields,
): string | null {
  if (proposed.brake.maxProviderStarts > parent.brake.maxProviderStarts) {
    return `Delegated work cannot raise maxProviderStarts above the parent limit of ${parent.brake.maxProviderStarts}.`;
  }
  if (
    proposed.goal !== parent.goal ||
    proposed.redirect !== parent.redirect ||
    proposed.acceptance !== parent.acceptance ||
    proposed.brake.stopConditions !== parent.brake.stopConditions ||
    proposed.brake.maxProviderStarts !== parent.brake.maxProviderStarts
  ) {
    return "Delegated work inherits the parent contract and cannot replace its goal, redirect, acceptance, or brake.";
  }
  return null;
}

/** Hash material bound to a dispatch grant. Absent for ordinary chat, so those hashes stay stable. */
export function contractGrantFields(contract: TaskContract | null): {
  readonly contractRevision?: number;
  readonly maxProviderStarts?: number;
} {
  if (contract === null) return {};
  return {
    contractRevision: contract.revision,
    maxProviderStarts: contract.brake.maxProviderStarts,
  };
}
