import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  DispatcherTaskRouteBinding,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  ModelSelection,
  type OrchestrationV2ProviderThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { argumentHash, authorizeDispatch } from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
const instanceId = ProviderInstanceId.make("fake-routing-provider");
const driver = ProviderDriverKind.make("codex");
const a: ModelSelection = { instanceId, model: "gpt-5.4" };
const b: ModelSelection = {
  instanceId: ProviderInstanceId.make("fake-manual-provider"),
  model: "gpt-5.3-codex",
};
const capabilities = CodexProviderCapabilitiesV2;
const encodeModelSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const decodeRoute = Schema.decodeEffect(Schema.fromJsonString(DispatcherTaskRouteBinding));
const session = {
  kind: "session" as const,
  actorId: "routing-user",
  sessionId: "routing-session",
  scopes: [AuthOrchestrationOperateScope],
};
const provider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  models: [a, b].map((selection) => ({
    slug: selection.model,
    name: selection.model,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
};
function makeAdapter(
  started: Ref.Ref<ReadonlyArray<ModelSelection>>,
  instanceId: ProviderInstanceId,
): ProviderAdapterV2Shape {
  return {
    instanceId: instanceId,
    driver: driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
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
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:handoff:${input.attemptId}`,
              );
              yield* Queue.offer(events, {
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
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live.each([
  { name: "auto", mode: "auto", queued: false, sameTarget: false, omitted: false, options: false },
  {
    name: "manual",
    mode: "manual",
    queued: false,
    sameTarget: false,
    omitted: false,
    options: false,
  },
  {
    name: "queued auto",
    mode: "auto",
    queued: true,
    sameTarget: false,
    omitted: false,
    options: false,
  },
  {
    name: "manual options",
    mode: "manual",
    queued: false,
    sameTarget: false,
    omitted: false,
    options: true,
  },
  {
    name: "auto same target options",
    mode: "auto",
    queued: false,
    sameTarget: true,
    omitted: false,
    options: true,
  },
  {
    name: "manual inherited options",
    mode: "manual",
    queued: false,
    sameTarget: false,
    omitted: true,
    options: true,
  },
  {
    name: "auto inherited same target options",
    mode: "auto",
    queued: false,
    sameTarget: true,
    omitted: true,
    options: true,
  },
  {
    name: "auto changed target drops options",
    mode: "auto",
    queued: false,
    sameTarget: false,
    omitted: false,
    options: true,
  },
] as const)(
  "server-bound $name preserves target, options, grant and replay",
  ({ name, mode, queued, sameTarget, omitted, options }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`bound-target-${name}`);
        const sourceSelection: ModelSelection = {
          ...(sameTarget ? a : b),
          ...(options
            ? {
                options: [
                  { id: "reasoningEffort", value: "high" },
                  { id: "serviceTier", value: "fast" },
                ],
              }
            : {}),
        };
        const started = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
        const database = SqlitePersistenceMemory;
        const runtime = Layer.mergeAll(
          database,
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([provider, { ...provider, instanceId: b.instanceId }]),
          }),
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: `bound-target-${name}` },
            ProviderAdapterRegistry.makeLayer([
              makeAdapter(started, a.instanceId),
              makeAdapter(started, b.instanceId),
            ]),
            { databaseLayer: database, runEffectWorker: !queued },
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make(`thread:${mode}`);
          const projectId = ProjectId.make(`project:${mode}`);
          const now = DateTime.formatIso(yield* DateTime.now);
          const defaultSelectionJson = yield* encodeModelSelection(a);
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at) VALUES (${projectId},'Routing fixture',${cwd},${defaultSelectionJson},'[]',${now},${now})`;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${mode}`),
            threadId,
            projectId,
            title: "Routing fixture",
            modelSelection: sourceSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const command = {
            type: "message.dispatch" as const,
            commandId: CommandId.make(`dispatch:${mode}`),
            threadId,
            messageId: MessageId.make(`message:${mode}`),
            text: "Inspect this fixture.",
            attachments: [],
            ...(omitted ? {} : { modelSelection: sourceSelection }),
            routingMode: mode,
            dispatchMode: {
              type: queued ? ("queue_after_active" as const) : ("start_immediately" as const),
            },
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          if (queued) {
            yield* orchestrator.dispatch({
              ...command,
              commandId: CommandId.make("active-foreground"),
              messageId: MessageId.make("active-foreground"),
              routingMode: "manual",
              dispatchMode: { type: "start_immediately" },
            });
          }
          const completed = queued
            ? null
            : yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) => event.type === "run.updated" && event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
          const receipt = yield* orchestrator.dispatch(command);
          if (completed !== null) {
            yield* worker.drain();
            yield* Fiber.join(completed);
            yield* worker.drain();
          }
          const expected = mode === "auto" && !sameTarget ? a : sourceSelection;
          assert.deepEqual(
            command.modelSelection,
            omitted ? undefined : sourceSelection,
            "the client input is never mutated",
          );
          assert.deepEqual(yield* Ref.get(started), queued ? [] : [expected]);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find(
            (candidate) => candidate.userMessageId === command.messageId,
          );
          assert.deepEqual(run?.modelSelection, expected);
          if (queued) assert.equal(run?.status, "queued");
          const routes = yield* sql<{
            binding: string;
          }>`SELECT binding_json AS binding FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${command.messageId}`;
          const route = yield* decodeRoute(routes[0]?.binding ?? "{}");
          assert.deepEqual(
            { instanceId: route.target.instanceId, model: route.target.model },
            { instanceId: expected.instanceId, model: expected.model },
          );
          const grants = yield* sql<{
            hash: string;
          }>`SELECT argument_hash AS hash FROM base3_execution_grants WHERE grant_id=${`grant:message:${threadId}:${command.messageId}`}`;
          assert.equal(
            grants[0]?.hash,
            argumentHash({
              text: command.text,
              model: expected.model,
              instanceId: expected.instanceId,
              attachmentIds: [],
              ...(expected.options === undefined ? {} : { options: expected.options }),
            }),
          );
          if (mode === "auto" && !sameTarget) {
            const staleTarget = yield* Effect.flip(
              authorizeDispatch(command).pipe(
                Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
              ),
            );
            assert.equal(staleTarget.reason, "argument-mismatch");
          }
          if (expected.options !== undefined) {
            const changed = yield* Effect.flip(
              authorizeDispatch({
                ...command,
                modelSelection: { ...expected, options: [{ id: "reasoningEffort", value: "low" }] },
              }).pipe(
                Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
              ),
            );
            assert.equal(changed.reason, "argument-mismatch");
          }
          const replay = yield* orchestrator.dispatch(command);
          if (!queued) yield* worker.drain();
          assert.equal(replay.sequence, receipt.sequence);
          assert.deepEqual(yield* Ref.get(started), queued ? [] : [expected]);
          const after = yield* sql<{
            binding: string;
          }>`SELECT binding_json AS binding FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${command.messageId}`;
          assert.deepEqual(after, routes);
        }).pipe(Effect.provide(runtime), Effect.provideService(PolicyExecutionContext, session));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
