import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeSubagentChildThread } from "../orchestration-v2/SubagentProjection.ts";
import { readCollaborationSnapshot } from "./store.ts";

const owner = {
  kind: "session" as const,
  actorId: "review-owner",
  sessionId: "review-session",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
const foreign = { ...owner, actorId: "foreign-reviewer", sessionId: "foreign-session" };
const projectId = ProjectId.make("review-project");
const threadId = ThreadId.make("review-root");
const contract = {
  goal: "Check parser",
  redirect: "Ask before syntax change",
  acceptance: "Owner checks regression",
  brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
};
const runtime = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "task-review" },
    ProviderAdapterRegistry.makeLayer([]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  ),
);
const create: OrchestrationV2Command = {
  type: "thread.create",
  commandId: CommandId.make("review-create"),
  threadId,
  projectId,
  title: "Parser review",
  modelSelection: { instanceId: ProviderInstanceId.make("fake-review"), model: "fake-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "required",
  taskContract: contract,
};
const decision = <A extends "accept" | "redirect" | "resume">(action: A) => ({
  type: `thread.task-contract.${action}` as const,
  commandId: CommandId.make(`review-${action}`),
  threadId,
  revision: 1,
});

it.live.each(["accept", "redirect", "resume"] as const)(
  "rejects a foreign actor with operate scope for sealed task %s without mutation",
  (action) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Review fixture','/tmp','[]',${now},${now})`;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator
          .dispatch(create)
          .pipe(Effect.provideService(PolicyExecutionContext, owner));
        if (action === "resume")
          yield* orchestrator
            .dispatch(decision("redirect"))
            .pipe(Effect.provideService(PolicyExecutionContext, owner));
        const before = yield* orchestrator.getThreadProjection(threadId);
        const result = yield* Effect.exit(
          orchestrator
            .dispatch(decision(action))
            .pipe(Effect.provideService(PolicyExecutionContext, foreign)),
        );
        assert.isTrue(
          Exit.isFailure(result),
          "operate scope and read access do not establish sealed task ownership",
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.thread.taskDecisions, before.thread.taskDecisions);
        assert.equal(after.thread.taskContractPhase, before.thread.taskContractPhase);
        assert.equal(after.thread.taskAcceptedRevision, before.thread.taskAcceptedRevision);
        assert.equal((yield* readCollaborationSnapshot(sql, owner.actorId)).tasks.length, 1);
        assert.equal((yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length, 0);
        assert.equal((yield* sql`SELECT grant_id FROM base3_execution_grants`).length, 0);
      }),
    ).pipe(Effect.provide(runtime)),
);

const environmentId = EnvironmentId.make("review-environment");
const environment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Unused fixture descriptor"),
});
const withReview = <E>(
  check: (fixture: {
    sql: SqlClient.SqlClient;
    orchestrator: Orchestrator.OrchestratorV2["Service"];
  }) => Effect.Effect<void, E, EventSink.EventSinkV2>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Review fixture','/tmp','[]',${now},${now})`;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator
        .dispatch(create)
        .pipe(
          Effect.provideService(PolicyExecutionContext, owner),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      yield* check({ sql, orchestrator });
    }),
  ).pipe(
    Effect.provide(runtime),
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
  );
const target = {
  environmentId,
  taskId: `task:governed:thread:${threadId}`,
  projectId,
  threadId,
  revision: 1,
};
const readReview = (
  sql: SqlClient.SqlClient,
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  subject = owner,
) =>
  orchestrator
    .getTaskReview(target)
    .pipe(
      Effect.provideService(PolicyExecutionContext, subject),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    );
const execute = (
  sql: SqlClient.SqlClient,
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  command: OrchestrationV2Command,
  subject = owner,
) =>
  orchestrator
    .dispatch(command)
    .pipe(
      Effect.provideService(PolicyExecutionContext, subject),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    );
const persisted = (sql: SqlClient.SqlClient) =>
  Effect.all({
    events: sql`SELECT * FROM orchestration_events`,
    thread: sql`SELECT * FROM orchestration_v2_projection_threads`,
    leases: sql`SELECT * FROM base3_capacity_leases`,
    grants: sql`SELECT * FROM base3_execution_grants`,
    outbox: sql`SELECT * FROM orchestration_v2_effect_outbox`,
    ledger: sql`SELECT * FROM collaboration_commands`,
  });

it.live(
  "reads fresh eligibility without mutation and records three revision-bound decisions on the same contract",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        const before = yield* persisted(sql);
        const initial = yield* readReview(sql, orchestrator);
        assert.equal(initial.status, "available");
        assert.deepEqual(yield* persisted(sql), before);
        for (const action of ["redirect", "resume", "accept"] as const) {
          const fresh = yield* readReview(sql, orchestrator);
          assert.equal(fresh.status, "available");
          if (fresh.status !== "available") return;
          assert.isTrue(fresh.actions.includes(action));
          const command = { ...decision(action), reviewTask: fresh.reference };
          const result = yield* execute(sql, orchestrator, command);
          const after = yield* persisted(sql);
          assert.equal((yield* execute(sql, orchestrator, command)).sequence, result.sequence);
          assert.deepEqual(yield* persisted(sql), after);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.thread.taskContract?.revision, 1);
          assert.equal(
            projection.thread.taskContractPhase,
            action === "redirect" ? "redirected" : "active",
          );
          assert.equal(projection.thread.taskAcceptedRevision, action === "accept" ? 1 : null);
          assert.equal(projection.thread.taskDecisions?.at(-1)?.actorId, owner.actorId);
          assert.deepEqual(projection.thread.taskDecisions?.at(-1)?.reviewTask, fresh.reference);
          const card = (yield* readCollaborationSnapshot(sql, owner.actorId, {
            environmentId,
            canOperate: true,
          })).tasks[0]!;
          assert.equal(card.state, "blocked");
          assert.equal(card.gateDecision, "DENY");
          assert.equal(card.contractReadout?.status, "available");
          assert.equal((yield* sql`SELECT grant_id FROM base3_execution_grants`).length, 0);
          assert.equal((yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length, 0);
        }
      }),
    ),
);

it.live.each([
  "readonly",
  "foreign",
  "wrong-environment",
  "wrong-project",
  "missing-task",
  "revision",
  "archive",
  "project-delete",
  "invalid-model",
  "ordinary",
  "child",
  "expiry",
] as const)("fails closed for %s fresh eligibility and attempted review action", (failure) =>
  withReview(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      const initial = yield* readReview(sql, orchestrator);
      assert.equal(initial.status, "available");
      if (initial.status !== "available") return;
      const subject =
        failure === "foreign"
          ? foreign
          : failure === "readonly"
            ? { ...owner, scopes: [AuthOrchestrationReadScope] }
            : failure === "expiry"
              ? { ...owner, expiresAt: "2000-01-01T00:00:00.000Z" }
              : owner;
      if (failure === "archive")
        yield* execute(sql, orchestrator, {
          type: "thread.archive",
          commandId: CommandId.make("review-archive"),
          threadId,
        });
      if (failure === "project-delete")
        yield* sql`UPDATE projection_projects SET deleted_at='2026-10-13T00:00:00Z' WHERE project_id=${projectId}`;
      if (failure === "invalid-model")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.model','unattested') WHERE thread_id=${threadId}`;
      if (failure === "ordinary")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskGovernance','chat') WHERE thread_id=${threadId}`;
      if (failure === "child")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId','other') WHERE thread_id=${threadId}`;
      const input = {
        ...target,
        ...(failure === "wrong-environment" ? { environmentId: "other-environment" } : {}),
        ...(failure === "wrong-project" ? { projectId: "other-project" } : {}),
        ...(failure === "missing-task" ? { taskId: "other-task" } : {}),
        ...(failure === "revision" ? { revision: 2 } : {}),
      };
      const eligibility = yield* orchestrator
        .getTaskReview(input)
        .pipe(
          Effect.provideService(PolicyExecutionContext, subject),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
        );
      assert.equal(eligibility.status, "unavailable");
      const before = yield* persisted(sql);
      const attempted = {
        ...decision("accept"),
        revision: input.revision,
        reviewTask: {
          ...initial.reference,
          environmentId: input.environmentId,
          projectId: input.projectId,
          taskId: input.taskId,
        },
      };
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, attempted, subject))),
      );
      const after = yield* persisted(sql);
      assert.deepEqual(after, before);
    }),
  ),
);

it.live(
  "readonly snapshot has no review hints and a wrong selector cannot claim another owned root",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        const readonly = yield* readCollaborationSnapshot(sql, owner.actorId, {
          environmentId,
          canOperate: false,
        });
        assert.equal(readonly.environmentId, environmentId);
        assert.isUndefined(readonly.tasks[0]?.review);
        const initial = yield* readReview(sql, orchestrator);
        if (initial.status !== "available") return;
        const second = {
          ...create,
          commandId: CommandId.make("review-create-second"),
          threadId: ThreadId.make("second-root"),
          title: "Second task",
        };
        yield* execute(sql, orchestrator, second);
        const before = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              execute(sql, orchestrator, {
                ...decision("accept"),
                threadId: second.threadId,
                reviewTask: initial.reference,
              }),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);

it.live(
  "invalidates a reviewed version after actual title update even with the same contract revision",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        const initial = yield* readReview(sql, orchestrator);
        if (initial.status !== "available") return;
        yield* execute(sql, orchestrator, {
          type: "thread.metadata.update",
          commandId: CommandId.make("review-rename"),
          threadId,
          title: "Renamed task",
        });
        const before = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              execute(sql, orchestrator, { ...decision("accept"), reviewTask: initial.reference }),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);

it.live.each(["actor", "revision", "reference", "omit-reference", "type", "root"] as const)(
  "rejects %s receipt replay without updating any task",
  (change) =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        const initial = yield* readReview(sql, orchestrator);
        if (initial.status !== "available") return;
        const command = { ...decision("accept"), reviewTask: initial.reference };
        yield* execute(sql, orchestrator, command);
        const before = yield* persisted(sql);
        const { reviewTask: _reference, ...withoutReference } = command;
        const replay: OrchestrationV2Command = {
          ...(change === "omit-reference" ? withoutReference : command),
          ...(change === "revision" ? { revision: 2 } : {}),
          ...(change === "reference"
            ? { reviewTask: { ...command.reviewTask, threadSequence: 999 } }
            : {}),
          ...(change === "type" ? { type: "thread.task-contract.redirect" as const } : {}),
          ...(change === "root" ? { threadId: ThreadId.make("other-root") } : {}),
        };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              execute(sql, orchestrator, replay, change === "actor" ? foreign : owner),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);

const seedRunningWork = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    // Disposable persistence fixture only: no adapter or provider is started.
    yield* sql`INSERT INTO base3_capacity_leases (lease_id,environment_id,thread_id,workload_class,status,created_at) VALUES ('review-lease',${environmentId},${threadId},'interactive','active',${now})`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES ('review-provider-thread',${threadId},'codex','review-provider-session','active',${now},'{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,payload_json) VALUES ('review-provider-turn',${threadId},'review-provider-thread','review-node',1,'running','{}')`;
  });
it.live.each(["review", "generic"] as const)(
  "requests cancellation atomically with redirect and receipt rollback on %s path",
  (path) =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedRunningWork(sql);
        const review = yield* readReview(sql, orchestrator);
        assert.equal(review.status, "available");
        if (review.status !== "available") return;
        const command = {
          ...decision("redirect"),
          ...(path === "review" ? { reviewTask: review.reference } : {}),
        };
        const before = yield* persisted(sql);
        {
          yield* sql`CREATE TRIGGER review_fault BEFORE UPDATE ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.redirect' AND NEW.result_sequence>0 BEGIN SELECT RAISE(ABORT,'review receipt fault'); END`;
          assert.isTrue(Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, command))));
          assert.deepEqual(yield* persisted(sql), before);
          yield* sql`DROP TRIGGER review_fault`;
        }
        yield* execute(sql, orchestrator, command);
        const after = yield* persisted(sql);
        assert.equal(after.leases[0]?.interrupt_requested, 1);
        assert.equal(after.leases[0]?.released_at, null);
        assert.equal(after.outbox.length, 1);
        assert.equal(after.outbox[0]?.effect_type, "provider-turn.interrupt");
        assert.equal(after.outbox[0]?.status, "pending");
        assert.equal(
          (yield* sql`SELECT status FROM orchestration_v2_projection_provider_turns`)[0]?.status,
          "running",
        );
        yield* execute(sql, orchestrator, command);
        assert.deepEqual(yield* persisted(sql), after);
        const resumed = yield* readReview(sql, orchestrator);
        if (resumed.status !== "available") return;
        yield* execute(sql, orchestrator, { ...decision("resume"), reviewTask: resumed.reference });
        assert.deepEqual((yield* persisted(sql)).leases, after.leases);
        assert.deepEqual((yield* persisted(sql)).outbox, after.outbox);
        assert.equal((yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length, 0);
        assert.equal((yield* sql`SELECT grant_id FROM base3_execution_grants`).length, 0);
      }),
    ),
);
it.live.each([
  "owner",
  "actor",
  "revision",
  "reference",
  "omit-decision",
  "omit-reference",
  "type",
  "root",
] as const)("checks %s during actual review reservation fallback", (change) =>
  withReview(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      const review = yield* readReview(sql, orchestrator);
      if (review.status !== "available") return;
      const command = { ...decision("accept"), reviewTask: review.reference };
      const accepted = yield* execute(sql, orchestrator, command);
      const sink = yield* EventSink.EventSinkV2;
      const before = yield* persisted(sql);
      const result = yield* Effect.exit(
        sink
          .commitCommand({
            commandId: command.commandId,
            threadId: change === "root" ? ThreadId.make("other-root") : threadId,
            commandType: change === "type" ? "thread.task-contract.redirect" : command.type,
            ...(change === "omit-decision"
              ? {}
              : {
                  taskContractDecision: {
                    action: "accept" as const,
                    revision: change === "revision" ? 2 : 1,
                    ...(change === "omit-reference"
                      ? {}
                      : {
                          reviewTask:
                            change === "reference"
                              ? { ...review.reference, threadSequence: 999 }
                              : review.reference,
                        }),
                  },
                }),
            acceptedAt: yield* DateTime.now,
            events: [],
            effects: [],
          })
          .pipe(
            Effect.provideService(PolicyExecutionContext, change === "actor" ? foreign : owner),
            Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          ),
      );
      if (change === "owner") {
        assert.isTrue(Exit.isSuccess(result));
        if (Exit.isSuccess(result)) {
          assert.isFalse(result.value.committed);
          assert.equal(result.value.receipt.resultSequence, accepted.sequence);
        }
      } else assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(yield* persisted(sql), before);
    }),
  ),
);

it.live(
  "preserves original command-bound proof after later decisions and a new revision in both replay paths",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        const review = yield* readReview(sql, orchestrator);
        if (review.status !== "available") return;
        const command = { ...decision("redirect"), reviewTask: review.reference };
        const accepted = yield* execute(sql, orchestrator, command);
        const resume = yield* readReview(sql, orchestrator);
        if (resume.status !== "available") return;
        yield* execute(sql, orchestrator, { ...decision("resume"), reviewTask: resume.reference });
        yield* execute(sql, orchestrator, {
          type: "thread.task-contract.set",
          commandId: CommandId.make("review-later-revision"),
          threadId,
          ...contract,
        });
        const before = yield* persisted(sql);
        assert.equal((yield* execute(sql, orchestrator, command)).sequence, accepted.sequence);
        const sink = yield* EventSink.EventSinkV2;
        const result = yield* sink
          .commitCommand({
            commandId: command.commandId,
            threadId,
            commandType: command.type,
            acceptedAt: yield* DateTime.now,
            events: [],
            effects: [],
            taskContractDecision: { action: "redirect", revision: 1, reviewTask: review.reference },
          })
          .pipe(
            Effect.provideService(PolicyExecutionContext, owner),
            Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          );
        assert.isFalse(result.committed);
        assert.equal(result.receipt.resultSequence, accepted.sequence);
        assert.deepEqual(yield* persisted(sql), before);
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(current.thread.taskContract?.revision, 2);
        assert.equal(current.thread.taskContractPhase, "active");
      }),
    ),
);

it.live.each(["owner", "archive"] as const)(
  "revalidates generic redirect %s inside the winning transaction before any cancellation",
  (change) =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedRunningWork(sql);
        const before = yield* persisted(sql);
        if (change === "owner")
          yield* sql`CREATE TRIGGER review_boundary BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.redirect' BEGIN UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.admittedBy','foreign-reviewer') WHERE json_extract(payload_json,'$.type')='task.enroll'; END`;
        else
          yield* sql`CREATE TRIGGER review_boundary BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.redirect' BEGIN UPDATE orchestration_v2_projection_threads SET archived_at='2026-10-13T00:00:00.000Z',payload_json=json_set(payload_json,'$.archivedAt','2026-10-13T00:00:00.000Z') WHERE thread_id='review-root'; END`;
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, decision("redirect")))),
        );
        assert.deepEqual(yield* persisted(sql), before);
        assert.equal(
          (yield* sql`SELECT status FROM orchestration_v2_projection_provider_turns`)[0]?.status,
          "running",
        );
      }),
    ),
);

const childId = ThreadId.make("review-child");
const seedChild = (
  sql: SqlClient.SqlClient,
  orchestrator: Orchestrator.OrchestratorV2["Service"],
) =>
  Effect.gen(function* () {
    const parent = (yield* orchestrator.getThreadProjection(threadId)).thread;
    const now = yield* DateTime.now;
    const child = makeSubagentChildThread({
      parentThread: parent,
      childThreadId: childId,
      parentNodeId: NodeId.make("review-child-node"),
      activeProviderThreadId: null,
      providerInstanceId: parent.providerInstanceId,
      modelSelection: parent.modelSelection,
      title: "Disposable review child",
      now,
      createdBy: "agent",
      creationSource: "provider",
    });
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make("review-child-created"),
          type: "thread.created",
          threadId: childId,
          providerInstanceId: parent.providerInstanceId,
          occurredAt: now,
          payload: child,
        },
      ],
    });
    yield* seedRunningWork(sql);
    yield* sql`INSERT INTO task_contract_members (thread_id,root_thread_id,revision) VALUES (${childId},${threadId},1)`;
    yield* sql`INSERT INTO base3_capacity_leases (lease_id,environment_id,thread_id,workload_class,status,created_at) VALUES ('review-member-lease',${environmentId},${childId},'interactive','active',${DateTime.formatIso(now)})`;
  });
const childSet = {
  type: "thread.task-contract.set" as const,
  commandId: CommandId.make("review-child-set"),
  threadId: childId,
  ...contract,
};
const childRedirect = (revision = 1) => ({
  ...decision("redirect"),
  commandId: CommandId.make("review-child-redirect"),
  threadId: childId,
  revision,
});
it.live(
  "rejects foreign child contract-set then redirect before affecting the sealed root cancellation cohort",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedChild(sql, orchestrator);
        const before = yield* persisted(sql);
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            yield* execute(sql, orchestrator, childSet, foreign);
            yield* execute(sql, orchestrator, childRedirect(2), foreign);
          }),
        );
        const after = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(result),
          `a child-local contract does not authorize cancellation of another owner root; actual interrupt flags=${after.leases.map((lease) => lease.interrupt_requested).join(",")}`,
        );
        assert.deepEqual(after.leases, before.leases);
        assert.deepEqual(after.outbox, before.outbox);
        assert.deepEqual(after.grants, before.grants);
        assert.equal(
          (yield* sql`SELECT status FROM orchestration_v2_projection_provider_turns`)[0]?.status,
          "running",
        );
        assert.deepEqual(after.thread, before.thread);
      }),
    ),
);
it.live(
  "rejects a foreign inherited child redirect without requesting root or member cancellation",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedChild(sql, orchestrator);
        const before = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, childRedirect(), foreign))),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);

const seedExistingFixtureGrants = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    // Inert synthetic rows in disposable SQLite, not issued executable grants.
    for (const id of [threadId, childId])
      yield* sql`INSERT INTO base3_execution_grants (grant_id,thread_id,message_id,operation,actor_id,scopes_json,argument_hash,created_at) VALUES (${`inert-fixture-grant:${id}`},${id},'no-executable-message','fixture-only',${owner.actorId},'[]','not-an-executable-grant',${now})`;
  });
it.live(
  "preserves legitimate owner child editing, atomic grant revocation and cancellation without releasing leases",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedChild(sql, orchestrator);
        yield* seedExistingFixtureGrants(sql);
        const before = yield* persisted(sql);
        yield* sql`CREATE TRIGGER child_set_fault BEFORE UPDATE ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' AND NEW.result_sequence>0 BEGIN SELECT RAISE(ABORT,'child set receipt fault'); END`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, childSet))));
        assert.deepEqual(yield* persisted(sql), before);
        yield* sql`DROP TRIGGER child_set_fault`;
        yield* execute(sql, orchestrator, childSet);
        assert.isTrue((yield* persisted(sql)).grants.every((grant) => grant.revoked_at !== null));
        yield* execute(sql, orchestrator, childRedirect(2));
        const after = yield* persisted(sql);
        assert.isTrue(
          after.leases.every(
            (lease) => lease.interrupt_requested === 1 && lease.released_at === null,
          ),
        );
        assert.equal(after.outbox.length, 1);
        const sink = yield* EventSink.EventSinkV2;
        yield* execute(sql, orchestrator, childRedirect(2));
        const replay = yield* sink
          .commitCommand({
            commandId: childRedirect(2).commandId,
            threadId: childId,
            commandType: "thread.task-contract.redirect",
            acceptedAt: yield* DateTime.now,
            events: [],
            effects: [],
            taskContractDecision: { action: "redirect", revision: 2 },
          })
          .pipe(Effect.provideService(PolicyExecutionContext, owner));
        assert.isFalse(replay.committed);
        assert.deepEqual(yield* persisted(sql), after);
        yield* execute(sql, orchestrator, {
          ...decision("resume"),
          commandId: CommandId.make("child-owner-resume"),
          threadId: childId,
          revision: 2,
        });
        assert.deepEqual((yield* persisted(sql)).leases, after.leases);
        assert.equal((yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length, 0);
      }),
    ),
);
it.live(
  "rejects foreign child edits before revoking any sealed root or cohort fixture grants",
  () =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedChild(sql, orchestrator);
        yield* seedExistingFixtureGrants(sql);
        const before = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, childSet, foreign))),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);
it.live.each([
  "missing-root",
  "missing-parent",
  "null-parent",
  "self-parent",
  "self-root",
  "wrong-parent-root",
  "wrong-project",
] as const)("rejects malformed child lineage %s without root or cohort mutation", (change) =>
  withReview(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      yield* seedChild(sql, orchestrator);
      if (change === "missing-root")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','missing-root') WHERE thread_id=${childId}`;
      if (change === "missing-parent")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId','missing-parent') WHERE thread_id=${childId}`;
      if (change === "null-parent")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId',NULL) WHERE thread_id=${childId}`;
      if (change === "self-parent")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId',${childId}) WHERE thread_id=${childId}`;
      if (change === "self-root")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId',${childId}) WHERE thread_id=${childId}`;
      if (change === "wrong-parent-root")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','other-root') WHERE thread_id=${threadId}`;
      if (change === "wrong-project") {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('other-child-project','Other fixture','/tmp','[]',${now},${now})`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='other-child-project',payload_json=json_set(payload_json,'$.projectId','other-child-project') WHERE thread_id=${childId}`;
      }
      const before = yield* persisted(sql);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, childRedirect()))),
      );
      assert.deepEqual(yield* persisted(sql), before);
    }),
  ),
);
it.live.each([
  { type: "thread.task-contract.set" as const, isForeign: true },
  { type: "thread.task-contract.redirect" as const, isForeign: true },
  { type: "thread.task-contract.set" as const, isForeign: false },
  { type: "thread.task-contract.redirect" as const, isForeign: false },
])("rejects effective root change at the winning transaction %j", ({ type, isForeign }) =>
  withReview(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      yield* seedChild(sql, orchestrator);
      yield* execute(
        sql,
        orchestrator,
        {
          ...create,
          commandId: CommandId.make("foreign-root-create"),
          threadId: ThreadId.make("foreign-root"),
        },
        isForeign ? foreign : owner,
      );
      const before = yield* persisted(sql);
      yield* sql`CREATE TRIGGER child_root_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type IN ('thread.task-contract.set','thread.task-contract.redirect') BEGIN UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','foreign-root','$.lineage.parentThreadId','foreign-root') WHERE thread_id='review-child'; END`;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            execute(
              sql,
              orchestrator,
              type === "thread.task-contract.set" ? childSet : childRedirect(),
            ),
          ),
        ),
      );
      assert.deepEqual(yield* persisted(sql), before);
    }),
  ),
);
it.live.each([false, true])(
  "rejects descendant receipt replay after effective root change to foreign=%s in both boundaries",
  (isForeign) =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedChild(sql, orchestrator);
        yield* execute(sql, orchestrator, childRedirect());
        yield* execute(
          sql,
          orchestrator,
          {
            ...create,
            commandId: CommandId.make("replay-root-create"),
            threadId: ThreadId.make("replay-root"),
          },
          isForeign ? foreign : owner,
        );
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','replay-root','$.lineage.parentThreadId','replay-root') WHERE thread_id=${childId}`;
        const before = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, childRedirect()))),
        );
        const sink = yield* EventSink.EventSinkV2;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sink
                .commitCommand({
                  commandId: childRedirect().commandId,
                  threadId: childId,
                  commandType: "thread.task-contract.redirect",
                  acceptedAt: yield* DateTime.now,
                  events: [],
                  effects: [],
                  taskContractDecision: { action: "redirect", revision: 1 },
                })
                .pipe(Effect.provideService(PolicyExecutionContext, owner)),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);
it.live("keeps valid unsealed legacy child contract editing and decisions compatible", () =>
  withReview(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      // Declare a legacy unsealed tree by removing only its disposable enrollment seal.
      yield* sql`DELETE FROM collaboration_commands WHERE json_extract(payload_json,'$.type')='task.enroll'`;
      yield* seedChild(sql, orchestrator);
      yield* execute(sql, orchestrator, childSet, foreign);
      yield* execute(sql, orchestrator, childRedirect(2), foreign);
      assert.isTrue(
        (yield* persisted(sql)).leases.every(
          (lease) => lease.interrupt_requested === 1 && lease.released_at === null,
        ),
      );
    }),
  ),
);

it.live.each([false, true])(
  "rejects child set receipt replay after effective root change to foreign=%s in both boundaries",
  (isForeign) =>
    withReview(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* seedChild(sql, orchestrator);
        yield* execute(sql, orchestrator, childSet);
        yield* execute(
          sql,
          orchestrator,
          {
            ...create,
            commandId: CommandId.make("set-replay-root-create"),
            threadId: ThreadId.make("set-replay-root"),
          },
          isForeign ? foreign : owner,
        );
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','set-replay-root','$.lineage.parentThreadId','set-replay-root') WHERE thread_id=${childId}`;
        const before = yield* persisted(sql);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(execute(sql, orchestrator, childSet))));
        const sink = yield* EventSink.EventSinkV2;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sink
                .commitCommand({
                  commandId: childSet.commandId,
                  threadId: childId,
                  commandType: childSet.type,
                  contractSetActor: owner.actorId,
                  acceptedAt: yield* DateTime.now,
                  events: [],
                  effects: [],
                })
                .pipe(Effect.provideService(PolicyExecutionContext, owner)),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);
