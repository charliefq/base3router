import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    Layer.mock(Launch.ThreadLaunchService)({}),
    Layer.mock(Management.ThreadManagementService)({}),
  );
  const runtime = ManagedRuntime.make(
    Schedules.layer.pipe(Layer.provide(dependencies), Layer.provideMerge(SqlitePersistenceMemory)),
  );
  const service = runtime.runPromise(Schedules.ScheduledTaskService);
  return {
    upsert: async (input: ScheduledTaskUpsertInput) =>
      runtime.runPromise((await service).upsert(input)),
    list: async () => runtime.runPromise((await service).list()),
    delete: async (input: ScheduledTaskDeleteInput) =>
      runtime.runPromise((await service).delete(input)),
    dispose: () => runtime.dispose(),
  };
}
