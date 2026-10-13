// Disposable databases only.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2Command,
  NodeId,
  EventId,
  CollaborationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { sealCollaborationCommand } from "./admit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { makeSubagentChildThread } from "../orchestration-v2/SubagentProjection.ts";
import { readCollaborationSnapshot, submitCollaborationCommand } from "./store.ts";

import { withGovernedEnrollmentFixture } from "./testkit/governedEnrollmentFixture.ts";

const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const principal = {
  kind: "session" as const,
  actorId: "governed-owner",
  sessionId: "governed-session",
  scopes: [AuthOrchestrationOperateScope],
};
const projectId = ProjectId.make("governed-project");
const selection = { instanceId: ProviderInstanceId.make("fake-governed"), model: "fake-model" };
const contract = {
  goal: "Fix the parser",
  redirect: "Ask before changing syntax",
  acceptance: "Parser regression passes",
  brake: { maxProviderStarts: 2, stopConditions: "Unexpected syntax change" },
};
const create = (id: string): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: `Task ${id}`,
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "required",
  taskContract: contract,
});
const fakeAdapter = (id: string) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider execution is unavailable in enrollment fixtures"),
  }) as ProviderAdapterV2Shape;

const makeRuntime = (
  database: Layer.Layer<
    SqlClient.SqlClient,
    MigrationError | PlatformError.PlatformError | SqlError
  > = SqlitePersistenceMemory,
) =>
  Layer.mergeAll(
    database,
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "governed-enrollment" },
      ProviderAdapterRegistry.makeLayer([
        fakeAdapter(selection.instanceId),
        fakeAdapter("fake-new-selection"),
      ]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
const runtime = makeRuntime();
const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Governed fixture','/tmp','[]',${now},${now})`;
  return sql;
});

it.live.each(["user", "agent", "system"] as const)(
  "normal governed creation createdBy=%s uses authenticated ownership without an Agents binding",
  (createdBy) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const command = { ...create("governed-one"), createdBy };
        yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        const projection = yield* orchestrator.getThreadProjection(command.threadId);
        assert.deepEqual(projection.thread.taskContract, { revision: 1, ...contract });
        const snapshot = yield* readCollaborationSnapshot(sql, principal.actorId);
        assert.equal(
          snapshot.tasks.length,
          1,
          "a successful governed creation must have one durable task card",
        );
        assert.equal(snapshot.tasks[0]?.threadId, command.threadId);
        assert.equal(snapshot.tasks[0]?.title, command.title);
        assert.equal(snapshot.tasks[0]?.ownerAgentId, principal.actorId);
        assert.equal(snapshot.tasks[0]?.contractReadout?.status, "available");
        assert.equal(snapshot.agents.filter((agent) => agent.origin === "internal").length, 0);
        const rows = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM base3_execution_grants`;
        assert.equal(rows[0]?.count, 0);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live("keeps two same-provider tasks distinct and partitions principals and projects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const id of ["one", "two"])
        yield* orchestrator
          .dispatch(create(id))
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
      const foreign = { ...principal, actorId: "foreign-owner", sessionId: "foreign-session" };
      yield* orchestrator
        .dispatch(create("foreign"))
        .pipe(Effect.provideService(PolicyExecutionContext, foreign));
      const otherProject = ProjectId.make("other-project");
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) SELECT ${otherProject},title,workspace_root,scripts_json,created_at,updated_at FROM projection_projects WHERE project_id=${projectId}`;
      yield* orchestrator
        .dispatch({ ...create("other-project-task"), projectId: otherProject })
        .pipe(Effect.provideService(PolicyExecutionContext, principal));
      const own = yield* readCollaborationSnapshot(sql, principal.actorId);
      assert.deepEqual(
        own.tasks.filter((task) => task.projectId === projectId).map((task) => task.threadId),
        ["one", "two"],
      );
      assert.equal(new Set(own.tasks.map((task) => task.id)).size, 3);
      assert.deepEqual(
        (yield* readCollaborationSnapshot(sql, foreign.actorId)).tasks.map((task) => task.threadId),
        ["foreign"],
      );
      assert.deepEqual((yield* readCollaborationSnapshot(sql, "")).tasks, []);
      const replay = yield* Effect.exit(
        orchestrator
          .dispatch(create("one"))
          .pipe(Effect.provideService(PolicyExecutionContext, foreign)),
      );
      assert.isTrue(
        Exit.isFailure(replay),
        "a foreign principal cannot replay another owner's enrollment receipt",
      );
      const adopted = yield* Effect.exit(
        orchestrator
          .dispatch({ ...create("one"), commandId: CommandId.make("new-owner-adoption") })
          .pipe(Effect.provideService(PolicyExecutionContext, foreign)),
      );
      assert.isTrue(Exit.isFailure(adopted));
      const chatOverwrite = yield* Effect.exit(
        orchestrator
          .dispatch({
            ...create("one"),
            commandId: CommandId.make("chat-overwrite"),
            taskGovernance: "chat",
            taskContract: undefined,
          })
          .pipe(Effect.provideService(PolicyExecutionContext, foreign)),
      );
      assert.isTrue(Exit.isFailure(chatOverwrite));
      assert.equal((yield* readCollaborationSnapshot(sql, principal.actorId)).tasks.length, 3);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live("does not enroll ordinary chats, upgrades or provider-originated child projections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator
        .dispatch({ ...create("ordinary"), taskGovernance: "chat", taskContract: undefined })
        .pipe(Effect.provideService(PolicyExecutionContext, principal));
      yield* orchestrator
        .dispatch({
          type: "thread.task-contract.set",
          commandId: CommandId.make("upgrade"),
          threadId: ThreadId.make("ordinary"),
          ...contract,
        })
        .pipe(Effect.provideService(PolicyExecutionContext, principal));
      yield* orchestrator
        .dispatch(create("root"))
        .pipe(Effect.provideService(PolicyExecutionContext, principal));
      const parent = (yield* orchestrator.getThreadProjection(ThreadId.make("root"))).thread;
      const child = makeSubagentChildThread({
        parentThread: parent,
        childThreadId: ThreadId.make("provider-child"),
        parentNodeId: NodeId.make("fake-parent-node"),
        activeProviderThreadId: null,
        providerInstanceId: selection.instanceId,
        modelSelection: selection,
        title: "Provider child",
        now: yield* DateTime.now,
        createdBy: "agent",
        creationSource: "provider",
      });
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("fixture-child-event"),
            type: "thread.created",
            threadId: child.id,
            providerInstanceId: selection.instanceId,
            occurredAt: yield* DateTime.now,
            payload: child,
          },
        ],
      });
      assert.deepEqual(
        (yield* readCollaborationSnapshot(sql, principal.actorId)).tasks.map(
          (task) => task.threadId,
        ),
        ["root"],
      );
      const unowned = yield* orchestrator.dispatch({
        ...create("provider-root"),
        createdBy: "agent",
        creationSource: "provider",
      });
      assert.isAbove(unowned.sequence, 0);
      assert.equal((yield* readCollaborationSnapshot(sql, principal.actorId)).tasks.length, 1);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live(
  "keeps contract decisions on the same card without equating acceptance with ledger completion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const command = create("decisions");
        const dispatch = (input: OrchestrationV2Command) =>
          orchestrator
            .dispatch(input)
            .pipe(Effect.provideService(PolicyExecutionContext, principal));
        yield* dispatch(command);
        const original = (yield* readCollaborationSnapshot(sql, principal.actorId)).tasks[0]!;
        yield* dispatch({
          type: "thread.task-contract.set",
          commandId: CommandId.make("revise"),
          threadId: command.threadId,
          ...contract,
          goal: "Revised goal",
        });
        for (const [action, phase] of [
          ["redirect", "redirected"],
          ["resume", "active"],
          ["accept", "active"],
        ] as const) {
          yield* dispatch({
            type: `thread.task-contract.${action}`,
            commandId: CommandId.make(action),
            threadId: command.threadId,
            revision: 2,
          });
          const snapshot = yield* readCollaborationSnapshot(sql, principal.actorId);
          assert.equal(snapshot.tasks.length, 1);
          const task = snapshot.tasks[0]!;
          assert.equal(task.id, original.id);
          assert.equal(task.state, "blocked");
          assert.equal(task.gateDecision, "DENY");
          assert.equal(task.resultReadout?.status, "unavailable");
          assert.equal(task.contractReadout?.status, "available");
          if (task.contractReadout?.status === "available") {
            assert.equal(task.contractReadout.contract.goal, "Revised goal");
            assert.equal(task.contractReadout.contract.revision, 2);
            assert.equal(task.contractReadout.phase, phase);
            assert.equal(task.contractReadout.acceptedRevision, action === "accept" ? 2 : null);
          }
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live.each([
  "archive",
  "delete",
  "missing",
  "malformed",
  "foreign-project",
  "foreign-provider",
  "foreign-provider-payload",
  "child-lineage",
] as const)("fails closed on %s enrollment links without recreating or adopting them", (change) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const command = create(`invalid-${change}`);
      const dispatch = () =>
        orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
      yield* dispatch();
      if (change === "archive" || change === "delete") {
        yield* orchestrator
          .dispatch({
            type: `thread.${change}`,
            commandId: CommandId.make(`invalidate-${change}`),
            threadId: command.threadId,
          })
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
      } else if (change === "missing") {
        yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id=${command.threadId}`;
      } else if (change === "malformed") {
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{}' WHERE thread_id=${command.threadId}`;
      } else if (change === "foreign-project") {
        yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='foreign-project' WHERE thread_id=${command.threadId}`;
      } else if (change === "foreign-provider-payload") {
        yield* sql`UPDATE orchestration_v2_projection_threads SET provider_instance_id='foreign-provider', payload_json=json_set(payload_json,'$.providerInstanceId','foreign-provider','$.modelSelection.instanceId','foreign-provider') WHERE thread_id=${command.threadId}`;
      } else if (change === "foreign-provider") {
        yield* sql`UPDATE orchestration_v2_projection_threads SET provider_instance_id='foreign-provider' WHERE thread_id=${command.threadId}`;
      } else {
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId','foreign-parent') WHERE thread_id=${command.threadId}`;
      }
      for (let read = 0; read < 2; read++) {
        const snapshot = yield* readCollaborationSnapshot(sql, principal.actorId);
        assert.equal(snapshot.tasks.length, 1);
        assert.equal(snapshot.tasks[0]?.threadId, null);
        assert.deepEqual(snapshot.tasks[0]?.contractReadout, {
          status: "unavailable",
          reason: "invalid_thread_link",
        });
        assert.equal(snapshot.tasks[0]?.routingReadout?.status, "unavailable");
      }
      const replacement = yield* Effect.exit(
        orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make(`replace-${change}`),
            taskGovernance: "chat",
            taskContract: undefined,
          })
          .pipe(Effect.provideService(PolicyExecutionContext, principal)),
      );
      assert.isTrue(
        Exit.isFailure(replacement),
        "a new create cannot recreate an invalidated enrolled identity",
      );
      yield* dispatch(); // Receipt replay never reconstructs an invalidated thread/card.
      assert.equal(
        (yield* readCollaborationSnapshot(sql, principal.actorId)).tasks[0]?.threadId,
        null,
      );
      const entries = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM collaboration_commands`;
      assert.equal(entries[0]?.count, 1);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live("rejects client enrollment even with forged server ownership fields", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* seedProject;
      const forged: CollaborationCommand = {
        type: "task.enroll",
        commandId: "forged",
        admittedBy: principal.actorId,
        admissionSource: "server",
        actor: "owner",
        fromAgentId: principal.actorId,
        threadId: "missing",
        projectId,
        agentId: selection.instanceId,
        title: "Forged",
        acceptance: "Forged",
      };
      const admitted = sealCollaborationCommand(forged, {
        principalId: principal.actorId,
        projectIds: [projectId],
        providers: [],
        threads: [],
        executionGate: "DENY",
      });
      assert.equal(admitted.outcome, "rejected");
      assert.equal((yield* submitCollaborationCommand(sql, forged)).outcome, "rejected");
      assert.deepEqual((yield* readCollaborationSnapshot(sql, principal.actorId)).tasks, []);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live.each(["enrollment", "receipt"] as const)(
  "rolls back projected creation, events and receipt when %s persistence fails, then retries",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const command = create("atomic");
        if (failure === "enrollment")
          yield* sql`CREATE TRIGGER fail_enrollment BEFORE INSERT ON collaboration_commands BEGIN SELECT RAISE(ABORT,'injected enrollment failure'); END`;
        else
          yield* sql`CREATE TRIGGER fail_enrollment BEFORE UPDATE ON orchestration_command_receipts WHEN NEW.result_sequence > 0 BEGIN SELECT RAISE(ABORT,'injected receipt failure after enrollment'); END`;
        const result = yield* Effect.exit(
          orchestrator
            .dispatch(command)
            .pipe(Effect.provideService(PolicyExecutionContext, principal)),
        );
        assert.isTrue(Exit.isFailure(result));
        const threads = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`;
        const receipts = yield* sql`SELECT command_id FROM orchestration_command_receipts`;
        const events =
          yield* sql`SELECT command_id FROM orchestration_events WHERE command_id=${command.commandId}`;
        assert.equal(threads.length, 0);
        assert.equal(receipts.length, 0);
        assert.equal(events.length, 0);
        assert.equal((yield* sql`SELECT command_id FROM collaboration_commands`).length, 0);
        assert.equal((yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).length, 0);
        yield* sql`DROP TRIGGER fail_enrollment`;
        const accepted = yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        const replay = yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        assert.equal(replay.sequence, accepted.sequence);
        assert.equal((yield* readCollaborationSnapshot(sql, principal.actorId)).tasks.length, 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live(
  "recovers one enrollment after a lost response and a fresh runtime on the same disposable database",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b3r-enrollment-"))),
          (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
        );
        const database = makeSqlitePersistenceLive(NodePath.join(dir, "state.sqlite")).pipe(
          Layer.provide(NodeServices.layer),
        );
        const command = create("restart");
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seedProject;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator
              .dispatch(command)
              .pipe(Effect.provideService(PolicyExecutionContext, principal));
            return yield* Effect.fail("lost response after commit");
          }),
        ).pipe(Effect.provide(makeRuntime(database)), Effect.exit);
        assert.isTrue(Exit.isFailure(first));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator
              .dispatch(command)
              .pipe(Effect.provideService(PolicyExecutionContext, principal));
            const snapshot = yield* readCollaborationSnapshot(sql, principal.actorId);
            assert.equal(snapshot.tasks.length, 1);
            assert.equal(snapshot.tasks[0]?.threadId, command.threadId);
            assert.equal((yield* sql`SELECT command_id FROM collaboration_commands`).length, 1);
            assert.equal(
              (yield* sql`SELECT command_id FROM orchestration_command_receipts`).length,
              1,
            );
            assert.equal((yield* sql`SELECT grant_id FROM base3_execution_grants`).length, 0);
            assert.equal(
              (yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length,
              0,
            );
          }),
        ).pipe(Effect.provide(makeRuntime(database)));
        // A different environment is a different DB and cannot see or adopt this owner's task.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* seedProject;
            assert.deepEqual((yield* readCollaborationSnapshot(sql, principal.actorId)).tasks, []);
          }),
        ).pipe(Effect.provide(makeRuntime()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("normal create-to-Tasks fixture reads the same two durable roots and no execution", () =>
  withGovernedEnrollmentFixture((fixture) =>
    Effect.gen(function* () {
      const snapshot = yield* fixture.readSnapshot();
      assert.deepEqual(
        snapshot.tasks.map((task) => task.threadId),
        ["task-parser", "task-docs"],
      );
      assert.deepEqual(yield* fixture.noExecution(), {
        runs: 0,
        grants: 0,
        outbox: 0,
      });
    }),
  ),
);

it.live.each([false, true])(
  "attributes strict routing/output after provider change=%s and rejects wrong attempt/root/child/latest-run facts",
  (changedSelection) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const command = create("strict-evidence");
        yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        const evidenceSelection = changedSelection
          ? {
              instanceId: ProviderInstanceId.make("fake-new-selection"),
              model: "another-fake-model",
            }
          : selection;
        if (changedSelection)
          yield* orchestrator
            .dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("strict-selection-change"),
              threadId: command.threadId,
              modelSelection: evidenceSelection,
            })
            .pipe(Effect.provideService(PolicyExecutionContext, principal));
        const json = encodeEvidence;
        const start = "2026-10-13T00:00:00Z";
        const end = "2026-10-13T00:00:01Z";
        const run = {
          id: "run-1",
          threadId: command.threadId,
          ordinal: 1,
          providerInstanceId: evidenceSelection.instanceId,
          modelSelection: evidenceSelection,
          userMessageId: "message-1",
          activeAttemptId: "attempt-1",
          rootNodeId: "root-1",
          providerThreadId: "p-thread-1",
          status: "completed",
        };
        const attempt = {
          id: "attempt-1",
          runId: run.id,
          rootNodeId: run.rootNodeId,
          providerInstanceId: evidenceSelection.instanceId,
          providerThreadId: run.providerThreadId,
          providerTurnId: "p-turn-1",
          status: "completed",
        };
        const providerThread = {
          id: "p-thread-1",
          appThreadId: command.threadId,
          providerInstanceId: evidenceSelection.instanceId,
          driver: "codex",
        };
        const turn = {
          id: "p-turn-1",
          providerThreadId: run.providerThreadId,
          nodeId: run.rootNodeId,
          runAttemptId: attempt.id,
          status: "completed",
          startedAt: start,
          completedAt: end,
        };
        const root = {
          id: "root-1",
          threadId: command.threadId,
          runId: run.id,
          parentNodeId: null,
          rootNodeId: "root-1",
          kind: "root_turn",
          status: "completed",
          providerThreadId: null,
          providerTurnId: null,
          startedAt: start,
          completedAt: end,
        };
        const child = {
          ...root,
          id: "assistant-node",
          parentNodeId: root.id,
          kind: "assistant_message",
          providerThreadId: providerThread.id,
          providerTurnId: turn.id,
        };
        const item = {
          id: "assistant-item",
          threadId: command.threadId,
          runId: run.id,
          nodeId: child.id,
          providerThreadId: providerThread.id,
          providerTurnId: turn.id,
          parentItemId: null,
          ordinal: 1,
          type: "assistant_message",
          status: "completed",
          startedAt: start,
          completedAt: end,
          updatedAt: end,
          text: "Strict fixture output",
          streaming: false,
        };
        const binding = {
          policyVersion: "dispatcher.phase-1a.v1",
          target: evidenceSelection,
          driver: "codex",
          modelFamily: "gpt",
          fallbackIndex: 0,
          source: "explicit",
          gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
        };
        yield* sql`INSERT INTO projection_dispatcher_task_routes (thread_id,message_id,binding_json,created_at) VALUES (${command.threadId},${run.userMessageId},${json(binding)},${start})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,completed_at,payload_json) VALUES (${run.id},${command.threadId},1,'codex',${evidenceSelection.instanceId},${providerThread.id},'completed',${start},${end},${json(run)})`;
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,provider_turn_id,status,payload_json) VALUES (${attempt.id},${command.threadId},${run.id},1,${root.id},'codex',${evidenceSelection.instanceId},${providerThread.id},${turn.id},'completed',${json(attempt)})`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id,thread_id,provider,provider_instance_id,driver,status,updated_at,payload_json) VALUES (${providerThread.id},${command.threadId},'codex',${evidenceSelection.instanceId},'codex','idle',${end},${json(providerThread)})`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES (${turn.id},${command.threadId},${providerThread.id},${root.id},${attempt.id},1,'completed',${start},${end},${json(turn)})`;
        for (const node of [root, child])
          yield* sql`INSERT INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES (${node.id},${command.threadId},${run.id},${node.parentNodeId},${root.id},${node.kind},'completed',${node.providerThreadId},${node.providerTurnId},${start},${end},${json(node)})`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES (${item.id},${command.threadId},${run.id},${child.id},${providerThread.id},${turn.id},NULL,1,'assistant_message','completed',${end},${json(item)})`;
        const read = () =>
          readCollaborationSnapshot(sql, principal.actorId).pipe(
            Effect.map((snapshot) => snapshot.tasks[0]!),
          );
        const task = yield* read();
        assert.equal(
          task.routingReadout?.status === "available" && task.routingReadout.execution.status,
          "observed",
        );
        assert.deepEqual(task.resultReadout?.status === "available" && task.resultReadout.content, {
          status: "output",
          itemId: item.id,
          preview: item.text,
          truncated: false,
        });
        assert.equal(task.state, "blocked");
        assert.equal(
          task.contractReadout?.status === "available" && task.contractReadout.acceptedRevision,
          null,
        );
        yield* sql`UPDATE orchestration_v2_projection_run_attempts SET payload_json=${json({ ...attempt, rootNodeId: "foreign-root" })} WHERE attempt_id=${attempt.id}`;
        const invalidAttempt = (yield* read()).resultReadout;
        assert.equal(
          invalidAttempt?.status === "available" && invalidAttempt.content.status,
          "unknown",
        );
        yield* sql`UPDATE orchestration_v2_projection_run_attempts SET payload_json=${json(attempt)} WHERE attempt_id=${attempt.id}`;
        for (const node of [
          { ...child, parentNodeId: "foreign-parent" },
          { ...child, rootNodeId: "foreign-root" },
          { ...child, threadId: "foreign-thread" },
        ]) {
          yield* sql`UPDATE orchestration_v2_projection_nodes SET payload_json=${json(node)} WHERE node_id=${child.id}`;
          const invalid = (yield* read()).resultReadout;
          assert.equal(invalid?.status === "available" && invalid.content.status, "unknown");
        }
        yield* sql`UPDATE orchestration_v2_projection_nodes SET payload_json=${json(child)} WHERE node_id=${child.id}`;
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json=${json({ ...turn, runAttemptId: "foreign-attempt" })} WHERE provider_turn_id=${turn.id}`;
        const invalidTurn = (yield* read()).routingReadout;
        assert.equal(
          invalidTurn?.status === "available" && invalidTurn.execution.status,
          "unknown",
        );
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json=${json(turn)} WHERE provider_turn_id=${turn.id}`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES ('run-2',${command.threadId},2,'codex',${evidenceSelection.instanceId},'running',${end},${json({ ...run, id: "run-2", ordinal: 2, userMessageId: "message-2", activeAttemptId: null, rootNodeId: null, providerThreadId: null, status: "running" })})`;
        const latest = yield* read();
        assert.equal(
          latest.resultReadout?.status === "available" && latest.resultReadout.content.status,
          "unknown",
        );
        assert.isFalse(json(latest.resultReadout).includes(item.text));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live.each([
  "missing-project",
  "deleted-project",
  "missing-principal",
  "missing-operate",
] as const)("fails closed before successful enrollment with %s", (failure) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      if (failure === "missing-project")
        yield* sql`DELETE FROM projection_projects WHERE project_id=${projectId}`;
      if (failure === "deleted-project")
        yield* sql`UPDATE projection_projects SET deleted_at='2026-10-13T00:00:00Z' WHERE project_id=${projectId}`;
      const actor =
        failure === "missing-principal"
          ? { ...principal, actorId: "" }
          : failure === "missing-operate"
            ? { ...principal, scopes: [] }
            : principal;
      const result = yield* Effect.exit(
        orchestrator
          .dispatch(create(failure))
          .pipe(Effect.provideService(PolicyExecutionContext, actor)),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.equal(
        (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
        0,
      );
      assert.equal((yield* sql`SELECT command_id FROM collaboration_commands`).length, 0);
      assert.deepEqual((yield* readCollaborationSnapshot(sql, principal.actorId)).tasks, []);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);

it.live.each([false, true])(
  "retains the owned task across provider selection change with archive recovery=%s without moving Agents",
  (archived) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const command = create("selection-change");
        yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        const original = (yield* readCollaborationSnapshot(sql, principal.actorId)).tasks[0]!;
        if (archived) {
          yield* orchestrator
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.make("archive-selection-task"),
              threadId: command.threadId,
            })
            .pipe(Effect.provideService(PolicyExecutionContext, principal));
          assert.equal(
            (yield* readCollaborationSnapshot(sql, principal.actorId)).tasks[0]?.threadId,
            null,
          );
        }
        const next = {
          instanceId: ProviderInstanceId.make("fake-new-selection"),
          model: "another-fake-model",
        };
        yield* orchestrator
          .dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("select-another-provider"),
            threadId: command.threadId,
            modelSelection: next,
          })
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        if (archived)
          yield* orchestrator
            .dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make("unarchive-selection-task"),
              threadId: command.threadId,
            })
            .pipe(Effect.provideService(PolicyExecutionContext, principal));
        yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("rename-task"),
            threadId: command.threadId,
            title: "Real renamed task",
          })
          .pipe(Effect.provideService(PolicyExecutionContext, principal));
        const snapshot = yield* readCollaborationSnapshot(sql, principal.actorId);
        assert.equal(snapshot.tasks.length, 1);
        assert.equal(snapshot.tasks[0]?.id, original.id);
        assert.equal(snapshot.tasks[0]?.ownerAgentId, principal.actorId);
        assert.equal(snapshot.tasks[0]?.threadId, command.threadId);
        assert.equal(snapshot.tasks[0]?.assigneeAgentId, next.instanceId);
        assert.equal(snapshot.tasks[0]?.title, "Real renamed task");
        assert.equal(snapshot.tasks[0]?.contractReadout?.status, "available");
        assert.equal(snapshot.agents.filter((agent) => agent.origin === "internal").length, 0);
        assert.equal((yield* sql`SELECT command_id FROM collaboration_commands`).length, 1);
        const grantCount = yield* sql`SELECT grant_id FROM base3_execution_grants`;
        assert.equal(grantCount.length, 0);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(runtime, NodeServices.layer))),
);
