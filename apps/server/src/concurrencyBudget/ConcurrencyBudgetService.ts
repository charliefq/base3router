import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ConcurrencyBudgetError,
  EnvironmentId,
  defaultConcurrencyBudgetPolicy,
  type ConcurrencyAdmissionRequestV0,
  type ConcurrencyAdmissionResultV0,
  type ConcurrencyGovernanceSnapshotV0,
  type LeaseId,
} from "@t3tools/contracts";
import { ConcurrencyScheduler } from "@t3tools/shared/concurrencyBudget";

export class ConcurrencyBudgetService extends Context.Service<
  ConcurrencyBudgetService,
  {
    readonly admit: (
      request: ConcurrencyAdmissionRequestV0,
    ) => Effect.Effect<ConcurrencyAdmissionResultV0, ConcurrencyBudgetError>;
    readonly withAdmission: <A, E, R>(
      request: ConcurrencyAdmissionRequestV0,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ConcurrencyBudgetError, R>;
    readonly release: (environmentId: EnvironmentId, leaseId: LeaseId) => Effect.Effect<void>;
    readonly snapshot: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ConcurrencyGovernanceSnapshotV0>;
    readonly shutdown: Effect.Effect<void>;
  }
>()("t3/concurrencyBudget/ConcurrencyBudgetService") {}

const outcomeError = (result: ConcurrencyAdmissionResultV0): ConcurrencyBudgetError =>
  new ConcurrencyBudgetError({
    reason:
      result.outcome === "timed-out"
        ? "timed-out"
        : result.outcome === "cancelled"
          ? "cancelled"
          : result.reasonCodes.includes("SHUTDOWN")
            ? "shutdown"
            : "rejected",
    detail: result.explanation,
    reasonCodes: [...result.reasonCodes],
  });

const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const schedulers = yield* Ref.make(new Map<string, ConcurrencyScheduler>());

  const schedulerClock = {
    nowMs: () => clock.currentTimeMillisUnsafe(),
    nowIso: () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
  };

  const schedulerFor = (environmentId: EnvironmentId): Effect.Effect<ConcurrencyScheduler> =>
    Ref.modify(schedulers, (current) => {
      const existing = current.get(environmentId);
      if (existing !== undefined) return [existing, current] as const;
      const created = new ConcurrencyScheduler({
        environmentId,
        policy: defaultConcurrencyBudgetPolicy(),
        clock: schedulerClock,
      });
      const next = new Map(current);
      next.set(environmentId, created);
      return [created, next] as const;
    });

  const awaitQueued = (
    scheduler: ConcurrencyScheduler,
    queued: ConcurrencyAdmissionResultV0,
  ): Effect.Effect<ConcurrencyAdmissionResultV0> => {
    const timeoutMs = scheduler.policy.classes[queued.workloadClass].maxQueueTimeMs;
    const timeoutResult: ConcurrencyAdmissionResultV0 = {
      outcome: "timed-out",
      admissionId: queued.admissionId,
      workloadClass: queued.workloadClass,
      queuedMs: timeoutMs,
      reasonCodes: ["QUEUE_TIMEOUT"],
      explanation: "Queued work exceeded the wait budget.",
    };
    return Effect.gen(function* () {
      const deferred = yield* Deferred.make<ConcurrencyAdmissionResultV0>();
      const attached = scheduler.attachWaiter(queued.admissionId, {
        resolve: (result) => {
          Deferred.doneUnsafe(deferred, Effect.succeed(result));
        },
      });
      if (!attached) return timeoutResult;
      const wait = Deferred.await(deferred);
      if (timeoutMs <= 0) return yield* wait;
      return yield* wait.pipe(
        Effect.timeoutOrElse({
          duration: `${timeoutMs} millis`,
          orElse: () =>
            Effect.sync(() => {
              scheduler.tick();
              Deferred.doneUnsafe(deferred, Effect.succeed(timeoutResult));
            }).pipe(Effect.andThen(Deferred.await(deferred))),
        }),
      );
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          scheduler.cancel(queued.admissionId);
        }),
      ),
    );
  };

  const admit = (
    request: ConcurrencyAdmissionRequestV0,
  ): Effect.Effect<ConcurrencyAdmissionResultV0, ConcurrencyBudgetError> =>
    Effect.gen(function* () {
      const scheduler = yield* schedulerFor(request.environmentId);
      const immediate = scheduler.admit(request);
      if (immediate.outcome === "admitted") return immediate;
      if (immediate.outcome !== "queued") return yield* outcomeError(immediate);
      const waited = yield* awaitQueued(scheduler, immediate);
      if (waited.outcome === "admitted") return waited;
      return yield* outcomeError(waited);
    });

  const withAdmission = <A, E, R>(
    request: ConcurrencyAdmissionRequestV0,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ConcurrencyBudgetError, R> =>
    Effect.flatMap(admit(request), (result): Effect.Effect<A, E | ConcurrencyBudgetError, R> => {
      const leaseId = result.lease?.leaseId;
      if (leaseId === undefined) {
        return new ConcurrencyBudgetError({
          reason: "invalid",
          detail: "Admission succeeded without a lease.",
          reasonCodes: ["CAPACITY_EXHAUSTED"],
        });
      }
      return effect.pipe(
        Effect.ensuring(
          schedulerFor(request.environmentId).pipe(
            Effect.map((scheduler) => scheduler.release(leaseId)),
            Effect.asVoid,
          ),
        ),
      );
    });

  const snapshot = (environmentId: EnvironmentId): Effect.Effect<ConcurrencyGovernanceSnapshotV0> =>
    schedulerFor(environmentId).pipe(Effect.map((scheduler) => scheduler.snapshot()));

  const release = (environmentId: EnvironmentId, leaseId: LeaseId): Effect.Effect<void> =>
    schedulerFor(environmentId).pipe(
      Effect.map((scheduler) => scheduler.release(leaseId)),
      Effect.asVoid,
    );

  const shutdown: Effect.Effect<void> = Ref.get(schedulers).pipe(
    Effect.map((current) => {
      for (const scheduler of current.values()) scheduler.shutdownNow();
    }),
  );

  yield* Effect.addFinalizer(() => shutdown);

  return {
    admit,
    withAdmission,
    release,
    snapshot,
    shutdown,
  } satisfies ConcurrencyBudgetService["Service"];
});

export const layer = Layer.effect(ConcurrencyBudgetService, make);
