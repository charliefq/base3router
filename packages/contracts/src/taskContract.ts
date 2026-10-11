/**
 * Explicit contract for a governed task on the V2 thread.
 * Goal, redirect, acceptance, and brake are user intent. The server does not
 * invent them. Redirect and acceptance text stay human decisions.
 */
import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Fixture-only mark for a price a test inserted on purpose.
 * Production usage accounting never writes this label and never treats a
 * reported cost as verified.
 */
export const SYNTHETIC_FIXTURE_PRICE_LABEL = "synthetic-fixture";

export const TaskContractBrake = Schema.Struct({
  /** Provider starts allowed across the task execution tree. Required; no default. */
  maxProviderStarts: PositiveInt,
  /** Natural-language stop conditions. Recorded for a human; not semantically enforced. */
  stopConditions: TrimmedNonEmptyString,
  /**
   * Cumulative input plus output tokens for the whole task tree.
   * Omitted means this contract does not use a token cap. It is not an
   * unlimited default, and a child cannot invent one.
   */
  maxTokens: Schema.optional(PositiveInt),
  /**
   * Cumulative reported dollars for the whole task tree.
   * Omitted means this contract does not use a dollar cap.
   */
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /**
   * Absolute UTC instant. The server freezes it before the first budgeted
   * start and does not move it forward on restart.
   */
  deadlineAt: Schema.optional(TrimmedNonEmptyString),
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
  readonly maxTokens?: number | null;
  readonly maxCostUsd?: number | null;
  readonly deadlineAt?: string | null;
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
  if (input.maxTokens === null) {
    errors.push("Brake maxTokens cannot be cleared. Omit it, or set an explicit positive integer.");
  } else if (
    input.maxTokens !== undefined &&
    (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)
  ) {
    errors.push(
      "Brake maxTokens must be an explicit positive integer when set. No default is applied.",
    );
  }
  if (input.maxCostUsd === null) {
    errors.push("Brake maxCostUsd cannot be cleared. Omit it, or set an explicit positive amount.");
  } else if (
    input.maxCostUsd !== undefined &&
    (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0)
  ) {
    errors.push(
      "Brake maxCostUsd must be an explicit positive amount when set. No default is applied.",
    );
  }
  if (input.deadlineAt === null) {
    errors.push("Brake deadlineAt cannot be cleared. Omit it, or set an absolute UTC timestamp.");
  } else if (
    input.deadlineAt !== undefined &&
    (input.deadlineAt.trim().length === 0 || !Number.isFinite(Date.parse(input.deadlineAt)))
  ) {
    errors.push(
      "Brake deadlineAt must be an absolute UTC timestamp when set. No default is applied.",
    );
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
    proposed.brake.maxTokens !== undefined &&
    parent.brake.maxTokens !== undefined &&
    proposed.brake.maxTokens > parent.brake.maxTokens
  ) {
    return `Delegated work cannot raise maxTokens above the parent limit of ${parent.brake.maxTokens}.`;
  }
  if (
    proposed.brake.maxCostUsd !== undefined &&
    parent.brake.maxCostUsd !== undefined &&
    proposed.brake.maxCostUsd > parent.brake.maxCostUsd
  ) {
    return `Delegated work cannot raise maxCostUsd above the parent limit of ${parent.brake.maxCostUsd}.`;
  }
  const parentDeadline = parent.brake.deadlineAt;
  const proposedDeadline = proposed.brake.deadlineAt;
  if (parentDeadline !== undefined && proposedDeadline !== undefined) {
    const parentInstant = Date.parse(parentDeadline);
    const proposedInstant = Date.parse(proposedDeadline);
    if (
      Number.isFinite(parentInstant) &&
      Number.isFinite(proposedInstant) &&
      proposedInstant > parentInstant
    ) {
      return `Delegated work cannot extend the parent deadline of ${parentDeadline}.`;
    }
  }
  if (
    proposed.goal !== parent.goal ||
    proposed.redirect !== parent.redirect ||
    proposed.acceptance !== parent.acceptance ||
    proposed.brake.stopConditions !== parent.brake.stopConditions ||
    proposed.brake.maxProviderStarts !== parent.brake.maxProviderStarts ||
    proposed.brake.maxTokens !== parent.brake.maxTokens ||
    proposed.brake.maxCostUsd !== parent.brake.maxCostUsd ||
    proposed.brake.deadlineAt !== parent.brake.deadlineAt
  ) {
    return "Delegated work inherits the parent contract and cannot replace its goal, redirect, acceptance, or brake.";
  }
  return null;
}

/** Hash material bound to a dispatch grant. Absent for ordinary chat, so those hashes stay stable. */
export function contractGrantFields(contract: TaskContract | null): {
  readonly contractRevision?: number;
  readonly maxProviderStarts?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly deadlineAt?: string;
} {
  if (contract === null) return {};
  return {
    contractRevision: contract.revision,
    maxProviderStarts: contract.brake.maxProviderStarts,
    ...(contract.brake.maxTokens === undefined ? {} : { maxTokens: contract.brake.maxTokens }),
    ...(contract.brake.maxCostUsd === undefined ? {} : { maxCostUsd: contract.brake.maxCostUsd }),
    ...(contract.brake.deadlineAt === undefined ? {} : { deadlineAt: contract.brake.deadlineAt }),
  };
}
