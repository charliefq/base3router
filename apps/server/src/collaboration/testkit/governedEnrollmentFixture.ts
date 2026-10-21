import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { readCollaborationSnapshot } from "../store.ts";

/** Real normal governed-create commands and authoritative reads, with execution unavailable. */
export const withGovernedEnrollmentFixture = <E>(
  check: (fixture: {
    readonly readSnapshot: () => ReturnType<typeof readCollaborationSnapshot>;
    readonly noExecution: () => Effect.Effect<
      { readonly runs: number; readonly grants: number; readonly outbox: number },
      SqlError
    >;
  }) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project-a");
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Enrollment UI fixture','/tmp','[]',${now},${now})`;
      const principal = {
        kind: "session" as const,
        actorId: "fixture-owner",
        sessionId: "fixture-session",
        scopes: [AuthOrchestrationOperateScope],
      };
      for (const [id, title] of [
        ["task-parser", "Fix parser behavior"],
        ["task-docs", "Write parser documentation"],
      ]) {
        yield* orchestrator
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId: ThreadId.make(id!),
            projectId,
            title: title!,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
            taskGovernance: "required",
            taskContract: {
              goal: title!,
              redirect: "Ask before expanding scope",
              acceptance: "Owner checks the result",
              brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
            },
          })
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
      }
      yield* check({
        readSnapshot: () => readCollaborationSnapshot(sql, principal.actorId),
        noExecution: () =>
          Effect.gen(function* () {
            const [runs, grants, outbox] = yield* Effect.all([
              sql`SELECT run_id FROM orchestration_v2_projection_runs`,
              sql`SELECT grant_id FROM base3_execution_grants`,
              sql`SELECT effect_id FROM orchestration_v2_effect_outbox`,
            ]);
            return { runs: runs.length, grants: grants.length, outbox: outbox.length };
          }),
      });
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        SqlitePersistenceMemory,
        makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "governed-enrollment-ui" },
          ProviderAdapterRegistry.makeLayer([]),
          { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
        ),
      ),
    ),
  );
