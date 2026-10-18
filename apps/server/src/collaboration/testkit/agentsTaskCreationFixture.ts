import type { SavedPrRead } from "../TaskCapabilityStep.ts";
import * as ActionGate from "../../actionGate/ActionGateService.ts";
import * as ProviderSessions from "../../orchestration-v2/ProviderSessionManager.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationV2Command,
  type ServerProvider,
  type TaskContractReviewInput,
  type TaskAutoPreviewInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as RouterEvaluation from "../../routerEvaluation/RouterEvaluationService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import type * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as CollaborationThreads from "../CollaborationThreads.ts";
import { readCollaborationSnapshot } from "../store.ts";

export const agentsCreationActor = {
  kind: "session" as const,
  actorId: "fixture-owner",
  sessionId: "fixture-session",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
export const agentsCreationProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-13T00:00:00Z",
  models: [
    { slug: "fake-model", name: "Fake", isDefault: true, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
export const eligibleCapProviders = (count = 32): ReadonlyArray<ServerProvider> => [
  {
    ...agentsCreationProvider,
    instanceId: ProviderInstanceId.make("aaa-disabled"),
    enabled: false,
    status: "disabled",
    models: Array.from({ length: count }, (_, i) => ({
      slug: `blocked-${i.toString().padStart(2, "0")}`,
      name: `Blocked ${i}`,
      isCustom: false,
      capabilities: null,
    })),
  },
  agentsCreationProvider,
];

export const agentsCreationCommand = (
  id: string,
): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`agents-create:${id}`),
  threadId: id as Extract<OrchestrationV2Command, { type: "thread.create" }>["threadId"],
  projectId: ProjectId.make("project-a"),
  title: `Task ${id}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "required",
  taskContract: {
    goal: "Fix parser",
    redirect: "Ask before expanding scope",
    acceptance: "Parser regression passes",
    brake: {
      maxProviderStarts: 2,
      stopConditions: "Scope changed",
      maxTokens: 900,
      maxCostUsd: 0.1,
      deadlineAt: "2026-10-14T00:00:00Z",
    },
  },
  taskCreationReview: {
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project-a"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
  },
});
type Fixture = {
  sql: SqlClient.SqlClient;
  actionGate: ActionGate.ActionGateService["Service"];
  sessions: ProviderSessions.ProviderSessionManagerV2["Service"];
  worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
  governWorker: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  orchestrator: Orchestrator.OrchestratorV2["Service"];
  eventSink: EventSink.EventSinkV2["Service"];
  setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
  providerStarts: () => number;
  setProviderReadHook: (hook: (count: number) => void) => void;
  setEnvironment: (environment: string) => void;
  dispatch: (
    command: OrchestrationV2Command,
    actor?: import("../../policy/executionContext.ts").PolicyExecutionContext,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["dispatch"]>;
  reject: (
    command: Extract<OrchestrationV2Command, { type: "thread.create" }>,
  ) => ReturnType<EventSink.EventSinkV2["Service"]["commitRejectedCommand"]>;
  commitCreation: (
    input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0],
  ) => ReturnType<EventSink.EventSinkV2["Service"]["commitCommand"]>;
  evaluation: RouterEvaluation.RouterEvaluationService["Service"];
  previewAuto: (
    input: TaskAutoPreviewInput,
    actor?: typeof agentsCreationActor,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["getTaskAutoPreview"]>;
  readStatus: (
    command: OrchestrationV2Command,
    actor?: typeof agentsCreationActor,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["getAgentsCreationStatus"]>;
  readSnapshot: () => ReturnType<typeof readCollaborationSnapshot>;
  readReview: (
    input: TaskContractReviewInput,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["getTaskReview"]>;
  readFirstLaunchStatus: (
    command: OrchestrationV2Command,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["getTaskFirstLaunchStatus"]>;
  openCanonical: () => ReturnType<CollaborationThreads.CollaborationThreads["Service"]["open"]>;
  noExecution: () => Effect.Effect<
    { runs: number; grants: number; outbox: number; messages: number },
    SqlError
  >;
};
export const withAgentsTaskCreationFixture = <E>(
  check: (fixture: Fixture) => Effect.Effect<void, E, Scope.Scope>,
  options: {
    readonly useProjectRuntimePolicy?: boolean;
    readonly decorateSavedPrRead?: (service: SavedPrRead["Service"]) => SavedPrRead["Service"];
    readonly runContinuationWorker?: boolean;
    readonly dbPath?: string;
    readonly adapterRegistryLayer?: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>;
    readonly decorateEventSink?: (
      service: EventSink.EventSinkV2["Service"],
    ) => EventSink.EventSinkV2["Service"];
    readonly decorateCommandReceipts?: (
      service: CommandReceiptStore.CommandReceiptStoreV2["Service"],
    ) => CommandReceiptStore.CommandReceiptStoreV2["Service"];
  } = {},
) => {
  let providers: ReadonlyArray<ServerProvider> = [agentsCreationProvider];
  let sessions: ProviderSessions.ProviderSessionManagerV2["Service"] | undefined;
  let providerReadCount = 0;
  let providerStartCount = 0;
  let providerReadHook = (_count: number) => {};
  let environment = "environment-a";
  const registry = Layer.mock(ProviderRegistry)({
    getProviders: Effect.sync(() => {
      providerReadHook(++providerReadCount);
      return providers;
    }),
  });
  const environmentLayer = Layer.mock(ServerEnvironment)({
    getEnvironmentId: Effect.sync(() => EnvironmentId.make(environment)),
  });
  const database = options.dbPath
    ? makeSqlitePersistenceLive(options.dbPath).pipe(Layer.provide(NodeServices.layer))
    : SqlitePersistenceMemory;
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "agents-task-creation" },
    options.adapterRegistryLayer ??
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed(providers.map((p) => p.instanceId)),
        get: (id) =>
          Effect.succeed({
            instanceId: id,
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: () => {
              providerStartCount += 1;
              return Effect.die("Preview fixture must never open a provider session");
            },
          }),
      }),
    {
      databaseLayer: database,
      useProjectRuntimePolicy: options.useProjectRuntimePolicy ?? false,
      ...(options.decorateSavedPrRead ? { decorateSavedPrRead: options.decorateSavedPrRead } : {}),
      decorateSessionManager: (service) => {
        sessions = service;
        return service;
      },
      capabilityContextLayer: Layer.mergeAll(registry, environmentLayer),
      runEffectWorker: false,
      runContinuationWorker: options.runContinuationWorker ?? false,
      ...(options.decorateEventSink ? { decorateEventSink: options.decorateEventSink } : {}),
      ...(options.decorateCommandReceipts
        ? { decorateCommandReceipts: options.decorateCommandReceipts }
        : {}),
    },
  );
  const dependencies = Layer.mergeAll(
    database,
    ActionGate.layer.pipe(Layer.provide(database)),
    orchestrator,
    registry,
    environmentLayer,
    RouterEvaluation.layer.pipe(Layer.provide(database)),
    ProjectStore.layer.pipe(Layer.provide(database)),
    ThreadManagement.layer.pipe(Layer.provide(orchestrator)),
  );
  const runtime = Layer.mergeAll(
    dependencies,
    CollaborationThreads.layer.pipe(Layer.provide(dependencies)),
    NodeServices.layer,
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const actionGate = yield* ActionGate.ActionGateService;
      const service = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const evaluation = yield* RouterEvaluation.RouterEvaluationService;
      const eventSink = yield* EventSink.EventSinkV2;
      const canonical = yield* CollaborationThreads.CollaborationThreads;
      const context = yield* Effect.context();
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const id of ["project-a", "project-b"])
        yield* sql`INSERT OR IGNORE INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},'/tmp','[]',${now},${now})`;
      const actorContext = Effect.provideService(PolicyExecutionContext, agentsCreationActor);
      yield* check({
        sql,
        actionGate,
        sessions: sessions!,
        worker,
        governWorker: (effect) =>
          effect.pipe(
            Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
            Effect.provide(context),
          ),
        orchestrator: service,
        eventSink,
        providerStarts: () => providerStartCount,
        setProviders: (next) => {
          providers = next;
        },
        setProviderReadHook: (hook) => {
          providerReadHook = hook;
        },
        setEnvironment: (next) => {
          environment = next;
        },
        dispatch: (command, actor = agentsCreationActor) =>
          service
            .dispatch(command)
            .pipe(Effect.provideService(PolicyExecutionContext, actor), Effect.provide(context)),
        reject: (command) =>
          Effect.gen(function* () {
            return yield* eventSink.commitRejectedCommand({
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.type,
              creationCommand: command,
              rejectedAt: yield* DateTime.now,
              error: "Controlled fixture rejection",
            });
          }).pipe(actorContext, Effect.provide(context)),
        commitCreation: (input) =>
          eventSink.commitCommand(input).pipe(actorContext, Effect.provide(context)),
        evaluation,
        previewAuto: (input, actor = agentsCreationActor) =>
          service
            .getTaskAutoPreview(input)
            .pipe(Effect.provideService(PolicyExecutionContext, actor), Effect.provide(context)),
        readStatus: (command, actor = agentsCreationActor) =>
          service
            .getAgentsCreationStatus({ command })
            .pipe(Effect.provideService(PolicyExecutionContext, actor), Effect.provide(context)),
        readSnapshot: () =>
          readCollaborationSnapshot(sql, agentsCreationActor.actorId, {
            environmentId: environment,
            canOperate: true,
          }).pipe(actorContext, Effect.provide(context)),
        readReview: (input) =>
          service.getTaskReview(input).pipe(actorContext, Effect.provide(context)),
        readFirstLaunchStatus: (command) =>
          service.getTaskFirstLaunchStatus({ command }).pipe(actorContext, Effect.provide(context)),
        openCanonical: () =>
          canonical
            .open(agentsCreationActor.actorId, { projectId: "project-a", providerId: "codex" })
            .pipe(actorContext, Effect.provide(context)),
        noExecution: () =>
          Effect.gen(function* () {
            const [runs, grants, outbox, messages] = yield* Effect.all([
              sql`SELECT run_id FROM orchestration_v2_projection_runs`,
              sql`SELECT grant_id FROM base3_execution_grants`,
              sql`SELECT effect_id FROM orchestration_v2_effect_outbox`,
              sql`SELECT message_id FROM orchestration_v2_projection_messages WHERE role='user'`,
            ]);
            return {
              runs: runs.length,
              grants: grants.length,
              outbox: outbox.length,
              messages: messages.length,
            };
          }),
      });
    }),
  ).pipe(Effect.provide(runtime));
};
