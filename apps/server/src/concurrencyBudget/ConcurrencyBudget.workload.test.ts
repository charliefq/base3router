// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { EnvironmentId, ThreadId, defaultConcurrencyBudgetPolicy } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ConcurrencyBudgetService, layerWithPolicy } from "./ConcurrencyBudgetService.ts";

const environmentId = EnvironmentId.make("env-workload");

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

const layer = layerWithPolicy(mixedPolicy());

const hold = (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined);
    yield* Deferred.await(release);
  });

it.effect("measures mixed foreground/background occupancy and cancellation-cycle cleanup", () =>
  Effect.gen(function* () {
    const budget = yield* ConcurrencyBudgetService;
    const startedAt = Date.now();
    const rssBefore = process.memoryUsage().rss;
    const fgRelease = yield* Deferred.make<void>();
    const bgRelease = yield* Deferred.make<void>();
    const bgStarted = yield* Deferred.make<void>();
    const bgFiber = yield* budget
      .withAdmission(
        {
          workloadClass: "dream-job",
          environmentId,
          requestedAt: "2026-10-04T00:00:10.000Z",
        },
        hold(bgStarted, bgRelease),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(bgStarted);
    const shadowFiber = yield* budget
      .withAdmission(
        {
          workloadClass: "detached-background",
          environmentId,
          requestedAt: "2026-10-04T00:00:11.000Z",
        },
        hold(yield* Deferred.make<void>(), bgRelease),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    const fgStarted: Array<Deferred.Deferred<void>> = [];
    const fgFibers: Array<Fiber.Fiber<void, unknown>> = [];
    for (let index = 0; index < 3; index += 1) {
      const started = yield* Deferred.make<void>();
      fgStarted.push(started);
      const fiber = yield* budget
        .withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId: ThreadId.make(`thread-fg-${index}`),
            requestedAt: `2026-10-04T00:00:0${index}.000Z`,
          },
          hold(started, fgRelease),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      fgFibers.push(fiber);
    }
    yield* Deferred.await(fgStarted[0]!);
    yield* Deferred.await(fgStarted[1]!);

    const occupied = yield* budget.snapshot(environmentId);
    const cancellationCycles: Array<{
      readonly cycle: number;
      readonly cancelled: number;
      readonly queuedAfter: number;
    }> = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const waiter = yield* budget
        .withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId: ThreadId.make("thread-cancel-cycle"),
            requestedAt: `2026-10-04T00:01:0${cycle}.000Z`,
          },
          Effect.void,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const cancelled = yield* budget.cancelQueuedForThread(
        environmentId,
        ThreadId.make("thread-cancel-cycle"),
      );
      yield* Fiber.join(waiter).pipe(Effect.exit);
      const after = yield* budget.snapshot(environmentId);
      cancellationCycles.push({ cycle, cancelled, queuedAfter: after.queued });
    }

    yield* Deferred.succeed(fgRelease, undefined);
    yield* Deferred.succeed(bgRelease, undefined);
    yield* Fiber.join(fgFibers[0]!).pipe(Effect.exit);
    yield* Fiber.join(fgFibers[1]!).pipe(Effect.exit);
    yield* Fiber.join(fgFibers[2]!).pipe(Effect.exit);
    yield* Fiber.join(bgFiber).pipe(Effect.exit);
    yield* Fiber.join(shadowFiber).pipe(Effect.exit);
    yield* budget.shutdown;
    const finalSnapshot = yield* budget.snapshot(environmentId);
    const durationMs = Date.now() - startedAt;
    const rssAfter = process.memoryUsage().rss;
    const evidence = {
      workload: {
        foregroundAttempted: 3,
        foregroundLimit: 2,
        backgroundAttempted: 2,
        cancellationCycles: 5,
      },
      occupied: {
        foregroundActive: occupied.foregroundActive,
        queued: occupied.queued,
        classes: occupied.classes.map((item) => ({
          workloadClass: item.workloadClass,
          active: item.active,
          queued: item.queued,
        })),
      },
      cancellationCycles,
      durationMs,
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
      NodeFS.writeFileSync(
        NodePath.join(evidenceDir, "mixed-workload.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
    assert.equal(occupied.foregroundActive, 2);
    assert.equal(occupied.queued >= 1, true);
    assert.equal(finalSnapshot.foregroundActive, 0);
    assert.equal(finalSnapshot.queued, 0);
    assert.equal(evidence.cleanup.allIdle, true);
    assert.equal(durationMs >= 0, true);
  }).pipe(Effect.provide(layer)),
);
