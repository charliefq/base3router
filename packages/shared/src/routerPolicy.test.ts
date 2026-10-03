import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  RouterEvaluationError,
  type RouterPolicySnapshotV0,
} from "@t3tools/contracts";

import { activatePolicy, canTransitionPolicy, rollbackPolicy } from "./routerPolicy.ts";

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
    expect(() =>
      activatePolicy({
        candidate: snapshot("shadow", "policy-hybrid"),
        currentActive: snapshot("active", "policy-v0"),
        confirmActivation: false,
        authorized: true,
        now: "2026-10-03T01:00:00.000Z",
      }),
    ).toThrow(RouterEvaluationError);
  });

  it("denies unauthorized activation", () => {
    expect(() =>
      activatePolicy({
        candidate: snapshot("shadow", "policy-hybrid"),
        currentActive: snapshot("active", "policy-v0"),
        confirmActivation: true,
        authorized: false,
        now: "2026-10-03T01:00:00.000Z",
      }),
    ).toThrow(RouterEvaluationError);
  });

  it("activates with confirmation and supports rollback", () => {
    const activated = activatePolicy({
      candidate: snapshot("shadow", "policy-hybrid"),
      currentActive: snapshot("active", "policy-v0"),
      confirmActivation: true,
      authorized: true,
      now: "2026-10-03T01:00:00.000Z",
    });
    expect(activated.active.state).toBe("active");
    expect(activated.previous?.state).toBe("retired");
    const rolled = rollbackPolicy({
      currentActive: activated.active,
      prior: activated.previous ?? null,
      confirmRollback: true,
      authorized: true,
      now: "2026-10-03T01:05:00.000Z",
      baseline: snapshot("baseline", "policy-v0"),
    });
    expect(rolled.active.policyId).toBe("policy-v0");
    expect(rolled.previous.state).toBe("retired");
  });
});
