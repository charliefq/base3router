import {
  makeOpenRouterAdapter,
  OPENROUTER_DRIVER,
} from "../../orchestration-v2/Adapters/OpenRouterAdapterV2.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { checkpointWorkspace } from "../../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import {
  withAgentsTaskCreationFixture,
  agentsCreationCommand,
} from "./agentsTaskCreationFixture.ts";
import {
  CommandId,
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type {
  ProviderAdapterV2Shape,
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
  ProviderAdapterV2SteerInput,
  ProviderAdapterV2Error,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { agentsCreationProvider } from "./agentsTaskCreationFixture.ts";
type ProviderInstanceId = typeof agentsCreationProvider.instanceId;
interface LinkageAdapterOptions {
  readonly supportsActiveSteering?: boolean;
  readonly governedWorker?: boolean;
  readonly startWorker?: boolean;
  readonly restartSessionOnSelectionChange?: boolean;
  readonly onSteer?: (
    input: ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly terminalOnly?: boolean;
  readonly fixtureOpenRouterModel?: string;
  readonly adapter?: ProviderAdapterV2Shape;
  readonly provider?: import("@t3tools/contracts").ServerProvider;
  readonly driver?: typeof agentsCreationProvider.driver;
  readonly appThread?: boolean;
  readonly runningFirst?: boolean;
  readonly enrichNative?: boolean;
  readonly onInterrupt?: (
    input: ProviderAdapterV2TurnInput,
    events: ReadonlyArray<ProviderAdapterV2Event>,
    emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly onStart?: (
    input: ProviderAdapterV2TurnInput,
    events: ReadonlyArray<ProviderAdapterV2Event>,
    emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}
function makeAdapter(
  started: Ref.Ref<ReadonlyArray<ModelSelection>>,
  instanceId: ProviderInstanceId,
  resultText: string,
  options: LinkageAdapterOptions,
  opened: Ref.Ref<number>,
  executions: Ref.Ref<ReadonlyArray<ProviderAdapterV2TurnInput>>,
): ProviderAdapterV2Shape {
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering:
        options.supportsActiveSteering ?? CodexProviderCapabilitiesV2.turns.supportsActiveSteering,
    },
  };
  const driver = options.driver ?? ProviderDriverKind.make("codex");
  return {
    instanceId: instanceId,
    driver: driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () =>
      Effect.succeed(
        options.restartSessionOnSelectionChange
          ? { type: "restart_session" }
          : { type: "apply_on_next_turn" },
      ),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        yield* Ref.update(opened, (n) => n + 1);
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const active = new Map<
          string,
          {
            input: ProviderAdapterV2TurnInput;
            events: ReadonlyArray<ProviderAdapterV2Event>;
            emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
          }
        >();
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
              yield* Ref.update(executions, (values) => [...values, input]);
              const script: Array<ProviderAdapterV2Event> = [];
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:handoff:${input.attemptId}`,
              );
              script.push({
                type: "provider_turn.updated",
                driver: driver,
                providerTurn: {
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
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                },
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
                script.push({
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
                script.push({
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
              script.push({
                type: "turn.terminal",
                driver: driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
              const first = script[0]!;
              if (first.type !== "provider_turn.updated") throw new Error("Missing root script");
              const root = { ...first, ...(options.appThread ? { threadId: input.threadId } : {}) };
              const terminal = script.at(-1)!;
              const middle = script.slice(1, -1);
              const completed = options.enrichNative
                ? {
                    ...root,
                    providerTurn: {
                      ...root.providerTurn,
                      nativeTurnRef: {
                        driver,
                        nativeId: `enriched:${input.attemptId}`,
                        strength: "strong" as const,
                      },
                    },
                  }
                : root;
              const delivery = options.runningFirst
                ? [
                    {
                      ...root,
                      providerTurn: {
                        ...root.providerTurn,
                        status: "running" as const,
                        completedAt: null,
                      },
                    },
                    ...middle,
                    completed,
                    terminal,
                  ]
                : [completed, ...middle, terminal];
              const emit = (event: ProviderAdapterV2Event) =>
                Queue.offer(events, event).pipe(Effect.asVoid);
              active.set(input.providerThread.id, { input, events: delivery, emit });
              if (options.onStart) yield* options.onStart(input, delivery, emit);
              else yield* Effect.forEach(delivery, emit, { discard: true });
            }),
          steerTurn: (input) => options.onSteer?.(input) ?? Effect.void,
          interruptTurn: (input) =>
            Effect.gen(function* () {
              const turn = active.get(input.providerThread.id);
              if (turn !== undefined && options.onInterrupt !== undefined)
                yield* options.onInterrupt(turn.input, turn.events, turn.emit);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const makeTaskResultLinkageAdapter = (options: LinkageAdapterOptions = {}) =>
  Effect.gen(function* () {
    const started = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    const opened = yield* Ref.make(0);
    const executions = yield* Ref.make<ReadonlyArray<ProviderAdapterV2TurnInput>>([]);
    return {
      started,
      opened,
      executions,
      adapter: makeAdapter(
        started,
        agentsCreationProvider.instanceId,
        "Linked task output",
        options,
        opened,
        executions,
      ),
    };
  });

type BaseFixture = Parameters<Parameters<typeof withAgentsTaskCreationFixture>[0]>[0];
function linkageOperations(
  f: BaseFixture,
  settlements: Queue.Queue<string>,
  provider?: import("@t3tools/contracts").ServerProvider,
  terminalOnly = false,
) {
  const settle = (key: string) =>
    Stream.fromQueue(settlements).pipe(
      Stream.filter((messageId) => messageId === key),
      Stream.take(1),
      Stream.runDrain,
    );
  const createTask = (key: string) =>
    Effect.gen(function* () {
      const command = {
        ...agentsCreationCommand(key),
        ...(provider
          ? {
              modelSelection: { instanceId: provider.instanceId, model: provider.models[0]!.slug },
              taskCreationReview: {
                ...agentsCreationCommand(key).taskCreationReview!,
                modelSelection: {
                  instanceId: provider.instanceId,
                  model: provider.models[0]!.slug,
                },
              },
            }
          : {}),
        taskContract: {
          goal: `Run linkage ${key}`,
          redirect: "Keep disposable fixture scope",
          acceptance: "Owner checks linked output",
          brake: { maxProviderStarts: 3, stopConditions: "Scope changed" },
        },
      };
      yield* f.dispatch(command);
      return command;
    });
  const execute = (
    creation: ReturnType<typeof agentsCreationCommand>,
    key: string,
    routing: Partial<
      Pick<
        Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
        "routingMode" | "modelSelection" | "dispatchMode" | "sourcePlanRef" | "capabilityStep"
      >
    > = {},
    afterDispatch: () => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const completed = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.payload.userMessageId === key &&
              ["completed", "failed", "cancelled", "interrupted"].includes(e.payload.status),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId: creation.threadId,
          messageId: MessageId.make(key),
          text: key,
          attachments: [],
          routingMode: provider?.driver === "openrouter" ? "manual" : "auto",
          ...(provider?.driver === "openrouter"
            ? {
                modelSelection: {
                  instanceId: provider.instanceId,
                  model: provider.models[0]!.slug,
                },
              }
            : {}),
          dispatchMode: { type: "start_immediately" },
          ...routing,
          createdBy: "user",
          creationSource: "web",
        });
        yield* afterDispatch();
        yield* Fiber.join(completed);
        if (terminalOnly) {
          yield* f.worker.drain();
          return;
        }
        yield* Stream.fromQueue(settlements).pipe(
          Stream.filter((messageId) => messageId === key),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* f.worker.drain();
      }),
    );
  const rebuild = ProjectionMaintenance.ProjectionMaintenanceV2.use(
    (maintenance) => maintenance.rebuild,
  ).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
      ),
    ),
    Effect.provideService(SqlClient.SqlClient, f.sql),
  );
  return { createTask, execute, rebuild, settle };
}

export const withTaskResultLinkageFixture = <E>(
  check: (
    fixture: BaseFixture &
      ReturnType<typeof linkageOperations> & {
        readonly dbPath: string;
        readonly started: Ref.Ref<ReadonlyArray<ModelSelection>>;
        readonly opened: Ref.Ref<number>;
        readonly executions: Ref.Ref<ReadonlyArray<ProviderAdapterV2TurnInput>>;
      },
  ) => Effect.Effect<void, E, Scope.Scope>,
  options: LinkageAdapterOptions &
    Pick<
      NonNullable<Parameters<typeof withAgentsTaskCreationFixture>[1]>,
      | "dbPath"
      | "decorateEventSink"
      | "runContinuationWorker"
      | "decorateSavedPrRead"
      | "useProjectRuntimePolicy"
    > = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "b3r-linkage-a2-" });
      const dbPath = options.dbPath ?? path.join(directory, "state.sqlite");
      const cwd = yield* checkpointWorkspace("task-result-linkage");
      if (options.fixtureOpenRouterModel) {
        const model = options.fixtureOpenRouterModel;
        options = {
          ...options,
          governedWorker: true,
          provider: {
            ...agentsCreationProvider,
            driver: OPENROUTER_DRIVER,
            models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
          },
          adapter: makeOpenRouterAdapter({
            instanceId: agentsCreationProvider.instanceId,
            enabled: true,
            models: [model],
            apiKey: Effect.succeed("synthetic-fixture-key"),
            fetch: async () =>
              new Response(
                'data: {"id":"gen-local-fixture","model":"fixture/resolved-model","choices":[{"delta":{"content":"LOCAL/FIXTURE streamed output"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } },
              ),
          }),
        };
      }
      const fake = yield* makeTaskResultLinkageAdapter(options);
      const adapter = options.adapter ?? fake.adapter;
      yield* withAgentsTaskCreationFixture(
        (f) =>
          Effect.gen(function* () {
            yield* f.sql`UPDATE projection_projects SET workspace_root=${cwd} WHERE project_id='project-a'`;
            f.setProviders([
              options.provider ?? { ...agentsCreationProvider, driver: adapter.driver },
            ]);
            const settlements = yield* Queue.unbounded<string>();
            const notified = new Set<string>();
            const govern = <A, E>(effect: Effect.Effect<A, E>) =>
              options.governedWorker ? f.governWorker(effect) : effect;
            const worker = {
              ...f.worker,
              drain: () => govern(f.worker.drain()),
              runOnce: govern(f.worker.runOnce).pipe(
                Effect.tap((worked) =>
                  !worked
                    ? Effect.void
                    : Effect.gen(function* () {
                        const rows = yield* f.sql<{ message_id: string }>`
                  SELECT json_extract(r.payload_json,'$.userMessageId') AS message_id
                  FROM orchestration_v2_effect_outbox e JOIN orchestration_v2_projection_runs r
                    ON r.run_id=json_extract(e.payload_json,'$.runId')
                  WHERE e.effect_type='checkpoint.capture' AND e.status='succeeded'`;
                        for (const row of rows)
                          if (!notified.has(row.message_id)) {
                            notified.add(row.message_id);
                            yield* Queue.offer(settlements, row.message_id);
                          }
                      }).pipe(Effect.orDie),
                ),
              ),
            };
            if (options.startWorker !== false)
              yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
                Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
                Effect.forkScoped,
              );
            const operations = linkageOperations(
              { ...f, worker },
              settlements,
              options.provider,
              options.terminalOnly,
            );
            yield* check({
              ...f,
              worker,
              dbPath,
              started: fake.started,
              opened: fake.opened,
              executions: fake.executions,
              ...operations,
            });
          }),
        {
          dbPath,
          useProjectRuntimePolicy: options.useProjectRuntimePolicy ?? false,
          ...(options.decorateSavedPrRead
            ? { decorateSavedPrRead: options.decorateSavedPrRead }
            : {}),
          runContinuationWorker: options.runContinuationWorker ?? false,
          adapterRegistryLayer: ProviderAdapterRegistry.makeLayer([adapter]),
          ...(options.decorateEventSink === undefined
            ? {}
            : { decorateEventSink: options.decorateEventSink }),
        },
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));
