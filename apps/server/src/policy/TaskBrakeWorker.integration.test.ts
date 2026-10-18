import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as TaskBrakeWorker from "./TaskBrakeWorker.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { authorizeDispatch } from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import { runOrderedV2StartupPhases } from "../serverRuntimeStartup.ts";
import {
  makeTaskBrakeFixture,
  seedSilentTask,
  startWatchdogRuntime,
  stopWatchdogRuntime,
  ingestionLayer,
  confirmTerminal,
} from "./testkit/taskBrakeWorkerFixture.ts";

const withFixture = <A, E, R>(
  check: (
    fixture: Effect.Success<ReturnType<typeof makeTaskBrakeFixture>>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeTaskBrakeFixture();
      return yield* check(fixture).pipe(
        Effect.provide(Layer.provideMerge(ingestionLayer, fixture.dependencies)),
      );
    }),
  );
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const makeProducer = Effect.fn("makeDeadlineProducer")(function* (
  sql: SqlClient.SqlClient,
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  scheduler: Scheduler.Scheduler["Service"],
) {
  const context = yield* Layer.build(
    Layer.fresh(TaskBrakeWorker.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
          Layer.succeed(Scheduler.Scheduler, scheduler),
        ),
      ),
    ),
  );
  return Context.get(context, TaskBrakeWorker.TaskBrakeWorker);
});

it.effect(
  "interrupts a silent overdue task through Scheduler, durable outbox, worker and the live fake adapter",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeTaskBrakeFixture();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const seed = yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10.000Z" });
          const before = yield* sql`SELECT COUNT(*) AS n FROM task_contract_admissions`;
          const usageBefore = yield* sql`SELECT * FROM task_usage_attempts`;
          const runtime = yield* startWatchdogRuntime;
          yield* TestClock.adjust("5 seconds");
          expect(yield* Ref.get(fixture.calls)).toEqual([]);
          yield* TestClock.adjust("5 seconds");
          // No work/message/usage receipt is injected to wake the producer or the consumer.
          expect({
            bounds: yield* sql`SELECT deadline_at FROM task_contract_deadlines`,
            leases: yield* sql`SELECT interrupt_requested, released_at FROM base3_capacity_leases`,
            effects: yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`,
          }).toEqual({
            bounds: [{ deadline_at: "1970-01-01T00:00:10.000Z" }],
            leases: [{ interrupt_requested: 1, released_at: null }],
            effects: [{ effect_id: `effect:task-contract-cancel:${seed.turnId}` }],
          });
          yield* Queue.take(fixture.receipts);
          yield* Queue.take(runtime.settled);
          expect(yield* sql`SELECT status, last_error FROM orchestration_v2_effect_outbox`).toEqual(
            [{ status: "succeeded", last_error: null }],
          );
          expect(yield* Ref.get(fixture.calls)).toEqual([
            {
              sessionId: seed.sessionId,
              providerThreadId: seed.nativeThreadId,
              providerTurnId: seed.turnId,
            },
          ]);
          expect(yield* sql`SELECT status FROM orchestration_v2_effect_outbox`).toEqual([
            { status: "succeeded" },
          ]);
          expect(
            yield* sql`SELECT interrupt_requested, released_at FROM base3_capacity_leases`,
          ).toEqual([{ interrupt_requested: 1, released_at: null }]);
          expect(yield* sql`SELECT COUNT(*) AS n FROM task_contract_admissions`).toEqual(before);
          expect(yield* sql`SELECT * FROM task_usage_attempts`).toEqual(usageBefore);
        }).pipe(Effect.provide(fixture.dependencies));
      }),
    ),
);

it.effect.each([
  "ordinary chat",
  "no deadline",
  "not due",
  "released lease",
  "terminal turn",
] as const)("does not interrupt %s", (scenario) =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const seed = yield* seedSilentTask({
        ...(scenario === "ordinary chat" ? { governance: "chat" as const } : {}),
        ...(scenario === "no deadline"
          ? {}
          : {
              deadlineAt: scenario === "not due" ? "1970-01-01T00:01:00Z" : "1970-01-01T00:00:10Z",
            }),
      });
      if (scenario === "released lease" || scenario === "terminal turn") {
        yield* confirmTerminal(seed);
        const released = yield* sql<{
          released_at: string | null;
        }>`SELECT released_at FROM base3_capacity_leases`;
        expect(released[0]?.released_at).not.toBeNull();
      }
      if (scenario === "terminal turn")
        yield* sql`UPDATE base3_capacity_leases SET released_at = NULL, status = 'active'`;
      const baseline = yield* sql`SELECT COUNT(*) AS n FROM task_contract_admissions`;
      yield* startWatchdogRuntime;
      yield* TestClock.adjust("15 seconds");
      expect(yield* Ref.get(fixture.calls)).toEqual([]);
      expect(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).toEqual([]);
      expect(yield* sql`SELECT COUNT(*) AS n FROM task_contract_admissions`).toEqual(baseline);
    }),
  ),
);

it.effect.each(["later payload", "omitted deadline", "paused"] as const)(
  "uses the frozen deadline despite %s",
  (scenario) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const seed = yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
        const original = seed.thread.taskContract!;
        const { deadlineAt: _deadlineAt, ...brake } = original.brake;
        const updated = {
          ...seed.thread,
          taskContractPhase: scenario === "paused" ? ("redirected" as const) : ("active" as const),
          taskContract: {
            ...original,
            brake:
              scenario === "omitted deadline"
                ? brake
                : { ...brake, deadlineAt: "2099-01-01T00:00:00Z" },
          },
        };
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${yield* encodeThread(updated)} WHERE thread_id = ${seed.threadId}`;
        const runtime = yield* startWatchdogRuntime;
        yield* TestClock.adjust("10 seconds");
        yield* Queue.take(fixture.receipts);
        yield* Queue.take(runtime.settled);
        expect(yield* Ref.get(fixture.calls)).toHaveLength(1);
        expect(yield* sql`SELECT deadline_at FROM task_contract_deadlines`).toEqual([
          { deadline_at: "1970-01-01T00:00:10.000Z" },
        ]);
        expect(yield* sql`SELECT released_at FROM base3_capacity_leases`).toEqual([
          { released_at: null },
        ]);
      }),
    ),
);

it.effect(
  "keeps a delivered cancellation leased until an ingested provider terminal confirmation",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const seed = yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
        const runtime = yield* startWatchdogRuntime;
        yield* TestClock.adjust("10 seconds");
        yield* Queue.take(fixture.receipts);
        yield* Queue.take(runtime.settled);
        expect(yield* sql`SELECT status FROM orchestration_v2_effect_outbox`).toEqual([
          { status: "succeeded" },
        ]);
        expect(yield* sql`SELECT released_at FROM base3_capacity_leases`).toEqual([
          { released_at: null },
        ]);
        yield* confirmTerminal(seed);
        const lease = yield* sql<{
          released_at: string | null;
        }>`SELECT released_at FROM base3_capacity_leases`;
        expect(lease[0]?.released_at).not.toBeNull();
        yield* TestClock.adjust("15 seconds");
        expect(yield* Ref.get(fixture.calls)).toHaveLength(1);
      }),
    ),
);

it.effect("does not release an occupied lease when the adapter session is missing", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z", liveSession: false });
      yield* sql`UPDATE base3_capacity_leases SET disconnect_unconfirmed = 1`;
      const runtime = yield* startWatchdogRuntime;
      yield* TestClock.adjust("10 seconds");
      yield* Queue.take(runtime.settled);
      expect(yield* Ref.get(fixture.calls)).toEqual([]);
      const effects = yield* sql<{
        status: string;
        last_error: string;
      }>`SELECT status,last_error FROM orchestration_v2_effect_outbox`;
      expect(effects[0]?.status).toBe("pending");
      expect(effects[0]?.last_error).toContain("Native termination is unconfirmed");
      expect(
        yield* sql`SELECT released_at, disconnect_unconfirmed FROM base3_capacity_leases`,
      ).toEqual([{ released_at: null, disconnect_unconfirmed: 1 }]);
      yield* TestClock.adjust("15 seconds");
      expect(yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox`).toEqual([
        { n: 1 },
      ]);
    }),
  ),
);

it.effect(
  "stops scanning when the worker scope closes while another scheduler source continues",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
        const scheduler = yield* Scheduler.Scheduler;
        const other = yield* Ref.make(0);
        yield* scheduler.register(
          "unrelated source",
          Ref.update(other, (n) => n + 1),
        );
        const runtime = yield* startWatchdogRuntime;
        yield* TestClock.adjust("5 seconds");
        yield* stopWatchdogRuntime(runtime);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
        expect(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).toEqual([]);
        expect(yield* Ref.get(other)).toBeGreaterThan(1);
      }),
    ),
);

it.effect(
  "rolls back a failed cancellation transaction without notifying and succeeds next period",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const scheduler = yield* Scheduler.Scheduler;
        yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
        yield* sql`CREATE TEMP TRIGGER fail_cancel BEFORE INSERT ON orchestration_v2_effect_outbox
      WHEN NEW.effect_type = 'provider-turn.interrupt'
      BEGIN SELECT RAISE(ABORT, 'injected cancellation write failure'); END`;
        const failed = yield* Deferred.make<void>();
        const notifications = yield* Ref.make(0);
        const observedSql = new Proxy(sql, {
          get: (target, key, receiver) =>
            key === "withTransaction"
              ? <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  target
                    .withTransaction(effect)
                    .pipe(Effect.onError(() => Deferred.succeed(failed, undefined)))
              : Reflect.get(target, key, receiver),
        });
        const producer = yield* makeProducer(
          observedSql,
          {
            ...outbox,
            notifyAvailable: (count) =>
              Ref.update(notifications, (n) => n + (count ?? 1)).pipe(
                Effect.andThen(outbox.notifyAvailable(count)),
              ),
          },
          scheduler,
        );
        const runtime = yield* startWatchdogRuntime.pipe(
          Effect.provideService(TaskBrakeWorker.TaskBrakeWorker, producer),
        );
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(failed);
        expect(
          yield* sql`SELECT interrupt_requested, released_at FROM base3_capacity_leases`,
        ).toEqual([{ interrupt_requested: 0, released_at: null }]);
        expect(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).toEqual([]);
        expect(yield* Ref.get(notifications)).toBe(0);
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
        yield* sql`DROP TRIGGER fail_cancel`;
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(fixture.receipts);
        yield* Queue.take(runtime.settled);
        expect(yield* Ref.get(notifications)).toBe(1);
        expect(yield* sql`SELECT status FROM orchestration_v2_effect_outbox`).toEqual([
          { status: "succeeded" },
        ]);
      }),
    ),
);

it.effect.each(["release", "close"] as const)(
  "does not overlap a slow scan or block another source, then %s",
  (scenario) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const scheduler = yield* Scheduler.Scheduler;
        yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const scans = yield* Ref.make(0);
        const other = yield* Ref.make(0);
        // Delay only the I/O boundary; the scanner, scheduler and eventual SQL work remain real.
        const delayedSql = new Proxy(sql, {
          get: (target, key, receiver) =>
            key === "withTransaction"
              ? <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  Ref.update(scans, (n) => n + 1).pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(target.withTransaction(effect)),
                  )
              : Reflect.get(target, key, receiver),
        });
        const producer = yield* makeProducer(delayedSql, outbox, scheduler);
        yield* scheduler.register(
          "unrelated slow-scan peer",
          Ref.update(other, (n) => n + 1),
        );
        const runtime = yield* startWatchdogRuntime.pipe(
          Effect.provideService(TaskBrakeWorker.TaskBrakeWorker, producer),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Ref.get(scans)).toBe(1);
        expect(yield* Ref.get(other)).toBeGreaterThan(1);
        if (scenario === "close") yield* stopWatchdogRuntime(runtime);
        yield* Deferred.succeed(release, undefined);
        if (scenario === "release") {
          yield* Queue.take(fixture.receipts);
          yield* Queue.take(runtime.settled);
          expect(yield* Ref.get(fixture.calls)).toHaveLength(1);
        } else {
          yield* TestClock.adjust("10 seconds");
          expect(yield* Ref.get(fixture.calls)).toEqual([]);
          expect(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).toEqual([]);
          expect(yield* Ref.get(scans)).toBe(1);
        }
      }),
    ),
);

it.effect(
  "two SQLite producers and concurrent consumption keep one committed turn cancellation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "deadline-two-connections-",
        });
        const dbPath = path.join(directory, "state.sqlite");
        const fixture = yield* makeTaskBrakeFixture({ dbPath });
        yield* Effect.gen(function* () {
          const sqlA = yield* SqlClient.SqlClient;
          const seed = yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
          const secondContext = yield* Layer.build(
            makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
          );
          const sqlB = Context.get(secondContext, SqlClient.SqlClient);
          expect(sqlA).not.toBe(sqlB);
          const outbox = yield* EffectOutbox.EffectOutboxV2,
            scheduler = yield* Scheduler.Scheduler;
          const notifications = yield* Ref.make(0);
          const observing = (
            other: SqlClient.SqlClient,
          ): EffectOutbox.EffectOutboxV2["Service"] => ({
            ...outbox,
            notifyAvailable: (count) =>
              Effect.gen(function* () {
                // A different connection cannot see an uncommitted cancellation.
                expect(yield* other`SELECT effect_id FROM orchestration_v2_effect_outbox`).toEqual([
                  { effect_id: `effect:task-contract-cancel:${seed.turnId}` },
                ]);
                yield* Ref.update(notifications, (n) => n + (count ?? 1));
                yield* outbox.notifyAvailable(count);
              }).pipe(Effect.orDie),
          });
          const producerA = yield* makeProducer(sqlA, observing(sqlB), scheduler);
          const producerB = yield* makeProducer(sqlB, observing(sqlA), scheduler);
          const baseline = yield* sqlA`SELECT COUNT(*) AS n FROM task_contract_admissions`;
          const runtime = yield* startWatchdogRuntime.pipe(
            Effect.provideService(TaskBrakeWorker.TaskBrakeWorker, producerA),
          );
          yield* producerB.run.pipe(Effect.forkScoped);
          yield* TestClock.adjust("10 seconds");
          yield* Queue.take(fixture.receipts);
          yield* Queue.take(runtime.settled);
          yield* TestClock.adjust("15 seconds");
          expect(
            yield* sqlA`SELECT effect_id, status, attempt_count FROM orchestration_v2_effect_outbox`,
          ).toEqual([
            {
              effect_id: `effect:task-contract-cancel:${seed.turnId}`,
              status: "succeeded",
              attempt_count: 1,
            },
          ]);
          expect(yield* Ref.get(fixture.calls)).toHaveLength(1);
          expect(yield* Ref.get(notifications)).toBe(1);
          expect(yield* sqlA`SELECT COUNT(*) AS n FROM task_contract_admissions`).toEqual(baseline);
        }).pipe(Effect.provide(fixture.dependencies));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "restart retires an old process interrupt before scanning and never restores its session or deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "deadline-restart-" });
        const dbPath = path.join(directory, "state.sqlite");
        const first = yield* makeTaskBrakeFixture({ dbPath });
        const seed = yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const seeded = yield* seedSilentTask({ deadlineAt: "1970-01-01T00:00:10Z" });
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const watcher = yield* TaskBrakeWorker.TaskBrakeWorker;
            yield* watcher.run.pipe(Effect.forkScoped);
            yield* TestClock.adjust("10 seconds");
            yield* outbox.awaitAvailable;
            expect(yield* sql`SELECT status FROM orchestration_v2_effect_outbox`).toEqual([
              { status: "pending" },
            ]);
            expect(yield* Ref.get(first.calls)).toEqual([]);
            return seeded;
          }).pipe(Effect.provide(first.dependencies)),
        );
        const second = yield* makeTaskBrakeFixture({ dbPath });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const recovery = yield* RuntimeRecovery.ProviderRuntimeRecoveryService;
          yield* runOrderedV2StartupPhases({
            importLegacyShells: Effect.void,
            recover: recovery.recover,
            startEffectWorker: startWatchdogRuntime.pipe(Effect.asVoid),
            autoBootstrap: Effect.void,
          });
          yield* TestClock.adjust("15 seconds");
          expect(yield* Ref.get(second.calls)).toEqual([]);
          expect(
            yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).get(seed.sessionId),
          ).toEqual(Option.none());
          expect(yield* sql`SELECT status FROM orchestration_v2_effect_outbox`).toEqual([
            { status: "cancelled" },
          ]);
          expect(yield* sql`SELECT deadline_at FROM task_contract_deadlines`).toEqual([
            { deadline_at: "1970-01-01T00:00:10.000Z" },
          ]);
          expect(yield* sql`SELECT released_at FROM base3_capacity_leases`).toEqual([
            { released_at: null },
          ]);
          const denied = yield* authorizeDispatch({
            type: "message.dispatch",
            commandId: "restart-new-input",
            threadId: seed.threadId,
            messageId: "restart-new-message",
            text: "Try again",
            attachments: [],
            modelSelection: seed.thread.modelSelection,
            routingMode: "manual",
            dispatchMode: { type: "start_immediately" },
          }).pipe(
            Effect.provideService(PolicyExecutionContext, {
              kind: "session",
              actorId: "deadline-owner",
              sessionId: "owner-session",
              scopes: ["orchestration:operate"],
            }),
            Effect.flip,
          );
          expect(denied.message).toMatch(/deadline|Absolute/i);
          expect(yield* Ref.get(second.calls)).toEqual([]);
        }).pipe(Effect.provide(second.dependencies));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
