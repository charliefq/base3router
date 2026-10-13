import { it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  RouterPolicyId,
  MODEL_ROUTER_POLICY_VERSION,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  ROUTER_POLICY_SNAPSHOT_VERSION,
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  HYBRID_SHRINKAGE_K,
  HYBRID_MIN_SAMPLE_RATE,
  type EnvironmentRouterPolicyStatus,
  type RouterPolicySnapshotV0,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import {
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  RelayConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/state/session";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
const ui = vi.hoisted(() => ({
  read: vi.fn(),
  operate: vi.fn(),
  effects: [] as Array<() => void>,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: Atom.runtime(Layer.empty) }));
vi.mock("../../state/use-atom-command", async () => {
  const module = await import("../../state/routerPolicy");
  return {
    useAtomCommand: (command: unknown) =>
      command === module.routerPolicyStatusCommand ? ui.read : ui.operate,
  };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: hooks.useCallback,
  useMemo: hooks.useMemo,
  useEffect: (effect: () => void) => ui.effects.push(effect),
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
import { RouterPolicySettings } from "./RouterPolicySettings";
import { routerPolicyRequests } from "../../state/routerPolicy";
const environmentId = EnvironmentId.make("remote-policy-test");
const baseline = {
  version: ROUTER_POLICY_SNAPSHOT_VERSION,
  policyId: RouterPolicyId.make("fixture-baseline"),
  policyVersion: MODEL_ROUTER_POLICY_VERSION,
  state: "active" as const,
  environmentId,
  createdAt: "2026-10-13T00:00:00.000Z",
  weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
  shrinkageK: HYBRID_SHRINKAGE_K,
  minSampleRate: HYBRID_MIN_SAMPLE_RATE,
  recencyDecayImplemented: false as const,
} satisfies RouterPolicySnapshotV0;
const candidate = {
  ...baseline,
  policyId: RouterPolicyId.make("fixture-hybrid"),
  policyVersion: HYBRID_ROUTER_POLICY_VERSION,
  state: "candidate" as const,
};
const first: EnvironmentRouterPolicyStatus = {
  environmentId,
  active: baseline,
  policies: [baseline, candidate],
  revision: 1,
};
const shadow: EnvironmentRouterPolicyStatus = {
  ...first,
  policies: [baseline, { ...candidate, state: "shadow" }],
  revision: 2,
};
const active: EnvironmentRouterPolicyStatus = {
  ...first,
  active: { ...candidate, state: "active" },
  policies: [
    { ...baseline, state: "retired" },
    { ...candidate, state: "active" },
  ],
  revision: 3,
};
const result = (value: unknown) => ({ _tag: "Success", value });
const render = (readOnly = false) => {
  hooks.beginRender();
  return RouterPolicySettings({ environmentId, readOnly }) as ReactElement<Record<string, unknown>>;
};
const elements = (tree: ReactElement) => {
  const found: Array<ReactElement<Record<string, unknown>>> = [];
  visitElements(tree, (element) => {
    found.push(element);
    return false;
  });
  return found;
};
const button = (tree: ReactElement, name: string) =>
  elements(tree).find((element) => element.props.children === name)!;
const click = (tree: ReactElement, name: string) =>
  (button(tree, name).props.onClick as () => Promise<void> | void)();
const checkbox = (tree: ReactElement) =>
  elements(tree).find((element) => element.type === "input")!;
const text = (tree: ReactElement) =>
  elements(tree)
    .flatMap((element) =>
      (Array.isArray(element.props.children)
        ? element.props.children
        : [element.props.children]
      ).filter((value): value is string => typeof value === "string"),
    )
    .join(" ");
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  hooks.reset();
  ui.effects = [];
  ui.read.mockReset().mockResolvedValue(result(first));
  ui.operate.mockReset();
});

describe("selected environment policy controls", () => {
  it("reads status without mutation, confirms each transition, and refreshes the displayed active state", async () => {
    let tree = render();
    ui.effects[0]!();
    await flush();
    tree = render();
    expect(ui.read).toHaveBeenCalledWith({ environmentId, input: undefined });
    expect(ui.operate).not.toHaveBeenCalled();
    expect(button(tree, "Activate Hybrid").props.disabled).toBe(true);
    await click(tree, "Enable shadow");
    tree = render();
    expect(button(tree, "Confirm policy change").props.disabled).toBe(true);
    await click(tree, "Confirm policy change");
    expect(ui.operate).not.toHaveBeenCalled();
    (checkbox(tree).props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = render();
    expect(text(tree)).toContain("future Auto turns still use Router V0");
    ui.operate.mockResolvedValueOnce(result({ outcome: "applied", status: shadow }));
    await click(tree, "Confirm policy change");
    await flush();
    tree = render();
    expect(ui.operate).toHaveBeenLastCalledWith({
      environmentId,
      input: { action: "shadow", policyId: candidate.policyId, expectedRevision: 1, confirm: true },
    });
    expect(text(tree)).toContain("Hybrid: shadow");
    await click(tree, "Activate Hybrid");
    tree = render();
    (checkbox(tree).props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = render();
    expect(text(tree)).toContain("changing future Auto turns to Hybrid ranking");
    ui.operate.mockResolvedValueOnce(result({ outcome: "applied", status: active }));
    await click(tree, "Confirm policy change");
    await flush();
    tree = render();
    expect(text(tree)).toContain(`Active: ${HYBRID_ROUTER_POLICY_VERSION}`);
    await click(tree, "Restore prior policy");
    tree = render();
    (checkbox(tree).props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = render();
    ui.operate.mockResolvedValueOnce(
      result({ outcome: "applied", status: { ...first, revision: 4 } }),
    );
    await click(tree, "Confirm policy change");
    await flush();
    tree = render();
    expect(ui.operate).toHaveBeenLastCalledWith({
      environmentId,
      input: { action: "rollback", expectedRevision: 3, confirm: true },
    });
    expect(text(tree)).toContain(`Active: ${MODEL_ROUTER_POLICY_VERSION}`);
  });
  it("shows pending honestly, rejects duplicate submission, and requires fresh status after ambiguous failure", async () => {
    let tree = render();
    ui.effects[0]!();
    await flush();
    tree = render();
    await click(tree, "Enable shadow");
    tree = render();
    (checkbox(tree).props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = render();
    let settle!: (value: unknown) => void;
    ui.operate.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await click(tree, "Confirm policy change");
    await click(tree, "Confirm policy change");
    tree = render();
    expect(text(tree)).toContain("Updating policy status");
    expect(ui.operate).toHaveBeenCalledTimes(1);
    settle({ _tag: "Failure" });
    await flush();
    tree = render();
    expect(text(tree)).toContain("could not be confirmed");
    expect(button(tree, "Enable shadow").props.disabled).toBe(true);
    await click(tree, "Refresh policy");
    await flush();
    tree = render();
    expect(button(tree, "Enable shadow").props.disabled).toBe(false);
    expect(ui.operate).toHaveBeenCalledTimes(1);
  });
  it("keeps read-only operator controls disabled", async () => {
    let tree = render(true);
    ui.effects[0]!();
    await flush();
    tree = render(true);
    expect(button(tree, "Enable shadow").props.disabled).toBe(true);
    expect(ui.operate).not.toHaveBeenCalled();
    expect(text(tree)).toContain("Operator permission is required");
  });
});

const prepared: PreparedConnection = {
  environmentId,
  label: "Remote",
  httpBaseUrl: "https://selected.test",
  socketUrl: "wss://selected.test/ws",
  target: new RelayConnectionTarget({ environmentId, label: "Remote" }),
  httpAuthorization: { _tag: "Dpop", accessToken: "stale-fixture-token", expiresAtEpochMs: 0 },
};
const decodeControlBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const transport = (
  reply: (count: number) => Response | Promise<Response>,
  auth = true,
  connected = true,
) =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const renewals: unknown[] = [];
    const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
    const reference = yield* SubscriptionRef.make(
      connected ? Option.some(prepared) : Option.none(),
    );
    const supervisor = Layer.mock(EnvironmentSupervisor.EnvironmentSupervisor)({
      prepared: reference,
      target: prepared.target,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(
        Option.none<import("@t3tools/client-runtime/rpc").RpcSession>(),
      ),
    });
    const signer = Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
      thumbprint: Effect.succeed("fixture"),
      createProof: (input) =>
        Effect.sync(() => {
          proofs.push(input);
          return "fixture-proof";
        }),
    });
    const authorization = auth
      ? Layer.succeed(RemoteEnvironmentAuthorization, {
          authorizeBearer: () => Effect.die("Not used"),
          authorizeDpop: () => Effect.die("No new connection"),
          authorizeDpopHttp: (input) =>
            Effect.sync(() => {
              renewals.push(input);
              return {
                environmentId,
                label: "Remote",
                httpBaseUrl: "https://selected-current.test",
                httpAuthorization: {
                  _tag: "Dpop" as const,
                  accessToken: "current-fixture-token",
                  expiresAtEpochMs: 99999,
                },
              };
            }),
        })
      : Layer.empty;
    const layer = Layer.mergeAll(
      supervisor,
      signer,
      authorization,
      remoteHttpClientLayer(async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return reply(calls.length);
      }),
    );
    return {
      calls,
      renewals,
      proofs,
      run: <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | EnvironmentSupervisor.EnvironmentSupervisor
          | import("effect/unstable/http/HttpClient").HttpClient
        >,
      ) => effect.pipe(Effect.provide(layer), Effect.result),
    };
  });
describe("authenticated selected-environment transport", () => {
  effectIt.effect(
    "reads and posts to the selected current origin with request-bound current authorization",
    () =>
      Effect.gen(function* () {
        const fixture = yield* transport(() => Response.json(first));
        const read = yield* fixture.run(routerPolicyRequests.status(environmentId));
        expect(read._tag).toBe("Success");
        expect(fixture.calls[0]?.url).toBe("https://selected-current.test/api/router-policy");
        expect(new Headers(fixture.calls[0]?.init.headers).get("authorization")).toBe(
          "DPoP current-fixture-token",
        );
        expect(fixture.proofs[0]?.url).toBe(fixture.calls[0]?.url);
        const writeFixture = yield* transport(() =>
          Response.json({ outcome: "applied", status: shadow }),
        );
        const input = {
          action: "shadow" as const,
          policyId: candidate.policyId,
          expectedRevision: first.revision,
          confirm: true,
        };
        expect(
          (yield* writeFixture.run(routerPolicyRequests.control(environmentId, input)))._tag,
        ).toBe("Success");
        expect(writeFixture.calls[0]?.url).toBe(
          "https://selected-current.test/api/router-policy/command",
        );
        expect(writeFixture.proofs[0]?.method).toBe("POST");
        expect(decodeControlBody(String(writeFixture.calls[0]?.init.body))).toEqual(input);
      }),
  );
  effectIt.effect("does not retry scope denial or an ambiguous transport failure", () =>
    Effect.gen(function* () {
      const input = {
        action: "shadow" as const,
        policyId: candidate.policyId,
        expectedRevision: 1,
        confirm: true,
      };
      for (const reply of [
        () =>
          Response.json(
            {
              _tag: "EnvironmentScopeRequiredError",
              code: "insufficient_scope",
              requiredScope: "orchestration:operate",
              traceId: "fixture",
            },
            { status: 403 },
          ),
        () => Promise.reject(new Error("fixture connection lost")),
      ]) {
        const fixture = yield* transport(reply);
        expect((yield* fixture.run(routerPolicyRequests.control(environmentId, input)))._tag).toBe(
          "Failure",
        );
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.renewals).toHaveLength(1);
      }
    }),
  );
  effectIt.effect(
    "never uses stale tokens when current authorization or selected connection is missing",
    () =>
      Effect.gen(function* () {
        for (const fixture of [
          yield* transport(() => Response.json(first), false),
          yield* transport(() => Response.json(first), true, false),
        ]) {
          expect((yield* fixture.run(routerPolicyRequests.status(environmentId)))._tag).toBe(
            "Failure",
          );
          expect(fixture.calls).toHaveLength(0);
        }
        const wrong = yield* transport(() => Response.json(first));
        expect(
          (yield* wrong.run(routerPolicyRequests.status(EnvironmentId.make("primary-elsewhere"))))
            ._tag,
        ).toBe("Failure");
        expect(wrong.calls).toHaveLength(0);
      }),
  );
});

it("selects the explicit new version and confirms its environment while shadow retains active v1", async () => {
  const taskCandidate = {
    ...candidate,
    policyId: RouterPolicyId.make("fixture-task-policy"),
    policyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
  };
  const oldActive = { ...candidate, state: "active" as const };
  const status: EnvironmentRouterPolicyStatus = {
    ...first,
    active: oldActive,
    policies: [{ ...baseline, state: "retired" }, oldActive, taskCandidate],
  };
  ui.read.mockResolvedValueOnce(result(status));
  let tree = render();
  ui.effects[0]!();
  await flush();
  tree = render();
  const select = elements(tree).find((element) => element.type === "select")!;
  expect(select.props.value).toBe(HYBRID_ROUTER_POLICY_VERSION);
  (select.props.onChange as (event: unknown) => void)({
    target: { value: HYBRID_TASK_ROUTER_POLICY_VERSION },
  });
  tree = render();
  await click(tree, "Enable shadow");
  tree = render();
  expect(text(tree)).toContain(HYBRID_TASK_ROUTER_POLICY_VERSION);
  expect(text(tree)).toContain(environmentId);
  expect(text(tree)).toContain(`future Auto turns keep ${HYBRID_ROUTER_POLICY_VERSION}`);
  (checkbox(tree).props.onChange as (event: unknown) => void)({ target: { checked: true } });
  tree = render();
  const shadowStatus: EnvironmentRouterPolicyStatus = {
    ...status,
    revision: 2,
    policies: [{ ...baseline, state: "retired" }, oldActive, { ...taskCandidate, state: "shadow" }],
  };
  ui.operate.mockResolvedValueOnce(result({ outcome: "applied", status: shadowStatus }));
  await click(tree, "Confirm policy change");
  await flush();
  tree = render();
  expect(ui.operate).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      action: "shadow",
      policyId: taskCandidate.policyId,
      expectedRevision: 1,
      confirm: true,
    },
  });
  expect(text(tree)).toContain(`Active: ${HYBRID_ROUTER_POLICY_VERSION}`);
  await click(tree, "Activate Hybrid");
  tree = render();
  (checkbox(tree).props.onChange as (event: unknown) => void)({ target: { checked: true } });
  tree = render();
  const activeStatus: EnvironmentRouterPolicyStatus = {
    ...shadowStatus,
    revision: 3,
    active: { ...taskCandidate, state: "active", priorActivePolicyId: oldActive.policyId },
    policies: [
      { ...baseline, state: "retired" },
      { ...oldActive, state: "retired" },
      { ...taskCandidate, state: "active" },
    ],
  };
  ui.operate.mockResolvedValueOnce(result({ outcome: "applied", status: activeStatus }));
  await click(tree, "Confirm policy change");
  await flush();
  tree = render();
  expect(ui.operate).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      action: "activate",
      policyId: taskCandidate.policyId,
      expectedRevision: 2,
      confirm: true,
    },
  });
  expect(text(tree)).toContain(`Active: ${HYBRID_TASK_ROUTER_POLICY_VERSION}`);
  await click(tree, "Restore prior policy");
  tree = render();
  expect(text(tree)).toContain(`Policy ${HYBRID_ROUTER_POLICY_VERSION}`);
});

it("does not enable a second shadow or trust another environment's policy status", async () => {
  const taskCandidate = {
    ...candidate,
    policyId: RouterPolicyId.make("fixture-task-policy"),
    policyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
  };
  ui.read.mockResolvedValueOnce(
    result({ ...first, policies: [baseline, { ...candidate, state: "shadow" }, taskCandidate] }),
  );
  let tree = render();
  ui.effects[0]!();
  await flush();
  tree = render();
  (
    elements(tree).find((element) => element.type === "select")!.props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: HYBRID_TASK_ROUTER_POLICY_VERSION } });
  tree = render();
  expect(button(tree, "Enable shadow").props.disabled).toBe(true);
  expect(ui.operate).not.toHaveBeenCalled();
  hooks.reset();
  ui.effects = [];
  ui.read.mockResolvedValueOnce(
    result({ ...first, environmentId: EnvironmentId.make("other-environment") }),
  );
  tree = render();
  ui.effects[0]!();
  await flush();
  tree = render();
  expect(button(tree, "Enable shadow").props.disabled).toBe(true);
  expect(text(tree)).toContain("could not be loaded");
});
