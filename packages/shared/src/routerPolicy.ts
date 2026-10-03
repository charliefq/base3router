import {
  type RouterPolicySnapshotV0,
  type RouterPolicyState,
  MODEL_ROUTER_POLICY_VERSION,
  ROUTER_POLICY_STATES,
  RouterEvaluationError,
  RouterPolicyId as RouterPolicyIdSchema,
} from "@t3tools/contracts";

const BASELINE_POLICY_VERSION = MODEL_ROUTER_POLICY_VERSION;

export const canTransitionPolicy = (from: RouterPolicyState, to: RouterPolicyState): boolean => {
  if (from === to) return false;
  if (!ROUTER_POLICY_STATES.includes(from) || !ROUTER_POLICY_STATES.includes(to)) return false;
  switch (from) {
    case "baseline":
      return to === "active" || to === "retired";
    case "candidate":
      return to === "shadow" || to === "retired";
    case "shadow":
      return to === "active" || to === "candidate" || to === "retired";
    case "active":
      return to === "retired";
    case "retired":
      return false;
  }
};

export const activatePolicy = (input: {
  readonly candidate: RouterPolicySnapshotV0;
  readonly currentActive: RouterPolicySnapshotV0 | null;
  readonly confirmActivation: boolean;
  readonly authorized: boolean;
  readonly now: string;
}): {
  readonly active: RouterPolicySnapshotV0;
  readonly previous?: RouterPolicySnapshotV0;
} => {
  if (!input.authorized) {
    throw new RouterEvaluationError({
      reason: "unauthorized_activation",
      detail: "Policy activation requires orchestration:operate.",
    });
  }
  if (input.confirmActivation !== true) {
    throw new RouterEvaluationError({
      reason: "confirmation_required",
      detail: "Activation requires confirmActivation=true. A candidate cannot activate itself.",
    });
  }
  if (input.candidate.state !== "shadow" && input.candidate.state !== "candidate") {
    throw new RouterEvaluationError({
      reason: "malformed_policy",
      detail: `Policy in state ${input.candidate.state} cannot become active.`,
    });
  }
  const previous =
    input.currentActive === null
      ? undefined
      : { ...input.currentActive, state: "retired" as const, retiredAt: input.now };
  const active: RouterPolicySnapshotV0 = {
    ...input.candidate,
    state: "active",
    activatedAt: input.now,
    activationConfirmed: true,
    ...(input.currentActive !== undefined && input.currentActive !== null
      ? { priorActivePolicyId: input.currentActive.policyId }
      : {}),
  };
  return previous === undefined ? { active } : { active, previous };
};

export const rollbackPolicy = (input: {
  readonly currentActive: RouterPolicySnapshotV0;
  readonly prior: RouterPolicySnapshotV0 | null;
  readonly confirmRollback: boolean;
  readonly authorized: boolean;
  readonly now: string;
  readonly baseline: RouterPolicySnapshotV0;
}): {
  readonly active: RouterPolicySnapshotV0;
  readonly previous: RouterPolicySnapshotV0;
} => {
  if (!input.authorized) {
    throw new RouterEvaluationError({
      reason: "unauthorized_activation",
      detail: "Policy rollback requires orchestration:operate.",
    });
  }
  if (input.confirmRollback !== true) {
    throw new RouterEvaluationError({
      reason: "confirmation_required",
      detail: "Rollback requires confirmRollback=true.",
    });
  }
  const restored =
    input.prior ??
    (input.currentActive.priorActivePolicyId !== undefined ? input.prior : input.baseline);
  const active: RouterPolicySnapshotV0 = {
    ...(restored ?? input.baseline),
    state: "active",
    activatedAt: input.now,
    activationConfirmed: true,
    policyVersion: restored?.policyVersion ?? BASELINE_POLICY_VERSION,
  };
  const previous: RouterPolicySnapshotV0 = {
    ...input.currentActive,
    state: "retired",
    retiredAt: input.now,
  };
  return { active, previous };
};

export const baselinePolicyId = RouterPolicyIdSchema.make("policy-model-router-v0");

export const isBaselinePolicyVersion = (version: string): boolean =>
  version === BASELINE_POLICY_VERSION;
