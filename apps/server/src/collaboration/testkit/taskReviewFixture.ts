import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TaskContractReviewInput,
  type TaskContractReviewAction,
  type TaskContractReviewReference,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { readCollaborationSnapshot } from "../store.ts";

const actor = {
  kind: "session" as const,
  actorId: "fixture-owner",
  sessionId: "fixture-session",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
const environmentId = EnvironmentId.make("environment-a");
const environment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Descriptor is unused in review fixtures"),
});
export const withTaskReviewFixture = <E>(
  check: (fixture: {
    readSnapshot: (canOperate?: boolean) => ReturnType<typeof readCollaborationSnapshot>;
    readReview: (
      input: TaskContractReviewInput,
    ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["getTaskReview"]>;
    decide: (input: {
      threadId: string;
      action: TaskContractReviewAction;
      revision: number;
      reviewTask: TaskContractReviewReference;
    }) => ReturnType<Orchestrator.OrchestratorV2["Service"]["dispatch"]>;
    createAdditional: () => ReturnType<Orchestrator.OrchestratorV2["Service"]["dispatch"]>;
    revise: () => ReturnType<Orchestrator.OrchestratorV2["Service"]["dispatch"]>;
    facts: () => Effect.Effect<
      {
        runs: number;
        grants: number;
        outbox: number;
        acceptedRevision: number | null;
        phase: string | undefined;
      },
      | Effect.Error<ReturnType<Orchestrator.OrchestratorV2["Service"]["getThreadProjection"]>>
      | import("effect/unstable/sql/SqlError").SqlError
    >;
  }) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = DateTime.formatIso(yield* DateTime.now);
      const projectId = ProjectId.make("project-a");
      const threadId = ThreadId.make("task-parser");
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Review UI fixture','/tmp','[]',${now},${now})`;
      yield* orchestrator
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("review-ui-create"),
          threadId,
          projectId,
          title: "Fix parser behavior",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          taskGovernance: "required",
          taskContract: {
            goal: "Fix parser behavior",
            redirect: "Ask before expanding scope",
            acceptance: "Owner checks the result",
            brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
          },
        })
        .pipe(Effect.provideService(PolicyExecutionContext, actor));
      let command = 0;
      yield* check({
        readSnapshot: (canOperate = true) =>
          readCollaborationSnapshot(sql, actor.actorId, { environmentId, canOperate }),
        readReview: (input) =>
          orchestrator
            .getTaskReview(input)
            .pipe(
              Effect.provideService(PolicyExecutionContext, actor),
              Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
        decide: (input) =>
          orchestrator
            .dispatch({
              type: `thread.task-contract.${input.action}`,
              commandId: CommandId.make(`review-ui:${++command}`),
              threadId: ThreadId.make(input.threadId),
              revision: input.revision,
              reviewTask: input.reviewTask,
            })
            .pipe(
              Effect.provideService(PolicyExecutionContext, actor),
              Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
        createAdditional: () =>
          orchestrator
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make("review-ui-additional"),
              threadId: ThreadId.make("task-second"),
              projectId,
              title: "Second review task",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
              taskGovernance: "required",
              taskContract: {
                goal: "Review second task",
                redirect: "Ask owner",
                acceptance: "Owner review",
                brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
              },
            })
            .pipe(
              Effect.provideService(PolicyExecutionContext, actor),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
        revise: () =>
          orchestrator
            .dispatch({
              type: "thread.task-contract.set",
              commandId: CommandId.make(`review-ui-revise:${++command}`),
              threadId,
              goal: "Revised parser behavior",
              redirect: "Ask owner",
              acceptance: "Owner reviews revision",
              brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
            })
            .pipe(
              Effect.provideService(PolicyExecutionContext, actor),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
        facts: () =>
          Effect.gen(function* () {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const runs = yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`;
            const grants = yield* sql`SELECT grant_id FROM base3_execution_grants`;
            const outbox = yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`;
            return {
              runs: runs.length,
              grants: grants.length,
              outbox: outbox.length,
              acceptedRevision: projection.thread.taskAcceptedRevision ?? null,
              phase: projection.thread.taskContractPhase,
            };
          }),
      });
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        SqlitePersistenceMemory,
        makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "task-review-ui" },
          ProviderAdapterRegistry.makeLayer([]),
          { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
        ),
      ),
    ),
  );
