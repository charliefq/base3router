import { CollaborationCommand } from "@t3tools/contracts";
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
    archived_at TEXT, deleted_at TEXT
  )`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('thread-1', 'project-a', 'provider-codex', NULL, NULL)`;
  return sql;
});

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
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES
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
