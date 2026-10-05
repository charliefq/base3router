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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { sendTurnUntilTerminal } from "./awaitTurnTerminal.ts";
import { ConcurrencyBudgetService, layerWithPolicy } from "./ConcurrencyBudgetService.ts";

const environmentId = EnvironmentId.make("env-lease");
const threadId = ThreadId.make("thread-async");
const turnId = TurnId.make("turn-async-1");
const otherTurnId = TurnId.make("turn-async-2");

const tightForegroundPolicy = () => {
  const policy = defaultConcurrencyBudgetPolicy();
  return {
    ...policy,
    threadForegroundConcurrent: 1,
    classes: {
      ...policy.classes,
      "foreground-turn": { maxConcurrent: 1, maxQueue: 1, maxQueueTimeMs: 5_000 },
      "failover-retry": { maxConcurrent: 2, maxQueue: 0, maxQueueTimeMs: 5_000 },
    },
  };
};

const provideTight = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(layerWithPolicy(tightForegroundPolicy())));

const completed = (id: TurnId): ProviderRuntimeEvent =>
  ({
    type: "turn.completed",
    eventId: EventId.make(`evt-complete-${id}`),
    provider: "codex",
    createdAt: "2026-10-04T00:00:00.000Z",
    threadId,
    turnId: id,
    payload: { state: "completed" },
  }) as ProviderRuntimeEvent;

const aborted = (id: TurnId): ProviderRuntimeEvent =>
  ({
    type: "turn.aborted",
    eventId: EventId.make(`evt-abort-${id}`),
    provider: "codex",
    createdAt: "2026-10-04T00:00:00.100Z",
    threadId,
    turnId: id,
    payload: { reason: "interrupted" },
  }) as ProviderRuntimeEvent;

const startReturnSend = (id: TurnId, returned: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    yield* Deferred.succeed(returned, undefined);
    return { threadId, turnId: id };
  });

const forkAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.forkChild({ startImmediately: true }));

it.effect("keeps capacity until a start-return adapter emits a terminal event", () =>
  provideTight(
    Effect.gen(function* () {
      const budget = yield* ConcurrencyBudgetService;
      const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const returned = yield* Deferred.make<void>();
      const afterStart = yield* Deferred.make<void>();
      const secondBegan = yield* Ref.make(false);
      const secondRelease = yield* Deferred.make<void>();
      const first = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:00.000Z",
          },
          sendTurnUntilTerminal(startReturnSend(turnId, returned), Stream.fromQueue(terminals), {
            afterStart: () => Deferred.succeed(afterStart, undefined),
          }),
        ),
      );
      yield* Deferred.await(returned);
      yield* Deferred.await(afterStart);
      const during = yield* budget.snapshot(environmentId);
      assert.equal(during.foregroundActive, 1);
      const second = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId: ThreadId.make("thread-async-other"),
            requestedAt: "2026-10-04T00:00:01.000Z",
          },
          Effect.gen(function* () {
            yield* Ref.set(secondBegan, true);
            yield* Deferred.await(secondRelease);
          }),
        ),
      );
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(secondBegan), false);
      const queued = yield* budget.snapshot(environmentId);
      assert.equal(queued.foregroundActive, 1);
      assert.equal(queued.queued >= 1, true);
      yield* Queue.offer(terminals, completed(turnId));
      yield* Fiber.join(first);
      while (!(yield* Ref.get(secondBegan))) {
        yield* Effect.yieldNow;
      }
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 1);
      yield* Deferred.succeed(secondRelease, undefined);
      yield* Fiber.join(second);
      const after = yield* budget.snapshot(environmentId);
      assert.equal(after.foregroundActive, 0);
      assert.equal(after.queued, 0);
    }),
  ),
);

it.effect("releases once on success, failure, and confirmed abort", () =>
  provideTight(
    Effect.gen(function* () {
      const budget = yield* ConcurrencyBudgetService;
      const successTerminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const returned = yield* Deferred.make<void>();
      const successFiber = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:02.000Z",
          },
          sendTurnUntilTerminal(
            startReturnSend(turnId, returned),
            Stream.fromQueue(successTerminals),
          ),
        ),
      );
      yield* Deferred.await(returned);
      yield* Queue.offer(successTerminals, completed(turnId));
      const ok = yield* Fiber.join(successFiber);
      assert.equal(ok.turnId, turnId);
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 0);

      const failedSend = Effect.fail(
        new ConcurrencyBudgetError({
          reason: "invalid",
          detail: "adapter failed after start",
          reasonCodes: ["CAPACITY_EXHAUSTED"],
        }),
      );
      const failed = yield* budget
        .withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:03.000Z",
          },
          sendTurnUntilTerminal(
            failedSend,
            Stream.fromQueue(yield* Queue.unbounded<ProviderRuntimeEvent>()),
          ),
        )
        .pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 0);

      const abortTerminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const abortReturned = yield* Deferred.make<void>();
      const abortFiber = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:04.000Z",
          },
          sendTurnUntilTerminal(
            startReturnSend(turnId, abortReturned),
            Stream.fromQueue(abortTerminals),
          ),
        ),
      );
      yield* Deferred.await(abortReturned);
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 1);
      yield* Queue.offer(abortTerminals, aborted(turnId));
      yield* Fiber.join(abortFiber);
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 0);
    }),
  ),
);

it.effect("does not release on a cancellation request while execution continues", () =>
  provideTight(
    Effect.gen(function* () {
      const budget = yield* ConcurrencyBudgetService;
      const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const returned = yield* Deferred.make<void>();
      const cancelRequested = yield* Ref.make(false);
      const fiber = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:05.000Z",
          },
          sendTurnUntilTerminal(startReturnSend(turnId, returned), Stream.fromQueue(terminals)),
        ),
      );
      yield* Deferred.await(returned);
      yield* Ref.set(cancelRequested, true);
      const duringCancel = yield* budget.snapshot(environmentId);
      assert.equal(yield* Ref.get(cancelRequested), true);
      assert.equal(duringCancel.foregroundActive, 1);
      yield* Queue.offer(terminals, aborted(turnId));
      yield* Fiber.join(fiber);
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 0);
    }),
  ),
);

it.effect("ignores duplicate and late terminals for another execution's lease", () =>
  provideTight(
    Effect.gen(function* () {
      const budget = yield* ConcurrencyBudgetService;
      const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const firstReturned = yield* Deferred.make<void>();
      const first = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:06.000Z",
          },
          sendTurnUntilTerminal(
            startReturnSend(turnId, firstReturned),
            Stream.fromQueue(terminals),
          ),
        ),
      );
      yield* Deferred.await(firstReturned);
      yield* Queue.offer(terminals, completed(turnId));
      yield* Queue.offer(terminals, completed(turnId));
      yield* Fiber.join(first);
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 0);

      const secondReturned = yield* Deferred.make<void>();
      const second = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:07.000Z",
          },
          sendTurnUntilTerminal(
            startReturnSend(otherTurnId, secondReturned),
            Stream.fromQueue(terminals),
          ),
        ),
      );
      yield* Deferred.await(secondReturned);
      yield* Queue.offer(terminals, completed(turnId));
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 1);
      yield* Queue.offer(terminals, completed(otherTurnId));
      yield* Fiber.join(second);
      assert.equal((yield* budget.snapshot(environmentId)).foregroundActive, 0);
    }),
  ),
);

it.effect("preserves execution-tree accounting across failover-retry", () =>
  provideTight(
    Effect.gen(function* () {
      const budget = yield* ConcurrencyBudgetService;
      const parentAdmit = yield* budget.admit({
        workloadClass: "foreground-turn",
        environmentId,
        threadId,
        requestedAt: "2026-10-04T00:00:10.000Z",
      });
      assert.equal(parentAdmit.outcome, "admitted");
      const tree = parentAdmit.lease?.tree;
      assert.equal(tree !== undefined, true);
      const retry = yield* budget.admit({
        workloadClass: "failover-retry",
        environmentId,
        threadId,
        requestedAt: "2026-10-04T00:00:10.100Z",
        ...(tree !== undefined ? { tree } : {}),
      });
      assert.equal(retry.outcome, "admitted");
      assert.equal(retry.lease?.tree.treeId, tree?.treeId);
      assert.equal((retry.lease?.tree.attempt ?? 0) >= (tree?.attempt ?? 0), true);
      const during = yield* budget.snapshot(environmentId);
      assert.equal(during.foregroundActive, 1);
      assert.equal(
        during.classes.some((item) => item.workloadClass === "failover-retry" && item.active === 1),
        true,
      );
      if (parentAdmit.lease !== undefined) {
        yield* budget.release(environmentId, parentAdmit.lease.leaseId);
        yield* budget.release(environmentId, parentAdmit.lease.leaseId);
      }
      if (retry.lease !== undefined) {
        yield* budget.release(environmentId, retry.lease.leaseId);
      }
      const after = yield* budget.snapshot(environmentId);
      assert.equal(
        after.classes.every((item) => item.active === 0),
        true,
      );
    }),
  ),
);

it.effect("releases on bounded timeout when the terminal event never arrives", () =>
  provideTight(
    Effect.gen(function* () {
      const budget = yield* ConcurrencyBudgetService;
      const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const returned = yield* Deferred.make<void>();
      const fiber = yield* forkAdmission(
        budget.withAdmission(
          {
            workloadClass: "foreground-turn",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:11.000Z",
          },
          sendTurnUntilTerminal(startReturnSend(turnId, returned), Stream.fromQueue(terminals), {
            timeout: "20 millis",
          }),
        ),
      );
      yield* Deferred.await(returned);
      yield* TestClock.adjust("20 millis");
      yield* Fiber.join(fiber);
      const after = yield* budget.snapshot(environmentId);
      assert.equal(after.foregroundActive, 0);
    }),
  ),
);

it.effect(
  "shutdown cancels queued work; missing terminals still release on the timeout bound",
  () =>
    provideTight(
      Effect.gen(function* () {
        const budget = yield* ConcurrencyBudgetService;
        const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const returned = yield* Deferred.make<void>();
        const fiber = yield* forkAdmission(
          budget.withAdmission(
            {
              workloadClass: "foreground-turn",
              environmentId,
              threadId,
              requestedAt: "2026-10-04T00:00:12.000Z",
            },
            sendTurnUntilTerminal(startReturnSend(turnId, returned), Stream.fromQueue(terminals), {
              timeout: "50 millis",
            }),
          ),
        );
        yield* Deferred.await(returned);
        const queued = yield* forkAdmission(
          budget.withAdmission(
            {
              workloadClass: "foreground-turn",
              environmentId,
              threadId: ThreadId.make("thread-queued"),
              requestedAt: "2026-10-04T00:00:12.100Z",
            },
            Effect.void,
          ),
        );
        yield* Effect.yieldNow;
        const cancelled = yield* budget.cancelQueuedForThread(
          environmentId,
          ThreadId.make("thread-queued"),
        );
        assert.equal(cancelled >= 0, true);
        yield* budget.shutdown;
        const shutdown = yield* budget.snapshot(environmentId);
        assert.equal(shutdown.queued, 0);
        yield* TestClock.adjust("50 millis");
        yield* Fiber.join(fiber);
        yield* Fiber.interrupt(queued);
        const after = yield* budget.snapshot(environmentId);
        assert.equal(after.foregroundActive, 0);
      }),
    ),
);
