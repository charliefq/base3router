// @effect-diagnostics nodeBuiltinImport:off - crash evidence must survive process.exit without scope finalization.
// Only spawned against a disposable directory by ProviderRuntimeRecovery.process.test.ts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { runOrderedV2StartupPhases } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EventSink from "../EventSink.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as Recovery from "../ProviderRuntimeRecoveryService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";

const [directory, phase] = process.argv.slice(2);
if (!directory || !phase || !["crash", "recover", "repeat"].includes(phase))
  throw new Error("invalid-test-input");
const relative = NodePath.relative(
  NodeFS.realpathSync(NodeOS.tmpdir()),
  NodeFS.realpathSync(directory),
);
if (
  NodeFS.realpathSync(directory) !== directory ||
  relative.startsWith("..") ||
  NodePath.isAbsolute(relative) ||
  !NodePath.basename(directory).startsWith("native-recovery-")
)
  throw new Error("not-an-isolated-test-directory");
const trace = (event: string) =>
  NodeFS.appendFileSync(
    NodePath.join(directory, "calls.jsonl"),
    JSON.stringify({ event, pid: process.pid }) + "\n",
  );
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("native-recovery-fake");
const threadId = ThreadId.make("native-recovery-thread");
const modelSelection = { instanceId, model: "fake-model" };
const unexpected = () => Effect.die("unexpected fake provider operation");
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      trace("openSession");
      const now = yield* DateTime.now;
      const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: directory,
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: () =>
          Effect.succeed({
            id: ProviderThreadId.make("native-recovery-provider-thread"),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "fake-native-thread", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        startTurn: (turn) =>
          Effect.gen(function* () {
            trace("startTurn");
            if (phase !== "crash") return yield* unexpected();
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              threadId,
              providerTurn: {
                id: ProviderTurnId.make("native-recovery-provider-turn"),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: "fake-native-turn", strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            });
            // Keep the actual provider-turn.start effect leased and unsettled until process death.
            return yield* Effect.never;
          }),
        resumeThread: unexpected,
        steerTurn: unexpected,
        interruptTurn: unexpected,
        respondToRuntimeRequest: unexpected,
        readThreadSnapshot: unexpected,
        rollbackThread: unexpected,
        forkThread: unexpected,
      };
    }),
};
const database = makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite")).pipe(
  Layer.provide(NodeServices.layer),
);
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "native-process-recovery", runtimePolicyOverride: { cwd: directory } },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const settings = ServerSettings.layerTest();
const recovery = Recovery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      runtime,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      IdAllocator.layer,
      settings,
    ),
  ),
);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const program = Effect.scoped(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    let drained = 0;
    let hasMoreWork = false;
    if (phase === "crash") {
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("native-create"),
        threadId,
        projectId: ProjectId.make("native-project"),
        title: "Native recovery",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("native-send"),
        threadId,
        messageId: MessageId.make("native-message"),
        text: "Fake provider only",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* worker.drain(20).pipe(Effect.forkScoped);
      const sink = yield* EventSink.EventSinkV2;
      // This stream replays committed events before tailing, so subscription timing cannot lose the barrier.
      yield* sink.stream({ threadId, eventType: "provider-turn.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.nativeTurnRef?.nativeId === "fake-native-turn",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    } else {
      const service = yield* Recovery.ProviderRuntimeRecoveryService;
      yield* runOrderedV2StartupPhases({
        importLegacyShells: Effect.void,
        recover: service.recover.pipe(Effect.tap(() => Effect.sync(() => trace("recovered")))),
        startEffectWorker: Effect.gen(function* () {
          drained = yield* worker.drain(20);
          hasMoreWork = yield* worker.runOnce;
          trace("drained");
        }),
        autoBootstrap: Effect.void,
      });
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const effects =
      yield* sql`SELECT effect_id AS id, effect_type, status, attempt_count, lease_owner FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
    const report = yield* encode({
      providerThreads: projection.providerThreads,
      providerTurns: projection.providerTurns,
      runs: projection.runs,
      attempts: projection.attempts,
      sessions: projection.providerSessions,
      effects,
      drained,
      hasMoreWork,
      continueThreadsAfterServerUpdate: config.continueThreadsAfterServerUpdate,
    });
    NodeFS.writeFileSync(NodePath.join(directory, `${phase}.json`), report);
    if (phase === "crash") process.exit(77);
  }),
).pipe(Effect.provide(Layer.mergeAll(runtime, recovery, database, settings)));
Effect.runPromise(program).catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
