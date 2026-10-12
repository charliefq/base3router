import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
const [repo, base] = process.argv.slice(2);
if (
  !repo ||
  !base ||
  NodePath.dirname(NodePath.resolve(base)) !== NodePath.join(NodeFS.realpathSync(repo), ".t3") ||
  !/^qa-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(NodePath.basename(base)) ||
  [NodePath.join(repo, ".t3"), base].some(
    (path) => NodeFS.existsSync(path) && NodeFS.lstatSync(path).isSymbolicLink(),
  ) ||
  !NodeFS.existsSync(NodePath.join(base, "qa-public.json"))
)
  throw Error("Only a prepared disposable QA base is allowed.");
const load = (relative) => import(NodeURL.pathToFileURL(NodePath.join(repo, relative)).href);
const { makeSqlitePersistenceLive } = await load("apps/server/src/persistence/Layers/Sqlite.ts");
const TM = await load("apps/server/src/orchestration-v2/ThreadManagementService.ts");
const Registry = await load("apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts");
const { CodexProviderCapabilitiesV2 } = await load(
  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
);
const { makeOrchestratorV2ReplayLayerWithRegistry } = await load(
  "apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts",
);
const { sealCollaborationCommand, collaborationExecutionGate } = await load(
  "apps/server/src/collaboration/admit.ts",
);
const { submitCollaborationCommand } = await load("apps/server/src/collaboration/store.ts");
const { projectWorkflowEvent } = await load("apps/server/src/workflow/Projection.ts");
const { initialWorkflowRun } = await load("apps/server/src/workflow/Policy.ts");
const { BUILTIN_WORKFLOW_TEMPLATES } = await load("apps/server/src/workflow/Builtins.ts");
const id = ProviderInstanceId.make("qa-fixture");
const adapter = {
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("QA refuses execution"),
};
const database = makeSqlitePersistenceLive(NodePath.join(base, "userdata/state.sqlite")).pipe(
  Layer.provide(NodeServices.layer),
);
const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "manual-qa", runtimePolicyOverride: { cwd: base } },
  Registry.makeLayer([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const threads = TM.layer.pipe(Layer.provide(orchestrator));
const runtime = Layer.mergeAll(database, threads);
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const management = yield* TM.ThreadManagementService;
    const at = new Date().toISOString();
    for (const slug of ["alpha", "beta"]) {
      const projectId = ProjectId.make("qa-" + slug);
      const root = NodePath.join(base, "projects", slug);
      yield* sql`INSERT OR IGNORE INTO projection_projects(project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at)
    VALUES (${projectId},${"QA " + slug + " — disposable"},${root},${JSON.stringify({ instanceId: id, model: "gpt-5.4" })},'[]',${at},${at})`;
    }
    const projectId = ProjectId.make("qa-alpha");
    const threadId = ThreadId.make("qa-inspection-thread");
    yield* management.dispatch({
      type: "thread.create",
      commandId: CommandId.make("qa-seed-create"),
      threadId,
      projectId,
      title: "QA read-only inspection — no provider turn",
      modelSelection: { instanceId: id, model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "server",
      taskGovernance: "required",
      taskContract: {
        goal: "Inspect navigation and read-only Workflow preview.",
        redirect: "Stop if any real provider or live execution is requested.",
        acceptance: "User separately records browser, simulator and physical-device observations.",
        brake: {
          maxProviderStarts: 1,
          stopConditions:
            "QA only. Do not dispatch. Metadata-only fake peer denies all sessions and turns.",
        },
      },
    });
    const sealed = sealCollaborationCommand(
      { type: "thread.bind", commandId: "qa-seed-bind", projectId, threadId, agentId: id },
      {
        principalId: "administrative-bootstrap",
        projectIds: [projectId],
        providers: [
          {
            id,
            displayName: "QA fixture — no execution",
            capabilities: ["gpt-5.4"],
            executable: true,
          },
        ],
        threads: [{ id: threadId, projectId }],
        executionGate: collaborationExecutionGate,
      },
    );
    if (sealed.outcome !== "sealed") throw Error("Fixture seal failed");
    const linked = yield* submitCollaborationCommand(sql, sealed.command, {
      allowNewBinding: true,
    });
    if (linked.outcome !== "applied") throw Error("Fixture bind failed");
    const existing =
      yield* sql`SELECT run_id FROM projection_workflow_runs WHERE project_id = ${projectId}`;
    if (existing.length === 0)
      yield* projectWorkflowEvent({
        sequence: 1,
        type: "workflow.recorded",
        commandId: "qa-seed-workflow",
        payload: {
          projectId,
          mutation: {
            type: "run.start",
            run: initialWorkflowRun({
              runId: "qa-preview-run",
              projectId,
              template: BUILTIN_WORKFLOW_TEMPLATES[0],
              originThreadId: threadId,
              originMessageId: null,
              at,
            }),
          },
        },
      });
    const counts =
      yield* sql`SELECT (SELECT count(*) FROM projection_projects) AS projects,(SELECT count(*) FROM orchestration_v2_projection_threads) AS threads,(SELECT count(*) FROM orchestration_v2_projection_runs) AS providerRuns,(SELECT count(*) FROM orchestration_v2_projection_messages) AS messages`;
    console.log(
      JSON.stringify({
        fixture: counts[0],
        purpose: "manual QA preparation; no UI acceptance claim",
      }),
    );
  }).pipe(Effect.provide(runtime)),
);
