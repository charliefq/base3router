import { assert, it } from "@effect/vitest";
import {
  DISPATCHER_POLICY_VERSION,
  EnvironmentId,
  EventId,
  MessageId,
  MODEL_ROUTER_DEFAULT_POLICY,
  MODEL_ROUTER_POLICY_VERSION,
  NodeId,
  ProjectId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { persistDispatcherTaskRoute } from "../dispatcher/Dispatcher.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RouterEvaluationService, layer as evaluationLayer } from "./RouterEvaluationService.ts";

const environmentId = EnvironmentId.make("lab-environment");
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.5" };

const database = SqlitePersistenceMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const environmentLayer = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("descriptor unused"),
});
const TestLayer = Layer.mergeAll(
  stores,
  sink,
  IdAllocator.layer,
  evaluationLayer.pipe(Layer.provide(database)),
  environmentLayer,
  ProviderEventIngestor.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink, IdAllocator.layer))),
);

const provideTestLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestLayer));

const binding = (attempts: number) => ({
  policyVersion: DISPATCHER_POLICY_VERSION,
  target: { instanceId: providerInstanceId, model: "gpt-5.5" },
  driver,
  modelFamily: "gpt",
  fallbackIndex: 0,
  source: "provider-default" as const,
  gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED" as const] },
  modelRoute: {
    policyVersion: MODEL_ROUTER_POLICY_VERSION,
    mode: "auto" as const,
    task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: [] },
    policy: MODEL_ROUTER_DEFAULT_POLICY,
    selected: null,
    fallbacks: [],
    candidates: [],
    reasonCodes: ["SELECTED" as const],
    explanation: "Router V0 selected the default.",
    estimatedCostUsd: { status: "unknown" as const },
    estimatedLatencyMs: { status: "unknown" as const },
    estimatedQuality: { status: "unknown" as const },
    executionStatus: "bound" as const,
    attemptBudget: 3,
    attempts: Array.from({ length: attempts }, (_, index) => ({
      attempt: index,
      target: { instanceId: providerInstanceId, model: "gpt-5.5" },
      driver,
      outcome: index === attempts - 1 ? ("succeeded" as const) : ("failed" as const),
      fallbackAllowed: true,
    })),
  },
});

function threadCreated(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2DomainEvent {
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-outcome"),
    title: "Outcome capture",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  };
}

function messageUpdated(
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent {
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "user",
    creationSource: "web",
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: "complete the turn",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: EventId.make(`event:${messageId}:updated`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: message,
  };
}

function runUpdated(
  threadId: ThreadId,
  runId: RunId,
  messageId: MessageId,
  now: DateTime.Utc,
  ordinal = 1,
): OrchestrationV2DomainEvent {
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    queuePosition: null,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    id: EventId.make(`event:${runId}:updated`),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: run,
  };
}

const providerTurn = (
  now: DateTime.Utc,
  status: OrchestrationV2ProviderTurn["status"],
  nativeTurnId: string,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`turn:${nativeTurnId}`),
  providerThreadId: ProviderThreadId.make(`provider-thread-${nativeTurnId}`),
  nodeId: NodeId.make(`node:${nativeTurnId}`),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status,
  startedAt: now,
  completedAt: status === "pending" || status === "running" ? null : now,
  turnTokenUsage: {
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens: 4,
    cachedInputTokens: 0,
    outputTokens: 2,
  },
});

const seed = (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly attempts?: number;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: [
        threadCreated(input.threadId, now),
        messageUpdated(input.threadId, input.messageId, input.runId, now),
        runUpdated(input.threadId, input.runId, input.messageId, now),
      ],
    });
    yield* persistDispatcherTaskRoute({
      threadId: input.threadId,
      messageId: input.messageId,
      binding: binding(input.attempts ?? 1),
      createdAt: DateTime.formatIso(now),
    });
    return now;
  });

const ingest = (input: {
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly turn: OrchestrationV2ProviderTurn;
}) =>
  Effect.gen(function* () {
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    yield* ingestor.ingestNormalized({
      providerSessionId: yield* idAllocator.allocate.providerSession({
        providerInstanceId,
        threadId: input.threadId,
      }),
      providerInstanceId,
      threadId: input.threadId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      event: {
        type: "provider_turn.updated",
        driver,
        providerTurn: input.turn,
      },
    });
  });

it.effect("records one durable observation from a completed fake-provider turn", () =>
  provideTestLayer(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-outcome-success");
      const messageId = MessageId.make("message-outcome-success");
      const runId = RunId.make("run-outcome-success");
      const now = yield* seed({ threadId, messageId, runId });
      yield* ingest({
        threadId,
        runId,
        turn: providerTurn(now, "completed", "success"),
      });
      const evaluation = yield* RouterEvaluationService;
      const latest = yield* evaluation.latestObservationForThread(environmentId, threadId);
      if (latest._tag !== "Some") {
        assert.fail("expected a durable observation");
        return;
      }
      const observation = latest.value;
      assert.equal(observation.observationId, `${environmentId}:${threadId}:${messageId}`);
      assert.equal(observation.terminalCategory, "success");
      assert.equal(observation.model, "gpt-5.5");
      assert.equal(observation.driver, driver);
      assert.equal(observation.routingMode, "auto");
      assert.equal(observation.cost.reportedUsd.status, "unknown");
      assert.equal(observation.cost.estimatedUsd.status, "unknown");
      assert.equal(observation.providerAttempts, 1);
    }),
  ),
);

it.effect("classifies failure, interruption, and cancellation without inventing cost", () =>
  provideTestLayer(
    Effect.gen(function* () {
      const evaluation = yield* RouterEvaluationService;
      for (const [status, category] of [
        ["failed", "provider_failure"],
        ["interrupted", "infrastructure_failure"],
        ["cancelled", "cancelled"],
      ] as const) {
        const threadId = ThreadId.make(`thread-outcome-${status}`);
        const messageId = MessageId.make(`message-outcome-${status}`);
        const runId = RunId.make(`run-outcome-${status}`);
        const now = yield* seed({ threadId, messageId, runId });
        yield* ingest({
          threadId,
          runId,
          turn: providerTurn(now, status, status),
        });
        const latest = yield* evaluation.latestObservationForThread(environmentId, threadId);
        if (latest._tag !== "Some") {
          assert.fail(`expected observation for ${status}`);
          return;
        }
        assert.equal(latest.value.terminalCategory, category);
        assert.equal(latest.value.cost.reportedUsd.status, "unknown");
      }
    }),
  ),
);

it.effect("preserves failover attempt identity on the observation", () =>
  provideTestLayer(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-outcome-failover");
      const messageId = MessageId.make("message-outcome-failover");
      const runId = RunId.make("run-outcome-failover");
      const now = yield* seed({ threadId, messageId, runId, attempts: 2 });
      yield* ingest({
        threadId,
        runId,
        turn: providerTurn(now, "completed", "failover"),
      });
      const evaluation = yield* RouterEvaluationService;
      const latest = yield* evaluation.latestObservationForThread(environmentId, threadId);
      if (latest._tag !== "Some") {
        assert.fail("expected failover observation");
        return;
      }
      assert.equal(latest.value.providerAttempts, 2);
      assert.equal(latest.value.fallbackCount, 1);
      assert.equal(latest.value.model, "gpt-5.5");
    }),
  ),
);

it.effect("does not record a second observation for a duplicate terminal event", () =>
  provideTestLayer(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-outcome-duplicate");
      const messageId = MessageId.make("message-outcome-duplicate");
      const runId = RunId.make("run-outcome-duplicate");
      const now = yield* seed({ threadId, messageId, runId });
      const turn = providerTurn(now, "completed", "duplicate");
      yield* ingest({ threadId, runId, turn });
      yield* ingest({ threadId, runId, turn });
      const evaluation = yield* RouterEvaluationService;
      const latest = yield* evaluation.latestObservationForThread(environmentId, threadId);
      if (latest._tag !== "Some") {
        assert.fail("expected one observation");
        return;
      }
      assert.equal(latest.value.observationId, `${environmentId}:${threadId}:${messageId}`);
      const exported = yield* evaluation.exportObservations(environmentId);
      assert.equal(
        exported.records.filter((record) =>
          record.observationId.endsWith(`:${threadId}:${messageId}`),
        ).length,
        1,
      );
    }),
  ),
);

it.effect("records a new observation after restart with a new message identity", () =>
  provideTestLayer(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-outcome-restart");
      const firstMessage = MessageId.make("message-outcome-restart-1");
      const secondMessage = MessageId.make("message-outcome-restart-2");
      const firstRun = RunId.make("run-outcome-restart-1");
      const secondRun = RunId.make("run-outcome-restart-2");
      const now = yield* seed({ threadId, messageId: firstMessage, runId: firstRun });
      yield* ingest({
        threadId,
        runId: firstRun,
        turn: providerTurn(now, "completed", "restart-1"),
      });
      yield* persistDispatcherTaskRoute({
        threadId,
        messageId: secondMessage,
        binding: binding(1),
        createdAt: DateTime.formatIso(now),
      });
      const eventSink = yield* EventSink.EventSinkV2;
      yield* eventSink.write({
        events: [
          messageUpdated(threadId, secondMessage, secondRun, now),
          runUpdated(threadId, secondRun, secondMessage, now, 2),
        ],
      });
      yield* ingest({
        threadId,
        runId: secondRun,
        turn: providerTurn(now, "completed", "restart-2"),
      });
      const evaluation = yield* RouterEvaluationService;
      const exported = yield* evaluation.exportObservations(environmentId);
      const records = exported.records.filter((record) =>
        record.observationId.startsWith(`${environmentId}:${threadId}:`),
      );
      assert.equal(records.length, 2);
      assert.equal(new Set(records.map((record) => record.observationId)).size, 2);
    }),
  ),
);

it.effect("skips persist when the run id is missing and when the turn is still running", () =>
  provideTestLayer(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-outcome-skip");
      const messageId = MessageId.make("message-outcome-skip");
      const runId = RunId.make("run-outcome-skip");
      const now = yield* seed({ threadId, messageId, runId });
      yield* ingest({
        threadId,
        turn: providerTurn(now, "completed", "missing-run"),
      });
      yield* ingest({
        threadId,
        runId,
        turn: providerTurn(now, "running", "still-running"),
      });
      const evaluation = yield* RouterEvaluationService;
      const latest = yield* evaluation.latestObservationForThread(environmentId, threadId);
      assert.equal(latest._tag, "None");
    }),
  ),
);
