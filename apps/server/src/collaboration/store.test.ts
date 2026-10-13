import {
  CollaborationCommand,
  CollaborationSnapshot,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { routeModel } from "@t3tools/shared/modelRouter";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { collaborationExecutionGate, sealCollaborationCommand } from "./admit.ts";
import { readCollaborationSnapshot, submitCollaborationCommand } from "./store.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const facts = {
  principalId: "principal-owner",
  projectIds: ["project-a"],
  providers: [
    {
      id: "provider-codex",
      displayName: "Codex",
      capabilities: ["gpt"],
      executable: true,
    },
  ],
  threads: [{ id: "thread-1", projectId: "project-a" }],
  executionGate: collaborationExecutionGate,
};

const createTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE collaboration_commands (
      command_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT, provider_instance_id TEXT,
    archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL DEFAULT '{}'
  )`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, provider_instance_id, archived_at, deleted_at) VALUES ('thread-1', 'project-a', 'provider-codex', NULL, NULL)`;
  return sql;
});

const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const routingFixture = Effect.gen(function* () {
  const sql = yield* createTable;
  yield* sql`CREATE TABLE projection_dispatcher_task_routes (thread_id TEXT, message_id TEXT, binding_json TEXT, created_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, provider_instance_id TEXT, status TEXT, payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT, thread_id TEXT, run_id TEXT, provider_instance_id TEXT, payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, provider_instance_id TEXT, payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, provider_thread_id TEXT, run_attempt_id TEXT, node_id TEXT, status TEXT, started_at TEXT, payload_json TEXT)`;
  const bind = sealCollaborationCommand(
    {
      type: "thread.bind",
      commandId: "routing-bind",
      projectId: "project-a",
      threadId: "thread-1",
      agentId: "provider-codex",
    },
    facts,
  );
  assert.equal(bind.outcome, "sealed");
  if (bind.outcome !== "sealed") throw new Error("Fixture admission failed");
  yield* submitCollaborationCommand(sql, bind.command, { allowNewBinding: true });
  const decision = routeModel({
    mode: "auto",
    catalog: [
      {
        instanceId: ProviderInstanceId.make("provider-codex"),
        driver: ProviderDriverKind.make("codex"),
        model: "selected-A",
        isDefault: true,
        capabilities: ["code"],
        availabilityReasons: [],
      },
    ],
  });
  const binding = {
    policyVersion: "dispatcher.phase-1a.v1",
    target: { instanceId: "provider-codex", model: "selected-A" },
    driver: "codex",
    modelFamily: "gpt",
    fallbackIndex: 0,
    source: "explicit",
    gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
    modelRoute: { ...decision, executed: decision.selected, executionStatus: "bound" },
  };
  const run = {
    id: "run-1",
    threadId: "thread-1",
    ordinal: 1,
    providerInstanceId: "provider-codex",
    modelSelection: { instanceId: "provider-codex", model: "configured-B" },
    userMessageId: "message-1",
    activeAttemptId: "attempt-1",
    rootNodeId: "node-1",
    providerThreadId: "provider-thread-1",
    status: "running",
  };
  const attempt = {
    id: "attempt-1",
    runId: "run-1",
    rootNodeId: "node-1",
    providerInstanceId: "provider-codex",
    providerThreadId: "provider-thread-1",
    providerTurnId: "turn-1",
  };
  const providerThread = {
    id: "provider-thread-1",
    appThreadId: "thread-1",
    providerInstanceId: "provider-codex",
  };
  const turn = {
    id: "turn-1",
    providerThreadId: "provider-thread-1",
    nodeId: "node-1",
    runAttemptId: "attempt-1",
    status: "running",
    startedAt: "2026-10-13T00:00:00Z",
  };
  yield* sql`INSERT INTO projection_dispatcher_task_routes VALUES ('thread-1','message-1',${encodeEvidence(binding)},'2026-10-13T00:00:00Z')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('run-1','thread-1',1,'provider-codex','running',${encodeEvidence(run)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt-1','thread-1','run-1','provider-codex',${encodeEvidence(attempt)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('provider-thread-1','thread-1','provider-codex',${encodeEvidence(providerThread)})`;
  const read = () =>
    readCollaborationSnapshot(sql, facts.principalId).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollaborationSnapshot)),
      Effect.map((snapshot) => snapshot.tasks[0]?.routingReadout),
    );
  const insertTurn = () =>
    sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('turn-1','thread-1','provider-thread-1','attempt-1','node-1','running',${turn.startedAt},${encodeEvidence(turn)})`;
  return { sql, binding, run, attempt, turn, read, insertTurn };
});

it.effect(
  "separates immutable selection, configured runtime and matching provider-turn start",
  () =>
    Effect.gen(function* () {
      const f = yield* routingFixture;
      const bound = yield* f.read();
      assert.equal(bound?.status, "available");
      if (bound?.status !== "available") return;
      assert.equal(bound.selected?.model, "selected-A");
      assert.equal(bound.configuredModel?.model, "configured-B");
      assert.equal(bound.mode, "auto");
      assert.equal(bound.execution.status, "unknown");
      assert.equal(bound.execution.reason, "missing_provider_turn");
      yield* f.insertTurn();
      const observed = yield* f.read();
      assert.equal(observed?.status === "available" && observed.execution.status, "observed");
      assert.equal(observed?.status === "available" && observed.execution.providerTurnId, "turn-1");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "does not borrow an older route for the newest run and supports route-only legacy binding",
  () =>
    Effect.gen(function* () {
      const f = yield* routingFixture;
      yield* f.sql`INSERT INTO orchestration_v2_projection_runs VALUES ('run-2','thread-1',2,'provider-codex','running',${encodeEvidence({ ...f.run, id: "run-2", ordinal: 2, userMessageId: "message-2", activeAttemptId: null })})`;
      const latest = yield* f.read();
      assert.equal(latest?.status === "available" && latest.selected, null);
      assert.equal(latest?.status === "available" && latest.messageId, "message-2");
      assert.equal(
        latest?.status === "available" && latest.selectionUnknownReason,
        "route_missing",
      );
      yield* f.sql`DELETE FROM orchestration_v2_projection_runs`;
      const { modelRoute: _modelRoute, ...legacy } = f.binding;
      yield* f.sql`UPDATE projection_dispatcher_task_routes SET binding_json=${encodeEvidence(legacy)}`;
      const only = yield* f.read();
      assert.equal(only?.status === "available" && only.selected?.model, "selected-A");
      assert.equal(only?.status === "available" && only.mode, null);
      assert.equal(only?.status === "available" && only.execution.reason, "route_only");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([
  "pending",
  "unstarted",
  "unrelated",
  "cross-thread",
  "invalid-json",
  "wrong-provider",
  "wrong-run",
])("rejects %s execution evidence", (scenario) =>
  Effect.gen(function* () {
    const f = yield* routingFixture;
    yield* f.insertTurn();
    if (scenario === "pending")
      yield* f.sql`UPDATE orchestration_v2_projection_provider_turns SET status='pending',payload_json=${encodeEvidence({ ...f.turn, status: "pending" })}`;
    if (scenario === "unstarted")
      yield* f.sql`UPDATE orchestration_v2_projection_provider_turns SET started_at=NULL,payload_json=${encodeEvidence({ ...f.turn, startedAt: null })}`;
    if (scenario === "unrelated")
      yield* f.sql`UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id='another-attempt',payload_json=${encodeEvidence({ ...f.turn, runAttemptId: "another-attempt" })}`;
    if (scenario === "cross-thread")
      yield* f.sql`UPDATE orchestration_v2_projection_provider_turns SET thread_id='foreign-thread'`;
    if (scenario === "invalid-json")
      yield* f.sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json='{secret-unreadable'`;
    if (scenario === "wrong-provider")
      yield* f.sql`UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id='foreign-provider'`;
    if (scenario === "wrong-run")
      yield* f.sql`UPDATE orchestration_v2_projection_run_attempts SET payload_json=${encodeEvidence({ ...f.attempt, runId: "foreign-run" })}`;
    const result = yield* f.read();
    assert.equal(result?.status === "available" && result.execution.status, "unknown");
    assert.equal(result?.status === "available" && result.execution.providerTurnId, null);
    assert.isFalse(encodeEvidence(result).includes("secret-unreadable"));
    assert.isFalse(encodeEvidence(result).includes("foreign"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects malformed and foreign identity before evidence disclosure", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture;
    assert.equal((yield* readCollaborationSnapshot(f.sql, "other-owner")).tasks.length, 0);
    yield* f.sql`UPDATE orchestration_v2_projection_threads SET project_id='foreign-project'`;
    assert.deepEqual(yield* f.read(), { status: "unavailable", reason: "invalid_thread_link" });
    yield* f.sql`UPDATE orchestration_v2_projection_threads SET project_id='project-a',payload_json='{broken'`;
    assert.deepEqual(yield* f.read(), { status: "unavailable", reason: "invalid_thread_evidence" });
    yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json='{}'`;
    yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json='{broken'`;
    assert.deepEqual(yield* f.read(), { status: "unavailable", reason: "invalid_run" });
    yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=${encodeEvidence(f.run)}`;
    yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=${encodeEvidence({ ...f.run, modelSelection: { instanceId: "foreign-provider", model: "secret-model" } })}`;
    assert.deepEqual(yield* f.read(), { status: "unavailable", reason: "invalid_run" });
    yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=${encodeEvidence(f.run)}`;
    yield* f.sql`UPDATE projection_dispatcher_task_routes SET binding_json='{broken'`;
    const route = yield* f.read();
    assert.equal(route?.status === "available" && route.selected, null);
    assert.equal(route?.status === "available" && route.selectionUnknownReason, "route_invalid");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

layer("collaboration store", (it) => {
  it.effect("persists a linked thread and drops unsealed or refused commands", () =>
    Effect.gen(function* () {
      const sql = yield* createTable;
      const bind = sealCollaborationCommand(
        {
          type: "thread.bind",
          commandId: "bind-codex",
          projectId: "project-a",
          threadId: "thread-1",
          agentId: "provider-codex",
          displayName: "Not Codex",
          actor: "owner",
          fromAgentId: "spoofed-agent",
        },
        facts,
      );
      assert.equal(bind.outcome, "sealed");
      if (bind.outcome !== "sealed") return;
      const applied = yield* submitCollaborationCommand(sql, bind.command, {
        allowNewBinding: true,
      });
      assert.equal(applied.outcome, "applied");
      assert.equal(applied.snapshot.realGrokbot, "NOT_CONNECTED");
      assert.equal(applied.snapshot.tasks[0]?.threadId, "thread-1");
      assert.equal(applied.snapshot.tasks[0]?.state, "blocked");
      assert.equal(applied.snapshot.tasks[0]?.gateDecision, "DENY");
      assert.equal(applied.snapshot.tasks[0]?.ownerAgentId, "principal-owner");
      assert.equal(
        applied.snapshot.agents.find((agent) => agent.id === "provider-codex")?.displayName,
        "Codex",
      );

      const again = yield* submitCollaborationCommand(sql, bind.command, { allowNewBinding: true });
      assert.equal(again.idempotent, true);
      assert.equal(again.snapshot.tasks.length, 1);

      const restarted = yield* readCollaborationSnapshot(sql, facts.principalId);
      assert.equal(restarted.tasks.length, 1);
      assert.equal(restarted.tasks[0]?.threadId, "thread-1");
      assert.equal(
        restarted.agents.find((agent) => agent.id === "grokbot")?.connection,
        "NOT_CONNECTED",
      );

      const client = yield* submitCollaborationCommand(sql, {
        type: "delegate",
        commandId: "client-send",
        actor: "owner",
        fromAgentId: "provider-codex",
        toAgentId: "provider-codex",
        projectId: "project-a",
        correlationId: "client",
        title: "Build X",
        body: "Build X.",
        acceptance: "X exists.",
        gateDecision: "ALLOW",
      });
      assert.equal(client.outcome, "rejected");
      assert.equal(client.code, "unauthorized");
      const afterClient = yield* readCollaborationSnapshot(sql, facts.principalId);
      assert.equal(afterClient.tasks.length, 1);

      const denied = sealCollaborationCommand(
        {
          type: "delegate",
          commandId: "send-deny",
          toAgentId: "provider-codex",
          projectId: "project-a",
          correlationId: "build-x",
          title: "Build X",
          body: "Build X.",
          acceptance: "X exists.",
          gateDecision: "ALLOW",
          actor: "owner",
          fromAgentId: "spoofed-agent",
        },
        facts,
      );
      assert.equal(denied.outcome, "sealed");
      if (denied.outcome !== "sealed") return;
      const blocked = yield* submitCollaborationCommand(sql, denied.command);
      assert.equal(blocked.outcome, "applied");
      assert.equal(
        blocked.snapshot.tasks.find((task) => task.title === "Build X")?.state,
        "blocked",
      );
      assert.equal(
        blocked.snapshot.tasks.find((task) => task.title === "Build X")?.gateDecision,
        "DENY",
      );
      assert.equal(blocked.snapshot.messages[0]?.grantsExecution, false);

      const repeated = yield* submitCollaborationCommand(sql, {
        ...denied.command,
        commandId: "send-deny-again",
      });
      assert.equal(repeated.idempotent, true);
      assert.equal(
        repeated.snapshot.tasks.filter((task) => task.correlationId === "build-x").length,
        1,
      );
      assert.equal(repeated.snapshot.messages.length, 1);
    }),
  );
});

it.effect(
  "isolates project partitions and rejects overwrite, unknown adoption and replay impersonation",
  () =>
    Effect.gen(function* () {
      const sql = yield* createTable;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, provider_instance_id, archived_at, deleted_at) VALUES
      ('thread-b', 'project-b', 'provider-codex', NULL, NULL),
      ('thread-2', 'project-a', 'provider-codex', NULL, NULL)`;
      const bind = {
        type: "thread.bind" as const,
        commandId: "first",
        projectId: "project-a",
        threadId: "thread-1",
        agentId: "provider-codex",
        displayName: "Codex",
        origin: "internal" as const,
        capabilities: ["gpt"],
        admissionSource: "server" as const,
        admittedBy: "principal-owner",
      };
      assert.equal((yield* submitCollaborationCommand(sql, bind)).outcome, "rejected");
      assert.equal(
        (yield* submitCollaborationCommand(sql, bind, { allowNewBinding: true })).outcome,
        "applied",
      );
      const otherProject = yield* submitCollaborationCommand(
        sql,
        {
          ...bind,
          commandId: "project-b",
          projectId: "project-b",
          threadId: "thread-b",
        },
        { allowNewBinding: true },
      );
      assert.equal(otherProject.outcome, "applied");
      assert.equal(otherProject.snapshot.tasks.length, 2);
      assert.equal(
        otherProject.snapshot.agents.filter((item) => item.origin === "internal").length,
        2,
      );
      const replay = yield* submitCollaborationCommand(sql, {
        ...bind,
        admittedBy: "other-principal",
      });
      assert.equal(replay.outcome, "rejected");
      assert.equal(replay.snapshot.tasks.length, 0);
      const overwrite = yield* submitCollaborationCommand(
        sql,
        {
          ...bind,
          commandId: "overwrite",
          threadId: "thread-2",
        },
        { allowNewBinding: true },
      );
      assert.equal(overwrite.outcome, "rejected");
      assert.equal((yield* readCollaborationSnapshot(sql, "principal-owner")).tasks.length, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "hides ambiguous ownership and never assigns an unsealed legacy binding to a reader",
  () =>
    Effect.gen(function* () {
      const sql = yield* createTable;
      const encode = Schema.encodeEffect(Schema.fromJsonString(CollaborationCommand));
      const bind = {
        type: "thread.bind" as const,
        projectId: "project-a",
        threadId: "thread-1",
        agentId: "provider-codex",
        displayName: "Codex",
        origin: "internal" as const,
        capabilities: ["gpt"],
        admissionSource: "server" as const,
        admittedBy: "principal-owner",
        commandId: "first",
      };
      yield* submitCollaborationCommand(sql, bind, { allowNewBinding: true });
      const stolen = { ...bind, admittedBy: "other-principal", commandId: "legacy-stolen" };
      yield* sql`INSERT INTO collaboration_commands VALUES (${stolen.commandId}, 2, ${yield* encode(stolen)}, '2026-10-12')`;
      const snapshot = yield* readCollaborationSnapshot(sql, "principal-owner");
      assert.equal(snapshot.agents.find((agent) => agent.origin === "internal")?.threadId, null);
      assert.equal(snapshot.tasks[0]?.threadId, null);
      const legacy = {
        ...bind,
        admittedBy: undefined,
        admissionSource: undefined,
        commandId: "unknown",
      };
      yield* sql`INSERT INTO collaboration_commands VALUES ('unknown', 3, ${yield* encode(legacy)}, '2026-10-12')`;
      assert.equal((yield* readCollaborationSnapshot(sql, "new-principal")).tasks.length, 0);
      const result = yield* submitCollaborationCommand(
        sql,
        { ...bind, commandId: "new", admittedBy: "new-principal" },
        { allowNewBinding: true },
      );
      assert.equal(result.outcome, "rejected");
      assert.equal(result.snapshot.tasks.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses cross-project task identity reuse and masks ambiguous legacy messages", () =>
  Effect.gen(function* () {
    const sql = yield* createTable;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, provider_instance_id, archived_at, deleted_at) VALUES ('thread-b', 'project-b', 'provider-codex', NULL, NULL)`;
    const bind = {
      type: "thread.bind" as const,
      commandId: "bind-a",
      projectId: "project-a",
      threadId: "thread-1",
      agentId: "provider-codex",
      displayName: "Codex",
      origin: "internal" as const,
      capabilities: ["gpt"],
      admissionSource: "server" as const,
      admittedBy: "principal-owner",
    };
    yield* submitCollaborationCommand(sql, bind, { allowNewBinding: true });
    yield* submitCollaborationCommand(
      sql,
      { ...bind, commandId: "bind-b", projectId: "project-b", threadId: "thread-b" },
      { allowNewBinding: true },
    );
    const delegate = {
      type: "delegate" as const,
      commandId: "delegate-a",
      projectId: "project-a",
      toAgentId: "provider-codex",
      correlationId: "shared-correlation",
      title: "Work",
      body: "Private project note",
      acceptance: "Done",
      admissionSource: "server" as const,
      admittedBy: "principal-owner",
      gateDecision: "DENY" as const,
    };
    yield* submitCollaborationCommand(sql, delegate);
    const other = { ...delegate, commandId: "delegate-b", projectId: "project-b" };
    assert.equal((yield* submitCollaborationCommand(sql, other)).outcome, "rejected");
    const encode = Schema.encodeEffect(Schema.fromJsonString(CollaborationCommand));
    yield* sql`INSERT INTO collaboration_commands VALUES ('delegate-b', 4, ${yield* encode(other)}, '2026-10-12')`;
    const snapshot = yield* readCollaborationSnapshot(sql, "principal-owner");
    const ambiguous = snapshot.tasks.filter((task) => task.correlationId === "shared-correlation");
    assert.equal(ambiguous.length, 2);
    assert.isTrue(ambiguous.every((task) => task.threadId === null && task.state === "blocked"));
    assert.equal(
      snapshot.messages.filter((message) => message.taskId === "task:shared-correlation").length,
      0,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "rejects bind correlation collisions and hides the agent link of a legacy inconsistent binding",
  () =>
    Effect.gen(function* () {
      const sql = yield* createTable;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, provider_instance_id, archived_at, deleted_at) VALUES ('thread-b', 'project-b', 'provider-codex', NULL, NULL)`;
      const bind = {
        type: "thread.bind" as const,
        commandId: "bind-a",
        projectId: "project-a",
        threadId: "thread-1",
        agentId: "provider-codex",
        displayName: "Codex",
        origin: "internal" as const,
        capabilities: ["gpt"],
        admissionSource: "server" as const,
        admittedBy: "principal-owner",
      };
      yield* submitCollaborationCommand(sql, bind, { allowNewBinding: true });
      yield* submitCollaborationCommand(sql, {
        type: "delegate",
        commandId: "held",
        projectId: "project-a",
        toAgentId: "provider-codex",
        correlationId: "thread:thread-b",
        title: "Held",
        body: "Blocked work",
        acceptance: "Review",
        admissionSource: "server",
        admittedBy: "principal-owner",
        gateDecision: "DENY",
      });
      const other = { ...bind, commandId: "bind-b", projectId: "project-b", threadId: "thread-b" };
      assert.equal(
        (yield* submitCollaborationCommand(sql, other, { allowNewBinding: true })).outcome,
        "rejected",
      );
      const encode = Schema.encodeEffect(Schema.fromJsonString(CollaborationCommand));
      yield* sql`INSERT INTO collaboration_commands VALUES ('bind-b', 3, ${yield* encode(other)}, '2026-10-12')`;
      const snapshot = yield* readCollaborationSnapshot(sql, "principal-owner");
      assert.equal(
        snapshot.agents.find((agent) => agent.projectId === "project-b")?.threadId,
        null,
      );
      assert.isTrue(
        snapshot.tasks
          .filter((task) => task.correlationId === "thread:thread-b")
          .every((task) => task.threadId === null),
      );
      const replay = yield* submitCollaborationCommand(sql, other);
      assert.equal(replay.outcome, "rejected");
      assert.equal(replay.idempotent, false);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "reads only the linked principal's persisted contract and its latest revision/phase",
  () =>
    Effect.gen(function* () {
      const sql = yield* createTable;
      const bind = {
        type: "thread.bind" as const,
        commandId: "contract-bind",
        projectId: "project-a",
        threadId: "thread-1",
        agentId: "provider-codex",
        displayName: "Codex",
        origin: "internal" as const,
        capabilities: ["gpt"],
        admissionSource: "server" as const,
        admittedBy: "principal-owner",
      };
      yield* submitCollaborationCommand(sql, bind, { allowNewBinding: true });
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const contract = {
        revision: 1,
        goal: "Persisted goal, not task title",
        redirect: "Ask the owner before scope changes",
        acceptance: "Review the stored artifact",
        brake: {
          maxProviderStarts: 2,
          stopConditions: "Stop on missing input",
          maxTokens: 1200,
          maxCostUsd: 0.2,
          deadlineAt: "2026-10-14T00:00:00Z",
        },
      };
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskGovernance: "required", taskContract: contract, taskContractPhase: "active", taskAcceptedRevision: null })} WHERE thread_id='thread-1'`;
      const first = yield* readCollaborationSnapshot(sql, "principal-owner");
      assert.deepEqual(first.tasks[0]?.contractReadout, {
        status: "available",
        contract,
        phase: "active",
        acceptedRevision: null,
      });
      assert.equal(first.tasks[0]?.state, "blocked");
      assert.equal(first.tasks[0]?.gateDecision, "DENY");
      const revised = { ...contract, revision: 2, goal: "Revised persisted goal" };
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskGovernance: "required", taskContract: revised, taskContractPhase: "redirected", taskAcceptedRevision: 1 })} WHERE thread_id='thread-1'`;
      assert.deepEqual(
        (yield* readCollaborationSnapshot(sql, "principal-owner")).tasks[0]?.contractReadout,
        { status: "available", contract: revised, phase: "redirected", acceptedRevision: 1 },
      );
      assert.equal((yield* readCollaborationSnapshot(sql, "other-principal")).tasks.length, 0);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskContract: contract })} WHERE thread_id='thread-1'`;
      assert.deepEqual(
        (yield* readCollaborationSnapshot(sql, "principal-owner")).tasks[0]?.contractReadout,
        { status: "available", contract, phase: null, acceptedRevision: null },
      );
      const states = [
        { payload: {}, reason: "ordinary_chat" },
        {
          payload: {
            taskGovernance: "required",
            taskContract: contract,
            projectId: "foreign-project",
          },
          reason: "invalid_contract",
        },
        {
          payload: {
            taskGovernance: "required",
            taskContract: contract,
            taskContractPhase: "unknown",
          },
          reason: "invalid_contract",
        },
        { payload: { taskGovernance: "required", taskContract: null }, reason: "missing_contract" },
        {
          payload: { taskGovernance: "required", taskContract: { ...contract, goal: "" } },
          reason: "invalid_contract",
        },
        {
          payload: { taskGovernance: "required", taskContract: { ...contract, brake: undefined } },
          reason: "invalid_contract",
        },
      ] as const;
      for (const { payload, reason } of states) {
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode(payload)} WHERE thread_id='thread-1'`;
        assert.deepEqual(
          (yield* readCollaborationSnapshot(sql, "principal-owner")).tasks[0]?.contractReadout,
          { status: "unavailable", reason },
        );
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='invalid JSON' WHERE thread_id='thread-1'`;
      assert.deepEqual(
        (yield* readCollaborationSnapshot(sql, "principal-owner")).tasks[0]?.contractReadout,
        { status: "unavailable", reason: "invalid_contract" },
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${yield* encode({ taskGovernance: "required", taskContract: contract })}, project_id='foreign-project' WHERE thread_id='thread-1'`;
      const wrongProject = (yield* readCollaborationSnapshot(sql, "principal-owner")).tasks[0];
      assert.equal(wrongProject?.threadId, null);
      assert.deepEqual(wrongProject?.contractReadout, {
        status: "unavailable",
        reason: "invalid_thread_link",
      });
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='project-a', archived_at='2026-10-13' WHERE thread_id='thread-1'`;
      assert.deepEqual(
        (yield* readCollaborationSnapshot(sql, "principal-owner")).tasks[0]?.contractReadout,
        { status: "unavailable", reason: "invalid_thread_link" },
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
