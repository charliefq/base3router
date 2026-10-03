import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const MAX_TIMING_ENTRIES = 2048;

export type TurnTimingKey = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
};

export type TurnTimingSnapshot = {
  readonly routeStartNanos?: bigint;
  readonly providerRequestStartNanos?: bigint;
  readonly firstOutputNanos?: bigint;
  readonly terminalNanos?: bigint;
  readonly routeStartMs?: number;
  readonly providerRequestStartMs?: number;
  readonly firstOutputMs?: number;
  readonly terminalMs?: number;
};

type TimingEntry = {
  routeStartNanos?: bigint;
  providerRequestStartNanos?: bigint;
  firstOutputNanos?: bigint;
  routeStartMs?: number;
  providerRequestStartMs?: number;
  firstOutputMs?: number;
  lastTouchMs: number;
};

const turnTimingKey = (input: TurnTimingKey): string =>
  `${input.environmentId}\0${input.threadId}\0${input.turnId}`;

export class TurnTiming extends Context.Service<
  TurnTiming,
  {
    readonly markRouteStart: (key: TurnTimingKey) => Effect.Effect<void>;
    readonly markProviderRequestStart: (key: TurnTimingKey) => Effect.Effect<void>;
    readonly markFirstOutput: (key: TurnTimingKey) => Effect.Effect<void>;
    readonly take: (key: TurnTimingKey) => Effect.Effect<TurnTimingSnapshot | undefined>;
    readonly discard: (key: TurnTimingKey) => Effect.Effect<void>;
    readonly size: Effect.Effect<number>;
  }
>()("t3/routerEvaluation/TurnTiming") {}

const evictIfNeeded = (store: Map<string, TimingEntry>): void => {
  while (store.size > MAX_TIMING_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTouch = Number.POSITIVE_INFINITY;
    for (const [key, entry] of store) {
      if (entry.lastTouchMs < oldestTouch) {
        oldestTouch = entry.lastTouchMs;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
};

const make = Effect.gen(function* () {
  const store = yield* Ref.make(new Map<string, TimingEntry>());

  const patch = (
    key: TurnTimingKey,
    apply: (entry: TimingEntry, nowMs: number, nowNanos: bigint) => TimingEntry,
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const nowNanos = yield* Clock.monotonicTimeNanos;
      yield* Ref.update(store, (current) => {
        const next = new Map(current);
        const id = turnTimingKey(key);
        const existing = next.get(id) ?? { lastTouchMs: nowMs };
        next.set(id, { ...apply(existing, nowMs, nowNanos), lastTouchMs: nowMs });
        evictIfNeeded(next);
        return next;
      });
    });

  return {
    markRouteStart: (key) =>
      patch(key, (entry, nowMs, nowNanos) =>
        entry.routeStartNanos !== undefined
          ? entry
          : { ...entry, routeStartNanos: nowNanos, routeStartMs: nowMs },
      ),
    markProviderRequestStart: (key) =>
      patch(key, (entry, nowMs, nowNanos) =>
        entry.providerRequestStartNanos !== undefined
          ? entry
          : {
              ...entry,
              providerRequestStartNanos: nowNanos,
              providerRequestStartMs: nowMs,
            },
      ),
    markFirstOutput: (key) =>
      patch(key, (entry, nowMs, nowNanos) =>
        entry.firstOutputNanos !== undefined
          ? entry
          : { ...entry, firstOutputNanos: nowNanos, firstOutputMs: nowMs },
      ),
    take: (key) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const nowNanos = yield* Clock.monotonicTimeNanos;
        const id = turnTimingKey(key);
        const current = yield* Ref.get(store);
        const entry = current.get(id);
        if (entry !== undefined) {
          yield* Ref.update(store, (map) => {
            if (!map.has(id)) return map;
            const next = new Map(map);
            next.delete(id);
            return next;
          });
        }
        return {
          ...(entry?.routeStartNanos !== undefined
            ? { routeStartNanos: entry.routeStartNanos }
            : {}),
          ...(entry?.providerRequestStartNanos !== undefined
            ? { providerRequestStartNanos: entry.providerRequestStartNanos }
            : {}),
          ...(entry?.firstOutputNanos !== undefined
            ? { firstOutputNanos: entry.firstOutputNanos }
            : {}),
          terminalNanos: nowNanos,
          ...(entry?.routeStartMs !== undefined ? { routeStartMs: entry.routeStartMs } : {}),
          ...(entry?.providerRequestStartMs !== undefined
            ? { providerRequestStartMs: entry.providerRequestStartMs }
            : {}),
          ...(entry?.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
          terminalMs: nowMs,
        } satisfies TurnTimingSnapshot;
      }),
    discard: (key) =>
      Ref.update(store, (current) => {
        const id = turnTimingKey(key);
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      }),
    size: Ref.get(store).pipe(Effect.map((map) => map.size)),
  } satisfies TurnTiming["Service"];
});

export const layer = Layer.effect(TurnTiming, make);
