import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as McpRegistry from "../../mcp/McpSessionRegistry.testkit.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
} from "../../orchestration-v2/runtimeLayer.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as TaskBrakeWorker from "../TaskBrakeWorker.ts";
import { authorizeDispatch, revalidateOutboxEffect } from "../Base3PolicyGate.ts";
import { PolicyExecutionContext } from "../executionContext.ts";

const environmentId = EnvironmentId.make("deadline-test");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "fake-model" };
const provider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-14T00:00:00Z",
  models: [{ slug: "fake-model", name: "Fake", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
export type InterruptReceipt = {
  sessionId: ProviderSessionId;
  providerThreadId: ProviderThreadId;
  providerTurnId: ProviderTurnId;
};

export const makeTaskBrakeFixture = Effect.fn("makeTaskBrakeFixture")(function* (
  options: {
    readonly dbPath?: string;
  } = {},
) {
  const calls = yield* Ref.make<ReadonlyArray<InterruptReceipt>>([]);
  const receipts = yield* Queue.unbounded<InterruptReceipt>();
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: () => Effect.die("seeded native thread; ensure is unused"),
          resumeThread: () => Effect.die("restart must not restore this session"),
          startTurn: () => Effect.die("watchdog must not start a turn"),
          steerTurn: () => Effect.die("watchdog must not steer a turn"),
          interruptTurn: (target) => {
            const receipt = {
              sessionId: input.providerSessionId,
              providerThreadId: target.providerThread.id,
              providerTurnId: target.providerTurnId,
            };
            return Ref.update(calls, (all) => [...all, receipt]).pipe(
              Effect.andThen(Queue.offer(receipts, receipt)),
              Effect.asVoid,
            );
          },
          respondToRuntimeRequest: () => Effect.die("unused request"),
          readThreadSnapshot: () => Effect.die("unused snapshot"),
          rollbackThread: () => Effect.die("unused rollback"),
          forkThread: () => Effect.die("unused fork"),
        };
        return runtime;
      }),
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    enabled: true,
    displayName: "Deadline fake",
    continuationIdentity: { driverKind: driver, continuationKey: "deadline:fake" },
    orchestrationAdapter: adapter,
    snapshot: {
      getSnapshot: Effect.succeed(provider),
      refresh: Effect.succeed(provider),
      streamChanges: Stream.empty,
      resolveMaintenance: () => Effect.die("unused maintenance"),
      applyUsageLimits: () => Effect.void,
    },
    textGeneration: {
      generateCommitMessage: () => Effect.die("unused generation"),
      generatePrContent: () => Effect.die("unused generation"),
      generateBranchName: () => Effect.die("unused generation"),
      generateThreadTitle: () => Effect.die("unused generation"),
    },
  };
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-deadline-watchdog-" });
  const platform = Layer.merge(
    NodeServices.layer,
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused link"),
    }),
  );
  const vcs = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(config),
    Layer.provide(platform),
  );
  const database = options.dbPath
    ? makeSqlitePersistenceLive(options.dbPath).pipe(Layer.provide(NodeServices.layer))
    : SqlitePersistenceMemory;
  const runtime = Layer.mergeAll(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
    EffectOutbox.layer,
    ProjectionStore.layer,
    IdAllocator.layer,
    Scheduler.layer,
  ).pipe(
    Layer.provide(McpRegistry.layer),
    Layer.provide(database),
    Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcs))),
    Layer.provide(config),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.die("watchdog must not create worktrees"),
      }),
    ),
    Layer.provide(platform),
  );
  const providerFacts = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([provider]),
  });
  const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const dependencies = Layer.mergeAll(runtime, database, providerFacts, environment);
  return { calls, receipts, dependencies };
});

export const seedSilentTask = Effect.fn("seedSilentTask")(function* (input: {
  readonly name?: string;
  readonly deadlineAt?: string;
  readonly governance?: "required" | "chat";
  readonly liveSession?: boolean;
}) {
  const name = input.name ?? "silent";
  const threadId = ThreadId.make(`thread:${name}`),
    runId = RunId.make(`run:${name}`);
  const messageId = MessageId.make(`message:${name}`),
    attemptId = RunAttemptId.make(`attempt:${name}`);
  const sessionId = ProviderSessionId.make(`session:${name}`),
    nativeThreadId = ProviderThreadId.make(`native-thread:${name}`);
  const turnId = ProviderTurnId.make(`turn:${name}`),
    nodeId = NodeId.make(`node:${name}`);
  const now = yield* DateTime.now;
  const sink = yield* EventSink.EventSinkV2;
  const contract = {
    revision: 1,
    goal: "Finish the bounded task",
    redirect: "Ask before expanding",
    acceptance: "Regression passes",
    brake: {
      maxProviderStarts: 2,
      stopConditions: "Stop at the frozen deadline",
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    },
  };
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:deadline"),
    title: "Silent task",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: nativeThreadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    ...(input.governance === "chat"
      ? {}
      : {
          taskGovernance: "required" as const,
          taskContract: contract,
          taskContractPhase: "active" as const,
          taskAcceptedRevision: null,
        }),
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`create:${name}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  yield* authorizeDispatch({
    type: "message.dispatch",
    commandId: `admit:${name}`,
    threadId,
    messageId,
    runId,
    text: "Initial task input",
    modelSelection,
    routingMode: "manual",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  }).pipe(
    Effect.provideService(PolicyExecutionContext, {
      kind: "session",
      actorId: "deadline-owner",
      sessionId: "owner-session",
      scopes: [AuthOrchestrationOperateScope],
    }),
  );
  if (input.liveSession !== false) {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* sessions.open({
      threadId,
      providerSessionId: sessionId,
      modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });
  }
  const providerThread: OrchestrationV2ProviderThread = {
    id: nativeThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: sessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const turn: OrchestrationV2ProviderTurn = {
    id: turnId,
    providerThreadId: nativeThreadId,
    nodeId,
    runAttemptId: attemptId,
    nativeTurnRef: { driver, nativeId: `native-turn:${name}`, strength: "strong" },
    ordinal: 1,
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: nativeThreadId,
    userMessageId: messageId,
    rootNodeId: nodeId,
    activeAttemptId: attemptId,
    status: "running",
    queuePosition: null,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId: nodeId,
    providerInstanceId: instanceId,
    providerThreadId: nativeThreadId,
    providerTurnId: turnId,
    reason: "initial",
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId,
    runId,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "root_turn",
    status: "running",
    countsForRun: true,
    providerThreadId: nativeThreadId,
    providerTurnId: turnId,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const message: OrchestrationV2ConversationMessage = {
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: "Initial task input",
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`message:${name}`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: message,
      },
      {
        id: EventId.make(`run:${name}`),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make(`attempt:${name}`),
        type: "run-attempt.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: attempt,
      },
      {
        id: EventId.make(`native:${name}`),
        type: "provider-thread.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: providerThread,
      },
      {
        id: EventId.make(`turn:${name}`),
        type: "provider-turn.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: turn,
      },
      {
        id: EventId.make(`node:${name}`),
        type: "node.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: node,
      },
    ],
  });
  yield* revalidateOutboxEffect({
    threadId,
    commandId: `admit:${name}`,
    attemptCount: 0,
    request: { type: "provider-turn.start", runId },
  }).pipe(Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }));
  return { threadId, runId, messageId, attemptId, sessionId, nativeThreadId, turnId, turn, thread };
});

export const startWatchdogRuntime = Effect.gen(function* () {
  // Presence comes from the production runtime layer; the old baseline has no watchdog service.
  const watchdog = yield* Effect.serviceOption(TaskBrakeWorker.TaskBrakeWorker);
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const settled = yield* Queue.unbounded<void>();
  const fiber = yield* Effect.all(
    [
      EffectWorker.runDaemonWithOptions({ concurrency: 1, livenessPollIntervalMs: 300_000 }).pipe(
        Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, {
          ...worker,
          runOnce: worker.runOnce.pipe(
            Effect.tap((worked) => (worked ? Queue.offer(settled, undefined) : Effect.void)),
          ),
        }),
      ),
      Option.isSome(watchdog) ? watchdog.value.run : Effect.never,
    ],
    { concurrency: "unbounded", discard: true },
  ).pipe(
    Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
    Effect.forkScoped,
  );
  return { fiber, settled };
});

export const stopWatchdogRuntime = (runtime: Effect.Success<typeof startWatchdogRuntime>) =>
  Fiber.interrupt(runtime.fiber);

export const confirmTerminal = Effect.fn("confirmTerminal")(function* (
  seed: Effect.Success<ReturnType<typeof seedSilentTask>>,
) {
  const now = yield* DateTime.now;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  yield* ingestor.ingestNormalized({
    providerSessionId: seed.sessionId,
    providerInstanceId: instanceId,
    threadId: seed.threadId,
    runId: seed.runId,
    event: {
      type: "provider_turn.updated",
      driver,
      threadId: seed.threadId,
      providerTurn: { ...seed.turn, status: "interrupted", completedAt: now },
    },
  });
});

export const ingestionLayer = ProviderEventIngestor.layer;
