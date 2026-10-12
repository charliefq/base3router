// @effect-diagnostics nodeBuiltinImport:off - synchronous crash evidence must be written before process.exit, without scope finalization.
// Subprocess entrypoint for Workflow.processRecovery.test.ts. Never uses live config or providers.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "../Builtins.ts";
import { initialWorkflowRun } from "../Policy.ts";
import { projectWorkflowEvent } from "../Projection.ts";
import { dispatchWorkflowStage, workflowCatalogForProject } from "../Workflow.ts";

const [directory, phase] = process.argv.slice(2);
if (
  !directory ||
  !phase ||
  !["crash", "recover", "wrong-route", "old-attempt", "wrong-dispatch", "ledger-failure"].includes(
    phase,
  )
)
  throw new Error("invalid-test-input");
const canonical = NodeFS.realpathSync(directory);
const relative = NodePath.relative(NodeFS.realpathSync(NodeOS.tmpdir()), canonical);
if (
  canonical !== directory ||
  relative.startsWith("..") ||
  NodePath.isAbsolute(relative) ||
  !NodePath.basename(directory).startsWith("workflow-recovery-")
)
  throw new Error("not-an-isolated-test-directory");
const trace = (event: string) =>
  NodeFS.appendFileSync(
    NodePath.join(directory, "calls.jsonl"),
    JSON.stringify({ event, pid: process.pid }) + "\n",
  );
const projectId = ProjectId.make("recovery-project");
const environmentId = EnvironmentId.make("recovery-environment");
const instanceId = ProviderInstanceId.make("recovery-fake");
const at = "2026-10-12T00:00:00.000Z";
const project = {
  id: projectId,
  title: "Recovery test",
  workspaceRoot: directory,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};
const provider = (id: ProviderInstanceId): ServerProvider => ({
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [{ slug: "fake-model", name: "Fake", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () =>
    Effect.sync(() => trace("provider.openSession")).pipe(
      Effect.andThen(Effect.die("provider execution disabled")),
    ),
} as ProviderAdapterV2Shape;
const database = makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite")).pipe(
  Layer.provide(NodeServices.layer),
);
const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "workflow-process-recovery", runtimePolicyOverride: { cwd: directory } },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const threads = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
const external = Layer.mergeAll(
  WorktreeSetupTracker.layer,
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
  Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
  Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  }),
  Layer.mock(GitWorkflow.GitWorkflowService)({}),
  Layer.mock(TextGeneration.TextGeneration)({}),
  Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
    // Hold preparation so no provider effect is eligible; process death, not scope
    // teardown, ends this fiber. Re-entry is expected and is not a provider send.
    runForThread: () => Effect.sync(() => trace("setup.fake")).pipe(Effect.andThen(Effect.never)),
  }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: directory,
    folderForThread: () => Effect.succeed(Option.none()),
  }),
  ServerSettings.layerTest(),
  makeProviderRegistryLayer([provider(instanceId)]),
);
const launchLayer = ThreadLaunch.layer.pipe(
  Layer.provide(Layer.mergeAll(external, threads, receipts, IdAllocator.layer)),
);
const runtime = Layer.mergeAll(database, receipts, threads, launchLayer);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const management = yield* ThreadManagement.ThreadManagementService;
  if (phase === "crash" || phase === "ledger-failure") {
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Recovery', ${directory}, '[]', ${at}, ${at})`;
    yield* projectWorkflowEvent({
      sequence: 1,
      type: "workflow.recorded",
      commandId: "seed-workflow",
      payload: {
        projectId,
        mutation: {
          type: "run.start",
          run: initialWorkflowRun({
            runId: "recovery-run",
            projectId,
            template: BUILTIN_WORKFLOW_TEMPLATES[0]!,
            originThreadId: null,
            originMessageId: null,
            at,
          }),
        },
      },
    });
  }
  if (phase === "ledger-failure")
    yield* sql`CREATE TEMP TRIGGER fail_stage_ledger BEFORE INSERT ON base3_workflow_commands
    WHEN NEW.command_id = 'workflow-dispatch-recovery-dispatch'
    BEGIN SELECT RAISE(ABORT, 'injected-ledger-failure'); END`;
  const target = {
    instanceId: phase === "wrong-route" ? ProviderInstanceId.make("other-fake") : instanceId,
    model: "fake-model",
  };
  const dispatchId = phase === "wrong-dispatch" ? "different-dispatch" : "recovery-dispatch";
  const input = {
    environmentId,
    projectId,
    runId: "recovery-run",
    stageId: "discovery",
    attempt: phase === "old-attempt" ? 2 : 1,
    dispatchId,
    target,
    additionalInstruction: "",
  };
  const result = yield* Effect.exit(
    dispatchWorkflowStage(input, {
      environmentId,
      providers: [provider(instanceId), provider(ProviderInstanceId.make("other-fake"))],
      environmentDefaultModelSelection: null,
      launch: (payload) =>
        Effect.gen(function* () {
          trace("launch.enter");
          const launched = yield* launches.launch({
            commandId: CommandId.make(`workflow-create-${dispatchId}`),
            threadId: payload.threadId,
            projectId,
            title: `Workflow: ${payload.stage.label}`,
            modelSelection: target,
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: payload.messageId, text: payload.prompt, attachments: [] },
            createdBy: "user",
            creationSource: "web",
          });
          const receipt = yield* receiptStore.getByCommandId(
            CommandId.make(`workflow-create-${dispatchId}`),
          );
          if (Option.isNone(receipt) || receipt.value.status !== "accepted")
            return yield* Effect.die("missing-real-command-receipt");
          const projection = yield* management.getThreadProjection(launched.threadId);
          trace(`receipt.accepted:${projection.messages.length}:${projection.runs.length}`);
          if (phase === "crash") process.exit(77);
          return { sequence: receipt.value.resultSequence };
        }),
    }),
  );
  const catalog = yield* workflowCatalogForProject(projectId);
  const receipt = yield* receiptStore.getByCommandId(
    CommandId.make("workflow-create-recovery-dispatch"),
  );
  const projection = Option.isSome(receipt)
    ? yield* management.getThreadProjection(receipt.value.threadId)
    : null;
  const report = yield* encodeReport({
    pid: process.pid,
    result: result._tag,
    receipt: Option.getOrNull(receipt),
    stage: catalog.runs[0]?.attempts[0],
    nativeThreadRefs: projection?.providerThreads.map((thread) => thread.nativeThreadRef) ?? [],
  });
  NodeFS.writeFileSync(NodePath.join(directory, `${phase}.json`), report);
  // Explicit process exit keeps this test independent of graceful scope cleanup.
  process.exit(0);
});
Effect.runPromise(program.pipe(Effect.provide(runtime))).catch((error: unknown) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
