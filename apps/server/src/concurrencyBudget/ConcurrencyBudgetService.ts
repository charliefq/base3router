import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ConcurrencyBudgetError,
  EnvironmentId,
  MODEL_ROUTER_UNKNOWN_METRIC,
  defaultConcurrencyBudgetPolicy,
  type ConcurrencyAdmissionRequestV0,
  type ConcurrencyAdmissionResultV0,
  type ConcurrencyGovernanceSnapshotV0,
  type ConcurrencyWorkloadClass,
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
  const schedulers = yield* Ref.make(new Map<string, ConcurrencyScheduler>());

  const schedulerFor = (environmentId: EnvironmentId) =>
    Ref.modify(schedulers, (current) => {
      const existing = current.get(environmentId);
      if (existing !== undefined) return [existing, current] as const;
      const created = new ConcurrencyScheduler({
        environmentId,
        policy: defaultConcurrencyBudgetPolicy(),
        clock: {
          nowMs: () => Date.now(),
          nowIso: () => new Date().toISOString(),
        },
      });
      const next = new Map(current);
      next.set(environmentId, created);
      return [created, next] as const;
    });

  const admit: ConcurrencyBudgetService["Service"]["admit"] = (request) =>
    Effect.gen(function* () {
      const scheduler = yield* schedulerFor(request.environmentId);
      const immediate = scheduler.admit(request);
      if (immediate.outcome !== "queued") {
        return immediate.outcome === "admitted" ? immediate : yield* outcomeError(immediate);
      }
      const timeoutMs = scheduler.policy.classes[request.workloadClass].maxQueueTimeMs;
      const waited = yield* Effect.async<ConcurrencyAdmissionResultV0>((resume) => {
        const handle =
          timeoutMs > 0
            ? setTimeout(() => {
                scheduler.tick();
              }, timeoutMs)
            : undefined;
        const attached = scheduler.attachWaiter(immediate.admissionId, {
          resolve: (result) => {
            if (handle !== undefined) clearTimeout(handle);
            resume(Effect.succeed(result));
          },
        });
        if (!attached) {
          if (handle !== undefined) clearTimeout(handle);
          resume(Effect.succeed(immediate));
          return;
        }
        return Effect.sync(() => {
          if (handle !== undefined) clearTimeout(handle);
          scheduler.cancel(immediate.admissionId);
        });
      });
      return waited.outcome === "admitted" ? waited : yield* outcomeError(waited);
    });

  const withAdmission: ConcurrencyBudgetService["Service"]["withAdmission"] = (request, effect) =>
    admit(request).pipe(
      Effect.flatMap((result) => {
        const leaseId = result.lease?.leaseId;
        if (leaseId === undefined) {
          return Effect.fail(
            new ConcurrencyBudgetError({
              reason: "invalid",
              detail: "Admission succeeded without a lease.",
              reasonCodes: ["CAPACITY_EXHAUSTED"],
            }),
          );
        }
        return effect.pipe(
          Effect.ensuring(
            schedulerFor(request.environmentId).pipe(
              Effect.map((scheduler) => scheduler.release(leaseId)),
              Effect.asVoid,
            ),
          ),
        );
      }),
    );

  const snapshot: ConcurrencyBudgetService["Service"]["snapshot"] = (environmentId) =>
    schedulerFor(environmentId).pipe(Effect.map((scheduler) => scheduler.snapshot()));

  const release: ConcurrencyBudgetService["Service"]["release"] = (environmentId, leaseId) =>
    schedulerFor(environmentId).pipe(
      Effect.map((scheduler) => scheduler.release(leaseId)),
      Effect.asVoid,
    );

  const shutdown: ConcurrencyBudgetService["Service"]["shutdown"] = Ref.get(schedulers).pipe(
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

export const layer = Layer.scoped(ConcurrencyBudgetService, make);

export const layerTest = Layer.scoped(ConcurrencyBudgetService, make);

export const shedIfRejected = (
  result: ConcurrencyAdmissionResultV0,
  workloadClass: ConcurrencyWorkloadClass,
): boolean =>
  result.outcome === "rejected" &&
  (workloadClass === "dream-job" ||
    workloadClass === "openrouter-shadow" ||
    workloadClass === "detached-background");

export const emptyConcurrencySnapshot = (
  environmentId: EnvironmentId,
): ConcurrencyGovernanceSnapshotV0 => ({
  environmentId,
  policyVersion: "concurrency-budget.v0",
  topology: "process-local",
  saturation: "idle",
  foregroundActive: 0,
  backgroundActive: 0,
  queued: 0,
  reservedForegroundFree: 1,
  classes: [],
  knownCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
  cancelledCount: 0,
  rejectedCount: 0,
});
