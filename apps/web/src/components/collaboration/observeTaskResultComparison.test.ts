import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
  ConnectionTransientError,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type { Done } from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { observeTaskResultComparison } from "./observeTaskResultComparison";

const threadId = ThreadId.make("comparison-observation-thread");
const harness = Effect.fn(function* (supported = true) {
  const frames = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem, Error | Done>();
  const reports = yield* Queue.unbounded<string>();
  const seen: string[] = [];
  const subscribed = yield* Deferred.make<unknown>();
  const closed = yield* Deferred.make<never, ConnectionTransientError>();
  const finalized = yield* Ref.make(0);
  const session: RpcSession = {
    initialConfig: Effect.succeed({ threadResumeCompletionMarker: supported } as ServerConfig),
    client: {
      [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: unknown) =>
        Stream.fromQueue(frames).pipe(
          Stream.onStart(Deferred.succeed(subscribed, input)),
          Stream.ensuring(Ref.update(finalized, (n) => n + 1)),
        ),
    } as unknown as WsRpcProtocolClient,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Deferred.await(closed),
  };
  const sessions = yield* SubscriptionRef.make(Option.some(session));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-a"),
      label: "Fixture",
      httpBaseUrl: "http://fixture",
      wsBaseUrl: "ws://fixture",
    }),
    session: sessions,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const controller = new AbortController();
  const fiber = yield* observeTaskResultComparison({
    threadId,
    afterSequence: 100,
    signal: controller.signal,
    report: (state) => {
      seen.push(state);
      Queue.offerUnsafe(reports, state);
    },
  }).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.forkScoped,
  );
  return {
    frames,
    reports,
    seen,
    subscribed,
    sessions,
    session,
    closed,
    controller,
    fiber,
    finalized,
  };
});

it.effect(
  "comparison observation waits for replay completion and disposes without output or writes",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* Deferred.await(h.subscribed)).toEqual({
        threadId,
        afterSequence: 100,
        requestCompletionMarker: true,
        acceptBoundedSnapshot: true,
      });
      yield* Queue.offer(h.frames, { kind: "unknown-event", sequence: 100, eventType: "old" });
      yield* Queue.offer(h.frames, { kind: "synchronized" });
      expect(yield* Queue.take(h.reports)).toBe("ready");
      h.controller.abort();
      yield* Fiber.join(h.fiber);
      expect(yield* Ref.get(h.finalized)).toBe(1);
      expect(h.seen).toEqual(["ready"]);
    }),
);

it.effect.each([
  "event",
  "unknown-event",
  "snapshot",
  "error",
  "completion",
  "session loss",
  "session ABA",
  "socket loss",
] as const)("comparison observation retires on %s after a synchronized read", (kind) =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Deferred.await(h.subscribed);
    yield* Queue.offer(h.frames, { kind: "synchronized" });
    expect(yield* Queue.take(h.reports)).toBe("ready");
    if (kind === "error") yield* Queue.fail(h.frames, new Error("fixture stream failure"));
    else if (kind === "completion") yield* Queue.end(h.frames);
    else if (kind === "socket loss")
      yield* Deferred.fail(
        h.closed,
        new ConnectionTransientError({ reason: "transport", detail: "fixture socket loss" }),
      );
    else if (kind === "session loss" || kind === "session ABA") {
      yield* SubscriptionRef.set(h.sessions, Option.none());
      if (kind === "session ABA") yield* SubscriptionRef.set(h.sessions, Option.some(h.session));
    } else {
      // Only envelope identity is used: frames never become displayed output.
      yield* Queue.offer(h.frames, {
        kind,
        sequence: 101,
        snapshotSequence: 101,
        eventType: "future-event",
      } as OrchestrationV2ThreadStreamItem);
    }
    expect(yield* Queue.take(h.reports)).toBe(
      ["event", "unknown-event", "snapshot"].includes(kind) ? "changed" : "unavailable",
    );
    yield* Queue.offer(h.frames, { kind: "synchronized" });
    h.controller.abort();
    yield* Fiber.join(h.fiber);
    expect(h.seen).toHaveLength(2);
  }),
);

it.effect("comparison observation fails closed when completion markers are unsupported", () =>
  Effect.gen(function* () {
    const h = yield* harness(false);
    expect(yield* Queue.take(h.reports)).toBe("unavailable");
    yield* Fiber.join(h.fiber);
    expect(yield* Deferred.isDone(h.subscribed)).toBe(false);
  }),
);

it.effect("comparison observation rejects a replay event before the completion marker", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Deferred.await(h.subscribed);
    yield* Queue.offerAll(h.frames, [
      { kind: "unknown-event", sequence: 101, eventType: "newer" },
      { kind: "synchronized" },
    ]);
    expect(yield* Queue.take(h.reports)).toBe("changed");
    h.controller.abort();
    yield* Fiber.join(h.fiber);
    expect(h.seen).toEqual(["changed"]);
  }),
);
