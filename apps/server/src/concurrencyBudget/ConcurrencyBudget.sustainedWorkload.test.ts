// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ConcurrencyBudgetError,
  EnvironmentId,
  EventId,
  ThreadId,
  TurnId,
  defaultConcurrencyBudgetPolicy,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { sendTurnUntilTerminal } from "./awaitTurnTerminal.ts";
import { ConcurrencyBudgetService, layerWithPolicy } from "./ConcurrencyBudgetService.ts";

const environmentId = EnvironmentId.make("env-sustained");
const WORKLOAD_MS = 60_000;
const SAMPLE_EVERY_MS = 5_000;
const TURN_WORK_MS = 1_500;
const CANCEL_CYCLES = 50;
const FOREGROUND_LIMIT = 2;
const BACKGROUND_LIMIT = 2;

const mixedPolicy = () => {
  const policy = defaultConcurrencyBudgetPolicy();
  return {
    ...policy,
    classes: {
      ...policy.classes,
      "foreground-turn": { maxConcurrent: 2, maxQueue: 4, maxQueueTimeMs: 5_000 },
      "dream-job": { maxConcurrent: 1, maxQueue: 4, maxQueueTimeMs: 5_000 },
      "detached-background": { maxConcurrent: 1, maxQueue: 2, maxQueueTimeMs: 5_000 },
    },
  };
};

const completed = (threadId: ThreadId, turnId: TurnId): ProviderRuntimeEvent =>
  ({
    type: "turn.completed",
    eventId: EventId.make(`evt-complete-${turnId}`),
    provider: "codex",
    createdAt: "2026-10-05T00:00:00.000Z",
    threadId,
    turnId,
    payload: { state: "completed" },
  }) as ProviderRuntimeEvent;

it.effect(
  "Internal Beta: bounded 60-second fake-provider workload with overlapping FG/BG and cancellation",
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const budget = yield* ConcurrencyBudgetService;
        const startedAt = yield* Clock.currentTimeMillis;
        const rssBefore = process.memoryUsage().rss;
        const completedWork = yield* Ref.make(0);
        const foregroundAttempted = yield* Ref.make(0);
        const backgroundAttempted = yield* Ref.make(0);
        const seq = yield* Ref.make(0);
        const peak = yield* Ref.make({ foregroundActive: 0, queued: 0, backgroundActive: 0 });
        const samples = yield* Ref.make<
          Array<{
            readonly atMs: number;
            readonly rss: number;
            readonly foregroundActive: number;
            readonly queued: number;
            readonly backgroundActive: number;
          }>
        >([]);
        const cancellationCycles: Array<{
          readonly cycle: number;
          readonly cancelled: number;
          readonly queuedAfter: number;
        }> = [];
        const live = yield* Ref.make<Array<Fiber.Fiber<unknown, ConcurrencyBudgetError>>>([]);

        const recordPeak = (snapshot: {
          readonly foregroundActive: number;
          readonly queued: number;
          readonly classes: ReadonlyArray<{
            readonly workloadClass: string;
            readonly active: number;
          }>;
        }) =>
          Effect.gen(function* () {
            const backgroundActive = snapshot.classes
              .filter(
                (item) =>
                  item.workloadClass === "dream-job" ||
                  item.workloadClass === "detached-background",
              )
              .reduce((sum, item) => sum + item.active, 0);
            yield* Ref.update(peak, (current) => ({
              foregroundActive: Math.max(current.foregroundActive, snapshot.foregroundActive),
              queued: Math.max(current.queued, snapshot.queued),
              backgroundActive: Math.max(current.backgroundActive, backgroundActive),
            }));
            const atMs = (yield* Clock.currentTimeMillis) - startedAt;
            yield* Ref.update(samples, (current) => [
              ...current,
              {
                atMs,
                rss: process.memoryUsage().rss,
                foregroundActive: snapshot.foregroundActive,
                queued: snapshot.queued,
                backgroundActive,
              },
            ]);
          });

        const nextId = (prefix: string) =>
          Ref.updateAndGet(seq, (value) => value + 1).pipe(
            Effect.map((value) => `${prefix}-${String(value)}`),
          );

        const fakeTurn = (input: {
          readonly workloadClass: "foreground-turn" | "dream-job" | "detached-background";
        }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(yield* nextId("thread"));
            const turnId = TurnId.make(yield* nextId("turn"));
            yield* Ref.update(
              input.workloadClass === "foreground-turn" ? foregroundAttempted : backgroundAttempted,
              (count) => count + 1,
            );
            const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
            return yield* budget.withAdmission(
              {
                workloadClass: input.workloadClass,
                environmentId,
                threadId,
                requestedAt: "2026-10-05T00:00:00.000Z",
              },
              sendTurnUntilTerminal(
                Effect.gen(function* () {
                  yield* Effect.sleep(Duration.millis(TURN_WORK_MS)).pipe(
                    Effect.andThen(Queue.offer(terminals, completed(threadId, turnId))),
                    Effect.andThen(Ref.update(completedWork, (count) => count + 1)),
                    Effect.forkChild({ startImmediately: true }),
                  );
                  return { threadId, turnId };
                }),
                Stream.fromQueue(terminals),
                { timeout: "8 seconds", interruptAckTimeout: "200 millis" },
              ),
            );
          }).pipe(
            Effect.catchTag("ConcurrencyBudgetError", () => Effect.void),
            Effect.forkChild({ startImmediately: true }),
          );

        const track = (fiber: Fiber.Fiber<unknown, ConcurrencyBudgetError>) =>
          Ref.update(live, (current) => [...current, fiber]);

        const sampler = yield* Effect.forever(
          Effect.gen(function* () {
            yield* recordPeak(yield* budget.snapshot(environmentId));
            yield* Effect.sleep(Duration.millis(SAMPLE_EVERY_MS));
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        let cycle = 0;
        while (
          (yield* Clock.currentTimeMillis) - startedAt < WORKLOAD_MS ||
          cycle < CANCEL_CYCLES
        ) {
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (elapsed < WORKLOAD_MS) {
            yield* fakeTurn({ workloadClass: "foreground-turn" }).pipe(Effect.flatMap(track));
            yield* fakeTurn({ workloadClass: "foreground-turn" }).pipe(Effect.flatMap(track));
            yield* fakeTurn({ workloadClass: "dream-job" }).pipe(Effect.flatMap(track));
            yield* fakeTurn({ workloadClass: "detached-background" }).pipe(Effect.flatMap(track));
          }

          if (cycle < CANCEL_CYCLES) {
            const waiter = yield* budget
              .withAdmission(
                {
                  workloadClass: "foreground-turn",
                  environmentId,
                  threadId: ThreadId.make("thread-cancel-cycle"),
                  requestedAt: `2026-10-05T00:01:00.000Z`,
                },
                Effect.void,
              )
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.sleep("200 millis");
            const cancelled = yield* budget.cancelQueuedForThread(
              environmentId,
              ThreadId.make("thread-cancel-cycle"),
            );
            yield* Fiber.join(waiter).pipe(Effect.exit);
            const afterCancel = yield* budget.snapshot(environmentId);
            yield* recordPeak(afterCancel);
            cancellationCycles.push({ cycle, cancelled, queuedAfter: afterCancel.queued });
            cycle += 1;
          }
          yield* Effect.sleep(cycle < CANCEL_CYCLES ? "200 millis" : "1 second");
        }

        const remaining = yield* Ref.get(live);
        for (const fiber of remaining) {
          yield* Fiber.interrupt(fiber);
        }
        yield* Fiber.interrupt(sampler);
        yield* budget.shutdown;
        const finalSnapshot = yield* budget.snapshot(environmentId);
        const finished = yield* Ref.get(completedWork);
        const peaks = yield* Ref.get(peak);
        const resourceSamples = yield* Ref.get(samples);
        const testHarnessDurationMs = (yield* Clock.currentTimeMillis) - startedAt;
        const rssAfter = process.memoryUsage().rss;
        const evidence = {
          note: "testHarnessDurationMs is harness wall time for this 60-second bounded fake-provider run. It is not application latency.",
          workload: {
            foregroundAttempted: yield* Ref.get(foregroundAttempted),
            backgroundAttempted: yield* Ref.get(backgroundAttempted),
            cancellationCycles: cancellationCycles.length,
            cancelCycleTarget: CANCEL_CYCLES,
            completedWork: finished,
          },
          peak: peaks,
          testHarnessDurationMs,
          resourceSamples,
          rssBytes: { before: rssBefore, after: rssAfter, delta: rssAfter - rssBefore },
          cleanup: {
            foregroundActive: finalSnapshot.foregroundActive,
            queued: finalSnapshot.queued,
            allIdle: finalSnapshot.classes.every((item) => item.active === 0 && item.queued === 0),
          },
        };
        const evidenceDir = process.env.INTERNAL_BETA_EVIDENCE_DIR;
        if (evidenceDir !== undefined && evidenceDir.length > 0) {
          NodeFS.mkdirSync(evidenceDir, { recursive: true });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const encoded = JSON.stringify(evidence, null, 2);
          NodeFS.writeFileSync(
            NodePath.join(evidenceDir, "sustained-workload.json"),
            `${encoded}\n`,
          );
        }
        assert.equal(testHarnessDurationMs >= WORKLOAD_MS, true);
        assert.equal(finished >= 1, true);
        assert.equal(peaks.foregroundActive >= 1, true);
        assert.equal(peaks.foregroundActive <= FOREGROUND_LIMIT, true);
        assert.equal(peaks.backgroundActive <= BACKGROUND_LIMIT, true);
        assert.equal(resourceSamples.length >= 10, true);
        assert.equal(cancellationCycles.length >= CANCEL_CYCLES, true);
        assert.equal(finalSnapshot.foregroundActive, 0);
        assert.equal(finalSnapshot.queued, 0);
        assert.equal(evidence.cleanup.allIdle, true);
      }),
    ).pipe(Effect.provide(layerWithPolicy(mixedPolicy()))),
  120_000,
);
