import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { ScheduledTaskUpsertInput, ScheduledTaskDeleteInput } from "@t3tools/contracts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Launch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Management from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Schedules from "../ScheduledTaskService.ts";

/** Disposable real service for mounted client tests; no provider implementation is installed. */
export function createFixture() {
  let tick = Effect.void;
  let dispatches = 0;
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(Scheduler.Scheduler, {
      register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          tick = work.pipe(Effect.provideContext(context), Effect.orDie);
        }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: () =>
        Effect.sync(() => {
          dispatches++;
          throw new Error("Unexpected fixture dispatch");
        }),
    }),
    Layer.mock(Management.ThreadManagementService)({
      sendToThread: () =>
        Effect.sync(() => {
          dispatches++;
          throw new Error("Unexpected fixture dispatch");
        }),
    }),
  );
  const runtime = ManagedRuntime.make(
    Schedules.layer.pipe(
      Layer.provide(dependencies),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  const service = runtime.runPromise(Schedules.ScheduledTaskService);
  return {
    upsert: async (input: ScheduledTaskUpsertInput) =>
      runtime.runPromise((await service).upsert(input)),
    list: async () => runtime.runPromise((await service).list()),
    delete: async (input: ScheduledTaskDeleteInput) =>
      runtime.runPromise((await service).delete(input)),
    setEnabled: async (input: {
      id: import("@t3tools/contracts").ScheduledTaskId;
      enabled: boolean;
    }) => runtime.runPromise((await service).setEnabled(input)),
    advance: async (ms: number) => {
      await service;
      await runtime.runPromise(TestClock.adjust(ms));
      await runtime.runPromise(tick);
      return dispatches;
    },
    dispose: () => runtime.dispose(),
  };
}
