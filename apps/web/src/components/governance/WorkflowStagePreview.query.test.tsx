import type {
  EnvironmentRegistry as RegistryModule,
  SupervisorConnectionState,
  PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type WorkflowStagePreview,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";
import {
  environmentId,
  projectId,
  profile,
  template,
  run,
} from "./WorkflowStagePreview.test-fixtures";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  query: vi.fn(),
  action: vi.fn(),
}));
// Only replace the connection/network boundary. The workflow atom factory, SWR,
// query runner, RegistryContext and preview component all execute production code.
vi.mock("../../connection/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { EnvironmentId, WS_METHODS } = await import("@t3tools/contracts");
  const {
    EnvironmentRegistry,
    EnvironmentSupervisor,
    AVAILABLE_CONNECTION_STATE,
    PrimaryConnectionTarget,
  } = await import("@t3tools/client-runtime/connection");
  const session = {
    client: {
      [WS_METHODS.workflowStagePreview]: (input: unknown) =>
        Effect.promise(() => mocks.rpc(WS_METHODS.workflowStagePreview, input)),
    },
  } as unknown as import("@t3tools/client-runtime/rpc").RpcSession;
  const registryLayer = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
        desired: true,
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("environment-a"),
          label: "Fake",
          httpBaseUrl: "https://fake.invalid",
          wsBaseUrl: "wss://fake.invalid",
        }),
        state,
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const registry: Pick<RegistryModule.EnvironmentRegistry["Service"], "run" | "followStream"> =
        {
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        };
      return registry as RegistryModule.EnvironmentRegistry["Service"];
    }),
  );
  return { connectionAtomRuntime: Atom.runtime(registryLayer) };
});
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => mocks.query() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.action }));
vi.mock("../../state/governance", () => ({ governanceEnvironment: {} }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ useUpdateEnvironmentSettings: () => vi.fn() }));
vi.mock("../chat/TaskContractPanel", () => ({ TaskContractReadout: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { ProjectWorkflowDecisions } from "./GovernanceSurfaces";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const result = (model: string): WorkflowStagePreview => {
  const candidate = {
    fallbackIndex: 0,
    target: { instanceId: ProviderInstanceId.make("fake-provider"), model },
    driver: ProviderDriverKind.make("codex"),
    modelFamily: "unknown",
    source: "environment-default" as const,
    eligible: true,
    reasonCodes: [],
  };
  return {
    stage: template.stages[0]!,
    profile,
    attempt: 1,
    packetText: "Fake",
    route: {
      policyVersion: "dispatcher.phase-1a.v1",
      environmentId,
      actionKind: "workspace-write",
      projectResolution: { status: "resolved", source: "project-id", projectId, reasonCodes: [] },
      context: {
        threadId: null,
        messageId: null,
        hasPersistedMessage: false,
        attachmentCount: 0,
        composerContextKinds: [],
      },
      candidates: [candidate],
      selected: candidate,
      gate: { decision: "ALLOW", reasonCodes: [] },
    },
  };
};
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let revision: number;
const page = () => (
  <RegistryContext.Provider value={registry}>
    <ProjectWorkflowDecisions
      environmentId={environmentId}
      projectId={projectId}
      projectTitle="Fake"
      refreshTick={revision}
    />
  </RegistryContext.Provider>
);
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => node.children.includes(label))!;
const text = () => JSON.stringify(renderer.toJSON());
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  revision = 1;
  mocks.rpc.mockReset();
  mocks.action.mockReset();
  mocks.query.mockImplementation(() => ({
    data: { profiles: [profile], templates: [template], runs: [run] },
    dataUpdatedAt: revision,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: mocks.refresh,
  }));
  await act(async () => {
    renderer = create(page());
  });
});
afterEach(async () => {
  await act(async () => {
    renderer.unmount();
    registry.dispose();
  });
  vi.unstubAllGlobals();
});

it.each([
  ["reset", "old first"],
  ["reset", "new first"],
  ["catalog refresh", "old first"],
  ["catalog refresh", "new first"],
])("%s replaces the actual in-flight RPC (%s)", async (change, order) => {
  const first = deferred<WorkflowStagePreview>();
  const second = deferred<WorkflowStagePreview>();
  const started = deferred<void>();
  mocks.rpc
    .mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    })
    .mockImplementationOnce(() => second.promise);
  await act(async () => {
    const onClick = button("Preview stage").props.onClick;
    onClick();
    onClick();
    await started.promise;
  });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  await act(async () => {
    if (change === "reset") button("Reset preview").props.onClick();
    else {
      revision++;
      renderer.update(page());
    }
  });
  await act(async () => button("Preview stage").props.onClick());
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  if (order === "old first") {
    await act(async () => first.resolve(result("old-model")));
    expect(text()).not.toContain("old-model");
    expect(button("Loading preview…").props.disabled).toBe(true);
  }
  await act(async () => second.resolve(result("new-model")));
  expect(text()).toContain("new-model");
  await act(async () => first.resolve(result("old-model")));
  expect(text()).toContain("new-model");
  expect(text()).not.toContain("old-model");
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.rpc.mock.calls.map(([method]) => method)).toEqual([
    WS_METHODS.workflowStagePreview,
    WS_METHODS.workflowStagePreview,
  ]);
});

it("refreshes a settled cached result instead of presenting it again", async () => {
  mocks.rpc
    .mockResolvedValueOnce(result("first-model"))
    .mockResolvedValueOnce(result("second-model"));
  await act(async () => button("Preview stage").props.onClick());
  expect(text()).toContain("first-model");
  await act(async () => button("Preview stage").props.onClick());
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(text()).toContain("second-model");
  expect(text()).not.toContain("first-model");
  expect(mocks.action).not.toHaveBeenCalled();
});
