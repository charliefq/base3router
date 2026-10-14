import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { evaluatePersistedBrakes } from "./TaskContract.ts";

export class TaskBrakeWorker extends Context.Service<
  TaskBrakeWorker,
  { readonly run: Effect.Effect<void> }
>()("t3/policy/TaskBrakeWorker") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const scheduler = yield* Scheduler.Scheduler;
  const sweep = Effect.fn("TaskBrakeWorker.sweep")(function* () {
    const inserted = yield* sql.withTransaction(evaluatePersistedBrakes(sql));
    // Only the committed producer can notify the exact consumer instance.
    // A failed transaction leaves no lease flag, cancellation row, or wake-up.
    if (inserted.length > 0) yield* outbox.notifyAvailable(inserted.length);
  });
  return TaskBrakeWorker.of({
    // Construction does not scan: startup must finish process-loss recovery first.
    run: Effect.scoped(
      scheduler.register("task-contract-brakes", sweep()).pipe(Effect.andThen(Effect.never)),
    ),
  });
});
export const layer = Layer.effect(TaskBrakeWorker, make);
