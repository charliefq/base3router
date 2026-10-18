import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  ModelSelection,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ChatAttachment,
  type ServerProvider,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnMessage,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
const instanceId = ProviderInstanceId.make("image-correction-fixture");
const driver = ProviderDriverKind.make("codex");
const capabilities = CodexProviderCapabilitiesV2;
const selection = { instanceId, model: "declared-fixture" };
const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const image: ChatAttachment = {
  type: "image",
  id: "original-image-id",
  name: "fixture.png",
  mimeType: "image/png",
  sizeBytes: 12,
};
const provider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00Z",
  models: [
    {
      slug: selection.model,
      name: "Fixture",
      isCustom: false,
      capabilities: null,
      inputModalities: ["text", "image"],
    },
  ],
  slashCommands: [],
  skills: [],
};
const session = {
  kind: "session" as const,
  actorId: "routing-user",
  sessionId: "routing-session",
  scopes: [AuthOrchestrationOperateScope],
};
function makeAdapter(
  started: Ref.Ref<ReadonlyArray<ModelSelection>>,
  instanceId: ProviderInstanceId,
  resultText?: string,
  delivered?: Ref.Ref<ReadonlyArray<ReadonlyArray<ChatAttachment>>>,
  controls: {
    beforeEnsure?: Effect.Effect<void>;
    keepRunning?: boolean;
    restartSession?: boolean;
    onInterrupt?: Effect.Effect<void>;
    onSteer?: (message: ProviderAdapterV2TurnMessage) => Effect.Effect<void>;
  } = {},
): ProviderAdapterV2Shape {
  return {
    instanceId: instanceId,
    driver: driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () =>
      Effect.succeed(
        controls.restartSession ? { type: "restart_session" } : { type: "apply_on_next_turn" },
      ),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        let stopActive: Effect.Effect<void> = Effect.void;
        const now = yield* DateTime.now;
        return {
          instanceId: instanceId,
          driver: driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities: capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              if (controls.beforeEnsure) yield* controls.beforeEnsure;
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:handoff:${threadInput.threadId}`),
                driver: driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: driver,
                  nativeId: `native-thread:handoff:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(started, (models) => [...models, input.modelSelection]);
              if (delivered)
                yield* Ref.update(delivered, (messages) => [
                  ...messages,
                  input.message.attachments,
                ]);
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:handoff:${input.attemptId}`,
              );
              const activeTurn: OrchestrationV2ProviderTurn = {
                id: providerTurnId,
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: {
                  driver: driver,
                  nativeId: `native:${providerTurnId}`,
                  strength: "strong",
                },
                ordinal: input.providerTurnOrdinal,
                status: controls.keepRunning ? "running" : "completed",
                startedAt: occurredAt,
                completedAt: controls.keepRunning ? null : occurredAt,
              };
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: activeTurn,
              });
              stopActive = Effect.gen(function* () {
                if (controls.onInterrupt) yield* controls.onInterrupt;
                const interruptedAt = yield* DateTime.now;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    ...activeTurn,
                    status: "interrupted",
                    completedAt: interruptedAt,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId,
                  runOrdinal: input.runOrdinal,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                });
              });
              if (resultText !== undefined) {
                const ids = yield* IdAllocator.IdAllocatorV2.pipe(
                  Effect.provide(IdAllocator.layer),
                );
                const ref = {
                  driver,
                  nativeId: `eligible-output:${input.attemptId}`,
                  strength: "strong" as const,
                };
                const nodeId = ids.derive.nodeFromProviderItem({
                  driver,
                  nativeItemId: ref.nativeId,
                });
                yield* Queue.offer(events, {
                  type: "node.updated",
                  driver,
                  node: {
                    id: nodeId,
                    threadId: input.threadId,
                    runId: input.runId,
                    parentNodeId: input.rootNodeId,
                    rootNodeId: input.rootNodeId,
                    kind: "assistant_message",
                    status: "completed",
                    countsForRun: false,
                    providerThreadId: input.providerThread.id,
                    providerTurnId,
                    nativeItemRef: ref,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: occurredAt,
                    completedAt: occurredAt,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: ids.derive.turnItemFromProviderItem({ driver, nativeItemId: ref.nativeId }),
                    messageId: ids.derive.messageFromProviderItem({
                      driver,
                      nativeItemId: ref.nativeId,
                    }),
                    threadId: input.threadId,
                    runId: input.runId,
                    nodeId,
                    providerThreadId: input.providerThread.id,
                    providerTurnId,
                    nativeItemRef: ref,
                    parentItemId: null,
                    ordinal: 1,
                    type: "assistant_message",
                    status: "completed",
                    title: null,
                    startedAt: occurredAt,
                    completedAt: occurredAt,
                    updatedAt: occurredAt,
                    text: `${resultText} [run=${input.runId}; attempt=${input.attemptId}]`,
                    streaming: false,
                  },
                });
              }
              if (controls.keepRunning) return;
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver: driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: (input) => controls.onSteer?.(input.message) ?? Effect.void,
          interruptTurn: () => stopActive,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

type Fixture = {
  sql: SqlClient.SqlClient;
  orchestrator: Orchestrator.OrchestratorV2["Service"];
  worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
  threadId: ThreadId;
};
const fixture = (
  label: string,
  controls: {
    boundary?: "ensure" | "checkpoint";
    active?: boolean;
    failOnce?: boolean;
    restart?: boolean;
  },
  body: (
    f: Fixture & {
      reached: Deferred.Deferred<void>;
      release: Deferred.Deferred<void>;
      providers: Ref.Ref<ReadonlyArray<ServerProvider>>;
      delivered: Ref.Ref<ReadonlyArray<ReadonlyArray<ChatAttachment>>>;
      steered: Ref.Ref<ReadonlyArray<ProviderAdapterV2TurnMessage>>;
      failedWrites: Ref.Ref<number>;
      interrupts: Ref.Ref<number>;
      detaches: Ref.Ref<number>;
      reopen: (
        check: (
          f: Fixture,
        ) => Effect.Effect<void, Error, Scope.Scope | EffectWorker.OrchestrationEffectWorkerV2>,
      ) => Effect.Effect<void, Error>;
    },
  ) => Effect.Effect<void, Error, Scope.Scope | EffectWorker.OrchestrationEffectWorkerV2>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(label);
      const database = makeSqlitePersistenceLive(`${cwd}/policy-fixture.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const barrier = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const initialProvider = controls.restart
        ? {
            ...provider,
            models: [
              ...provider.models,
              {
                slug: "old-text",
                name: "Old text fixture",
                isCustom: false,
                capabilities: null,
                inputModalities: ["text"],
              },
            ],
          }
        : provider;
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([initialProvider]);
      const delivered = yield* Ref.make<ReadonlyArray<ReadonlyArray<ChatAttachment>>>([]);
      const steered = yield* Ref.make<ReadonlyArray<ProviderAdapterV2TurnMessage>>([]);
      const started = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
      const failedWrites = yield* Ref.make(0);
      const interrupts = yield* Ref.make(0);
      const detaches = yield* Ref.make(0);
      const runtime = Layer.mergeAll(
        database,
        Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
        makeOrchestratorV2ReplayLayerWithRegistry(
          { name: label },
          ProviderAdapterRegistry.makeLayer([
            makeAdapter(started, instanceId, "Earlier output", delivered, {
              ...(controls.boundary === "ensure" ? { beforeEnsure: barrier } : {}),
              ...(controls.active || controls.restart ? { keepRunning: true } : {}),
              ...(controls.restart
                ? { restartSession: true, onInterrupt: Ref.update(interrupts, (n) => n + 1) }
                : {}),
              onSteer: (message) => Ref.update(steered, (rows) => [...rows, message]),
            }),
          ]),
          {
            databaseLayer: database,
            runEffectWorker: false,
            decorateSessionManager: (service) => ({
              ...service,
              detach: (input) =>
                Ref.update(detaches, (n) => n + 1).pipe(Effect.andThen(service.detach(input))),
            }),
            decorateCheckpointService: (service) => ({
              ...service,
              captureBaseline: (input) =>
                controls.boundary === "checkpoint"
                  ? barrier.pipe(Effect.andThen(service.captureBaseline(input)))
                  : service.captureBaseline(input),
            }),
            // Advance only fixture backoff scheduling, never ownership or execution identities.
            decorateEffectOutbox: (service) => ({
              ...service,
              retry: (input) => service.retry({ ...input, delayMs: 0 }),
            }),
            decorateEventSink: (service) => ({
              ...service,
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  if (
                    controls.failOnce &&
                    input.events.some(
                      (e) =>
                        (e.type === "run.updated" && e.payload.status === "failed") ||
                        (e.type === "turn-item.updated" &&
                          e.payload.type === "error" &&
                          e.payload.title === "Image delivery denied"),
                    )
                  ) {
                    const previous = yield* Ref.getAndUpdate(failedWrites, (n) => n + 1);
                    if (previous === 0)
                      return yield* new EventSink.EventSinkWriteError({
                        eventCount: input.events.length,
                        cause: "Injected fail-once denial terminal write",
                      });
                  }
                  return yield* service.writeIfRunCurrent(input);
                }),
            }),
          },
        ),
      );
      const threadId = ThreadId.make(`image-correction:${label}`);
      const services = Effect.all({
        sql: SqlClient.SqlClient,
        orchestrator: Orchestrator.OrchestratorV2,
        worker: EffectWorker.OrchestrationEffectWorkerV2,
      });
      let reopenCheck:
        | ((
            f: Fixture,
          ) => Effect.Effect<void, Error, Scope.Scope | EffectWorker.OrchestrationEffectWorkerV2>)
        | undefined;
      const reopen = (check: NonNullable<typeof reopenCheck>) =>
        Effect.sync(() => {
          reopenCheck = check;
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* services;
          const now = DateTime.formatIso(yield* DateTime.now);
          const projectId = ProjectId.make(`image-correction:${label}`);
          yield* f.sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at) VALUES (${projectId},'Image correction',${cwd},${yield* encodeSelection(selection)},'[]',${now},${now})`;
          yield* f.orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${label}`),
            threadId,
            projectId,
            title: "Image correction",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* body({
            ...f,
            threadId,
            reached,
            release,
            providers,
            delivered,
            steered,
            failedWrites,
            interrupts,
            detaches,
            reopen,
          });
        }).pipe(Effect.provide(runtime)),
      );
      if (reopenCheck !== undefined) {
        const check = reopenCheck;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* services;
            yield* check({ ...f, threadId });
          }).pipe(Effect.provide(Layer.fresh(runtime))),
        );
      }
    }).pipe(
      Effect.provideService(PolicyExecutionContext, session),
      Effect.provide(NodeServices.layer),
    ),
  );
const messageCommand = (
  threadId: ThreadId,
  label: string,
  attachments: ReadonlyArray<ChatAttachment> = [image],
) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${label}`),
  threadId,
  messageId: MessageId.make(`message:${label}`),
  text: "Inspect fixture",
  attachments,
  modelSelection: selection,
  routingMode: "auto" as const,
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});
const removeCapability = (providers: Ref.Ref<ReadonlyArray<ServerProvider>>) =>
  Ref.set(providers, [
    { ...provider, models: provider.models.map((m) => ({ ...m, inputModalities: ["text"] })) },
  ]);

it.live.each([
  { boundary: "ensure", loss: "capability", failOnce: false },
  { boundary: "ensure", loss: "availability", failOnce: false },
  { boundary: "checkpoint", loss: "capability", failOnce: false },
  { boundary: "checkpoint", loss: "availability", failOnce: false },
  { boundary: "checkpoint", loss: "capability", failOnce: true },
] as const)(
  "late image $loss loss at $boundary failOnce=$failOnce never reaches adapter",
  ({ boundary, loss, failOnce }) =>
    fixture(`late-${boundary}-${loss}-${failOnce}`, { boundary, failOnce }, (f) =>
      Effect.gen(function* () {
        const command = messageCommand(f.threadId, boundary);
        yield* f.orchestrator.dispatch(command);
        const drained = yield* f.worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(f.reached);
        if (loss === "availability")
          yield* Ref.set(f.providers, [{ ...provider, availability: "unavailable" }]);
        else yield* removeCapability(f.providers);
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(drained);
        const p = yield* f.orchestrator.getThreadProjection(f.threadId);
        assert.deepEqual(yield* Ref.get(f.delivered), [], "no image delivery after async setup");
        assert.equal(p.runs[0]?.status, "failed");
        assert.equal(p.attempts[0]?.status, "failed");
        assert.equal(p.nodes.find((n) => n.id === p.runs[0]?.rootNodeId)?.status, "failed");
        const denied = p.turnItems.find((i) => i.type === "error");
        assert.isDefined(denied);
        if (denied?.type !== "error") throw new Error("Missing denial output");
        assert.equal(denied.failure.class, "validation_error");
        assert.equal(denied.failure.retryable, false);
        assert.include(denied.failure.message, "declared image-input support");
        assert.include(denied.failure.message, "remove the image");
        assert.notInclude(denied.failure.message, image.name);
        assert.notInclude(denied.failure.message, image.id);
        assert.notInclude(denied.failure.message, "Bearer");
        assert.notInclude(denied.failure.message, "/private/");
        const grants = yield* f.sql<{
          revoked_at: string | null;
        }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${command.messageId}`;
        assert.isString(grants[0]?.revoked_at);
        if (failOnce) assert.isAtLeast(yield* Ref.get(f.failedWrites), 2);
        yield* Ref.set(f.providers, [provider]);
        yield* f.orchestrator.dispatch(command);
        yield* f.worker.drain();
        assert.deepEqual(yield* Ref.get(f.delivered), []);
      }),
    ),
);

it.live("revoked image denial retries failed terminal write and progresses queue", () =>
  fixture("denial-write-recovery", { failOnce: true }, (f) =>
    Effect.gen(function* () {
      const command = messageCommand(f.threadId, "denial-retry");
      yield* f.orchestrator.dispatch(command);
      const queued = {
        ...messageCommand(f.threadId, "next-text", []),
        dispatchMode: { type: "queue_after_active" as const },
      };
      yield* f.orchestrator.dispatch(queued);
      yield* removeCapability(f.providers);
      yield* f.worker.drain();
      const p = yield* f.orchestrator.getThreadProjection(f.threadId);
      const run = p.runs.find((r) => r.userMessageId === command.messageId);
      assert.equal(
        run?.status,
        "failed",
        "denied settlement survives the first failed event write",
      );
      assert.equal(p.attempts.find((a) => a.runId === run?.id)?.status, "failed");
      assert.equal(p.nodes.find((n) => n.id === run?.rootNodeId)?.status, "failed");
      assert.isAtLeast(yield* Ref.get(f.failedWrites), 2);
      const grant = yield* f.sql<{
        revoked_at: string | null;
      }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${command.messageId}`;
      assert.isString(grant[0]?.revoked_at);
      const terminal = yield* f.orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (e) =>
            e.type === "run.updated" &&
            e.payload.userMessageId === queued.messageId &&
            e.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
      yield* Fiber.join(terminal);
      yield* f.worker.drain();
      assert.deepEqual(
        yield* Ref.get(f.delivered),
        [[]],
        "queue progresses without image delivery",
      );
      yield* Ref.set(f.providers, [provider]);
      yield* f.reopen((fresh) =>
        Effect.gen(function* () {
          yield* fresh.orchestrator.dispatch(command);
          yield* fresh.worker.drain();
          assert.deepEqual(
            yield* Ref.get(f.delivered),
            [[]],
            "reopen cannot restore denied execution authority",
          );
          const p = yield* fresh.orchestrator.getThreadProjection(fresh.threadId);
          assert.equal(p.runs.find((r) => r.userMessageId === command.messageId)?.status, "failed");
        }),
      );
    }),
  ),
);

it.live.each([
  { failOnce: false, reopenPending: false },
  { failOnce: true, reopenPending: false },
  { failOnce: true, reopenPending: true },
])(
  "active Auto image steering denial preserves run and earlier output failOnce=$failOnce reopenPending=$reopenPending",
  ({ failOnce, reopenPending }) =>
    fixture(`active-steer-denial-${failOnce}-${reopenPending}`, { active: true, failOnce }, (f) =>
      Effect.gen(function* () {
        const foreground = messageCommand(f.threadId, "active-text", []);
        const output = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) => e.type === "turn-item.updated" && e.payload.type === "assistant_message",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.orchestrator.dispatch(foreground);
        yield* f.worker.drain();
        yield* Fiber.join(output);
        const before = yield* f.orchestrator.getThreadProjection(f.threadId);
        const command = {
          ...messageCommand(f.threadId, "active-image"),
          deliveryIntent: "auto" as const,
          dispatchMode: { type: "queue_after_active" as const },
        };
        yield* f.orchestrator.dispatch(command);
        const pending = yield* f.sql<{
          request_json: string;
        }>`SELECT payload_json AS request_json FROM orchestration_v2_effect_outbox WHERE command_id=${command.commandId}`;
        assert.isTrue(
          pending.some((row) => row.request_json.includes("provider-turn.steer")),
          "real active-run steer admission",
        );
        yield* removeCapability(f.providers);
        if (reopenPending) {
          while ((yield* Ref.get(f.failedWrites)) === 0) assert.isTrue(yield* f.worker.runOnce);
          const revoked = yield* f.sql<{
            revoked_at: string | null;
          }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${command.messageId}`;
          assert.isString(revoked[0]?.revoked_at);
          yield* Ref.set(f.providers, [provider]);
          yield* f.reopen((fresh) =>
            Effect.gen(function* () {
              yield* fresh.worker.drain();
              const after = yield* fresh.orchestrator.getThreadProjection(fresh.threadId);
              assert.deepEqual(after.runs, before.runs);
              assert.deepEqual(after.attempts, before.attempts);
              assert.deepEqual(after.providerTurns, before.providerTurns);
              assert.deepEqual(
                after.turnItems.filter((i) => i.type === "assistant_message"),
                before.turnItems.filter((i) => i.type === "assistant_message"),
              );
              assert.isTrue(
                after.turnItems.some(
                  (i) => i.type === "error" && i.title === "Image delivery denied",
                ),
              );
              assert.deepEqual(yield* Ref.get(f.steered), []);
              yield* fresh.orchestrator.dispatch(command);
              yield* fresh.worker.drain();
              assert.deepEqual(yield* Ref.get(f.steered), []);
            }),
          );
          return;
        }
        yield* f.worker.drain();
        assert.deepEqual(
          yield* Ref.get(f.steered),
          [],
          "ineligible image steer never reaches adapter",
        );
        const after = yield* f.orchestrator.getThreadProjection(f.threadId);
        assert.equal(after.runs[0]?.status, "running");
        assert.deepEqual(after.runs, before.runs, "the earlier active run remains intact");
        assert.deepEqual(after.attempts, before.attempts);
        assert.deepEqual(after.providerTurns, before.providerTurns);
        const original = yield* f.sql<{
          revoked_at: string | null;
        }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${foreground.messageId}`;
        assert.isNull(original[0]?.revoked_at);
        if (failOnce) assert.isAtLeast(yield* Ref.get(f.failedWrites), 2);
        assert.deepEqual(
          after.turnItems.filter((i) => i.type === "assistant_message"),
          before.turnItems.filter((i) => i.type === "assistant_message"),
        );
        const grant = yield* f.sql<{
          revoked_at: string | null;
        }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${command.messageId}`;
        assert.isString(grant[0]?.revoked_at);
        assert.isTrue(
          after.turnItems.some((i) => i.type === "error" && i.title === "Image delivery denied"),
        );
        yield* Ref.set(f.providers, [provider]);
        yield* f.orchestrator.dispatch(command);
        yield* f.worker.drain();
        assert.deepEqual(yield* Ref.get(f.steered), []);
        yield* f.reopen((fresh) =>
          Effect.gen(function* () {
            yield* fresh.orchestrator.dispatch(command);
            yield* fresh.worker.drain();
            assert.deepEqual(yield* Ref.get(f.steered), []);
            const reopened = yield* fresh.orchestrator.getThreadProjection(fresh.threadId);
            assert.deepEqual(
              reopened.turnItems.filter((i) => i.type === "assistant_message"),
              before.turnItems.filter((i) => i.type === "assistant_message"),
            );
          }),
        );
      }),
    ),
);

it.live(
  "pending image denial settles after real runtime close and reopen without new delivery",
  () =>
    fixture("pending-denial-reopen", { failOnce: true }, (f) =>
      Effect.gen(function* () {
        const command = messageCommand(f.threadId, "pending-image");
        const next = {
          ...messageCommand(f.threadId, "after-reopen", []),
          dispatchMode: { type: "queue_after_active" as const },
        };
        yield* f.orchestrator.dispatch(command);
        yield* f.orchestrator.dispatch(next);
        yield* removeCapability(f.providers);
        while ((yield* Ref.get(f.failedWrites)) === 0) assert.isTrue(yield* f.worker.runOnce);
        const p = yield* f.orchestrator.getThreadProjection(f.threadId);
        assert.equal(p.runs.find((r) => r.userMessageId === command.messageId)?.status, "starting");
        const rows = yield* f.sql<{
          revoked_at: string | null;
        }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${command.messageId}`;
        assert.isString(rows[0]?.revoked_at, "revocation survived failed terminal write");
        assert.deepEqual(yield* Ref.get(f.delivered), []);
        yield* Ref.set(f.providers, [provider]);
        yield* f.reopen((fresh) =>
          Effect.gen(function* () {
            yield* fresh.worker.drain();
            const p = yield* fresh.orchestrator.getThreadProjection(fresh.threadId);
            assert.equal(
              p.runs.find((r) => r.userMessageId === command.messageId)?.status,
              "failed",
            );
            const terminal = yield* fresh.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "run.updated" &&
                  e.payload.userMessageId === next.messageId &&
                  e.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
            yield* Fiber.join(terminal);
            yield* fresh.worker.drain();
            assert.deepEqual(
              yield* Ref.get(f.delivered),
              [[]],
              "only the queued text delivery starts",
            );
            yield* fresh.orchestrator.dispatch(command);
            yield* fresh.worker.drain();
            assert.deepEqual(yield* Ref.get(f.delivered), [[]]);
          }),
        );
      }),
    ),
);

it.live.each([false, true])(
  "real Auto model-change restart denial recovers fail-once terminal write reopen=%s",
  (reopenPending) =>
    fixture(`restart-denial-${reopenPending}`, { restart: true, failOnce: true }, (f) =>
      Effect.gen(function* () {
        const foreground = {
          ...messageCommand(f.threadId, "restart-old", []),
          routingMode: "manual" as const,
          modelSelection: { instanceId, model: "old-text" },
        };
        const output = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) => e.type === "turn-item.updated" && e.payload.type === "assistant_message",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.orchestrator.dispatch(foreground);
        yield* f.worker.drain();
        yield* Fiber.join(output);
        const before = yield* f.orchestrator.getThreadProjection(f.threadId);
        const oldAttempt = before.attempts[0]!;
        const oldTurn = before.providerTurns[0]!;
        const command = {
          ...messageCommand(f.threadId, "restart-image"),
          deliveryIntent: "auto" as const,
          dispatchMode: { type: "queue_after_active" as const },
        };
        yield* f.orchestrator.dispatch(command);
        const effects = yield* f.sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id=${command.commandId}`;
        assert.isTrue(
          effects.some((e) => e.payload_json.includes("provider-turn.restart")),
          "actual Auto selection change produces restart",
        );
        yield* removeCapability(f.providers);
        while ((yield* Ref.get(f.failedWrites)) === 0) assert.isTrue(yield* f.worker.runOnce);
        assert.equal(yield* Ref.get(f.interrupts), 1);
        assert.equal(yield* Ref.get(f.detaches), 1);
        const grants = yield* f.sql<{
          revoked_at: string | null;
        }>`SELECT revoked_at FROM base3_execution_grants WHERE message_id=${command.messageId}`;
        assert.isString(grants[0]?.revoked_at);
        yield* Ref.set(f.providers, [provider]);
        const check = (fresh: Fixture) =>
          Effect.gen(function* () {
            yield* fresh.worker.drain();
            const after = yield* fresh.orchestrator.getThreadProjection(fresh.threadId);
            const run = after.runs.find((r) => r.userMessageId === command.messageId);
            assert.equal(run?.id, before.runs[0]?.id, "restart retains the actual run ownership");
            assert.equal(run?.status, "failed");
            assert.equal(
              after.attempts.find((a) => a.id === run?.activeAttemptId)?.status,
              "failed",
            );
            assert.notEqual(run?.activeAttemptId, oldAttempt.id);
            const retired = after.attempts.find((a) => a.id === oldAttempt.id)!;
            assert.equal(retired.status, "interrupted");
            assert.isNotNull(retired.completedAt);
            assert.equal(
              after.providerTurns.find((t) => t.id === oldTurn.id)?.terminationConfirmed,
              true,
            );
            assert.equal(
              after.providerTurns.find((t) => t.id === oldTurn.id)?.status,
              "interrupted",
            );
            assert.deepEqual(
              after.turnItems.filter((i) => i.type === "assistant_message"),
              before.turnItems.filter((i) => i.type === "assistant_message"),
            );
            assert.equal(yield* Ref.get(f.interrupts), 1, "denial retry cannot replay interrupt");
            assert.equal(yield* Ref.get(f.detaches), 1, "denial retry cannot replay detach");
            assert.deepEqual(yield* Ref.get(f.delivered), [[]]);
            yield* fresh.orchestrator.dispatch(command);
            yield* fresh.worker.drain();
            assert.deepEqual(yield* Ref.get(f.delivered), [[]]);
            assert.equal(yield* Ref.get(f.interrupts), 1);
            assert.equal(yield* Ref.get(f.detaches), 1);
          });
        if (reopenPending) yield* f.reopen(check);
        else yield* check(f);
      }),
    ),
);
