import { EnvironmentId, ConcurrencyBudgetError, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { ConcurrencyBudgetService, layer as layerTest } from "./ConcurrencyBudgetService.ts";

const environmentId = EnvironmentId.make("env-1");

it.effect("releases leases after success, failure, and interruption", () =>
  Effect.gen(function* () {
    const service = yield* ConcurrencyBudgetService;
    const counter = yield* Ref.make(0);
    yield* service.withAdmission(
      {
        workloadClass: "foreground-turn",
        environmentId,
        requestedAt: "2026-10-03T00:00:00.000Z",
      },
      Ref.update(counter, (value) => value + 1),
    );
    const failed = yield* service
      .withAdmission(
        {
          workloadClass: "mcp-action",
          environmentId,
          requestedAt: "2026-10-03T00:00:01.000Z",
        },
        Effect.fail(
          new ConcurrencyBudgetError({
            reason: "invalid",
            detail: "boom",
            reasonCodes: ["CAPACITY_EXHAUSTED"],
          }),
        ),
      )
      .pipe(Effect.exit);
    assert.equal(failed._tag, "Failure");
    const snapshot = yield* service.snapshot(environmentId);
    assert.equal(snapshot.foregroundActive, 0);
    assert.equal(
      snapshot.classes.every((item) => item.active === 0),
      true,
    );
    yield* service.shutdown;
    const after = yield* service.snapshot(environmentId);
    assert.equal(after.queued, 0);
    const count = yield* Ref.get(counter);
    assert.equal(count, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("holds a lease until forked work finishes and releases on interrupt", () =>
  Effect.gen(function* () {
    const service = yield* ConcurrencyBudgetService;
    const started = yield* Deferred.make<void>();
    const releaseWork = yield* Deferred.make<void>();
    const fiber = yield* service
      .withAdmission(
        {
          workloadClass: "foreground-turn",
          environmentId,
          requestedAt: "2026-10-03T00:00:00.000Z",
        },
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseWork))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const during = yield* service.snapshot(environmentId);
    assert.equal(during.foregroundActive, 1);
    yield* Deferred.succeed(releaseWork, undefined);
    yield* Fiber.join(fiber);
    const after = yield* service.snapshot(environmentId);
    assert.equal(after.foregroundActive, 0);

    const interruptStarted = yield* Deferred.make<void>();
    const neverFiber = yield* service
      .withAdmission(
        {
          workloadClass: "mcp-action",
          environmentId,
          requestedAt: "2026-10-03T00:00:02.000Z",
          threadId: ThreadId.make("thread-interrupt"),
        },
        Deferred.succeed(interruptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(interruptStarted);
    const holding = yield* service.snapshot(environmentId);
    assert.equal(
      holding.classes.some((item) => item.workloadClass === "mcp-action" && item.active === 1),
      true,
    );
    yield* Fiber.interrupt(neverFiber);
    const interrupted = yield* service.snapshot(environmentId);
    assert.equal(
      interrupted.classes.every((item) => item.active === 0),
      true,
    );
  }).pipe(Effect.provide(layerTest)),
);
