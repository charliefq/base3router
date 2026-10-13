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
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
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
  orchestrator: Orchestrator.OrchestratorV2["Service"];
  eventSink: EventSink.EventSinkV2["Service"];
  setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
  setProviderReadHook: (hook: (count: number) => void) => void;
  setEnvironment: (environment: string) => void;
  dispatch: (
    command: OrchestrationV2Command,
    actor?: typeof agentsCreationActor,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["dispatch"]>;
  readSnapshot: () => ReturnType<typeof readCollaborationSnapshot>;
  readReview: (
    input: TaskContractReviewInput,
  ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["getTaskReview"]>;
  openCanonical: () => ReturnType<CollaborationThreads.CollaborationThreads["Service"]["open"]>;
  noExecution: () => Effect.Effect<
    { runs: number; grants: number; outbox: number; messages: number },
    SqlError
  >;
};
export const withAgentsTaskCreationFixture = <E>(
  check: (fixture: Fixture) => Effect.Effect<void, E>,
) => {
  let providers: ReadonlyArray<ServerProvider> = [agentsCreationProvider];
  let providerReadCount = 0;
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
  const database = SqlitePersistenceMemory;
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "agents-task-creation" },
    ProviderAdapterRegistry.makeLayer([]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const dependencies = Layer.mergeAll(
    database,
    orchestrator,
    registry,
    environmentLayer,
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
      const service = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const canonical = yield* CollaborationThreads.CollaborationThreads;
      const context = yield* Effect.context();
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const id of ["project-a", "project-b"])
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},'/tmp','[]',${now},${now})`;
      const actorContext = Effect.provideService(PolicyExecutionContext, agentsCreationActor);
      yield* check({
        sql,
        orchestrator: service,
        eventSink,
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
        readSnapshot: () =>
          readCollaborationSnapshot(sql, agentsCreationActor.actorId, {
            environmentId: environment,
            canOperate: true,
          }).pipe(actorContext, Effect.provide(context)),
        readReview: (input) =>
          service.getTaskReview(input).pipe(actorContext, Effect.provide(context)),
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
