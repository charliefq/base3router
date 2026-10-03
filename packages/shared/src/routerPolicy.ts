import {
  type RouterPolicySnapshotV0,
  type RouterPolicyState,
  MODEL_ROUTER_POLICY_VERSION,
  ROUTER_POLICY_STATES,
  RouterEvaluationError,
  RouterPolicyId as RouterPolicyIdSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
      return to === "active";
  }
};

const deny = (reason: RouterEvaluationError["reason"], detail: string) =>
  new RouterEvaluationError({ reason, detail });

export const shadowPolicy = Effect.fn("shadowPolicy")(function* (input: {
  readonly candidate: RouterPolicySnapshotV0;
  readonly confirmShadow: boolean;
  readonly authorized: boolean;
  readonly now: string;
  readonly actor?: string;
}) {
  if (!input.authorized) {
    return yield* deny("unauthorized_activation", "Policy shadow requires orchestration:operate.");
  }
  if (input.confirmShadow !== true) {
    return yield* deny(
      "confirmation_required",
      "Shadow requires confirmShadow=true. A candidate cannot shadow itself.",
    );
  }
  if (!canTransitionPolicy(input.candidate.state, "shadow")) {
    return yield* deny(
      "illegal_transition",
      `Policy in state ${input.candidate.state} cannot become shadow.`,
    );
  }
  return {
    active: {
      ...input.candidate,
      state: "shadow",
      ...(input.actor !== undefined ? { activatedBy: input.actor } : {}),
    },
  };
});

export const activatePolicy = Effect.fn("activatePolicy")(function* (input: {
  readonly candidate: RouterPolicySnapshotV0;
  readonly currentActive: RouterPolicySnapshotV0 | null;
  readonly confirmActivation: boolean;
  readonly authorized: boolean;
  readonly now: string;
  readonly actor?: string;
}) {
  if (!input.authorized) {
    return yield* deny(
      "unauthorized_activation",
      "Policy activation requires orchestration:operate.",
    );
  }
  if (input.confirmActivation !== true) {
    return yield* deny(
      "confirmation_required",
      "Activation requires confirmActivation=true. A candidate cannot activate itself.",
    );
  }
  if (!canTransitionPolicy(input.candidate.state, "active")) {
    return yield* deny(
      "illegal_transition",
      `Policy in state ${input.candidate.state} cannot become active.`,
    );
  }
  if (input.currentActive !== null && !canTransitionPolicy(input.currentActive.state, "retired")) {
    return yield* deny(
      "illegal_transition",
      `Active policy in state ${input.currentActive.state} cannot be retired.`,
    );
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
    ...(input.actor !== undefined ? { activatedBy: input.actor } : {}),
    ...(input.currentActive !== undefined && input.currentActive !== null
      ? { priorActivePolicyId: input.currentActive.policyId }
      : {}),
  };
  return previous === undefined ? { active } : { active, previous };
});

export const rollbackPolicy = Effect.fn("rollbackPolicy")(function* (input: {
  readonly currentActive: RouterPolicySnapshotV0;
  readonly prior: RouterPolicySnapshotV0 | null;
  readonly confirmRollback: boolean;
  readonly authorized: boolean;
  readonly now: string;
  readonly baseline: RouterPolicySnapshotV0;
  readonly actor?: string;
}) {
  if (!input.authorized) {
    return yield* deny(
      "unauthorized_activation",
      "Policy rollback requires orchestration:operate.",
    );
  }
  if (input.confirmRollback !== true) {
    return yield* deny("confirmation_required", "Rollback requires confirmRollback=true.");
  }
  if (!canTransitionPolicy(input.currentActive.state, "retired")) {
    return yield* deny(
      "illegal_transition",
      `Active policy in state ${input.currentActive.state} cannot be retired.`,
    );
  }
  const restored = input.prior ?? input.baseline;
  if (restored.state !== "active" && !canTransitionPolicy(restored.state, "active")) {
    return yield* deny(
      "illegal_transition",
      `Prior policy in state ${restored.state} cannot become active.`,
    );
  }
  const active: RouterPolicySnapshotV0 = {
    ...restored,
    state: "active",
    activatedAt: input.now,
    activationConfirmed: true,
    policyVersion: restored.policyVersion ?? BASELINE_POLICY_VERSION,
    ...(input.actor !== undefined ? { activatedBy: input.actor } : {}),
  };
  const previous: RouterPolicySnapshotV0 = {
    ...input.currentActive,
    state: "retired",
    retiredAt: input.now,
  };
  return { active, previous };
});

export const baselinePolicyId = RouterPolicyIdSchema.make("policy-model-router-v0");

export const isBaselinePolicyVersion = (version: string): boolean =>
  version === BASELINE_POLICY_VERSION;
