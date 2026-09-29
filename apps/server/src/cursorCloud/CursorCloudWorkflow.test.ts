import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ActionGateResult,
  type DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  assertCursorCloudDispatch,
  cursorCloudDispatchPreview,
  requireActionGateAllow,
} from "./CursorCloudWorkflow.ts";

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const allow: ActionGateResult = { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] };
const deny: ActionGateResult = { decision: "DENY", reasonCodes: ["PROVIDER_UNAVAILABLE"] };
const route: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
  driver: ProviderDriverKind.make("cursor"),
  modelFamily: "cursor",
  fallbackIndex: 0,
  source: "explicit",
  gate: allow,
};
const target = {
  mode: "repository" as const,
  repositoryUrl: "https://github.com/charliefq/base3router",
  startingRef: sha,
};

describe("Cursor Cloud workflow gating", () => {
  it("keeps ActionGate authoritative before a create payload is built", () => {
    expect(() => requireActionGateAllow(deny)).toThrow(/ActionGate denied/);
    expect(() =>
      assertCursorCloudDispatch({
        configured: true,
        gate: deny,
        routeBinding: route,
        target,
      }),
    ).toThrow(/ActionGate denied/);
    expect(
      assertCursorCloudDispatch({
        configured: true,
        gate: allow,
        routeBinding: route,
        target,
      }),
    ).toMatchObject({
      runnerKind: "cursor-cloud",
      workOnCurrentBranch: false,
      autoCreatePR: false,
      credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      target,
    });
  });

  it("hides the immutable payload when Cursor Cloud is unconfigured", () => {
    const preview = cursorCloudDispatchPreview({
      available: true,
      configured: false,
      gate: allow,
      provider: route.driver,
      model: route.target.model,
      target,
    });
    expect(preview.configured).toBe(false);
    expect(preview.payload).toBeNull();
    expect(() =>
      assertCursorCloudDispatch({
        configured: false,
        gate: allow,
        routeBinding: route,
        target,
      }),
    ).toThrow(/not configured/);
  });

  it("requires an exact repository target before dispatch", () => {
    expect(() =>
      assertCursorCloudDispatch({
        configured: true,
        gate: allow,
        routeBinding: route,
        target: undefined,
      }),
    ).toThrow(/missing/);
  });
});
