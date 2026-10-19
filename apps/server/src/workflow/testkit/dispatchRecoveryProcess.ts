// @effect-diagnostics nodeBuiltinImport:off - synchronous crash evidence must be written before process.exit, without scope finalization.
// Subprocess entrypoint for Workflow.processRecovery.test.ts. Never uses live config or providers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  WorkflowOperationError,
  WorkflowDispatchStageInput,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type {
  ProviderAdapterV2Shape,
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
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
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "../Builtins.ts";
import { initialWorkflowRun } from "../Policy.ts";
import { projectWorkflowEvent } from "../Projection.ts";
import {
  proposeWorkflowArtifact,
  previewWorkflowStage,
  dispatchWorkflowStage,
  performWorkflowAction,
  workflowCatalogForProject,
} from "../Workflow.ts";

const [directory, phase] = process.argv.slice(2);
if (
  !directory ||
  !phase ||
  ![
    "crash",
    "recover",
    "wrong-route",
    "future-attempt",
    "wrong-dispatch",
    "ledger-failure",
    "revise",
    "superseded-attempt",
    "journey",
    "journey-read",
    "unknown-launch",
    "pause-original",
    "replace-original-model",
  ].includes(phase)
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
const workspace =
  phase === "journey" || phase === "journey-read"
    ? NodePath.join(directory, "repository")
    : directory;
if (phase === "journey") {
  NodeFS.mkdirSync(workspace);
  NodeChildProcess.execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "Disposable workflow fixture");
  NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: workspace });
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: workspace, stdio: "ignore" },
  );
}
const projectId = ProjectId.make("recovery-project");
const environmentId = EnvironmentId.make("recovery-environment");
const instanceId = ProviderInstanceId.make("recovery-fake");
const at = "2026-10-12T00:00:00.000Z";
const project = {
  id: projectId,
  title: "Recovery test",
  workspaceRoot: workspace,
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
const driver = ProviderDriverKind.make("codex");
let journeyEvents: Queue.Queue<ProviderAdapterV2Event> | undefined;
let journeyTurn: ProviderAdapterV2TurnInput | undefined;
const journeyAdapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      trace("provider.openSession.fake");
      const now = yield* DateTime.now;
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      journeyEvents = events;
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: workspace,
          model: "fake-model",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: ({ threadId }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`fixture-provider-${threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "disposable-fake-only", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.gen(function* () {
            journeyTurn = turn;
            trace("provider.startTurn.fake");
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`fixture-turn-${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: "disposable-fake-turn", strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            });
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused fake snapshot"),
        rollbackThread: () => Effect.die("unused fake rollback"),
        forkThread: () => Effect.die("unused fake fork"),
      };
    }),
};
const database = makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite")).pipe(
  Layer.provide(NodeServices.layer),
);
const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "workflow-process-recovery", runtimePolicyOverride: { cwd: workspace } },
  ProviderAdapterRegistry.makeLayer([phase === "journey" ? journeyAdapter : adapter]),
  {
    databaseLayer: database,
    runEffectWorker: false,
    capabilityContextLayer: Layer.mergeAll(
      makeProviderRegistryLayer([provider(instanceId)]),
      Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    ),
  },
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
    runForThread: () =>
      phase === "journey"
        ? Effect.succeed({ status: "no-script" as const })
        : Effect.sync(() => trace("setup.fake")).pipe(Effect.andThen(Effect.never)),
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
const runtime = Layer.mergeAll(
  database,
  receipts,
  threads,
  launchLayer,
  orchestrator,
  external,
  makeProviderRegistryLayer([provider(instanceId)]),
  Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
);
const isWorkflowOperationError = Schema.is(WorkflowOperationError);
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowDispatchStageInput));
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(WorkflowDispatchStageInput));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const management = yield* ThreadManagement.ThreadManagementService;
  if (phase === "journey-read") {
    NodeFS.writeFileSync(
      NodePath.join(directory, "journey-read.json"),
      yield* encodeReport(yield* workflowCatalogForProject(projectId)),
    );
    process.exit(0);
  }
  if (
    phase === "crash" ||
    phase === "ledger-failure" ||
    phase === "journey" ||
    phase === "unknown-launch"
  ) {
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Recovery', ${workspace}, '[]', ${at}, ${at})`;
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
  if (phase === "revise") {
    const cursors = yield* sql<{ lastSequence: number }>`SELECT last_sequence AS "lastSequence"
      FROM projection_workflow_cursors WHERE project_id = ${projectId}`;
    const profile = BUILTIN_AGENT_PROFILES[0]!;
    // Fixture artifact only: the production decision path advances the attempt.
    // This is not evidence of a native/provider turn completing.
    yield* projectWorkflowEvent({
      sequence: cursors[0]!.lastSequence + 1,
      type: "workflow.recorded",
      commandId: "fixture-artifact",
      payload: {
        projectId,
        mutation: {
          type: "artifact.propose",
          artifact: {
            id: "revision-artifact",
            runId: "recovery-run",
            stageId: "discovery",
            attempt: 1,
            kind: "opportunity_brief",
            sourceTurnId: TurnId.make("fixture-turn"),
            profileId: profile.id,
            profileVersion: profile.version,
            sections: profile.requiredOutputSections.map((label) => ({
              label,
              content: "Unknown",
              missing: true,
            })),
            missingSections: [...profile.requiredOutputSections],
            extractionVersion: 1,
            redacted: false,
            status: "proposed",
            createdAt: at,
            acceptedAt: null,
          },
        },
      },
    });
    const revised = yield* performWorkflowAction(
      {
        type: "decision.record",
        projectId,
        commandId: "request-revision",
        decisionId: "revision",
        runId: "recovery-run",
        stageId: "discovery",
        attempt: 1,
        artifactId: "revision-artifact",
        value: "request_revision",
        revisionFeedback: {
          text: "Persisted process revision request",
          source: {
            runId: "recovery-run",
            stageId: "discovery",
            attempt: 1,
            artifactId: "revision-artifact",
          },
        },
      },
      () => Effect.succeed({ sequence: 1 }),
    );
    const report = yield* encodeReport({
      pid: process.pid,
      latestAttempt: revised.runs[0]?.attempts.at(-1)?.attempt,
    });
    NodeFS.writeFileSync(NodePath.join(directory, `${phase}.json`), report);
    process.exit(0);
  }
  if (phase === "pause-original" || phase === "replace-original-model") {
    if (phase === "pause-original")
      yield* performWorkflowAction(
        { type: "run.pause", projectId, commandId: "pause-original", runId: "recovery-run" },
        () => Effect.succeed({ sequence: 1 }),
      );
    else
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection.model','substituted')`;
    NodeFS.writeFileSync(NodePath.join(directory, `${phase}.json`), "{}");
    process.exit(0);
  }
  const target = {
    instanceId: phase === "wrong-route" ? ProviderInstanceId.make("other-fake") : instanceId,
    model: "fake-model",
  };
  const dispatchId = phase === "wrong-dispatch" ? "different-dispatch" : "recovery-dispatch";
  const draft = {
    environmentId,
    projectId,
    runId: "recovery-run",
    stageId: "discovery",
    attempt: phase === "future-attempt" ? 2 : 1,
    dispatchId,
    target,
    additionalInstruction: "",
  };
  const deps = {
    environmentId,
    providers: [provider(instanceId), provider(ProviderInstanceId.make("other-fake"))],
    environmentDefaultModelSelection: null,
  };
  const inputFile = NodePath.join(directory, "original-input.json");
  let original: typeof WorkflowDispatchStageInput.Type;
  if (
    phase === "crash" ||
    phase === "ledger-failure" ||
    phase === "journey" ||
    phase === "unknown-launch"
  ) {
    const preview = yield* previewWorkflowStage(
      {
        environmentId,
        projectId,
        runId: draft.runId,
        preferredRoute: target,
        taskContract: {
          goal: "Produce an evidence-backed discovery brief",
          redirect: "Only this stage",
          acceptance: "Human reviews the output",
          brake: {
            maxProviderStarts: 1,
            maxTokens: 4000,
            deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
            stopConditions: "Stop after this stage",
          },
        },
      },
      deps,
    );
    if (!preview.review) return yield* Effect.die("missing reviewed fixture route");
    original = { ...draft, review: preview.review };
    NodeFS.writeFileSync(inputFile, yield* encodeInput(original));
  } else original = yield* decodeInput(NodeFS.readFileSync(inputFile, "utf8"));
  const input = { ...original, target, dispatchId, attempt: draft.attempt };
  const runtimeOrchestrator = yield* Orchestrator.OrchestratorV2;
  const prepared =
    phase === "journey"
      ? yield* runtimeOrchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        )
      : null;
  const running =
    phase === "journey"
      ? yield* runtimeOrchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        )
      : null;
  const result = yield* Effect.exit(
    dispatchWorkflowStage(input, {
      environmentId,
      providers: [provider(instanceId), provider(ProviderInstanceId.make("other-fake"))],
      environmentDefaultModelSelection: null,
      launch: (payload) =>
        Effect.gen(function* () {
          trace("launch.enter");
          if (phase === "unknown-launch")
            return yield* new WorkflowOperationError({ message: "fixture uncertain entry" });
          const launched = yield* launches
            .launch({
              commandId: CommandId.make(`workflow-create-${dispatchId}`),
              threadId: payload.threadId,
              projectId,
              title: `Workflow: ${payload.stage.label}`,
              modelSelection: target,
              taskGovernance: "required",
              taskContract: payload.taskContract,
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: payload.messageId,
                text: payload.prompt,
                attachments: [],
              },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() =>
                  NodeFS.writeFileSync(
                    NodePath.join(directory, "launch-error.txt"),
                    Cause.pretty(cause),
                  ),
                ),
              ),
            );
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
  if (phase === "journey") {
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    if (prepared) yield* Fiber.join(prepared);
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    if (running) yield* Fiber.join(running);
    const turn = journeyTurn!;
    const events = journeyEvents!;
    const projection = yield* management.getThreadProjection(result.value.threadId);
    const providerTurn = projection.providerTurns.find(
      (entry) => entry.runAttemptId === turn.attemptId,
    )!;
    const now = yield* DateTime.now;
    yield* Queue.offer(events, {
      type: "message.updated",
      driver,
      message: {
        id: MessageId.make("disposable-fake-output"),
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId: turn.rootNodeId,
        role: "assistant",
        text: "# Product\nDisposable fake discovery product.\n\n# First customer\nA fixture customer.",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    });
    const settled = yield* runtimeOrchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === turn.runId &&
          event.payload.status === "waiting",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...providerTurn, status: "completed", completedAt: now },
    });
    yield* Queue.offer(events, {
      type: "turn.terminal",
      driver,
      providerThreadId: providerTurn.providerThreadId,
      providerTurnId: providerTurn.id,
      runOrdinal: turn.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    yield* Fiber.join(settled);
    yield* worker.drain();
    const artifactInput = {
      projectId,
      runId: "recovery-run",
      artifactId: "journey-artifact",
      commandId: "journey-propose",
    };
    const artifact = yield* proposeWorkflowArtifact(artifactInput, () =>
      Effect.succeed({ sequence: 1 }),
    );
    const duplicate = yield* proposeWorkflowArtifact(artifactInput, () =>
      Effect.die("duplicate artifact dispatch"),
    );
    const approve = (stageId: string, artifactId: string | null) =>
      performWorkflowAction(
        {
          type: "decision.record",
          projectId,
          commandId: `approve-${stageId}`,
          decisionId: `decision-${stageId}`,
          runId: "recovery-run",
          stageId,
          attempt: 1,
          artifactId,
          value: "approve",
        },
        () => Effect.succeed({ sequence: 1 }),
      );
    const gate = yield* approve("discovery", artifact.id);
    const architecture = yield* approve("build_gate", null);
    NodeFS.writeFileSync(
      NodePath.join(directory, "journey.json"),
      yield* encodeReport({
        artifact,
        duplicate,
        gate: gate.runs[0],
        architecture: architecture.runs[0],
        sourceRunId: turn.runId,
        native: yield* management.getThreadProjection(result.value.threadId),
      }),
    );
    process.exit(0);
  }
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
    failureDetails: result._tag === "Failure" ? Cause.pretty(result.cause) : null,
    error:
      result._tag === "Failure"
        ? (() => {
            const error = Cause.squash(result.cause);
            return isWorkflowOperationError(error)
              ? { tag: error._tag, message: error.message }
              : null;
          })()
        : null,
    latestAttempt: catalog.runs[0]?.attempts.at(-1)?.attempt,
    receipt: Option.getOrNull(receipt),
    stage: catalog.runs[0]?.attempts[0],
    nativeThreadRefs: projection?.providerThreads.map((thread) => thread.nativeThreadRef) ?? [],
  });
  NodeFS.writeFileSync(NodePath.join(directory, `${phase}.json`), report);
  // Explicit process exit keeps this test independent of graceful scope cleanup.
  process.exit(0);
});
NodeRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(runtime),
    Effect.provideService(PolicyExecutionContext, {
      kind: "session",
      actorId: "fixture-human",
      sessionId: "fixture-session",
      scopes: ["orchestration:operate", "orchestration:read"],
    }),
  ),
);
