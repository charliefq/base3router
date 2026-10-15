import { RunId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import {
  NodeId,
  ProviderThreadId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as Queue from "effect/Queue";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { CommandId, MessageId, EventId, RunAttemptId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CollaborationTaskResultReadout } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

const decodePhysicalAttempt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ providerTurnId: Schema.String })),
);

it.live.each([
  { driver: "codex", runningFirst: false, appThread: false, enrichNative: false },
  { driver: "codex", runningFirst: true, appThread: true, enrichNative: false },
  { driver: "claudeAgent", runningFirst: false, appThread: true, enrichNative: true },
  { driver: "claudeAgent", runningFirst: true, appThread: false, enrichNative: true },
])("result linkage public disk output $driver runningFirst=$runningFirst", (config) =>
  withTaskResultLinkageFixture(
    (f) =>
      Effect.gen(function* () {
        const c = yield* f.createTask(`linkage-${config.driver}-${config.runningFirst}`);
        const initial = (yield* f.readSnapshot()).tasks[0]!;
        yield* f.execute(c, `message:${c.threadId}`);
        const snapshot = yield* f.readSnapshot();
        const task = snapshot.tasks.find((t) => t.threadId === c.threadId)!;
        const result = task.resultReadout;
        assert.equal(result?.status, "available");
        if (result?.status !== "available") throw new Error("Unavailable readout");
        assert.equal(result.content.status, "output");
        if (result.content.status !== "output") throw new Error("No linked output");
        const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
        const run = projection.runs.find((r) => r.id === result.runId)!;
        const attempt = projection.attempts.find((a) => a.id === result.attemptId)!;
        const turn = projection.providerTurns.find((t) => t.id === result.providerTurnId)!;
        assert.equal(run.userMessageId, result.messageId);
        assert.equal(run.activeAttemptId, attempt.id);
        assert.equal(attempt.providerTurnId, turn.id);
        assert.equal(turn.runAttemptId, attempt.id);
        assert.equal(turn.nodeId, run.rootNodeId);
        assert.equal(turn.providerThreadId, run.providerThreadId);
        const itemId = result.content.itemId;
        const item = projection.turnItems.find((i) => i.id === itemId)!;
        assert.equal(item.type, "assistant_message");
        if (item.type !== "assistant_message") throw new Error("No assistant item");
        assert.equal(item.runId, run.id);
        assert.equal(item.providerTurnId, turn.id);
        assert.equal(item.parentItemId, null);
        assert.equal(item.text, `Linked task output [run=${run.id}; attempt=${attempt.id}]`);
        assert.equal(result.content.preview, item.text);
        const node = projection.nodes.find((n) => n.id === item.nodeId)!;
        assert.equal(node.runId, run.id);
        assert.equal(node.parentNodeId, run.rootNodeId);
        assert.equal(node.providerTurnId, turn.id);
        assert.deepEqual(node.nativeItemRef, item.nativeItemRef);
        const rows = yield* f.sql<{
          provider_turn_id: string | null;
          payload_json: string;
        }>`SELECT provider_turn_id,payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=${attempt.id}`;
        assert.equal(rows[0]!.provider_turn_id, turn.id);
        const persisted = yield* decodePhysicalAttempt(rows[0]!.payload_json);
        assert.equal(persisted.providerTurnId, turn.id);
        if (config.enrichNative)
          assert.equal(turn.nativeTurnRef?.nativeId, `enriched:${attempt.id}`);
        assert.deepEqual(
          task.contractReadout,
          initial.contractReadout,
          "output never accepts a task contract",
        );
        const before = yield* f.sql`SELECT total_changes() AS n`;
        assert.deepEqual(
          (yield* f.readSnapshot()).tasks.find((t) => t.id === task.id)?.resultReadout,
          result,
        );
        assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, before);
        assert.equal((yield* Ref.get(f.started)).length, 1);
      }),
    { ...config, driver: ProviderDriverKind.make(config.driver) },
  ),
);

it.live(
  "result linkage running observation and duplicate enrichment never pretend completion",
  () =>
    Effect.gen(function* () {
      const runningCommitted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const c = yield* f.createTask("linkage-running");
            const finished = yield* f.execute(c, "linkage-running-message").pipe(Effect.forkScoped);
            yield* Deferred.await(runningCommitted);
            const during = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
            assert.equal(during?.status, "available");
            if (during?.status !== "available") throw new Error("Missing running readout");
            assert.equal(during.runStatus, "running");
            assert.equal(during.providerTurnStatus, "running");
            assert.equal(during.content.status, "unknown");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(finished);
            const after = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
            assert.equal(after?.status === "available" && after.content.status, "output");
            const events =
              yield* f.sql`SELECT event_type FROM orchestration_events WHERE event_type='run-attempt.updated' AND payload_json LIKE '%providerTurnId%'`;
            assert.isAtLeast(events.length, 2);
            const checkpoints =
              yield* f.sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture'`;
            assert.equal(checkpoints.length, 1);
            assert.equal((yield* Ref.get(f.started)).length, 1);
          }),
        {
          runningFirst: true,
          onStart: (_input, events, emit) =>
            Effect.gen(function* () {
              yield* emit(events[0]!);
              yield* emit(events[0]!); // same internal ID, same ownership
              yield* Deferred.await(release);
              yield* Effect.forEach(events.slice(1), emit, { discard: true });
            }),
          decorateEventSink: (service) => ({
            ...service,
            writeIfRunCurrent: (input) =>
              service
                .writeIfRunCurrent(input)
                .pipe(
                  Effect.tap((result) =>
                    result.committed &&
                    input.events.some(
                      (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
                    )
                      ? Deferred.succeed(runningCommitted, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
          }),
        },
      );
    }),
);

it.live(
  "result linkage event-log rebuild and reopened disk retain output; new task has no borrowed answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "linkage-reopen-" });
        const dbPath = path.join(directory, "state.sqlite");
        let expected: CollaborationTaskResultReadout | undefined;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const c = yield* f.createTask("linkage-reopen-first");
              yield* f.execute(c, "linkage-reopen-first-message");
              expected = (yield* f.readSnapshot()).tasks.find(
                (t) => t.threadId === c.threadId,
              )!.resultReadout;
              assert.equal(expected?.status === "available" && expected.content.status, "output");
              yield* f.rebuild;
              assert.deepEqual(
                (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!
                  .resultReadout,
                expected,
              );
              const second = yield* f.createTask("linkage-reopen-second");
              const untouched = (yield* f.readSnapshot()).tasks.find(
                (t) => t.threadId === second.threadId,
              )!;
              assert.equal(untouched.resultReadout?.status, "unavailable");
              yield* f.execute(second, "linkage-reopen-second-message");
              const secondResult = (yield* f.readSnapshot()).tasks.find(
                (t) => t.id === untouched.id,
              )!.resultReadout;
              assert.equal(
                secondResult?.status === "available" && secondResult.content.status,
                "output",
              );
              if (expected?.status !== "available" || secondResult?.status !== "available")
                throw new Error("Missing independent output");
              assert.notEqual(secondResult.runId, expected.runId);
              assert.notEqual(secondResult.attemptId, expected.attemptId);
              assert.notEqual(secondResult.messageId, expected.messageId);
              assert.notEqual(secondResult.providerTurnId, expected.providerTurnId);
            }),
          { dbPath },
        );
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const before = yield* f.sql`SELECT total_changes() AS n`;
              const reopened = (yield* f.readSnapshot()).tasks.find(
                (t) => t.threadId === "linkage-reopen-first",
              )!;
              assert.deepEqual(reopened.resultReadout, expected);
              assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, before);
              yield* f.rebuild;
              assert.deepEqual(
                (yield* f.readSnapshot()).tasks.find((t) => t.id === reopened.id)!.resultReadout,
                expected,
              );
              assert.deepEqual(yield* Ref.get(f.started), []);
            }),
          { dbPath },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["observation", "terminal"] as const)(
  "result linkage SQLite current-owner barrier rejects late %s after Stop/retry/restart/new-owner",
  (stage) =>
    Effect.gen(function* () {
      for (const change of ["stop", "retry", "restart", "new-owner"] as const) {
        const reached =
          yield* Deferred.make<Parameters<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>[0]>();
        const release = yield* Deferred.make<void>();
        const rejected = yield* Deferred.make<boolean>();
        let held = false;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const c = yield* f.createTask(`linkage-race-${stage}-${change}`);
              yield* f.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`start:${c.threadId}`),
                threadId: c.threadId,
                messageId: MessageId.make(`message:${c.threadId}`),
                text: "Race fixture",
                attachments: [],
                routingMode: "auto",
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              const proposal = yield* Deferred.await(reached);
              const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
              const run = projection.runs.find((r) => r.id === proposal.runId)!;
              const attempt = projection.attempts.find((a) => a.id === proposal.activeAttemptId)!;
              const now = yield* DateTime.now;
              if (change === "stop") {
                yield* f.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make(`stop:${c.threadId}`),
                  threadId: c.threadId,
                  runId: run.id,
                });
                yield* f.worker.drain();
              } else {
                // Controlled negative owner transition through the real atomic event sink.
                // No positive turn link is supplied to the successor.
                const successor = {
                  ...attempt,
                  id: RunAttemptId.make(`${attempt.id}:successor`),
                  providerTurnId: null,
                  attemptOrdinal: attempt.attemptOrdinal + 1,
                  reason:
                    change === "retry"
                      ? ("retry" as const)
                      : change === "restart"
                        ? ("steering_restart" as const)
                        : ("provider_recovery" as const),
                };
                yield* f.eventSink.write({
                  events: [
                    {
                      id: EventId.make(`supersede:${c.threadId}`),
                      type: "run-attempt.updated",
                      threadId: c.threadId,
                      runId: run.id,
                      occurredAt: now,
                      payload: { ...attempt, status: "superseded", completedAt: now },
                    },
                    {
                      id: EventId.make(`successor:${c.threadId}`),
                      type: "run-attempt.created",
                      threadId: c.threadId,
                      runId: run.id,
                      occurredAt: now,
                      payload: successor,
                    },
                    {
                      id: EventId.make(`owner:${c.threadId}`),
                      type: "run.updated",
                      threadId: c.threadId,
                      runId: run.id,
                      occurredAt: now,
                      payload: { ...run, activeAttemptId: successor.id },
                    },
                  ],
                });
              }
              const winner = yield* f.orchestrator.getThreadProjection(c.threadId);
              const checkpoints =
                yield* f.sql`SELECT effect_id,status FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture'`;
              yield* Deferred.succeed(release, undefined);
              assert.isFalse(yield* Deferred.await(rejected));
              yield* f.worker.drain();
              const after = yield* f.orchestrator.getThreadProjection(c.threadId);
              assert.deepEqual(after.runs, winner.runs);
              assert.deepEqual(after.attempts, winner.attempts);
              assert.deepEqual(
                after.nodes.filter((n) => n.id === run.rootNodeId),
                winner.nodes.filter((n) => n.id === run.rootNodeId),
              );
              assert.deepEqual(after.providerTurns, winner.providerTurns);
              assert.deepEqual(
                yield* f.sql`SELECT effect_id,status FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture'`,
                checkpoints,
              );
              assert.equal((yield* Ref.get(f.started)).length, 1);
            }),
          {
            decorateEventSink: (service) => ({
              ...service,
              writeIfRunCurrent: (input) => {
                const matches =
                  input.rootExecution !== undefined &&
                  (stage === "terminal"
                    ? input.effects !== undefined && input.effects.length > 0
                    : input.events.some((e) => e.type === "provider-turn.updated"));
                if (held || !matches) return service.writeIfRunCurrent(input);
                held = true;
                return Effect.gen(function* () {
                  yield* Deferred.succeed(reached, input);
                  yield* Deferred.await(release);
                  const result = yield* service.writeIfRunCurrent(input);
                  yield* Deferred.succeed(rejected, result.committed);
                  return result;
                });
              },
            }),
          },
        );
      }
    }),
);

it.live(
  "result linkage shared runtime siblings isolate late A from live B and distinct public answers",
  () =>
    Effect.gen(function* () {
      type Start = {
        input: ProviderAdapterV2TurnInput;
        events: ReadonlyArray<ProviderAdapterV2Event>;
        emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
      };
      const starts = yield* Queue.unbounded<Start>();
      const bothObserved = yield* Deferred.make<void>();
      let observed = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const a = yield* f.createTask("linkage-sibling-a");
            const b = yield* f.createTask("linkage-sibling-b");
            for (const c of [a, b])
              yield* f.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`send:${c.threadId}`),
                threadId: c.threadId,
                messageId: MessageId.make(`message:${c.threadId}`),
                text: c.threadId,
                attachments: [],
                routingMode: "auto",
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
            const first = yield* Queue.take(starts);
            const second = yield* Queue.take(starts);
            yield* Deferred.await(bothObserved);
            assert.equal(
              yield* Ref.get(f.opened),
              1,
              "real SessionManager must share one fake runtime",
            );
            assert.equal(
              first.input.providerThread.providerSessionId,
              second.input.providerThread.providerSessionId,
            );
            assert.notEqual(first.input.providerThread.id, second.input.providerThread.id);
            assert.notEqual(first.input.attemptId, second.input.attemptId);
            yield* Effect.forEach(first.events.slice(1), first.emit, { discard: true });
            yield* f.settle(`message:${first.input.threadId}`);
            const before = yield* f.orchestrator.getThreadProjection(second.input.threadId);
            const pending = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === second.input.threadId,
            )!.resultReadout;
            assert.equal(pending?.status === "available" && pending.content.status, "unknown");
            // Repeated old completed root and terminal are broadcast to B's live subscription too.
            yield* first.emit(first.events.at(-2)!);
            yield* first.emit(first.events.at(-1)!);
            yield* Effect.forEach(second.events.slice(1), second.emit, { discard: true });
            yield* f.settle(`message:${second.input.threadId}`);
            const after = yield* f.orchestrator.getThreadProjection(second.input.threadId);
            assert.equal(after.attempts[0]!.providerTurnId, before.attempts[0]!.providerTurnId);
            const snapshot = yield* f.readSnapshot();
            const results = [first, second].map(
              (start) =>
                snapshot.tasks.find((t) => t.threadId === start.input.threadId)!.resultReadout,
            );
            for (let index = 0; index < results.length; index++) {
              const result = results[index]!;
              assert.equal(result.status, "available");
              if (result.status !== "available" || result.content.status !== "output")
                throw new Error("Missing sibling output");
              assert.equal(result.runId, [first, second][index]!.input.runId);
              assert.equal(result.attemptId, [first, second][index]!.input.attemptId);
              assert.include(result.content.preview, result.runId);
            }
            assert.equal((yield* Ref.get(f.started)).length, 2);
            const checkpoints =
              yield* f.sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture'`;
            assert.equal(checkpoints.length, 2);
          }),
        {
          runningFirst: true,
          onStart: (input, events, emit) =>
            Effect.gen(function* () {
              yield* emit(events[0]!);
              yield* Queue.offer(starts, { input, events, emit });
            }),
          decorateEventSink: (service) => ({
            ...service,
            writeIfRunCurrent: (input) =>
              service.writeIfRunCurrent(input).pipe(
                Effect.tap((result) => {
                  if (
                    !result.committed ||
                    !input.events.some(
                      (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
                    )
                  )
                    return Effect.void;
                  observed++;
                  return observed === 2
                    ? Deferred.succeed(bothObserved, undefined).pipe(Effect.asVoid)
                    : Effect.void;
                }),
              ),
          }),
        },
      );
    }),
);

it.live(
  "result linkage real SQLite rejects foreign execution context without in-memory terminal authority",
  () =>
    Effect.gen(function* () {
      type Root = NonNullable<
        Parameters<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>[0]["rootExecution"]
      >;
      const cases: ReadonlyArray<{
        name: string;
        patch: Partial<Root>;
        top?: Partial<
          Pick<
            Parameters<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>[0],
            "runId" | "threadId" | "activeAttemptId"
          >
        >;
      }> = [
        { name: "root", patch: { rootNodeId: NodeId.make("foreign-root") } },
        {
          name: "provider-thread",
          patch: { providerThreadId: ProviderThreadId.make("foreign-provider-thread") },
        },
        {
          name: "instance",
          patch: { providerInstanceId: ProviderInstanceId.make("foreign-instance") },
        },
        {
          name: "session",
          patch: { providerSessionId: ProviderSessionId.make("foreign-session") },
        },
        { name: "driver", patch: { driver: ProviderDriverKind.make("claudeAgent") } },
        { name: "run-ordinal", patch: { runOrdinal: 7 } },
        { name: "turn-ordinal", patch: { providerTurnOrdinal: 7 } },
        { name: "turn-id", patch: { providerTurnId: ProviderTurnId.make("foreign-turn") } },
        { name: "foreign-existing-turn", patch: {} },
        {
          name: "missing-attempt",
          patch: {},
          top: { activeAttemptId: RunAttemptId.make("missing-attempt") },
        },
        { name: "wrong-run", patch: {}, top: { runId: RunId.make("wrong-run") } },
        {
          name: "wrong-app-thread",
          patch: {},
          top: { threadId: ThreadId.make("wrong-app-thread") },
        },
      ];
      for (const entry of cases) {
        const rejected = yield* Deferred.make<void>();
        let changed = false;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const c = yield* f.createTask(`linkage-invalid-${entry.name}`);
              yield* f.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`send:${c.threadId}`),
                threadId: c.threadId,
                messageId: MessageId.make(`message:${c.threadId}`),
                text: "invalid ownership",
                attachments: [],
                routingMode: "auto",
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* Deferred.await(rejected);
              yield* f.worker.drain();
              const p = yield* f.orchestrator.getThreadProjection(c.threadId);
              assert.equal(p.attempts[0]!.providerTurnId, null, entry.name);
              assert.equal(
                p.runs[0]!.status,
                "running",
                "uncommitted root cannot authorize terminal",
              );
              assert.deepEqual(p.providerTurns, []);
              const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
              assert.equal(result?.status === "available" && result.content.status, "unknown");
              const checkpoints =
                yield* f.sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture'`;
              assert.deepEqual(checkpoints, []);
            }),
          {
            decorateEventSink: (service) => ({
              ...service,
              writeIfRunCurrent: (input) => {
                if (
                  changed ||
                  !input.rootExecution ||
                  !input.events.some((e) => e.type === "provider-turn.updated")
                )
                  return service.writeIfRunCurrent(input);
                changed = true;
                return Effect.gen(function* () {
                  if (entry.name === "foreign-existing-turn") {
                    const observed = input.events.find((e) => e.type === "provider-turn.updated")!;
                    if (observed.type !== "provider-turn.updated")
                      throw new Error("Missing observation");
                    // Negative foreign-row corruption only; never a positive task link.
                    yield* service.write({
                      events: [
                        {
                          ...observed,
                          id: EventId.make(`${observed.id}:foreign`),
                          threadId: ThreadId.make("foreign-app"),
                          payload: {
                            ...observed.payload,
                            runAttemptId: RunAttemptId.make("foreign-attempt"),
                            nodeId: NodeId.make("foreign-root"),
                          },
                        },
                      ],
                    });
                  }
                  const result = yield* service.writeIfRunCurrent({
                    ...input,
                    ...entry.top,
                    rootExecution: { ...input.rootExecution!, ...entry.patch },
                  });
                  assert.isFalse(result.committed, entry.name);
                  yield* Deferred.succeed(rejected, undefined);
                  return result;
                });
              },
            }),
          },
        );
      }
    }),
);

it.live(
  "result linkage rejected root leaves routing unpoisoned for the next committed internal turn",
  () =>
    Effect.gen(function* () {
      const rejected = yield* Deferred.make<void>();
      let first = true;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const c = yield* f.createTask("linkage-no-poison");
            yield* f.execute(c, "linkage-no-poison-message");
            const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
            assert.equal(result?.status === "available" && result.content.status, "output");
            if (result?.status !== "available") throw new Error("Missing result");
            assert.equal(result.providerTurnId, "accepted-second-internal-turn");
            const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
            assert.equal(projection.providerTurns.length, 1);
            assert.equal(projection.attempts[0]!.providerTurnId, result.providerTurnId);
          }),
        {
          onStart: (_input, events, emit) =>
            Effect.gen(function* () {
              yield* emit(events[0]!);
              yield* Deferred.await(rejected);
              const id = ProviderTurnId.make("accepted-second-internal-turn");
              for (const event of events) {
                switch (event.type) {
                  case "provider_turn.updated":
                    yield* emit({ ...event, providerTurn: { ...event.providerTurn, id } });
                    break;
                  case "node.updated":
                    yield* emit({ ...event, node: { ...event.node, providerTurnId: id } });
                    break;
                  case "turn_item.updated":
                    yield* emit({ ...event, turnItem: { ...event.turnItem, providerTurnId: id } });
                    break;
                  case "turn.terminal":
                    yield* emit({ ...event, providerTurnId: id });
                    break;
                  default:
                    throw new Error("Unexpected script event");
                }
              }
            }),
          decorateEventSink: (service) => ({
            ...service,
            writeIfRunCurrent: (input) => {
              if (
                !first ||
                !input.rootExecution ||
                !input.events.some((e) => e.type === "provider-turn.updated")
              )
                return service.writeIfRunCurrent(input);
              first = false;
              return service
                .writeIfRunCurrent({
                  ...input,
                  rootExecution: {
                    ...input.rootExecution,
                    providerSessionId: ProviderSessionId.make("lost-session"),
                  },
                })
                .pipe(
                  Effect.tap((result) => {
                    assert.isFalse(result.committed);
                    return Deferred.succeed(rejected, undefined);
                  }),
                );
            },
          }),
        },
      );
    }),
);

it.live(
  "result linkage SQLite rollback removes both turn and link and cannot publish an output",
  () =>
    withTaskResultLinkageFixture((f) =>
      Effect.gen(function* () {
        const c = yield* f.createTask("linkage-rollback");
        // Negative corruption fixture: abort the link insert inside the actual transaction.
        yield* f.sql.unsafe(
          `CREATE TRIGGER reject_link BEFORE INSERT ON orchestration_v2_projection_run_attempts WHEN NEW.provider_turn_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'linkage fixture rollback'); END`,
        );
        const failed = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.payload.userMessageId === "linkage-rollback-message" &&
              e.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("linkage-rollback-send"),
          threadId: c.threadId,
          messageId: MessageId.make("linkage-rollback-message"),
          text: "rollback",
          attachments: [],
          routingMode: "auto",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Fiber.join(failed);
        yield* f.worker.drain();
        const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
        assert.equal(projection.attempts[0]!.providerTurnId, null);
        assert.deepEqual(projection.providerTurns, []);
        const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
        assert.equal(result?.status === "available" && result.content.status, "unknown");
        const rootEvents =
          yield* f.sql`SELECT event_id FROM orchestration_events WHERE event_type='provider-turn.updated' AND stream_id=${c.threadId}`;
        assert.deepEqual(rootEvents, []);
        yield* f.rebuild;
        assert.deepEqual((yield* f.orchestrator.getThreadProjection(c.threadId)).providerTurns, []);
        assert.equal((yield* Ref.get(f.started)).length, 1);
      }),
    ),
);

it.live("result linkage observed failed root exposes only matching structured failure", () =>
  withTaskResultLinkageFixture(
    (f) =>
      Effect.gen(function* () {
        const c = yield* f.createTask("linkage-failed");
        const failed = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.payload.userMessageId === "linkage-failed-message" &&
              e.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("linkage-failed-send"),
          threadId: c.threadId,
          messageId: MessageId.make("linkage-failed-message"),
          text: "failed",
          attachments: [],
          routingMode: "auto",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Fiber.join(failed);
        yield* f.worker.drain();
        const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
        assert.equal(result?.status === "available" && result.content.status, "failure");
        if (result?.status !== "available" || result.content.status !== "failure")
          throw new Error("No attributed failure");
        assert.deepEqual(result.content.failure, {
          class: "provider_error",
          code: "fixture-failure",
          message: "Exact observed root failure",
        });
        const p = yield* f.orchestrator.getThreadProjection(c.threadId);
        assert.equal(p.attempts[0]!.providerTurnId, result.providerTurnId);
        assert.equal(p.providerTurns[0]!.status, "failed");
        const failureItemId = result.content.itemId;
        assert.equal(p.turnItems.find((i) => i.id === failureItemId)?.type, "error");
      }),
    {
      onStart: (_input, events, emit) =>
        Effect.gen(function* () {
          const root = events[0]!;
          const terminal = events.at(-1)!;
          if (root.type !== "provider_turn.updated" || terminal.type !== "turn.terminal")
            throw new Error("Invalid script");
          yield* emit({ ...root, providerTurn: { ...root.providerTurn, status: "failed" } });
          yield* emit({
            ...terminal,
            status: "failed",
            failureItemOrdinal: 1,
            failure: {
              class: "provider_error",
              code: "fixture-failure",
              message: "Exact observed root failure",
              retryable: false,
            },
          });
        }),
    },
  ),
);

it.live("result linkage terminal-only synthetic event never creates execution evidence", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    yield* withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const c = yield* f.createTask("linkage-terminal-only");
          yield* f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("linkage-terminal-only-send"),
            threadId: c.threadId,
            messageId: MessageId.make("linkage-terminal-only-message"),
            text: "terminal-only",
            attachments: [],
            routingMode: "auto",
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* Deferred.await(sent);
          yield* f.worker.drain();
          const p = yield* f.orchestrator.getThreadProjection(c.threadId);
          assert.equal(p.attempts[0]!.providerTurnId, null);
          assert.deepEqual(p.providerTurns, []);
          assert.equal(p.runs[0]!.status, "running");
          const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
          assert.equal(result?.status, "available");
          if (result?.status !== "available") throw new Error("Missing synthetic evidence");
          assert.deepEqual(result.content, { status: "unknown", reason: "missing_provider_turn" });
        }),
      {
        onStart: (_input, events, emit) =>
          emit(events.at(-1)!).pipe(Effect.andThen(Deferred.succeed(sent, undefined))),
      },
    );
  }),
);

it.live(
  "result linkage rebuild preserves a legacy null finalization link without historical backfill",
  () =>
    withTaskResultLinkageFixture((f) =>
      Effect.gen(function* () {
        const c = yield* f.createTask("linkage-legacy");
        yield* f.execute(c, "linkage-legacy-message");
        const p = yield* f.orchestrator.getThreadProjection(c.threadId);
        const run = p.runs[0]!;
        const attempt = p.attempts[0]!;
        assert.isNotNull(attempt.providerTurnId);
        // Historical negative fixture: the old finalizer recorded its stale null snapshot.
        // Replay must honor that event instead of inferring a link from a nearby turn.
        yield* f.eventSink.write({
          events: [
            {
              id: EventId.make("legacy-null-finalization"),
              type: "run-attempt.updated",
              threadId: c.threadId,
              runId: run.id,
              nodeId: run.rootNodeId!,
              occurredAt: yield* DateTime.now,
              payload: { ...attempt, providerTurnId: null },
            },
          ],
        });
        const legacy = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
        assert.equal(legacy?.status, "available");
        if (legacy?.status !== "available") throw new Error("Legacy evidence missing");
        assert.deepEqual(legacy.content, { status: "unknown", reason: "missing_provider_turn" });
        yield* f.rebuild;
        assert.deepEqual((yield* f.readSnapshot()).tasks[0]!.resultReadout, legacy);
        assert.equal(
          (yield* f.orchestrator.getThreadProjection(c.threadId)).attempts[0]!.providerTurnId,
          null,
        );
      }),
    ),
);

it.live(
  "result linkage checkpoint enqueue rollback preserves canonical link and leaves no waiting run",
  () =>
    withTaskResultLinkageFixture((f) =>
      Effect.gen(function* () {
        const c = yield* f.createTask("linkage-checkpoint-rollback");
        yield* f.sql.unsafe(
          `CREATE TRIGGER reject_checkpoint BEFORE INSERT ON orchestration_v2_effect_outbox WHEN NEW.effect_type='checkpoint.capture' BEGIN SELECT RAISE(ABORT,'checkpoint fixture rollback'); END`,
        );
        const failed = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.payload.userMessageId === "linkage-checkpoint-rollback-message" &&
              e.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("linkage-checkpoint-rollback-send"),
          threadId: c.threadId,
          messageId: MessageId.make("linkage-checkpoint-rollback-message"),
          text: "checkpoint rollback",
          attachments: [],
          routingMode: "auto",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Fiber.join(failed);
        yield* f.worker.drain();
        const p = yield* f.orchestrator.getThreadProjection(c.threadId);
        assert.equal(p.runs[0]!.status, "failed");
        assert.equal(p.nodes.find((n) => n.id === p.runs[0]!.rootNodeId)!.status, "failed");
        assert.equal(p.attempts[0]!.providerTurnId, p.providerTurns[0]!.id);
        const effects =
          yield* f.sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture'`;
        assert.deepEqual(effects, []);
        const waiting =
          yield* f.sql`SELECT event_id FROM orchestration_events WHERE event_type='run.updated' AND stream_id=${c.threadId} AND COALESCE(json_extract(payload_json,'$.payload.status'),json_extract(payload_json,'$.status'))='waiting'`;
        assert.deepEqual(
          waiting,
          [],
          "terminal events and checkpoint enqueue roll back atomically",
        );
        const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
        assert.equal(result?.status === "available" && result.content.status, "unknown");
        yield* f.rebuild;
        assert.equal(
          (yield* f.orchestrator.getThreadProjection(c.threadId)).attempts[0]!.providerTurnId,
          p.providerTurns[0]!.id,
        );
      }),
    ),
);

it.live.each(["interrupted", "cancelled", "start-failed"] as const)(
  "result linkage %s remains conservative without inventing an output",
  (status) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const c = yield* f.createTask(`linkage-${status}`);
          const terminalStatus = status === "start-failed" ? "failed" : status;
          const settled = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) =>
                e.type === "run.updated" &&
                e.payload.userMessageId === `message:${c.threadId}` &&
                e.payload.status === terminalStatus,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send:${c.threadId}`),
            threadId: c.threadId,
            messageId: MessageId.make(`message:${c.threadId}`),
            text: status,
            attachments: [],
            routingMode: "auto",
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* Fiber.join(settled);
          yield* f.worker.drain();
          const result = (yield* f.readSnapshot()).tasks[0]!.resultReadout;
          assert.equal(result?.status === "available" && result.content.status, "unknown");
          const p = yield* f.orchestrator.getThreadProjection(c.threadId);
          if (status === "start-failed") {
            assert.equal(p.attempts[0]!.providerTurnId, null);
            assert.deepEqual(p.providerTurns, []);
          } else assert.equal(p.attempts[0]!.providerTurnId, p.providerTurns[0]!.id);
        }),
      {
        onStart: (_input, events, emit) =>
          Effect.gen(function* () {
            if (status === "start-failed")
              return yield* Effect.die("controlled synthetic start failure");
            const root = events[0]!,
              terminal = events.at(-1)!;
            if (root.type !== "provider_turn.updated" || terminal.type !== "turn.terminal")
              throw new Error("Invalid script");
            yield* emit({ ...root, providerTurn: { ...root.providerTurn, status } });
            yield* emit({ ...terminal, status, failure: null });
          }),
      },
    ),
);
