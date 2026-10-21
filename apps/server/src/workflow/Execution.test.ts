import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { stageRouteAllows } from "./Workflow.ts";

const route: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit",
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};

it("keeps a workflow stage on its bound route", () => {
  expect(stageRouteAllows(route, route)).toBe(true);
});

it("rejects a workflow stage route rewrite before provider work", () => {
  expect(
    stageRouteAllows(route, {
      ...route,
      target: { instanceId: ProviderInstanceId.make("claude-work"), model: "sonnet" },
    }),
  ).toBe(false);
});
