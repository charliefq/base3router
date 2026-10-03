import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nanosToDurationMs } from "@t3tools/shared/turnOutcome";

import { TurnTiming, layer as turnTimingLayer } from "./TurnTiming.ts";

const environmentId = EnvironmentId.make("lab-environment");
const threadId = ThreadId.make("thread-timing");
const key = { environmentId, threadId, turnId: "turn-1" };

const fakeClock = (state: { millis: number; nanos: bigint }): Clock.Clock => {
  const real = Effect.runSync(Effect.service(Clock.Clock));
  return {
    currentTimeMillisUnsafe: () => state.millis,
    currentTimeMillis: Effect.sync(() => state.millis),
    currentTimeNanosUnsafe: () => state.nanos,
    currentTimeNanos: Effect.sync(() => state.nanos),
    monotonicTimeNanosUnsafe: () => state.nanos,
    monotonicTimeNanos: Effect.sync(() => state.nanos),
    sleep: (duration) => real.sleep(duration),
  };
};

it.effect("records TTFT and total duration from monotonic nanos", () => {
  const clock = { millis: 1_000, nanos: 1_000_000_000n };
  return Effect.gen(function* () {
    const timing = yield* TurnTiming;
    yield* timing.markRouteStart(key);
    clock.nanos = 1_010_000_000n;
    clock.millis = 1_010;
    yield* timing.markProviderRequestStart(key);
    clock.nanos = 1_060_000_000n;
    clock.millis = 1_060;
    yield* timing.markFirstOutput(key);
    clock.nanos = 1_400_000_000n;
    clock.millis = 1_400;
    const snapshot = yield* timing.take(key);
    assert.equal(
      nanosToDurationMs(snapshot?.providerRequestStartNanos, snapshot?.firstOutputNanos),
      50,
    );
    assert.equal(nanosToDurationMs(snapshot?.routeStartNanos, snapshot?.terminalNanos), 400);
    const size = yield* timing.size;
    assert.equal(size, 0);
  }).pipe(
    Effect.provide(turnTimingLayer),
    Effect.provide(Layer.succeed(Clock.Clock, fakeClock(clock))),
  );
});

it.effect("leaves TTFT unknown when the turn fails before first output", () => {
  const clock = { millis: 2_000, nanos: 2_000_000_000n };
  return Effect.gen(function* () {
    const timing = yield* TurnTiming;
    yield* timing.markRouteStart(key);
    clock.nanos = 2_120_000_000n;
    const snapshot = yield* timing.take(key);
    assert.equal(snapshot?.firstOutputNanos, undefined);
    assert.equal(nanosToDurationMs(snapshot?.routeStartNanos, snapshot?.terminalNanos), 120);
  }).pipe(
    Effect.provide(turnTimingLayer),
    Effect.provide(Layer.succeed(Clock.Clock, fakeClock(clock))),
  );
});

it.effect("records first output once for streaming deltas", () => {
  const clock = { millis: 3_000, nanos: 3_000_000_000n };
  return Effect.gen(function* () {
    const timing = yield* TurnTiming;
    yield* timing.markRouteStart(key);
    yield* timing.markProviderRequestStart(key);
    clock.nanos = 3_040_000_000n;
    yield* timing.markFirstOutput(key);
    clock.nanos = 3_080_000_000n;
    yield* timing.markFirstOutput(key);
    const snapshot = yield* timing.take(key);
    assert.equal(
      nanosToDurationMs(snapshot?.providerRequestStartNanos, snapshot?.firstOutputNanos),
      40,
    );
  }).pipe(
    Effect.provide(turnTimingLayer),
    Effect.provide(Layer.succeed(Clock.Clock, fakeClock(clock))),
  );
});
