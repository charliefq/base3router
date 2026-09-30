import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type DispatcherRouteDecision,
  type DispatcherRoutePreviewRequest,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  classifyDispatcherPreviewError,
  createDispatcherPreviewController,
  presentBoundDispatcherRoute,
  presentDispatcherDecision,
  shouldShowDispatcherRoute,
  type DispatcherPreviewState,
} from "./dispatcher.ts";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function request(model: string): DispatcherRoutePreviewRequest {
  return {
    environmentId,
    projectId,
    preferredRoute: { instanceId: ProviderInstanceId.make("codex_work"), model },
    actionKind: "workspace-write",
  };
}

function decision(model: string): DispatcherRouteDecision {
  const selected = {
    fallbackIndex: 0,
    target: { instanceId: ProviderInstanceId.make("codex_work"), model },
    driver: ProviderDriverKind.make("codex"),
    modelFamily: "openai",
    source: "explicit" as const,
    eligible: true,
    reasonCodes: [],
  };
  return {
    policyVersion: "dispatcher.phase-1a.v1",
    environmentId,
    actionKind: "workspace-write",
    projectResolution: {
      status: "resolved",
      source: "project-id",
      projectId,
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
      selected,
      {
        ...selected,
        fallbackIndex: 1,
        target: {
          instanceId: ProviderInstanceId.make("claude_team"),
          model: "claude-sonnet-4-6",
        },
        driver: ProviderDriverKind.make("claude"),
        source: "provider-default",
      },
    ],
    selected,
    gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
  };
}

afterEach(() => vi.useRealTimers());

describe("dispatcher preview controller", () => {
  it("debounces input changes and requests only the latest route", async () => {
    vi.useFakeTimers();
    const requested: string[] = [];
    const states: DispatcherPreviewState[] = [];
    const controller = createDispatcherPreviewController({
      debounceMs: 50,
      request: async (input) => {
        requested.push(input.preferredRoute?.model ?? "");
        return decision(input.preferredRoute?.model ?? "");
      },
      onChange: (state) => states.push(state),
    });

    controller.update(request("gpt-old"));
    controller.update(request("gpt-new"));
    expect(states.at(-1)).toEqual({ status: "loading" });
    await vi.advanceTimersByTimeAsync(50);

    expect(requested).toEqual(["gpt-new"]);
    expect(states.at(-1)).toMatchObject({
      status: "success",
      decision: { selected: { target: { model: "gpt-new" } } },
    });
    controller.dispose();
  });

  it("ignores an older response after a newer preview completes", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: DispatcherRouteDecision) => void> = [];
    const states: DispatcherPreviewState[] = [];
    const controller = createDispatcherPreviewController({
      debounceMs: 0,
      request: () => new Promise((resolve) => resolvers.push(resolve)),
      onChange: (state) => states.push(state),
    });

    controller.update(request("gpt-old"));
    await vi.advanceTimersByTimeAsync(0);
    controller.update(request("gpt-new"));
    await vi.advanceTimersByTimeAsync(0);
    resolvers[1]!(decision("gpt-new"));
    await Promise.resolve();
    resolvers[0]!(decision("gpt-old"));
    await Promise.resolve();

    expect(states.at(-1)).toMatchObject({
      status: "success",
      decision: { selected: { target: { model: "gpt-new" } } },
    });
    controller.dispose();
  });

  it("turns preview failure into non-throwing UI state", async () => {
    vi.useFakeTimers();
    const states: DispatcherPreviewState[] = [];
    const controller = createDispatcherPreviewController({
      debounceMs: 0,
      request: async () => {
        throw { _tag: "EnvironmentAuthorizationError", token: "never-render-this" };
      },
      onChange: (state) => states.push(state),
    });

    expect(() => controller.update(request("gpt-5.4"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ status: "error", kind: "unauthorized" });
    controller.dispose();
  });
});

it("keeps unsupported clients on the legacy UI while retaining authoritative bindings", () => {
  expect(
    shouldShowDispatcherRoute({
      capabilityAvailable: false,
      hasProject: true,
      hasBoundRoute: false,
    }),
  ).toBe(false);
  expect(
    shouldShowDispatcherRoute({
      capabilityAvailable: false,
      hasProject: true,
      hasBoundRoute: true,
    }),
  ).toBe(true);
});

it("produces a bounded redacted presentation for preview and persisted routes", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex_work"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Work Codex",
      credential: "secret-token",
      options: { cwd: "/sensitive/workspace" },
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
  const preview = presentDispatcherDecision(decision("gpt-5.4"), providers);
  const bound = presentBoundDispatcherRoute(
    {
      policyVersion: "dispatcher.phase-1a.v1",
      target: { instanceId: ProviderInstanceId.make("codex_work"), model: "gpt-5.4" },
      driver: ProviderDriverKind.make("codex"),
      modelFamily: "openai",
      fallbackIndex: 0,
      source: "explicit",
      gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
    },
    providers,
  );
  const rendered = JSON.stringify({ preview, bound });

  expect(preview).toMatchObject({ provider: "Work Codex", model: "gpt-5.4" });
  expect(preview?.fallbacks).toEqual([{ provider: "claude_team", model: "claude-sonnet-4-6" }]);
  expect(rendered).not.toContain("secret-token");
  expect(rendered).not.toContain("/sensitive/workspace");
  expect(classifyDispatcherPreviewError({ _tag: "EnvironmentAuthorizationError" })).toBe(
    "unauthorized",
  );
});
