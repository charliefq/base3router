import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { readGovernanceSnapshot } from "./GovernanceProjection.ts";
import {
  authorizeDispatch,
  countOccupied,
  noteUnconfirmedDisconnect,
  revalidateOutboxEffect,
} from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread-1");
const messageA = MessageId.make("message-1");
const messageB = MessageId.make("message-b");
const runA = RunId.make("run-a");
const runB = RunId.make("run-b");
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-work");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const provider: ServerProvider = {
  instanceId: providerInstanceId,
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-05T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const session = {
  kind: "session" as const,
  actorId: "user-1",
  sessionId: "session-1",
  scopes: [AuthOrchestrationOperateScope],
};

const providerLayer = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([provider]),
  refresh: () => Effect.succeed([provider]),
  refreshInstance: () => Effect.succeed([provider]),
  refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
  getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
  setProviderMaintenanceActionState: () => Effect.succeed([provider]),
  streamChanges: Stream.empty,
});

const database = SqlitePersistenceMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const TestLayer = Layer.mergeAll(
  stores,
  sink,
  IdAllocator.layer,
  providerLayer,
  Layer.succeed(ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("descriptor unused"),
  }),
  ProviderEventIngestor.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink, IdAllocator.layer))),
);

const dispatch = (messageId: string, commandId: string) =>
  authorizeDispatch({
    type: "message.dispatch",
    commandId,
    threadId,
    messageId,
    text: "Keep working.",
    modelSelection,
    routingMode: "manual",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  }).pipe(Effect.provideService(PolicyExecutionContext, session));

const occupied = (sql: SqlClient.SqlClient) => countOccupied({ sql, environmentId, threadId });

const bindStart = (runId: string, messageId: string) =>
  revalidateOutboxEffect({
    threadId,
    request: { type: "provider-turn.start", runId, messageId },
  }).pipe(Effect.provideService(PolicyExecutionContext, session));

function threadCreated(now: DateTime.Utc): OrchestrationV2DomainEvent {
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-lease"),
    title: "Continuing provider",
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
    id: EventId.make("event:thread-1:created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  };
}

function messageUpdated(
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
    text: "Keep working.",
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
  runId: RunId,
  messageId: MessageId,
  now: DateTime.Utc,
  ordinal: number,
  status: OrchestrationV2Run["status"] = "running",
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
    status,
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
});

const ingestTerminal = (runId: RunId, turn: OrchestrationV2ProviderTurn) =>
  Effect.gen(function* () {
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    yield* ingestor.ingestNormalized({
      providerSessionId: yield* idAllocator.allocate.providerSession({
        providerInstanceId,
        threadId,
      }),
      providerInstanceId,
      threadId,
      runId,
      event: {
        type: "provider_turn.updated",
        driver,
        providerTurn: turn,
      },
    });
  });

it.effect("keeps capacity until the fake provider confirms a matching terminal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fake = yield* Ref.make({ active: false, startCount: 0, streamOpen: true });
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        threadCreated(now),
        messageUpdated(messageA, runA, now),
        runUpdated(runA, messageA, now, 1),
      ],
    });
    yield* dispatch(messageA, "command-a");
    yield* bindStart(runA, messageA);
    yield* Ref.update(fake, (state) => ({
      ...state,
      active: true,
      startCount: state.startCount + 1,
    }));
    expect(yield* occupied(sql)).toBe(1);
    expect((yield* Ref.get(fake)).startCount).toBe(1);
    expect((yield* Ref.get(fake)).active).toBe(true);

    yield* revalidateOutboxEffect({
      threadId,
      request: { type: "provider-turn.interrupt", runId: runA },
    }).pipe(Effect.provideService(PolicyExecutionContext, session));
    const interruptFlags = yield* sql<{ readonly interrupt_requested: number }>`
      SELECT interrupt_requested FROM base3_capacity_leases WHERE run_id = ${runA}
    `;
    expect(interruptFlags[0]?.interrupt_requested).toBe(1);
    expect((yield* Ref.get(fake)).active).toBe(true);
    expect(yield* occupied(sql)).toBe(1);
    const blockedAfterInterrupt = yield* Effect.flip(dispatch(messageB, "command-b-interrupt"));
    expect(blockedAfterInterrupt.reason).toBe("capacity");
    expect((yield* Ref.get(fake)).startCount).toBe(1);

    yield* Ref.update(fake, (state) => ({ ...state, streamOpen: false }));
    yield* noteUnconfirmedDisconnect({ threadId, runId: runA });
    expect((yield* Ref.get(fake)).streamOpen).toBe(false);
    expect((yield* Ref.get(fake)).active).toBe(true);
    expect(yield* occupied(sql)).toBe(1);
    const blockedAfterClose = yield* Effect.flip(dispatch(messageB, "command-b-close"));
    expect(blockedAfterClose.reason).toBe("capacity");
    expect((yield* Ref.get(fake)).startCount).toBe(1);

    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted' WHERE run_id = ${runA}`;
    expect((yield* Ref.get(fake)).active).toBe(true);
    expect(yield* occupied(sql)).toBe(1);
    const snapshot = yield* readGovernanceSnapshot({ threadId }).pipe(
      Effect.provideService(PolicyExecutionContext, session),
    );
    expect(snapshot.leases.some((lease) => lease.occupied)).toBe(true);
    const blockedAfterProjection = yield* Effect.flip(dispatch(messageB, "command-b-projection"));
    expect(blockedAfterProjection.reason).toBe("capacity");
    expect((yield* Ref.get(fake)).startCount).toBe(1);

    const terminal = providerTurn(now, "interrupted", "a");
    yield* ingestTerminal(runA, terminal);
    yield* Ref.update(fake, (state) => ({ ...state, active: false }));
    expect((yield* Ref.get(fake)).active).toBe(false);
    expect(yield* occupied(sql)).toBe(0);

    yield* eventSink.write({
      events: [messageUpdated(messageB, runB, now), runUpdated(runB, messageB, now, 2)],
    });
    yield* dispatch(messageB, "command-b");
    yield* bindStart(runB, messageB);
    yield* Ref.update(fake, (state) => ({
      ...state,
      active: true,
      startCount: state.startCount + 1,
    }));
    expect((yield* Ref.get(fake)).startCount).toBe(2);
    expect(yield* occupied(sql)).toBe(1);

    yield* ingestTerminal(runA, terminal);
    yield* ingestTerminal(runA, providerTurn(now, "completed", "a-late"));
    expect((yield* Ref.get(fake)).startCount).toBe(2);
    expect(yield* occupied(sql)).toBe(1);
  }).pipe(Effect.provide(TestLayer)),
);
