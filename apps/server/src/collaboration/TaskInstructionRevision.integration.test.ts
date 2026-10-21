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
import * as Context from "effect/Context";
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
import { taskStateFromUnknown, reserveGovernedStart } from "../policy/TaskContract.ts";
import { makeSubagentChildThread } from "../orchestration-v2/SubagentProjection.ts";
import { readCollaborationSnapshot } from "./store.ts";
const owner = {
  kind: "session" as const,
  actorId: "instruction-owner",
  sessionId: "instruction-session",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
const foreign = { ...owner, actorId: "instruction-foreign" };
const projectId = ProjectId.make("instruction-project");
const threadId = ThreadId.make("instruction-root");
const environmentId = EnvironmentId.make("instruction-environment");
const environment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Unused fixture descriptor"),
});
const brake = {
  maxProviderStarts: 2,
  stopConditions: "Scope changed",
  maxTokens: 1000,
  maxCostUsd: 1,
  deadlineAt: "2030-01-01T00:00:00.000Z",
};
const fields = {
  goal: "Inspect parser",
  redirect: "Ask owner",
  acceptance: "Owner checks regression",
  brake,
};
const runtime = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "instruction-revision" },
    ProviderAdapterRegistry.makeLayer([]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  ),
);
const scoped = <E>(
  check: (fx: {
    sql: SqlClient.SqlClient;
    orchestrator: Orchestrator.OrchestratorV2["Service"];
  }) => Effect.Effect<void, E, EventSink.EventSinkV2>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Instruction fixture','/tmp','[]',${now},${now})`;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* dispatch(sql, orchestrator, {
        type: "thread.create",
        commandId: CommandId.make("instruction-create"),
        threadId,
        projectId,
        title: "Parser instructions",
        modelSelection: {
          instanceId: ProviderInstanceId.make("fake-instruction"),
          model: "fake-model",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        taskGovernance: "required",
        taskContract: fields,
      });
      yield* check({ sql, orchestrator });
    }),
  ).pipe(Effect.provide(runtime));
const dispatch = (
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
const target = {
  environmentId,
  taskId: `task:governed:thread:${threadId}`,
  projectId,
  threadId,
  revision: 1,
};
const review = (
  sql: SqlClient.SqlClient,
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  revision = 1,
  subject = owner,
) =>
  orchestrator
    .getTaskReview({ ...target, revision })
    .pipe(
      Effect.provideService(PolicyExecutionContext, subject),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    );
const pause = (sql: SqlClient.SqlClient, orchestrator: Orchestrator.OrchestratorV2["Service"]) =>
  dispatch(sql, orchestrator, {
    type: "thread.task-contract.redirect",
    commandId: CommandId.make("instruction-pause"),
    threadId,
    revision: 1,
  });
const persisted = (sql: SqlClient.SqlClient) =>
  Effect.all({
    events: sql`SELECT * FROM orchestration_events`,
    threads: sql`SELECT * FROM orchestration_v2_projection_threads`,
    grants: sql`SELECT * FROM base3_execution_grants`,
    leases: sql`SELECT * FROM base3_capacity_leases`,
    outbox: sql`SELECT * FROM orchestration_v2_effect_outbox`,
    ledger: sql`SELECT * FROM collaboration_commands`,
    runs: sql`SELECT * FROM orchestration_v2_projection_runs`,
    messages: sql`SELECT * FROM orchestration_v2_projection_messages`,
  });
it.live.each(["revision", "version", "environment"] as const)(
  "rejects stale reviewed instruction set %s without mutation",
  (change) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        assert.equal(facts.status, "available");
        if (facts.status !== "available") return;
        const before = yield* persisted(sql);
        const command = {
          type: "thread.task-contract.set",
          commandId: CommandId.make("instruction-save"),
          threadId,
          ...fields,
          goal: "Revised parser goal",
          expectedRevision: change === "revision" ? 99 : 1,
          reviewTask: {
            ...facts.reference,
            ...(change === "version" ? { threadSequence: 999 } : {}),
            ...(change === "environment" ? { environmentId: "other-environment" } : {}),
          },
        } as unknown as OrchestrationV2Command;
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(dispatch(sql, orchestrator, command))),
          "review-bound set must enforce its expected revision and complete fresh reference",
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);

const boundSet = (
  reference: import("@t3tools/contracts").TaskContractReviewReference,
  expectedRevision = 1,
) => ({
  type: "thread.task-contract.set" as const,
  commandId: CommandId.make(`instruction-save:${expectedRevision}`),
  threadId,
  ...fields,
  goal: `Revised parser goal ${expectedRevision}`,
  redirect: "Ask before syntax expansion",
  acceptance: "Owner reviews revised evidence",
  expectedRevision,
  reviewTask: reference,
});
it.live(
  "saves exactly one paused instruction revision with the entire Brake unchanged and separately resumes the new revision",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        assert.equal(facts.status, "available");
        if (facts.status !== "available") return;
        assert.isTrue(facts.canEditInstructions === true);
        const command = boundSet(facts.reference);
        const result = yield* dispatch(sql, orchestrator, command);
        const after = yield* persisted(sql);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.taskContract?.revision, 2);
        assert.equal(projection.thread.taskContractPhase, "redirected");
        assert.equal(projection.thread.taskAcceptedRevision, null);
        assert.deepEqual(projection.thread.taskContract?.brake, brake);
        assert.equal(projection.thread.taskDecisions?.at(-1)?.expectedRevision, 1);
        assert.deepEqual(projection.thread.taskDecisions?.at(-1)?.reviewTask, facts.reference);
        const card = (yield* readCollaborationSnapshot(sql, owner.actorId, {
          environmentId,
          canOperate: true,
        })).tasks[0]!;
        assert.equal(card.state, "blocked");
        assert.equal(card.gateDecision, "DENY");
        assert.equal(card.contractReadout?.status, "available");
        if (card.contractReadout?.status === "available") {
          assert.equal(card.contractReadout.phase, "redirected");
          assert.deepEqual(card.contractReadout.contract, projection.thread.taskContract);
        }
        assert.equal((yield* dispatch(sql, orchestrator, command)).sequence, result.sequence);
        assert.deepEqual(yield* persisted(sql), after);
        const sink = yield* EventSink.EventSinkV2;
        const replay = yield* sink
          .commitCommand({
            commandId: command.commandId,
            threadId,
            commandType: command.type,
            contractSetActor: owner.actorId,
            reviewedSet: command,
            acceptedAt: yield* DateTime.now,
            events: [],
            effects: [],
          })
          .pipe(
            Effect.provideService(PolicyExecutionContext, owner),
            Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          );
        assert.isFalse(replay.committed);
        assert.deepEqual(yield* persisted(sql), after);
        const next = yield* review(sql, orchestrator, 2);
        assert.equal(next.status, "available");
        if (next.status !== "available") return;
        yield* dispatch(sql, orchestrator, {
          type: "thread.task-contract.resume",
          commandId: CommandId.make("instruction-resume"),
          threadId,
          revision: 2,
          reviewTask: next.reference,
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).thread.taskContractPhase,
          "active",
        );
        const final = yield* persisted(sql);
        assert.equal(
          final.runs.length + final.messages.length + final.grants.length + final.outbox.length,
          0,
        );
        assert.equal((yield* readCollaborationSnapshot(sql, owner.actorId)).tasks.length, 1);
      }),
    ),
);

it.live.each([
  "active",
  "accepted",
  "foreign",
  "readonly",
  "expired",
  "ordinary",
  "unsealed",
  "archived",
  "deleted",
  "project-deleted",
  "selection",
  "project",
  "task",
  "expected-only",
  "reference-only",
  "noop",
  "blank",
  "provider-cap",
  "stop-conditions",
  "token-cap",
  "cost-cap",
  "deadline",
  "omitted-caps",
] as const)("rejects ineligible or invalid reviewed instructions %s without effects", (failure) =>
  scoped(({ sql, orchestrator }) =>
    Effect.gen(function* () {
      if (failure === "accepted")
        yield* dispatch(sql, orchestrator, {
          type: "thread.task-contract.accept",
          commandId: CommandId.make("instruction-accept"),
          threadId,
          revision: 1,
        });
      if (failure !== "active") yield* pause(sql, orchestrator);
      const facts = yield* review(sql, orchestrator);
      assert.equal(facts.status, "available");
      if (facts.status !== "available") return;
      if (failure === "ordinary")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskGovernance','chat') WHERE thread_id=${threadId}`;
      if (failure === "unsealed")
        yield* sql`DELETE FROM collaboration_commands WHERE json_extract(payload_json,'$.type')='task.enroll'`;
      if (failure === "archived" || failure === "deleted")
        yield* dispatch(sql, orchestrator, {
          type: failure === "archived" ? "thread.archive" : "thread.delete",
          commandId: CommandId.make("instruction-retire"),
          threadId,
        });
      if (failure === "project-deleted")
        yield* sql`UPDATE projection_projects SET deleted_at='2026-10-13T00:00:00.000Z' WHERE project_id=${projectId}`;
      if (failure === "selection")
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.model','unattested-model') WHERE thread_id=${threadId}`;
      const base = boundSet(facts.reference);
      const { expectedRevision: _expected, reviewTask: _reference, ...bare } = base;
      const changedBrake =
        failure === "provider-cap"
          ? { ...brake, maxProviderStarts: 3 }
          : failure === "stop-conditions"
            ? { ...brake, stopConditions: "Relaxed" }
            : failure === "token-cap"
              ? { ...brake, maxTokens: 2000 }
              : failure === "cost-cap"
                ? { ...brake, maxCostUsd: 2 }
                : failure === "deadline"
                  ? { ...brake, deadlineAt: "2031-01-01T00:00:00.000Z" }
                  : failure === "omitted-caps"
                    ? { maxProviderStarts: 2, stopConditions: brake.stopConditions }
                    : brake;
      const command = {
        ...(failure === "expected-only"
          ? { ...bare, expectedRevision: 1 }
          : failure === "reference-only"
            ? { ...bare, reviewTask: base.reviewTask }
            : base),
        brake: changedBrake,
        ...(failure === "noop"
          ? { goal: fields.goal, redirect: fields.redirect, acceptance: fields.acceptance }
          : {}),
        ...(failure === "blank" ? { goal: "  " } : {}),
        ...(failure === "project"
          ? { reviewTask: { ...facts.reference, projectId: "other-project" } }
          : {}),
        ...(failure === "task" ? { reviewTask: { ...facts.reference, taskId: "other-task" } } : {}),
      } as OrchestrationV2Command;
      const subject =
        failure === "foreign"
          ? foreign
          : failure === "readonly"
            ? { ...owner, scopes: [AuthOrchestrationReadScope] }
            : failure === "expired"
              ? { ...owner, expiresAt: "2020-01-01T00:00:00.000Z" }
              : owner;
      const before = yield* persisted(sql);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(dispatch(sql, orchestrator, command, subject))),
      );
      assert.deepEqual(yield* persisted(sql), before);
    }),
  ),
);
it.live.each(["revision", "resume", "accept", "selection", "lineage"] as const)(
  "rejects competing %s at the winning reviewed save transaction",
  (change) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        if (facts.status !== "available") return;
        const before = yield* persisted(sql);
        if (change === "revision")
          yield* sql`CREATE TRIGGER instruction_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' BEGIN UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskContract.revision',2) WHERE thread_id='instruction-root'; END`;
        if (change === "resume")
          yield* sql`CREATE TRIGGER instruction_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' BEGIN UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskContractPhase','active') WHERE thread_id='instruction-root'; END`;
        if (change === "accept")
          yield* sql`CREATE TRIGGER instruction_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' BEGIN UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskAcceptedRevision',1) WHERE thread_id='instruction-root'; END`;
        if (change === "selection")
          yield* sql`CREATE TRIGGER instruction_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' BEGIN UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.model','unattested') WHERE thread_id='instruction-root'; END`;
        if (change === "lineage")
          yield* sql`CREATE TRIGGER instruction_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' BEGIN UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.rootThreadId','other-root','$.lineage.parentThreadId','other-root','$.lineage.relationshipToParent','subagent') WHERE thread_id='instruction-root'; END`;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(dispatch(sql, orchestrator, boundSet(facts.reference))),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);
it.live(
  "revokes old inert grants atomically, rolls everything back on receipt fault and cannot start queued work while paused",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        if (facts.status !== "available") return;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO base3_execution_grants(grant_id,thread_id,message_id,operation,actor_id,scopes_json,argument_hash,created_at) VALUES ('inert-instruction-grant',${threadId},'no-executable-message','fixture-only',${owner.actorId},'[]','not-executable',${now})`;
        const before = yield* persisted(sql);
        yield* sql`CREATE TRIGGER instruction_receipt_fault BEFORE UPDATE ON orchestration_command_receipts WHEN NEW.command_type='thread.task-contract.set' AND NEW.result_sequence>0 BEGIN SELECT RAISE(ABORT,'instruction receipt fault'); END`;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(dispatch(sql, orchestrator, boundSet(facts.reference))),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
        yield* sql`DROP TRIGGER instruction_receipt_fault`;
        yield* dispatch(sql, orchestrator, boundSet(facts.reference));
        assert.isNotNull((yield* persisted(sql)).grants[0]?.revoked_at);
        const paused = yield* orchestrator.getThreadProjection(threadId);
        const state = taskStateFromUnknown(threadId, paused.thread);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              reserveGovernedStart({
                sql,
                state,
                commandType: "message.dispatch",
                commandId: "queued-old-revision",
                threadId,
              }),
            ),
          ),
        );
        const after = yield* persisted(sql);
        assert.equal(
          after.runs.length + after.messages.length + after.leases.length + after.outbox.length,
          0,
        );
        assert.equal(after.grants.length, 1);
      }),
    ),
);
it.live.each([
  "actor",
  "goal",
  "redirect",
  "acceptance",
  "expected",
  "reference",
  "brake",
  "omit",
  "partial",
  "root",
  "type",
] as const)(
  "rejects conflicting reviewed set replay %s at fast and reservation boundaries",
  (change) =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        if (facts.status !== "available") return;
        const command = boundSet(facts.reference);
        yield* dispatch(sql, orchestrator, command);
        const before = yield* persisted(sql);
        const { expectedRevision: _expected, reviewTask: _ref, ...bare } = command;
        const conflict = {
          ...(change === "omit"
            ? bare
            : change === "partial"
              ? { ...bare, reviewTask: command.reviewTask }
              : command),
          ...(change === "goal" ? { goal: "Conflicting goal" } : {}),
          ...(change === "redirect" ? { redirect: "Conflicting redirect" } : {}),
          ...(change === "acceptance" ? { acceptance: "Conflicting acceptance" } : {}),
          ...(change === "expected" ? { expectedRevision: 2 } : {}),
          ...(change === "reference"
            ? { reviewTask: { ...command.reviewTask, threadSequence: 999 } }
            : {}),
          ...(change === "brake" ? { brake: { ...brake, maxTokens: 9999 } } : {}),
          ...(change === "root" ? { threadId: ThreadId.make("other-root") } : {}),
          ...(change === "type"
            ? { type: "thread.task-contract.resume" as const, revision: 2 }
            : {}),
        } as OrchestrationV2Command;
        const subject = change === "actor" ? foreign : owner;
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(dispatch(sql, orchestrator, conflict, subject))),
        );
        const sink = yield* EventSink.EventSinkV2;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sink
                .commitCommand({
                  commandId: command.commandId,
                  threadId:
                    conflict.type === "thread.task-contract.set" ? conflict.threadId : threadId,
                  commandType: conflict.type,
                  contractSetActor: subject.actorId,
                  acceptedAt: yield* DateTime.now,
                  events: [],
                  effects: [],
                  ...(change === "omit"
                    ? {}
                    : {
                        reviewedSet: conflict as Extract<
                          OrchestrationV2Command,
                          { type: "thread.task-contract.set" }
                        >,
                      }),
                })
                .pipe(
                  Effect.provideService(PolicyExecutionContext, subject),
                  Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
                ),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);
it.live(
  "authentic reviewed set receipts survive later revisions without another mutation, while unbound set remains active",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        if (facts.status !== "available") return;
        const first = boundSet(facts.reference);
        const receipt = yield* dispatch(sql, orchestrator, first);
        const fresh = yield* review(sql, orchestrator, 2);
        if (fresh.status !== "available") return;
        yield* dispatch(sql, orchestrator, boundSet(fresh.reference, 2));
        yield* dispatch(sql, orchestrator, {
          type: "thread.task-contract.set",
          commandId: CommandId.make("instruction-unbound"),
          threadId,
          ...fields,
          goal: "Unbound composer goal",
        });
        const before = yield* persisted(sql);
        assert.equal((yield* dispatch(sql, orchestrator, first)).sequence, receipt.sequence);
        const sink = yield* EventSink.EventSinkV2;
        const replay = yield* sink
          .commitCommand({
            commandId: first.commandId,
            threadId,
            commandType: first.type,
            contractSetActor: owner.actorId,
            reviewedSet: first,
            acceptedAt: yield* DateTime.now,
            events: [],
            effects: [],
          })
          .pipe(
            Effect.provideService(PolicyExecutionContext, owner),
            Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          );
        assert.isFalse(replay.committed);
        assert.deepEqual(yield* persisted(sql), before);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.taskContract?.revision, 4);
        assert.equal(projection.thread.taskContractPhase, "active");
        assert.deepEqual(projection.thread.taskContract?.brake, brake);
      }),
    ),
);

it.live(
  "review-bound instruction edits cannot target an inherited child under the owned root",
  () =>
    scoped(({ sql, orchestrator }) =>
      Effect.gen(function* () {
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        if (facts.status !== "available") return;
        const parent = (yield* orchestrator.getThreadProjection(threadId)).thread;
        const now = yield* DateTime.now;
        const child = makeSubagentChildThread({
          parentThread: parent,
          childThreadId: ThreadId.make("instruction-child"),
          parentNodeId: NodeId.make("instruction-child-node"),
          activeProviderThreadId: null,
          providerInstanceId: parent.providerInstanceId,
          modelSelection: parent.modelSelection,
          title: "Disposable child",
          now,
          createdBy: "agent",
          creationSource: "provider",
        });
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("instruction-child-created"),
              type: "thread.created",
              threadId: child.id,
              providerInstanceId: parent.providerInstanceId,
              occurredAt: now,
              payload: child,
            },
          ],
        });
        const before = yield* persisted(sql);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              dispatch(sql, orchestrator, { ...boundSet(facts.reference), threadId: child.id }),
            ),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ),
);

class FixtureSql extends Context.Service<FixtureSql, SqlClient.SqlClient>()(
  "t3/collaboration/TaskInstructionRevision.integration.test/FixtureSql",
) {}
const missingReviewPersistenceRuntime = Layer.mergeAll(
  NodeServices.layer,
  Layer.effect(FixtureSql, SqlClient.SqlClient).pipe(Layer.provide(SqlitePersistenceMemory)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "instruction-no-review-sql" },
    ProviderAdapterRegistry.makeLayer([]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  ),
);
it.live.each([false, true])(
  "fails closed without review persistence at dispatch/replay accepted=%s",
  (accepted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* FixtureSql;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Instruction fixture','/tmp','[]',${now},${now})`;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* dispatch(sql, orchestrator, {
          type: "thread.create",
          commandId: CommandId.make("instruction-create"),
          threadId,
          projectId,
          title: "Parser instructions",
          modelSelection: {
            instanceId: ProviderInstanceId.make("fake-instruction"),
            model: "fake-model",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          taskGovernance: "required",
          taskContract: fields,
        });
        yield* pause(sql, orchestrator);
        const facts = yield* review(sql, orchestrator);
        if (facts.status !== "available") return;
        const command = boundSet(facts.reference);
        if (accepted) yield* dispatch(sql, orchestrator, command);
        const before = yield* persisted(sql);
        const isolated = Context.empty().pipe(
          Context.add(PolicyExecutionContext, owner),
          Context.add(ServerEnvironment.ServerEnvironment, environment),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(orchestrator.dispatch(command).pipe(Effect.provide(isolated))),
          ),
        );
        assert.deepEqual(yield* persisted(sql), before);
      }),
    ).pipe(Effect.provide(missingReviewPersistenceRuntime)),
);
