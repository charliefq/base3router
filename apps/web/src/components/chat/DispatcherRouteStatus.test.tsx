import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type DispatcherRouteDecision,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { DispatcherRouteStatus } from "./DispatcherRouteStatus";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON());
}

const decision: DispatcherRouteDecision = {
  policyVersion: "dispatcher.phase-1a.v1" as const,
  environmentId: EnvironmentId.make("environment-1"),
  actionKind: "workspace-write" as const,
  projectResolution: {
    status: "resolved" as const,
    source: "project-id" as const,
    projectId: ProjectId.make("project-1"),
    reasonCodes: [],
  },
  context: {
    threadId: null,
    messageId: null,
    hasPersistedMessage: false,
    attachmentCount: 0,
    composerContextKinds: [],
  },
  candidates: [
    {
      fallbackIndex: 0,
      target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      driver: ProviderDriverKind.make("codex"),
      modelFamily: "openai",
      source: "explicit" as const,
      eligible: true,
      reasonCodes: [],
    },
  ],
  selected: {
    fallbackIndex: 0,
    target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    driver: ProviderDriverKind.make("codex"),
    modelFamily: "openai",
    source: "explicit" as const,
    eligible: true,
    reasonCodes: [],
  },
  gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED" as const] },
};

it("labels a successful preview as provisional", async () => {
  await act(async () => {
    renderer = create(
      <DispatcherRouteStatus
        projectTitle="Base3 Router"
        state={{ status: "success", decision }}
        providers={[]}
      />,
    );
  });

  expect(renderedText()).toContain("Provisional route");
  expect(renderedText()).toContain("Project: ");
  expect(renderedText()).toContain("Base3 Router");
  expect(renderedText()).toContain("Automatic");
  expect(renderedText()).toContain("gpt-5.4");
  expect(renderedText()).not.toContain("Bound route");
});

it("renders a persisted binding as authoritative", async () => {
  await act(async () => {
    renderer = create(
      <DispatcherRouteStatus
        projectTitle="Base3 Router"
        state={{ status: "idle" }}
        providers={[]}
        boundRoute={{
          messageId: "message-1" as never,
          binding: {
            policyVersion: "dispatcher.phase-1a.v1",
            target: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-sonnet-4-6",
            },
            driver: ProviderDriverKind.make("claude"),
            modelFamily: "anthropic",
            fallbackIndex: 0,
            source: "explicit",
            gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
          },
        }}
      />,
    );
  });

  expect(renderedText()).toContain("Bound route");
  expect(renderedText()).toContain("Persisted for this task");
  expect(renderedText()).not.toContain("Provisional route");
});
