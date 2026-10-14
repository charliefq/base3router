import * as Schema from "effect/Schema";
import { DispatcherTaskRouteBinding as BindingSchema } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { withTaskResultFeedbackEffects } from "../collaboration/testkit/taskResultFeedbackFixture.ts";
import { expect } from "vite-plus/test";
import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import { emptyLocalEvidence, routeHybridModel } from "@t3tools/shared/hybridRouter";
import { assert, it } from "@effect/vitest";
import {
  DISPATCHER_POLICY_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  type DispatcherTaskRouteBinding,
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

const decodeOutcomeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(BindingSchema));
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
  readonly bound?: DispatcherTaskRouteBinding;
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
      binding: input.bound ?? binding(input.attempts ?? 1),
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

it.effect(
  "records bound task policy and local profile even when current environment policy is V0",
  () =>
    provideTestLayer(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-task-policy-outcome");
        const messageId = MessageId.make("message-task-policy-outcome");
        const runId = RunId.make("run-task-policy-outcome");
        const profile = classifyLocalTask("debug this exception");
        const routed = routeHybridModel({
          mode: "auto",
          executionStatus: "bound",
          activePolicyVersion: HYBRID_TASK_ROUTER_POLICY_VERSION,
          localTaskProfile: profile,
          catalog: [
            {
              instanceId: providerInstanceId,
              driver,
              model: "gpt-5.5",
              isDefault: true,
              capabilities: ["code", "tools"],
              availabilityReasons: [],
            },
          ],
          evidenceByTarget: new Map([
            [
              `${providerInstanceId}\u0000gpt-5.5`,
              { ...emptyLocalEvidence(), successTrials: 8, successCount: 8 },
            ],
          ]),
        });
        assert.equal(routed.hybrid.usedHybridRanking, true);
        const bound: DispatcherTaskRouteBinding = {
          ...binding(1),
          modelRoute: routed.decision,
          hybrid: routed.hybrid,
          localTaskProfile: profile,
        };
        const now = yield* seed({ threadId, messageId, runId, bound });
        const evaluation = yield* RouterEvaluationService;
        assert.equal(
          yield* evaluation.activePolicyVersion(environmentId),
          MODEL_ROUTER_POLICY_VERSION,
        );
        const turn = providerTurn(now, "completed", "task-policy");
        yield* ingest({ threadId, runId, turn });
        yield* ingest({ threadId, runId, turn });
        const latest = yield* evaluation.latestObservationForThread(environmentId, threadId);
        assert.equal(latest._tag, "Some");
        if (latest._tag !== "Some") return;
        assert.equal(latest.value.policyVersion, HYBRID_TASK_ROUTER_POLICY_VERSION);
        assert.deepEqual(latest.value.localTaskProfile, profile);
        assert.equal(latest.value.taskProfile.macroCategory, "unknown");
        assert.equal(yield* evaluation.observationCount(environmentId), 1);
      }),
    ),
);

it.effect("certifies an actual empty-bound dispatcher outcome at the running capture phase", () =>
  withTaskResultFeedbackEffects((f) =>
    Effect.gen(function* () {
      expect(f.capturePhase).toEqual({ run: "running", attempt: "running", attemptTurn: null });
      const capturedBinding = yield* decodeOutcomeBinding(f.bindingBefore);
      expect(capturedBinding.modelRoute?.attempts).toEqual([]);
      expect(f.observation.providerAttempts).toBe(1);
      expect(f.observation.fallbackCount).toBe(0);
      const route = yield* f.sql<{
        binding_json: string;
      }>`SELECT binding_json FROM projection_dispatcher_task_routes`;
      expect(route[0]?.binding_json).toBe(f.bindingBefore);
    }),
  ),
);

type CaptureIds = { run: string; attempt: string; turn: string; thread: string; message: string };
type MutateCapture = (
  sql: SqlClient.SqlClient,
  ids: CaptureIds,
) => Effect.Effect<void, import("effect/unstable/sql/SqlError").SqlError>;
const certificationFailures: {
  name: string;
  phase: "beforeCapture" | "afterProjection";
  mutate: MutateCapture;
}[] = [
  {
    name: "a second run for the message",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO orchestration_v2_projection_runs SELECT run_id||':extra',thread_id,ordinal+1,provider,provider_thread_id,status,requested_at,completed_at,json_set(payload_json,'$.id',run_id||':extra','$.ordinal',ordinal+1),provider_instance_id FROM orchestration_v2_projection_runs WHERE run_id=${id.run}`;
      }),
  },
  ...["retry", "provider_recovery"].map((reason) => ({
    name: `an extra ${reason} attempt`,
    phase: "beforeCapture" as const,
    mutate: (sql: SqlClient.SqlClient, id: CaptureIds) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts SELECT attempt_id||':extra',thread_id,run_id,2,root_node_id,provider,provider_thread_id,NULL,'pending',json_set(payload_json,'$.id',attempt_id||':extra','$.attemptOrdinal',2,'$.reason',${reason},'$.status','pending'),provider_instance_id FROM orchestration_v2_projection_run_attempts WHERE run_id=${id.run}`;
      }),
  })),
  {
    name: "mismatched attempt root",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_run_attempts SET root_node_id='forged' WHERE run_id=${id.run}`;
      }),
  },
  {
    name: "mismatched provider instance",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_run_attempts SET provider_instance_id='forged' WHERE run_id=${id.run}`;
      }),
  },
  {
    name: "a changed configured model",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection.model','forged') WHERE run_id=${id.run}`;
      }),
  },
  {
    name: "malformed run payload",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json='malformed' WHERE run_id=${id.run}`;
      }),
  },
  {
    name: "a child rather than governed root",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','foreign-root','$.lineage.parentThreadId','foreign-root','$.lineage.relationshipToParent','subagent') WHERE thread_id=${id.thread}`;
      }),
  },
  {
    name: "mismatched root times",
    phase: "beforeCapture",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_nodes SET started_at='malformed' WHERE thread_id=${id.thread} AND kind='root_turn'`;
      }),
  },
  {
    name: "missing usage start",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM task_usage_attempts WHERE provider_turn_id=${id.turn}`;
      }),
  },
  {
    name: "wrong usage environment",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE task_usage_attempts SET environment_id='foreign-environment' WHERE provider_turn_id=${id.turn}`;
      }),
  },
  {
    name: "wrong usage root",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE task_usage_attempts SET root_thread_id='foreign-root' WHERE provider_turn_id=${id.turn}`;
      }),
  },
  {
    name: "contradictory failover usage",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE task_usage_attempts SET attempt_role='failover' WHERE provider_turn_id=${id.turn}`;
      }),
  },
  {
    name: "unresolved extra start evidence",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO task_usage_attempts (environment_id,provider_turn_id,root_thread_id,thread_id,run_id,message_id,contract_revision,provider_instance_id,status,attempt_role,usage_status,basis,updated_at) SELECT environment_id,provider_turn_id||':unresolved',root_thread_id,thread_id,NULL,NULL,contract_revision,provider_instance_id,'running','primary',usage_status,basis,updated_at FROM task_usage_attempts WHERE provider_turn_id=${id.turn}`;
      }),
  },
  {
    name: "malformed turn physical identity",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET node_id='background-node' WHERE provider_turn_id=${id.turn}`;
      }),
  },
  {
    name: "a second provider turn",
    phase: "afterProjection",
    mutate: (sql, id) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns SELECT provider_turn_id||':second',thread_id,provider_thread_id,node_id,run_attempt_id,ordinal+1,status,started_at,completed_at,json_set(payload_json,'$.id',provider_turn_id||':second','$.ordinal',ordinal+1) FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=${id.turn}`;
      }),
  },
];
it.effect.each(certificationFailures)("does not certify $name", (scenario) =>
  withTaskResultFeedbackEffects(
    (f) =>
      Effect.gen(function* () {
        expect(f.observation?.providerAttempts ?? 0).toBe(0);
        expect((yield* Effect.promise(() => f.read())).status).toBe("unavailable");
        const route = yield* f.sql<{
          binding_json: string;
        }>`SELECT binding_json FROM projection_dispatcher_task_routes`;
        expect(route[0]?.binding_json).toBe(f.bindingBefore);
      }),
    { [scenario.phase]: scenario.mutate },
  ),
);
it.effect(
  "leaves historical zero-count observations unchanged through actual fresh terminal replay",
  () =>
    withTaskResultFeedbackEffects(
      (f) =>
        Effect.gen(function* () {
          expect(f.observation.providerAttempts).toBe(0);
          const before = yield* f.evaluation.exportObservations(f.observation.environmentId);
          yield* Effect.promise(f.replay);
          const after = yield* f.evaluation.exportObservations(f.observation.environmentId);
          expect(after.records).toEqual(before.records);
          expect((yield* Effect.promise(() => f.read())).status).toBe("unavailable");
        }),
      { legacyZero: true },
    ),
);
