import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  RouterEvaluationError,
  type RouterPolicySnapshotV0,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  activatePolicy,
  canTransitionPolicy,
  rollbackPolicy,
  shadowPolicy,
} from "./routerPolicy.ts";

const snapshot = (state: RouterPolicySnapshotV0["state"], id: string): RouterPolicySnapshotV0 => ({
  version: "router-policy-snapshot.v0",
  policyId: id as RouterPolicySnapshotV0["policyId"],
  policyVersion: id.includes("hybrid") ? HYBRID_ROUTER_POLICY_VERSION : MODEL_ROUTER_POLICY_VERSION,
  state,
  environmentId: "lab-environment" as RouterPolicySnapshotV0["environmentId"],
  createdAt: "2026-10-03T00:00:00.000Z",
  weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
  shrinkageK: 10,
  minSampleRate: 8,
  recencyDecayImplemented: false,
});

describe("router policy lifecycle", () => {
  it("allows candidate to shadow to active, and denies self-activation", () => {
    expect(canTransitionPolicy("candidate", "shadow")).toBe(true);
    expect(canTransitionPolicy("shadow", "active")).toBe(true);
    expect(canTransitionPolicy("candidate", "active")).toBe(false);
    const denied = Effect.runSyncExit(
      activatePolicy({
        candidate: snapshot("candidate", "policy-hybrid"),
        currentActive: snapshot("active", "policy-v0"),
        confirmActivation: true,
        authorized: true,
        now: "2026-10-03T01:00:00.000Z",
      }),
    );
    expect(Exit.isFailure(denied)).toBe(true);
    const unconfirmed = Effect.runSyncExit(
      activatePolicy({
        candidate: snapshot("shadow", "policy-hybrid"),
        currentActive: snapshot("active", "policy-v0"),
        confirmActivation: false,
        authorized: true,
        now: "2026-10-03T01:00:00.000Z",
      }),
    );
    expect(Exit.isFailure(unconfirmed)).toBe(true);
    if (Exit.isFailure(unconfirmed)) {
      const error = unconfirmed.cause;
      expect(String(error)).toContain("confirmation_required");
    }
  });

  it("denies unauthorized activation as a typed failure", () => {
    const denied = Effect.runSyncExit(
      activatePolicy({
        candidate: snapshot("shadow", "policy-hybrid"),
        currentActive: snapshot("active", "policy-v0"),
        confirmActivation: true,
        authorized: false,
        now: "2026-10-03T01:00:00.000Z",
      }),
    );
    expect(Exit.isFailure(denied)).toBe(true);
    expect(String(denied)).toContain("unauthorized_activation");
    expect(denied._tag).toBe("Failure");
  });

  it("shadows a candidate, activates with confirmation, and supports rollback", () => {
    const shadowed = Effect.runSync(
      shadowPolicy({
        candidate: snapshot("candidate", "policy-hybrid"),
        confirmShadow: true,
        authorized: true,
        now: "2026-10-03T00:30:00.000Z",
        actor: "session-lab",
      }),
    );
    expect(shadowed.active.state).toBe("shadow");
    const activated = Effect.runSync(
      activatePolicy({
        candidate: shadowed.active,
        currentActive: snapshot("active", "policy-v0"),
        confirmActivation: true,
        authorized: true,
        now: "2026-10-03T01:00:00.000Z",
        actor: "session-lab",
      }),
    );
    expect(activated.active.state).toBe("active");
    expect(activated.active.activatedBy).toBe("session-lab");
    expect(activated.previous?.state).toBe("retired");
    const rolled = Effect.runSync(
      rollbackPolicy({
        currentActive: activated.active,
        prior: activated.previous ?? null,
        confirmRollback: true,
        authorized: true,
        now: "2026-10-03T01:05:00.000Z",
        baseline: snapshot("baseline", "policy-v0"),
        actor: "session-lab",
      }),
    );
    expect(rolled.active.policyId).toBe("policy-v0");
    expect(rolled.previous.state).toBe("retired");
  });

  it("exports RouterEvaluationError for callers that match on reason", () => {
    expect(new RouterEvaluationError({ reason: "illegal_transition", detail: "no" }).reason).toBe(
      "illegal_transition",
    );
  });
});
