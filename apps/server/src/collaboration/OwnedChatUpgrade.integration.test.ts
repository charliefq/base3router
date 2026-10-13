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
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { readCollaborationSnapshot } from "./store.ts";

const actor = {
  kind: "session" as const,
  actorId: "chat-owner",
  sessionId: "chat-session",
  scopes: [AuthOrchestrationOperateScope],
};
const projectId = ProjectId.make("chat-project");
const selection = {
  instanceId: ProviderInstanceId.make("fake-chat-provider"),
  model: "fake-model",
};
const contract = {
  goal: "Fix parser",
  redirect: "Ask before syntax change",
  acceptance: "Owner checks parser regression",
  brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
};
const create = (id: string): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: `Chat ${id}`,
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "chat",
});
const upgrade = (
  id: string,
): Extract<OrchestrationV2Command, { type: "thread.task-contract.set" }> => ({
  type: "thread.task-contract.set",
  commandId: CommandId.make(`upgrade:${id}`),
  threadId: ThreadId.make(id),
  ...contract,
});
const fakeAdapter = (id: string) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Execution is unavailable in owned-upgrade fixtures"),
  }) as ProviderAdapterV2Shape;
const runtime = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "owned-chat-upgrade" },
    ProviderAdapterRegistry.makeLayer([
      fakeAdapter(selection.instanceId),
      fakeAdapter("fake-next"),
    ]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  ),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Chat fixture','/tmp','[]',${now},${now})`;
  return sql;
});

it.live(
  "actual future ordinary create and authenticated contract-set enroll the same root once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* seed;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator
          .dispatch(create("owned"))
          .pipe(Effect.provideService(PolicyExecutionContext, actor));
        assert.deepEqual((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks, []);
        yield* orchestrator
          .dispatch(upgrade("owned"))
          .pipe(Effect.provideService(PolicyExecutionContext, actor));
        const projection = yield* orchestrator.getThreadProjection(ThreadId.make("owned"));
        assert.deepEqual(projection.thread.taskContract, { revision: 1, ...contract });
        const snapshot = yield* readCollaborationSnapshot(sql, actor.actorId);
        assert.equal(
          snapshot.tasks.length,
          1,
          "a prospectively owned upgraded chat must appear in Tasks",
        );
        assert.equal(snapshot.tasks[0]?.threadId, "owned");
        assert.equal(snapshot.tasks[0]?.title, "Chat owned");
        assert.equal(snapshot.tasks[0]?.ownerAgentId, actor.actorId);
        assert.equal(snapshot.tasks[0]?.contractReadout?.status, "available");
        assert.equal(snapshot.agents.filter((item) => item.origin === "internal").length, 0);
        assert.equal((yield* sql`SELECT grant_id FROM base3_execution_grants`).length, 0);
        assert.equal((yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length, 0);
      }),
    ).pipe(Effect.provide(runtime)),
);

const scoped = <E>(
  check: (fixture: {
    sql: SqlClient.SqlClient;
    orchestrator: Orchestrator.OrchestratorV2["Service"];
  }) => Effect.Effect<void, E, EventSink.EventSinkV2>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* seed;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* check({ sql, orchestrator });
    }),
  ).pipe(Effect.provide(runtime));
const dispatch = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  command: OrchestrationV2Command,
  subject = actor,
) => orchestrator.dispatch(command).pipe(Effect.provideService(PolicyExecutionContext, subject));
const foreign = { ...actor, actorId: "foreign-owner", sessionId: "foreign-session" };
const facts = (sql: SqlClient.SqlClient) =>
  Effect.all({
    events: sql`SELECT * FROM orchestration_events`,
    receipts: sql`SELECT * FROM orchestration_command_receipts`,
    ledger: sql`SELECT * FROM collaboration_commands`,
    threads: sql`SELECT * FROM orchestration_v2_projection_threads`,
    runs: sql`SELECT * FROM orchestration_v2_projection_runs`,
    grants: sql`SELECT * FROM base3_execution_grants`,
    outbox: sql`SELECT * FROM orchestration_v2_effect_outbox`,
  });

it.live(
  "keeps two ordinary roots separate, records authenticated owner independently of createdBy, and never binds Agents",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, { ...create("one"), createdBy: "agent" });
        yield* dispatch(orchestrator, create("two"));
        assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 0);
        for (const id of ["one", "two"]) {
          const accepted = yield* dispatch(orchestrator, upgrade(id));
          assert.deepEqual(accepted.taskEnrollment, {
            status: "enrolled",
            taskId: `task:governed:thread:${id}`,
          });
          assert.deepEqual(yield* dispatch(orchestrator, upgrade(id)), accepted);
        }
        const snapshot = yield* readCollaborationSnapshot(sql, actor.actorId);
        assert.deepEqual(
          snapshot.tasks.map((task) => task.threadId),
          ["one", "two"],
        );
        assert.deepEqual(
          snapshot.tasks.map((task) => task.ownerAgentId),
          [actor.actorId, actor.actorId],
        );
        assert.equal(snapshot.agents.filter((agent) => agent.origin === "internal").length, 0);
        const persisted = yield* facts(sql);
        assert.equal(persisted.events.length, 4);
        assert.equal(persisted.ledger.length, 6);
        assert.equal(persisted.runs.length + persisted.grants.length + persisted.outbox.length, 0);
      }),
    ),
);

it.live(
  "foreign operate scope can edit but cannot claim sealed origin; owner can subsequently enroll",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        const first = yield* dispatch(orchestrator, upgrade("owned"), foreign);
        assert.deepEqual(first.taskEnrollment, {
          status: "not-enrolled",
          reason: "ownership-mismatch",
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(ThreadId.make("owned"))).thread.taskContract
            ?.revision,
          1,
        );
        assert.equal((yield* readCollaborationSnapshot(sql, foreign.actorId)).tasks.length, 0);
        const next = yield* dispatch(orchestrator, {
          ...upgrade("owned"),
          commandId: CommandId.make("owner-upgrade"),
        });
        assert.equal(next.taskEnrollment?.status, "enrolled");
        assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 1);
      }),
    ),
);

it.live.each([
  "legacy",
  "missing",
  "malformed",
  "conflicting",
  "wrong-birth",
  "wrong-receipt",
  "wrong-selection",
  "metadata-provider",
] as const)("keeps %s origin unadopted while preserving contract edit", (change) =>
  scoped(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      if (change === "legacy") yield* orchestrator.dispatch(create("owned"));
      else yield* dispatch(orchestrator, create("owned"));
      if (change === "missing")
        yield* sql`DELETE FROM collaboration_commands WHERE command_id='thread:origin:owned'`;
      if (change === "malformed")
        yield* sql`UPDATE collaboration_commands SET payload_json='{' WHERE command_id='thread:origin:owned'`;
      if (change === "conflicting")
        yield* sql`INSERT INTO collaboration_commands(command_id,sequence,payload_json,created_at) SELECT 'other-origin',99,payload_json,created_at FROM collaboration_commands WHERE command_id='thread:origin:owned'`;
      if (change === "wrong-birth")
        yield* sql`UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.createdBy','agent','$.taskGovernance','required') WHERE command_id='create:owned'`;
      if (change === "wrong-receipt")
        yield* sql`UPDATE orchestration_command_receipts SET command_type='thread.metadata.update' WHERE command_id='create:owned'`;
      if (change === "wrong-selection")
        yield* sql`UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.modelSelection.instanceId','foreign') WHERE command_id='create:owned'`;
      if (change === "metadata-provider")
        yield* sql`UPDATE orchestration_events SET metadata_json='{"providerInstanceId":"foreign"}' WHERE command_id='create:owned'`;
      const result = yield* dispatch(orchestrator, upgrade("owned"));
      assert.deepEqual(result.taskEnrollment, {
        status: "not-enrolled",
        reason:
          change === "legacy" || change === "missing" ? "origin-unavailable" : "origin-invalid",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(ThreadId.make("owned"))).thread.taskContract
          ?.revision,
        1,
      );
      assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 0);
      assert.deepEqual(yield* dispatch(orchestrator, upgrade("owned")), result);
    }),
  ),
);

it.live.each(["archive", "delete", "project-deleted", "child", "fork", "provider"] as const)(
  "does not enroll %s projections",
  (change) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        if (change === "project-deleted")
          yield* sql`UPDATE projection_projects SET deleted_at='2026-10-13T00:00:00Z' WHERE project_id=${projectId}`;
        else if (change === "archive" || change === "delete")
          yield* dispatch(orchestrator, {
            type: `thread.${change}`,
            commandId: CommandId.make(change),
            threadId: ThreadId.make("owned"),
          });
        else {
          const payload =
            change === "child"
              ? "$.lineage.parentThreadId"
              : change === "fork"
                ? "$.forkedFrom"
                : "$.creationSource";
          const value = change === "provider" ? "provider" : "parent";
          if (change === "fork")
            yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId','parent','$.lineage.relationshipToParent','fork') WHERE thread_id='owned'`;
          else
            yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,${payload},${value}) WHERE thread_id='owned'`;
        }
        const result = yield* Effect.exit(dispatch(orchestrator, upgrade("owned")));
        // Existing contract edit validation can reject inactive/child roots; automatic enrollment never adopts them.
        if (Exit.isSuccess(result))
          assert.equal(result.value.taskEnrollment?.status, "not-enrolled");
        assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 0);
      }),
    ),
);

it.live.each(["enrollment", "outcome", "receipt"] as const)(
  "rolls back transition, enrollment and receipt when %s persistence fails",
  (failure) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        const before = yield* facts(sql);
        if (failure === "enrollment")
          yield* sql`CREATE TRIGGER injected_fault BEFORE INSERT ON collaboration_commands WHEN json_extract(NEW.payload_json,'$.type')='task.enroll' BEGIN SELECT RAISE(ABORT,'enrollment fault'); END`;
        else if (failure === "outcome")
          yield* sql`CREATE TRIGGER injected_fault BEFORE INSERT ON collaboration_commands WHEN json_extract(NEW.payload_json,'$.kind')='task-enrollment-result.v1' BEGIN SELECT RAISE(ABORT,'outcome fault'); END`;
        else
          yield* sql`CREATE TRIGGER injected_fault BEFORE UPDATE ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' AND NEW.result_sequence>0 BEGIN SELECT RAISE(ABORT,'receipt fault'); END`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(dispatch(orchestrator, upgrade("owned")))));
        assert.deepEqual(yield* facts(sql), before);
        yield* sql`DROP TRIGGER injected_fault`;
        const result = yield* dispatch(orchestrator, upgrade("owned"));
        assert.equal(result.taskEnrollment?.status, "enrolled");
        assert.deepEqual(yield* dispatch(orchestrator, upgrade("owned")), result);
        assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 1);
      }),
    ),
);

it.live("rolls back ordinary creation on origin failure and safely retries", () =>
  scoped(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      yield* sql`CREATE TRIGGER injected_fault BEFORE INSERT ON collaboration_commands BEGIN SELECT RAISE(ABORT,'origin fault'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(dispatch(orchestrator, create("owned")))));
      assert.equal((yield* facts(sql)).events.length, 0);
      assert.equal((yield* facts(sql)).receipts.length, 0);
      assert.equal((yield* facts(sql)).threads.length, 0);
      yield* sql`DROP TRIGGER injected_fault`;
      yield* dispatch(orchestrator, create("owned"));
      yield* dispatch(orchestrator, upgrade("owned"));
      assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 1);
    }),
  ),
);

it.live.each(["actor", "root", "type", "missing-outcome", "malformed-outcome"] as const)(
  "rejects %s upgrade receipt replay without any mutation",
  (collision) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        yield* dispatch(orchestrator, upgrade("owned"));
        if (collision === "missing-outcome")
          yield* sql`DELETE FROM collaboration_commands WHERE command_id='task:enrollment-result:upgrade:owned'`;
        if (collision === "malformed-outcome")
          yield* sql`UPDATE collaboration_commands SET payload_json='{}' WHERE command_id='task:enrollment-result:upgrade:owned'`;
        const before = yield* facts(sql);
        const command: OrchestrationV2Command =
          collision === "type"
            ? { ...create("owned"), commandId: upgrade("owned").commandId }
            : {
                ...upgrade("owned"),
                ...(collision === "root" ? { threadId: ThreadId.make("other") } : {}),
              };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              dispatch(orchestrator, command, collision === "actor" ? foreign : actor),
            ),
          ),
        );
        assert.deepEqual(yield* facts(sql), before);
      }),
    ),
);

it.live.each([
  "event-id",
  "event-command",
  "event-envelope",
  "event-owner",
  "event-provider",
  "event-metadata",
  "birth-seal",
  "current-provider",
  "current-model",
] as const)("invalidates exact links on inconsistent %s evidence", (change) =>
  scoped(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      yield* dispatch(orchestrator, create("owned"));
      yield* dispatch(orchestrator, upgrade("owned"));
      if (change === "event-id")
        yield* sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.upgradeEventId','foreign') WHERE command_id='task:enroll:upgrade:owned'`;
      if (change === "event-command")
        yield* sql`UPDATE orchestration_events SET command_id='foreign' WHERE command_id='upgrade:owned'`;
      if (change === "event-envelope")
        yield* sql`UPDATE orchestration_events SET stream_id='foreign' WHERE command_id='upgrade:owned'`;
      if (change === "event-owner")
        yield* sql`UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.taskDecisions[0].actorId','foreign') WHERE command_id='upgrade:owned'`;
      if (change === "event-provider")
        yield* sql`UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.providerInstanceId','foreign','$.modelSelection.instanceId','foreign'),metadata_json='{}' WHERE command_id='upgrade:owned'`;
      if (change === "event-metadata")
        yield* sql`UPDATE orchestration_events SET metadata_json='{"providerInstanceId":"foreign"}' WHERE command_id='upgrade:owned'`;
      if (change === "birth-seal")
        yield* sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.ownerId','foreign') WHERE command_id='thread:origin:owned'`;
      if (change === "current-provider")
        yield* sql`UPDATE orchestration_v2_projection_threads SET provider_instance_id='foreign' WHERE thread_id='owned'`;
      if (change === "current-model")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.instanceId','foreign') WHERE thread_id='owned'`;
      const before = yield* facts(sql);
      for (let read = 0; read < 2; read++) {
        const task = (yield* readCollaborationSnapshot(sql, actor.actorId)).tasks[0]!;
        assert.equal(task.threadId, null);
        assert.equal(task.contractReadout?.status, "unavailable");
        assert.equal(task.routingReadout?.status, "unavailable");
        assert.equal(task.resultReadout?.status, "unavailable");
      }
      assert.deepEqual(yield* facts(sql), before);
    }),
  ),
);

it.live(
  "preserves optional metadata absence and later revisions/redirect/resume/human acceptance on one card",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        yield* sql`UPDATE orchestration_events SET metadata_json='{}' WHERE command_id='create:owned'`;
        yield* dispatch(orchestrator, upgrade("owned"));
        yield* sql`UPDATE orchestration_events SET metadata_json='{}' WHERE command_id='upgrade:owned'`;
        const original = (yield* readCollaborationSnapshot(sql, actor.actorId)).tasks[0]!;
        assert.equal(original.threadId, "owned");
        const revision = yield* dispatch(orchestrator, {
          ...upgrade("owned"),
          commandId: CommandId.make("revision"),
          goal: "Revised goal",
        });
        assert.equal(revision.taskEnrollment?.status, "already-enrolled");
        for (const action of ["redirect", "resume", "accept"] as const) {
          yield* dispatch(orchestrator, {
            type: `thread.task-contract.${action}`,
            commandId: CommandId.make(action),
            threadId: ThreadId.make("owned"),
            revision: 2,
          });
          const snapshot = yield* readCollaborationSnapshot(sql, actor.actorId);
          assert.equal(snapshot.tasks.length, 1);
          assert.equal(snapshot.tasks[0]?.id, original.id);
          assert.equal(snapshot.tasks[0]?.threadId, "owned");
          assert.equal(snapshot.tasks[0]?.state, "blocked");
          assert.equal(snapshot.tasks[0]?.resultReadout?.status, "unavailable");
          const readout = snapshot.tasks[0]?.contractReadout;
          assert.equal(readout?.status, "available");
          if (readout?.status === "available")
            assert.equal(readout.acceptedRevision, action === "accept" ? 2 : null);
        }
        const persisted = yield* facts(sql);
        assert.equal(persisted.runs.length + persisted.grants.length + persisted.outbox.length, 0);
      }),
    ),
);

it.live.each(["owner", "actor", "root", "type"] as const)(
  "uses the actual reservation fallback for %s upgrade replay",
  (collision) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        const accepted = yield* dispatch(orchestrator, upgrade("owned"));
        const sink = yield* EventSink.EventSinkV2;
        const input = {
          commandId: upgrade("owned").commandId,
          threadId: ThreadId.make(collision === "root" ? "other" : "owned"),
          commandType: collision === "type" ? "thread.metadata.update" : "thread.task-contract.set",
          acceptedAt: yield* DateTime.now,
          events: [],
          effects: [],
        };
        const before = yield* facts(sql);
        // Models two callers that missed the receipt before one won reservation. No concurrency timing claim.
        const result = yield* Effect.exit(
          sink
            .commitCommand(input)
            .pipe(
              Effect.provideService(
                PolicyExecutionContext,
                collision === "actor" ? foreign : actor,
              ),
            ),
        );
        if (collision === "owner") {
          assert.isTrue(Exit.isSuccess(result));
          if (Exit.isSuccess(result)) {
            assert.isFalse(result.value.committed);
            assert.deepEqual(result.value.taskEnrollment, accepted.taskEnrollment);
          }
        } else assert.isTrue(Exit.isFailure(result));
        assert.deepEqual(yield* facts(sql), before);
      }),
    ),
);

it.live("persists ownership and one upgrade across fresh runtimes and two lost responses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b3r-owned-upgrade-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const database = makeSqlitePersistenceLive(NodePath.join(dir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const makeRuntime = () =>
        Layer.mergeAll(
          NodeServices.layer,
          database,
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "owned-upgrade-restart" },
            ProviderAdapterRegistry.makeLayer([]),
            { databaseLayer: database, runEffectWorker: false },
          ),
        );
      const created = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* seed;
          yield* dispatch(yield* Orchestrator.OrchestratorV2, create("owned"));
          return yield* Effect.fail("lost ordinary create response after commit");
        }),
      ).pipe(Effect.provide(makeRuntime()), Effect.exit);
      assert.isTrue(Exit.isFailure(created));
      const upgraded = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* dispatch(orchestrator, create("owned"));
          assert.equal((yield* readCollaborationSnapshot(sql, actor.actorId)).tasks.length, 0);
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(dispatch(orchestrator, create("owned"), foreign))),
          );
          yield* dispatch(orchestrator, upgrade("owned"));
          return yield* Effect.fail("lost upgrade response after commit");
        }),
      ).pipe(Effect.provide(makeRuntime()), Effect.exit);
      assert.isTrue(Exit.isFailure(upgraded));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const result = yield* dispatch(orchestrator, upgrade("owned"));
          assert.equal(result.taskEnrollment?.status, "enrolled");
          const snapshot = yield* readCollaborationSnapshot(sql, actor.actorId);
          assert.equal(snapshot.tasks.length, 1);
          assert.equal(snapshot.tasks[0]?.threadId, "owned");
          const persisted = yield* facts(sql);
          assert.equal(persisted.events.length, 2);
          assert.equal(persisted.receipts.length, 2);
          assert.equal(persisted.ledger.length, 3);
          assert.equal(
            persisted.runs.length + persisted.grants.length + persisted.outbox.length,
            0,
          );
        }),
      ).pipe(Effect.provide(makeRuntime()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps the upgrade attestation and owner after a later actual model selection, without moving Agents or executing",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* dispatch(orchestrator, create("owned"));
        yield* dispatch(orchestrator, upgrade("owned"));
        const original = (yield* readCollaborationSnapshot(sql, actor.actorId)).tasks[0]!;
        yield* dispatch(orchestrator, {
          type: "thread.model-selection.set",
          commandId: CommandId.make("select-next"),
          threadId: ThreadId.make("owned"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("fake-next"),
            model: "fake-next-model",
          },
        });
        const task = (yield* readCollaborationSnapshot(sql, actor.actorId)).tasks[0]!;
        assert.equal(task.threadId, "owned");
        assert.equal(task.id, original.id);
        assert.equal(task.ownerAgentId, actor.actorId);
        assert.equal(task.assigneeAgentId, "fake-next");
        const revision = yield* dispatch(orchestrator, {
          ...upgrade("owned"),
          commandId: CommandId.make("revise-after-selection"),
        });
        assert.equal(revision.taskEnrollment?.status, "already-enrolled");
        const persisted = yield* facts(sql);
        assert.equal(persisted.runs.length + persisted.grants.length + persisted.outbox.length, 0);
        assert.equal(
          (yield* readCollaborationSnapshot(sql, actor.actorId)).agents.filter(
            (agent) => agent.origin === "internal",
          ).length,
          0,
        );
      }),
    ),
);

it.live("cannot report eligible success with invalid persisted upgrade evidence", () =>
  scoped(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      yield* dispatch(orchestrator, create("owned"));
      const before = yield* facts(sql);
      yield* sql`CREATE TRIGGER corrupt_upgrade AFTER INSERT ON orchestration_events WHEN NEW.command_id='upgrade:owned' BEGIN UPDATE orchestration_events SET metadata_json='{"providerInstanceId":"foreign"}' WHERE event_id=NEW.event_id; END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(dispatch(orchestrator, upgrade("owned")))));
      assert.deepEqual(yield* facts(sql), before);
      yield* sql`DROP TRIGGER corrupt_upgrade`;
      const result = yield* dispatch(orchestrator, upgrade("owned"));
      assert.equal(result.taskEnrollment?.status, "enrolled");
      assert.equal(
        (yield* readCollaborationSnapshot(sql, actor.actorId)).tasks[0]?.threadId,
        "owned",
      );
    }),
  ),
);
