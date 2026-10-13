import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ModelRouter from "@t3tools/shared/modelRouter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  AuthSessionId,
  AuthOrchestrationReadScope,
  EnvironmentRouterPolicyStatus,
  EnvironmentRouterPolicyCommandResult,
  EnvironmentRouterPolicyCommand,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  HYBRID_MIN_SAMPLE_RATE,
  MODEL_ROUTER_POLICY_VERSION,
  ObservationId,
  RouterEvaluationError,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyTiming,
  emptyUsageMeasurement,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
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
  ModelRouterConstraints,
  OrchestrationV2Command,
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
import { argumentHash, authorizeDispatch, Base3PolicyDeniedError } from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import * as RouterEvaluation from "../routerEvaluation/RouterEvaluationService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { routerPolicyHttpApiLayer } from "../routerEvaluation/http.ts";
const decodePolicyStatus = Schema.decodeUnknownSync(EnvironmentRouterPolicyStatus);
const decodePolicyResult = Schema.decodeUnknownSync(EnvironmentRouterPolicyCommandResult);
const encodePolicyControl = Schema.encodeSync(
  Schema.fromJsonString(EnvironmentRouterPolicyCommand),
);
class PolicyControlFixtureApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.routerPolicy,
) {}
const policyEnvironment = EnvironmentId.make("policy-control-disposable");
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
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);
const isPolicyDenied = Schema.is(Base3PolicyDeniedError);
const decodeCommand = Schema.decodeEffect(OrchestrationV2Command);
const decodeUnknownCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
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

interface BoundTargetScenario {
  readonly name: string;
  readonly mode: "auto" | "manual";
  readonly queued: boolean;
  readonly sameTarget: boolean;
  readonly omitted: boolean;
  readonly options: boolean;
  readonly constraints?: ModelRouterConstraints;
  readonly unknownEstimates?: boolean;
  readonly denied?: boolean;
}

const scenarios: ReadonlyArray<BoundTargetScenario> = [
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
  ...[
    { name: "auto cost limit", mode: "auto", constraints: { maxCostUsd: 0.1 } },
    { name: "auto latency limit", mode: "auto", constraints: { maxLatencyMs: 0.1 } },
    { name: "auto both limits", mode: "auto", constraints: { maxCostUsd: 0.1, maxLatencyMs: 0.1 } },
    {
      name: "queued auto cost limit",
      mode: "auto",
      constraints: { maxCostUsd: 0.1 },
      queued: true,
    },
    {
      name: "manual equality",
      mode: "manual",
      constraints: { maxCostUsd: 0.1, maxLatencyMs: 0.1 },
    },
    {
      name: "manual cost exceeded",
      mode: "manual",
      constraints: { maxCostUsd: 0.05 },
      denied: true,
    },
    {
      name: "manual latency exceeded",
      mode: "manual",
      constraints: { maxLatencyMs: 0.09 },
      denied: true,
    },
    {
      name: "auto cost unknown",
      mode: "auto",
      constraints: { maxCostUsd: 1 },
      unknownEstimates: true,
      denied: true,
    },
    {
      name: "auto latency unknown",
      mode: "auto",
      constraints: { maxLatencyMs: 1000 },
      unknownEstimates: true,
      denied: true,
    },
    {
      name: "manual cost unknown",
      mode: "manual",
      constraints: { maxCostUsd: 1 },
      unknownEstimates: true,
      denied: true,
    },
    {
      name: "manual latency unknown",
      mode: "manual",
      constraints: { maxLatencyMs: 1000 },
      unknownEstimates: true,
      denied: true,
    },
  ].map((row): BoundTargetScenario => ({
    queued: false,
    sameTarget: false,
    omitted: false,
    options: false,
    ...row,
    mode: row.mode as "auto" | "manual",
  })),
];

it.live.each(scenarios)(
  "server-bound $name preserves target, options, grant and replay",
  ({ name, mode, queued, sameTarget, omitted, options, constraints, unknownEstimates, denied }) =>
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
        // FIXTURE estimates only: production provider snapshots have no declared metrics.
        // Keep the real catalog builder/router; inject known estimates at this test seam.
        if (constraints !== undefined && !unknownEstimates) {
          const buildCatalog = ModelRouter.modelRouterCatalogFromProviders;
          const estimates = new Map([
            [
              `${a.instanceId}\u0000${a.model}`,
              {
                quality: { status: "known" as const, value: 1 },
                costUsd: { status: "known" as const, value: 0.2 },
                latencyMs: { status: "known" as const, value: 0.2 },
              },
            ],
            [
              `${b.instanceId}\u0000${b.model}`,
              {
                quality: { status: "known" as const, value: 0 },
                costUsd: { status: "known" as const, value: 0.1 },
                latencyMs: { status: "known" as const, value: 0.1 },
              },
            ],
          ]);
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi
                .spyOn(ModelRouter, "modelRouterCatalogFromProviders")
                .mockImplementation((providers, capabilities) =>
                  buildCatalog(providers, capabilities, estimates),
                ),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
        }
        const fixtureProviders =
          constraints === undefined
            ? [provider, { ...provider, instanceId: b.instanceId }]
            : [
                { ...provider, models: provider.models.filter((model) => model.slug === a.model) },
                {
                  ...provider,
                  instanceId: b.instanceId,
                  models: provider.models.filter((model) => model.slug === b.model),
                },
              ];
        if (constraints !== undefined && !unknownEstimates && mode === "auto") {
          const unconstrained = ModelRouter.routeModel({
            mode: "auto",
            catalog: ModelRouter.modelRouterCatalogFromProviders(fixtureProviders),
            preferredTargets: [a],
          });
          assert.deepEqual(
            unconstrained.selected?.target,
            a,
            "same fixture estimates prefer a without limits",
          );
        }
        const started = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
        const database = SqlitePersistenceMemory;
        const runtime = Layer.mergeAll(
          database,
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed(fixtureProviders),
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
            ...(constraints === undefined ? {} : { modelRouteConstraints: constraints }),
            dispatchMode: {
              type: queued ? ("queue_after_active" as const) : ("start_immediately" as const),
            },
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          const decoded = yield* decodeCommand(command);
          assert.equal(decoded.type, "message.dispatch");
          if (decoded.type !== "message.dispatch") return;
          assert.deepEqual(
            decoded.modelRouteConstraints,
            constraints,
            "wire decode retains exact constraints",
          );
          if (denied) {
            const error = yield* Effect.flip(orchestrator.dispatch(decoded));
            assert.isTrue(isDispatchError(error));
            if (!isDispatchError(error)) return;
            assert.isTrue(isPolicyDenied(error.cause));
            if (!isPolicyDenied(error.cause)) return;
            assert.equal(error.cause.reason, "binding");
            assert.include(error.cause.message, "Route");
            assert.deepEqual(yield* Ref.get(started), []);
            assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, []);
            const effects = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM orchestration_v2_effect_outbox WHERE command_id=${command.commandId}`;
            const grants = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM base3_execution_grants WHERE message_id=${command.messageId}`;
            const routes = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM projection_dispatcher_task_routes WHERE message_id=${command.messageId}`;
            assert.equal(effects[0]?.count, 0);
            assert.equal(grants[0]?.count, 0);
            assert.equal(routes[0]?.count, 0);
            return;
          }
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
          const receipt = yield* orchestrator.dispatch(decoded);
          if (completed !== null) {
            yield* worker.drain();
            yield* Fiber.join(completed);
            yield* worker.drain();
          }
          const expected =
            constraints !== undefined ? b : mode === "auto" && !sameTarget ? a : sourceSelection;
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
              ...(constraints === undefined ? {} : { modelRouteConstraints: constraints }),
            }),
          );
          if (constraints === undefined && mode === "auto" && !sameTarget) {
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
          if (constraints !== undefined) {
            assert.deepEqual(route.modelRoute?.selected?.target, {
              instanceId: expected.instanceId,
              model: expected.model,
            });
            assert.deepEqual(
              route.modelRoute?.executed?.target,
              route.modelRoute?.selected?.target,
            );
            if (mode === "auto") {
              const excluded = route.modelRoute?.candidates.find(
                (candidate) =>
                  candidate.target.instanceId === a.instanceId &&
                  candidate.target.model === a.model,
              );
              assert.equal(excluded?.eligible, false);
              if (constraints.maxCostUsd !== undefined)
                assert.include([...(excluded?.reasonCodes ?? [])], "ESTIMATED_COST_LIMIT_EXCEEDED");
              if (constraints.maxLatencyMs !== undefined)
                assert.include(
                  [...(excluded?.reasonCodes ?? [])],
                  "ESTIMATED_LATENCY_LIMIT_EXCEEDED",
                );
            }
            const effective = { ...decoded, modelSelection: expected };
            yield* authorizeDispatch(effective).pipe(
              Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
            );
            for (const replacement of [
              undefined,
              {},
              { maxCostUsd: 10 },
              { maxLatencyMs: 10000 },
            ]) {
              const changed = yield* Effect.flip(
                authorizeDispatch({ ...effective, modelRouteConstraints: replacement }).pipe(
                  Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
                ),
              );
              assert.equal(changed.reason, "argument-mismatch");
            }
            const changedTarget = yield* Effect.flip(
              authorizeDispatch({ ...effective, modelSelection: a }).pipe(
                Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
              ),
            );
            assert.equal(changedTarget.reason, "argument-mismatch");
            const changedIdentity = yield* Effect.flip(
              orchestrator.dispatch({
                ...decoded,
                commandId: CommandId.make(`changed:${mode}`),
                modelRouteConstraints: undefined,
                modelSelection: a,
                routingMode: "manual",
              }),
            );
            assert.isTrue(isDispatchError(changedIdentity));
            if (!isDispatchError(changedIdentity)) return;
            assert.isTrue(isPolicyDenied(changedIdentity.cause));
            if (!isPolicyDenied(changedIdentity.cause)) return;
            assert.equal(changedIdentity.cause.reason, "binding-immutable");
          }
          const replay = yield* orchestrator.dispatch(decoded);
          if (!queued) yield* worker.drain();
          assert.equal(replay.sequence, receipt.sequence);
          assert.deepEqual(yield* Ref.get(started), queued ? [] : [expected]);
          const after = yield* sql<{
            binding: string;
          }>`SELECT binding_json AS binding FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${command.messageId}`;
          assert.deepEqual(after, routes);
          const afterGrants = yield* sql<{
            hash: string;
          }>`SELECT argument_hash AS hash FROM base3_execution_grants WHERE grant_id=${`grant:message:${threadId}:${command.messageId}`}`;
          assert.deepEqual(afterGrants, grants);
          if (queued) {
            const finished = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(2),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
            yield* Fiber.join(finished);
            yield* worker.drain();
            assert.deepEqual(yield* Ref.get(started), [sourceSelection, expected]);
            const finalRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (candidate) => candidate.userMessageId === command.messageId,
            );
            assert.equal(finalRun?.status, "completed");
            assert.deepEqual(finalRun?.modelSelection, expected);
            const queuedReplay = yield* orchestrator.dispatch(decoded);
            yield* worker.drain();
            assert.equal(queuedReplay.sequence, receipt.sequence);
            assert.deepEqual(yield* Ref.get(started), [sourceSelection, expected]);
          }
        }).pipe(Effect.provide(runtime), Effect.provideService(PolicyExecutionContext, session));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it("decodes finite non-negative dispatch limits and rejects invalid numeric values", () => {
  const command = {
    type: "message.dispatch",
    commandId: "limits-schema",
    threadId: "limits-schema",
    messageId: "limits-schema",
    text: "Fixture only",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  };
  for (const key of ["maxCostUsd", "maxLatencyMs"]) {
    for (const value of [-1, Infinity, NaN, "1"]) {
      assert.throws(() =>
        decodeUnknownCommand({ ...command, modelRouteConstraints: { [key]: value } }),
      );
    }
  }
  const limits = { maxCostUsd: 0, maxLatencyMs: 0 };
  const decoded = decodeUnknownCommand({ ...command, modelRouteConstraints: limits });
  assert.equal(decoded.type, "message.dispatch");
  if (decoded.type === "message.dispatch") assert.deepEqual(decoded.modelRouteConstraints, limits);
});

it.live.each([0, 1, 24])(
  "policy control with %i observations per target: HTTP → shadow → active → real V2 bind → rollback",
  (recordCount) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("policy-control-whole-flow");
        const fixtureProviders = [
          { ...provider, models: provider.models.filter((model) => model.slug === a.model) },
          {
            ...provider,
            instanceId: b.instanceId,
            models: provider.models.filter((model) => model.slug === b.model),
          },
        ];
        const started = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
        const database = SqlitePersistenceMemory;
        const runtime = Layer.mergeAll(
          database,
          RouterEvaluation.layer.pipe(Layer.provide(database)),
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(fixtureProviders) }),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(policyEnvironment),
            getDescriptor: Effect.die("Not used"),
          }),
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "policy-control-whole-flow" },
            ProviderAdapterRegistry.makeLayer([
              makeAdapter(started, a.instanceId),
              makeAdapter(started, b.instanceId),
            ]),
            { databaseLayer: database, runEffectWorker: true },
          ),
        );
        yield* Effect.gen(function* () {
          const evaluation = yield* RouterEvaluation.RouterEvaluationService;
          const routes = HttpApiBuilder.layer(PolicyControlFixtureApi).pipe(
            Layer.provide(routerPolicyHttpApiLayer),
            Layer.provide(Layer.succeed(RouterEvaluation.RouterEvaluationService, evaluation)),
            Layer.provide(
              Layer.succeed(ServerEnvironment.ServerEnvironment, {
                getEnvironmentId: Effect.succeed(policyEnvironment),
                getDescriptor: Effect.die("Not used"),
              }),
            ),
            Layer.provide(
              Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
                effect.pipe(
                  Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                    sessionId: AuthSessionId.make("policy-fixture-session"),
                    subject: "fixture-operator",
                    method: "browser-session-cookie",
                    scopes: new Set([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
                  }),
                ),
              ),
            ),
            Layer.provideMerge(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(NodeServices.layer),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
            Layer.provide(NodeServices.layer),
          );
          const web = yield* Effect.acquireRelease(
            Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
            (web) => Effect.promise(() => web.dispose()),
          );
          const status = () =>
            Effect.promise(async () => {
              const response = await web.handler(new Request("http://fixture/api/router-policy"));
              assert.equal(response.status, 200);
              return decodePolicyStatus(await response.json());
            });
          const control = (input: EnvironmentRouterPolicyCommand) =>
            Effect.promise(async () => {
              const response = await web.handler(
                new Request("http://fixture/api/router-policy/command", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: encodePolicyControl(input),
                }),
              );
              assert.equal(response.status, 200);
              const result = decodePolicyResult(await response.json());
              assert.equal(result.outcome, "applied");
              if (result.outcome !== "applied") throw new Error(result.error.detail);
              return result.status;
            });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sql = yield* SqlClient.SqlClient;
          const projectId = ProjectId.make("policy-fixture-project");
          const now = DateTime.formatIso(yield* DateTime.now);
          const defaultJson = yield* encodeModelSelection(a);
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at) VALUES (${projectId},'Policy fixture',${cwd},${defaultJson},'[]',${now},${now})`;
          const runAuto = (
            label: string,
            expected: ModelSelection,
            hybrid: boolean,
            loadFailure = false,
            mode: "auto" | "manual" = "auto",
          ) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make(`policy-thread-${label}`);
              const messageId = MessageId.make(`policy-message-${label}`);
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`policy-create-${label}`),
                threadId,
                projectId,
                title: "Policy fixture",
                modelSelection: a,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
                createdBy: "user",
                creationSource: "web",
              });
              const completed = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.type === "run.updated" &&
                    event.payload.threadId === threadId &&
                    event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              const messageCommand = {
                type: "message.dispatch",
                commandId: CommandId.make(`policy-dispatch-${label}`),
                threadId,
                messageId,
                text: "Disposable policy fixture",
                attachments: [],
                routingMode: mode,
                modelSelection: a,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              } as const;
              yield* orchestrator.dispatch(messageCommand).pipe(
                Effect.provideService(
                  RouterEvaluation.RouterEvaluationService,
                  loadFailure
                    ? {
                        ...evaluation,
                        routingSnapshot: () =>
                          Effect.fail(
                            new RouterEvaluationError({
                              reason: "malformed_policy",
                              detail: "Fixture load failure",
                            }),
                          ),
                      }
                    : evaluation,
                ),
              );
              yield* worker.drain();
              yield* Fiber.join(completed);
              yield* worker.drain();
              const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                (entry) => entry.userMessageId === messageId,
              );
              assert.deepEqual(run?.modelSelection, expected);
              const row = (yield* sql<{
                binding: string;
              }>`SELECT binding_json AS binding FROM projection_dispatcher_task_routes WHERE message_id = ${messageId}`)[0]!;
              const binding = yield* decodeRoute(row.binding);
              assert.deepEqual(
                { instanceId: binding.target.instanceId, model: binding.target.model },
                expected,
              );
              assert.deepEqual(binding.modelRoute?.selected?.target, expected);
              assert.deepEqual(binding.modelRoute?.executed?.target, expected);
              assert.equal(binding.hybrid?.usedHybridRanking ?? false, hybrid);
              if (loadFailure && mode === "auto") {
                assert.equal(binding.hybrid?.fallbackToV0, true);
                assert.include(binding.hybrid?.fallbackReason ?? "", "unavailable");
              }
              if (label === "active" && recordCount < HYBRID_MIN_SAMPLE_RATE) {
                assert.equal(binding.hybrid?.fallbackToV0, true);
                assert.include(binding.hybrid?.fallbackReason ?? "", "Insufficient");
              }
              assert.deepEqual(
                binding.modelRoute?.estimatedCostUsd,
                binding.modelRoute?.selected?.metrics.costUsd,
              );
              assert.deepEqual(
                binding.modelRoute?.estimatedLatencyMs,
                binding.modelRoute?.selected?.metrics.latencyMs,
              );
              assert.equal(
                binding.modelRoute?.fallbacks.every(
                  (fallback) => fallback.target.instanceId !== expected.instanceId,
                ),
                true,
              );
              const grant = (yield* sql<{
                hash: string;
              }>`SELECT argument_hash AS hash FROM base3_execution_grants WHERE grant_id=${`grant:message:${threadId}:${messageId}`}`)[0]!;
              assert.equal(
                grant.hash,
                argumentHash({
                  text: "Disposable policy fixture",
                  model: expected.model,
                  instanceId: expected.instanceId,
                  attachmentIds: [],
                }),
              );
            });
          const initial = yield* status();
          const candidate = initial.policies.find(
            (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
          )!;
          yield* runAuto("baseline", a, false);
          // Synthetic, persisted local evidence only. No adapter or provider calls generate these measurements.
          for (const selection of [a, b])
            for (let index = 0; index < recordCount; index++)
              yield* evaluation.recordObservation({
                version: TURN_OUTCOME_OBSERVATION_VERSION,
                observationId: ObservationId.make(
                  `policy-fixture-${selection.instanceId}-${index}`,
                ),
                environmentId: policyEnvironment,
                recordedAt: now,
                policyVersion: MODEL_ROUTER_POLICY_VERSION,
                routingMode: "auto",
                instanceId: selection.instanceId,
                model: selection.model,
                taskProfile: UNKNOWN_TASK_PROFILE,
                timing: emptyTiming(),
                usage: emptyUsageMeasurement(),
                cost: emptyCostMeasurement(),
                providerAttempts: 1,
                fallbackCount: 0,
                cancelled: false,
                timedOut: false,
                finishReason: selection === b ? "stop" : "error",
                terminalCategory: selection === b ? "success" : "provider_failure",
                evidence: emptyOutcomeEvidence(),
              });
          const shadow = yield* control({
            action: "shadow",
            policyId: candidate.policyId,
            expectedRevision: initial.revision,
            confirm: true,
          });
          yield* runAuto("shadow", a, false);
          const active = yield* control({
            action: "activate",
            policyId: candidate.policyId,
            expectedRevision: shadow.revision,
            confirm: true,
          });
          yield* runAuto(
            "active",
            recordCount >= HYBRID_MIN_SAMPLE_RATE ? b : a,
            recordCount >= HYBRID_MIN_SAMPLE_RATE,
          );
          yield* runAuto("load-failure", a, false, true);
          yield* runAuto("manual", a, false, false, "manual");
          const rollback = yield* control({
            action: "rollback",
            expectedRevision: active.revision,
            confirm: true,
          });
          assert.equal(rollback.active.policyId, initial.active.policyId);
          yield* runAuto("rollback", a, false);
          assert.deepEqual(yield* Ref.get(started), [
            a,
            a,
            recordCount >= HYBRID_MIN_SAMPLE_RATE ? b : a,
            a,
            a,
            a,
          ]);
        }).pipe(Effect.provide(runtime), Effect.provideService(PolicyExecutionContext, session));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "task-conditioned policy crosses debugging A / writing B through real V2 and persisted observations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("task-conditioned-crossover");
        const started = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
        const database = SqlitePersistenceMemory;
        const fixtureEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(policyEnvironment),
          getDescriptor: Effect.die("Not used"),
        });
        const evaluationLayer = RouterEvaluation.layer.pipe(Layer.provide(database));
        const providers = [
          { ...provider, models: provider.models.filter((model) => model.slug === a.model) },
          {
            ...provider,
            instanceId: b.instanceId,
            models: provider.models.filter((model) => model.slug === b.model),
          },
        ];
        const runtime = Layer.mergeAll(
          database,
          evaluationLayer,
          fixtureEnvironment,
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "task-conditioned-crossover" },
            ProviderAdapterRegistry.makeLayer([
              makeAdapter(started, a.instanceId),
              makeAdapter(started, b.instanceId),
            ]),
            { databaseLayer: database, runEffectWorker: true },
          ).pipe(Layer.provide(Layer.mergeAll(evaluationLayer, fixtureEnvironment))),
        );
        yield* Effect.gen(function* () {
          const evaluation = yield* RouterEvaluation.RouterEvaluationService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sql = yield* SqlClient.SqlClient;
          const now = DateTime.formatIso(yield* DateTime.now);
          const projectId = ProjectId.make("task-conditioned-project");
          const defaultJson = yield* encodeModelSelection(a);
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at) VALUES (${projectId},'Task-conditioned fixture',${cwd},${defaultJson},'[]',${now},${now})`;
          const texts = {
            debugging: "debug this exception, fixture text must not become telemetry",
            writing: "draft an email, fixture text must not become telemetry",
          };
          for (const category of ["debugging", "writing"] as const)
            for (const selection of [a, b])
              for (let index = 0; index < 24; index++) {
                const success = category === "debugging" ? selection === a : selection === b;
                yield* evaluation.recordObservation({
                  version: TURN_OUTCOME_OBSERVATION_VERSION,
                  observationId: ObservationId.make(
                    `task-seed-${category}-${selection.instanceId}-${index}`,
                  ),
                  environmentId: policyEnvironment,
                  recordedAt: now,
                  policyVersion: MODEL_ROUTER_POLICY_VERSION,
                  routingMode: "auto",
                  instanceId: selection.instanceId,
                  model: selection.model,
                  taskProfile: UNKNOWN_TASK_PROFILE,
                  localTaskProfile: classifyLocalTask(texts[category]),
                  timing: emptyTiming(),
                  usage: emptyUsageMeasurement(),
                  cost: emptyCostMeasurement(),
                  providerAttempts: 1,
                  fallbackCount: 0,
                  cancelled: false,
                  timedOut: false,
                  finishReason: success ? "stop" : "error",
                  terminalCategory: success ? "success" : "provider_failure",
                  evidence: emptyOutcomeEvidence(),
                });
              }
          const initial = yield* evaluation.status(policyEnvironment);
          const old = initial.policies.find(
            (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
          )!;
          const task = initial.policies.find(
            (policy) => policy.policyVersion === HYBRID_TASK_ROUTER_POLICY_VERSION,
          )!;
          const transition = (
            action: "shadow" | "activate",
            policyId: typeof task.policyId,
            revision: number,
          ) =>
            evaluation.control(
              policyEnvironment,
              { action, policyId, expectedRevision: revision, confirm: true },
              now,
              "fixture-operator",
            );
          const run = (
            label: string,
            category: "debugging" | "writing",
            expected: ModelSelection,
            appliedPolicy: string,
            expectedShadow?: ModelSelection,
          ) =>
            Effect.gen(function* () {
              const text = texts[category];
              const threadId = ThreadId.make(`task-conditioned-${label}`);
              const messageId = MessageId.make(`task-conditioned-${label}`);
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`task-create-${label}`),
                threadId,
                projectId,
                title: "Task-conditioned fixture",
                modelSelection: a,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
                createdBy: "user",
                creationSource: "web",
              });
              const terminal = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.type === "run.updated" &&
                    event.payload.threadId === threadId &&
                    event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              const command = {
                type: "message.dispatch" as const,
                commandId: CommandId.make(`task-dispatch-${label}`),
                threadId,
                messageId,
                text,
                attachments: [],
                routingMode: "auto" as const,
                modelSelection: a,
                dispatchMode: { type: "start_immediately" as const },
                createdBy: "user" as const,
                creationSource: "web" as const,
              };
              yield* orchestrator.dispatch(command);
              yield* worker.drain();
              yield* Fiber.join(terminal);
              yield* worker.drain();
              const target = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                (candidate) => candidate.userMessageId === messageId,
              )?.modelSelection;
              assert.deepEqual(target, expected);
              const route = yield* decodeRoute(
                (yield* sql<{
                  binding: string;
                }>`SELECT binding_json AS binding FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${messageId}`)[0]!
                  .binding,
              );
              assert.deepEqual(route.target, expected);
              assert.equal(route.modelRoute?.policyVersion, appliedPolicy);
              assert.deepEqual(route.localTaskProfile, classifyLocalTask(text));
              assert.deepEqual(Object.keys(route.localTaskProfile!), [
                "classifierVersion",
                "category",
                "source",
              ]);
              if (expectedShadow) {
                assert.deepEqual(route.hybrid?.challenger?.selected, expectedShadow);
                assert.equal(
                  route.hybrid?.challenger?.policyVersion,
                  HYBRID_TASK_ROUTER_POLICY_VERSION,
                );
                assert.equal(route.hybrid?.challenger?.agreement, "disagreement");
              }
              if (appliedPolicy === HYBRID_TASK_ROUTER_POLICY_VERSION) {
                assert.include(route.modelRoute?.explanation ?? "", `Local task ${category}`);
                assert.notInclude(route.modelRoute?.explanation ?? "", "fixture text");
                for (const explanation of [
                  route.modelRoute?.explanation,
                  route.hybrid?.explanation,
                ]) {
                  assert.include(
                    explanation ?? "",
                    `Policy: ${HYBRID_TASK_ROUTER_POLICY_VERSION}.`,
                  );
                  assert.notInclude(explanation ?? "", `Policy: ${HYBRID_ROUTER_POLICY_VERSION}.`);
                }
              }
              const observationRow = (yield* sql<{
                id: string;
              }>`SELECT observation_id AS id FROM router_turn_observations WHERE thread_id=${threadId} AND message_id=${messageId}`)[0];
              const observation = (yield* evaluation.exportObservations(
                policyEnvironment,
              )).records.find((record) => record.observationId === observationRow?.id);
              assert.isDefined(
                observation,
                "real provider-turn ingestion must persist this observation",
              );
              assert.equal(observation?.policyVersion, appliedPolicy);
              assert.deepEqual(observation?.localTaskProfile, route.localTaskProfile);
              assert.deepEqual(observation?.taskProfile, UNKNOWN_TASK_PROFILE);
              const previousStarts = yield* Ref.get(started);
              yield* orchestrator.dispatch(command);
              yield* worker.drain();
              assert.deepEqual(yield* Ref.get(started), previousStarts);
              const replayed = (yield* evaluation.exportObservations(
                policyEnvironment,
              )).records.find((record) => record.observationId === observation!.observationId);
              assert.deepEqual(replayed?.localTaskProfile, observation?.localTaskProfile);
            });
          const oldShadow = yield* transition("shadow", old.policyId, initial.revision);
          const oldActive = yield* transition("activate", old.policyId, oldShadow.revision);
          yield* run("v1-debug", "debugging", a, HYBRID_ROUTER_POLICY_VERSION);
          yield* run("v1-write", "writing", a, HYBRID_ROUTER_POLICY_VERSION);
          const taskShadow = yield* transition("shadow", task.policyId, oldActive.revision);
          yield* run("task-shadow", "writing", a, HYBRID_ROUTER_POLICY_VERSION, b);
          const taskActive = yield* transition("activate", task.policyId, taskShadow.revision);
          yield* run("task-debug", "debugging", a, HYBRID_TASK_ROUTER_POLICY_VERSION);
          yield* run("task-write", "writing", b, HYBRID_TASK_ROUTER_POLICY_VERSION);
          const restored = yield* evaluation.control(
            policyEnvironment,
            { action: "rollback", expectedRevision: taskActive.revision, confirm: true },
            now,
            "fixture-operator",
          );
          assert.equal(restored.active.policyId, old.policyId);
          yield* run("rollback-write", "writing", a, HYBRID_ROUTER_POLICY_VERSION);
          assert.deepEqual(yield* Ref.get(started), [a, a, a, a, b, a]);
        }).pipe(Effect.provide(runtime), Effect.provideService(PolicyExecutionContext, session));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
