import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { createCollaborationEnvironmentAtoms } from "./collaboration.ts";

const environmentId = EnvironmentId.make("environment-a");
const projectId = ProjectId.make("project-a");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Fake",
  httpBaseUrl: "https://fake.invalid",
  wsBaseUrl: "wss://fake.invalid",
});
const snapshot = {
  agents: [],
  tasks: [],
  messages: [],
  realGrokbot: "NOT_CONNECTED",
  grokbotIntegration: [],
};
const makeCollaborationTestRuntime = Effect.fn(function* (
  fetch: typeof globalThis.fetch,
  preparedEnvironmentId = environmentId,
) {
  const prepared: PreparedConnection = {
    environmentId: preparedEnvironmentId,
    label: "Fake",
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: { _tag: "Bearer", token: "fake-test-token" },
    target,
  };
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
    desired: true,
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state,
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const registry: Pick<EnvironmentRegistry.EnvironmentRegistry["Service"], "run" | "followStream"> =
    {
      run: (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    };
  return Atom.runtime(
    Layer.merge(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        registry as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
      remoteHttpClientLayer(fetch),
    ),
  );
});

describe("collaboration existing authenticated GET", () => {
  it.effect(
    "uses the selected prepared connection and sends only a GET with its current bearer",
    () =>
      Effect.gen(function* () {
        const requests: Request[] = [];
        const runtime = yield* makeCollaborationTestRuntime(async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Response.json(snapshot);
        });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const atom = createCollaborationEnvironmentAtoms(runtime).snapshot({
          environmentId,
          input: { environmentId, projectId },
        });
        const result = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        expect(result).toEqual(snapshot);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.method).toBe("GET");
        expect(requests[0]!.url).toBe("https://fake.invalid/api/collaboration");
        expect(requests[0]!.headers.get("authorization")).toBe("Bearer fake-test-token");
      }),
  );
  it.effect("refuses a prepared connection from another environment without a network call", () =>
    Effect.gen(function* () {
      let requests = 0;
      const runtime = yield* makeCollaborationTestRuntime(async () => {
        requests++;
        return Response.json(snapshot);
      }, EnvironmentId.make("environment-b"));
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atom = createCollaborationEnvironmentAtoms(runtime).snapshot({
        environmentId,
        input: { environmentId, projectId },
      });
      const exit = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
      expect(requests).toBe(0);
    }),
  );
  it.effect("preserves a denied GET without falling back to mutations or another endpoint", () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const runtime = yield* makeCollaborationTestRuntime(async (input, init) => {
        methods.push(new Request(input, init).method);
        return Response.json({ message: "Denied" }, { status: 403 });
      });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atom = createCollaborationEnvironmentAtoms(runtime).snapshot({
        environmentId,
        input: { environmentId, projectId },
      });
      const exit = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
      expect(methods).toEqual(["GET"]);
    }),
  );
});
