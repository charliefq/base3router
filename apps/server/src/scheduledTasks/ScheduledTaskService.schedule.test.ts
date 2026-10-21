import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "web",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      // Cross the due time before the scheduler's first five-second tick.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "persists a lost dispatch acknowledgement as UNKNOWN across restart without resending",
  () =>
    Effect.gen(function* () {
      let dispatches = 0;
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Effect.sync(() => {
              dispatches += 1;
            }).pipe(Effect.andThen(Effect.die("lost acknowledgement"))),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      );
      const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
      const first = yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* tasks.upsert(
          yield* decodeUpsertInput({
            id: "scheduled-task:lost-ack",
            title: "Audit",
            prompt: "Review",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "project:test",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "fake" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        const result = (yield* tasks.runNow({ id: task.id })).task;
        expect(result.lastOccurrence?.status).toBe("unknown");
        expect(result.lastRunStatus).toBe("running");
        expect(result.runCount).toBe(1);
        return result;
      }).pipe(Effect.provide(serviceLayer));
      yield* TestClock.adjust("2 minutes");
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const result = (yield* tasks.list()).tasks[0]!;
        expect(result.lastOccurrence?.id).toBe(first.lastOccurrence?.id);
        expect(result.lastOccurrence?.status).toBe("unknown");
        expect(result.lastRunError).toContain("UNKNOWN");
        expect(result.runCount).toBe(1);
        // The due-work selector is the real scheduler admission boundary.
        expect(yield* ScheduledTaskService.listDueTasks(yield* DateTime.now)).toEqual([]);
        expect(dispatches).toBe(1);
      }).pipe(Effect.provide(Layer.fresh(serviceLayer)));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
