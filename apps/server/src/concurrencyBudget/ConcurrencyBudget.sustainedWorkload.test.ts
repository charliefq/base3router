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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { sendTurnUntilTerminal } from "./awaitTurnTerminal.ts";
import { ConcurrencyBudgetService, layerWithPolicy } from "./ConcurrencyBudgetService.ts";

const environmentId = EnvironmentId.make("env-sustained");

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
  "Internal Beta: bounded sustained fake-provider workload with overlapping FG/BG and cancellation",
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const budget = yield* ConcurrencyBudgetService;
        // @effect-diagnostics-next-line globalDateInEffect:off
        const startedAt = Date.now();
        const rssBefore = process.memoryUsage().rss;
        const completedWork = yield* Ref.make(0);
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

        const recordPeak = (snapshot: {
          readonly foregroundActive: number;
          readonly queued: number;
          readonly classes: ReadonlyArray<{
            readonly workloadClass: string;
            readonly active: number;
          }>;
        }) => {
          const backgroundActive = snapshot.classes
            .filter(
              (item) =>
                item.workloadClass === "dream-job" || item.workloadClass === "detached-background",
            )
            .reduce((sum, item) => sum + item.active, 0);
          return Ref.update(peak, (current) => ({
            foregroundActive: Math.max(current.foregroundActive, snapshot.foregroundActive),
            queued: Math.max(current.queued, snapshot.queued),
            backgroundActive: Math.max(current.backgroundActive, backgroundActive),
          })).pipe(
            Effect.andThen(
              Ref.update(samples, (current) => {
                // @effect-diagnostics-next-line globalDateInEffect:off
                const atMs = Date.now() - startedAt;
                return [
                  ...current,
                  {
                    atMs,
                    rss: process.memoryUsage().rss,
                    foregroundActive: snapshot.foregroundActive,
                    queued: snapshot.queued,
                    backgroundActive,
                  },
                ];
              }),
            ),
          );
        };

        const fakeTurn = (input: {
          readonly workloadClass: "foreground-turn" | "dream-job" | "detached-background";
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
          readonly workMs: number;
        }) =>
          Effect.gen(function* () {
            const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
            return yield* budget.withAdmission(
              {
                workloadClass: input.workloadClass,
                environmentId,
                threadId: input.threadId,
                requestedAt: "2026-10-05T00:00:00.000Z",
              },
              sendTurnUntilTerminal(
                Effect.gen(function* () {
                  yield* Effect.sleep(`${String(input.workMs)} millis`).pipe(
                    Effect.andThen(Queue.offer(terminals, completed(input.threadId, input.turnId))),
                    Effect.andThen(Ref.update(completedWork, (count) => count + 1)),
                    Effect.forkChild({ startImmediately: true }),
                  );
                  return { threadId: input.threadId, turnId: input.turnId };
                }),
                Stream.fromQueue(terminals),
                { timeout: "2 seconds", interruptAckTimeout: "100 millis" },
              ),
            );
          });

        const sampler = yield* Effect.forever(
          Effect.gen(function* () {
            const snapshot = yield* budget.snapshot(environmentId);
            yield* recordPeak(snapshot);
            yield* Effect.sleep("25 millis");
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        const foregroundFibers: Array<Fiber.Fiber<unknown, ConcurrencyBudgetError>> = [];
        for (let index = 0; index < 4; index += 1) {
          const fiber = yield* fakeTurn({
            workloadClass: "foreground-turn",
            threadId: ThreadId.make(`thread-fg-${String(index)}`),
            turnId: TurnId.make(`turn-fg-${String(index)}`),
            workMs: 40,
          }).pipe(Effect.forkChild({ startImmediately: true }));
          foregroundFibers.push(fiber);
        }
        const dreamFiber = yield* fakeTurn({
          workloadClass: "dream-job",
          threadId: ThreadId.make("thread-dream"),
          turnId: TurnId.make("turn-dream"),
          workMs: 50,
        }).pipe(Effect.forkChild({ startImmediately: true }));
        const shadowFiber = yield* fakeTurn({
          workloadClass: "detached-background",
          threadId: ThreadId.make("thread-shadow"),
          turnId: TurnId.make("turn-shadow"),
          workMs: 40,
        }).pipe(Effect.forkChild({ startImmediately: true }));

        const cancellationCycles: Array<{
          readonly cycle: number;
          readonly cancelled: number;
          readonly queuedAfter: number;
        }> = [];
        for (let cycle = 0; cycle < 4; cycle += 1) {
          const waiter = yield* budget
            .withAdmission(
              {
                workloadClass: "foreground-turn",
                environmentId,
                threadId: ThreadId.make("thread-cancel-cycle"),
                requestedAt: `2026-10-05T00:01:0${String(cycle)}.000Z`,
              },
              Effect.void,
            )
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.sleep("10 millis");
          const cancelled = yield* budget.cancelQueuedForThread(
            environmentId,
            ThreadId.make("thread-cancel-cycle"),
          );
          yield* Fiber.join(waiter).pipe(Effect.exit);
          const after = yield* budget.snapshot(environmentId);
          yield* recordPeak(after);
          cancellationCycles.push({ cycle, cancelled, queuedAfter: after.queued });
        }

        for (const fiber of foregroundFibers) {
          yield* Fiber.join(fiber).pipe(Effect.exit);
        }
        yield* Fiber.join(dreamFiber).pipe(Effect.exit);
        yield* Fiber.join(shadowFiber).pipe(Effect.exit);
        yield* Fiber.interrupt(sampler);
        yield* budget.shutdown;
        const finalSnapshot = yield* budget.snapshot(environmentId);
        const finished = yield* Ref.get(completedWork);
        const peaks = yield* Ref.get(peak);
        const resourceSamples = yield* Ref.get(samples);
        // @effect-diagnostics-next-line globalDateInEffect:off
        const testHarnessDurationMs = Date.now() - startedAt;
        const rssAfter = process.memoryUsage().rss;
        const evidence = {
          note: "testHarnessDurationMs is harness wall time, not application performance.",
          workload: {
            foregroundAttempted: 4,
            backgroundAttempted: 2,
            cancellationCycles: 4,
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
        assert.equal(finished >= 6, true);
        assert.equal(peaks.foregroundActive >= 1, true);
        assert.equal(resourceSamples.length >= 1, true);
        assert.equal(finalSnapshot.foregroundActive, 0);
        assert.equal(finalSnapshot.queued, 0);
        assert.equal(evidence.cleanup.allIdle, true);
        assert.equal(testHarnessDurationMs >= 0, true);
        assert.equal(cancellationCycles.length, 4);
      }),
    ).pipe(Effect.provide(layerWithPolicy(mixedPolicy()))),
);
