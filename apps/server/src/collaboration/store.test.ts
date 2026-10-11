import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { readCollaborationSnapshot, submitCollaborationCommand } from "./store.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

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
  return sql;
});

layer("collaboration store", (it) => {
  it.effect("keeps a rehearsed task after a new read and does not store a refusal", () =>
    Effect.gen(function* () {
      const sql = yield* createTable;
      const applied = yield* submitCollaborationCommand(sql, {
        type: "scenario.rehearse",
        commandId: "scenario-a-owner-project",
        scenario: "A",
        projectId: "owner-project",
      });
      assert.equal(applied.outcome, "applied");
      assert.equal(applied.snapshot.realGrokbot, "NOT_CONNECTED");
      assert.equal(applied.snapshot.tasks[0]?.state, "completed");
      assert.equal(applied.snapshot.tasks[0]?.title, "Build X");
      assert.equal(
        applied.snapshot.messages.every((message) => message.transport === "simulated"),
        true,
      );

      const again = yield* submitCollaborationCommand(sql, {
        type: "scenario.rehearse",
        commandId: "scenario-a-owner-project",
        scenario: "A",
        projectId: "owner-project",
      });
      assert.equal(again.idempotent, true);
      assert.equal(again.snapshot.tasks.length, 1);
      assert.equal(again.snapshot.messages.length, 4);

      const restarted = yield* readCollaborationSnapshot(sql);
      assert.equal(restarted.tasks.length, 1);
      assert.equal(restarted.messages.length, 4);
      assert.equal(
        restarted.agents.find((agent) => agent.id === "grokbot")?.connection,
        "SIMULATED",
      );

      const outbound = yield* submitCollaborationCommand(sql, {
        type: "scenario.rehearse",
        commandId: "scenario-b-owner-project",
        scenario: "B",
        projectId: "owner-project",
      });
      assert.equal(
        outbound.snapshot.tasks.find((task) => task.title === "Do Y")?.state,
        "completed",
      );
      const result = outbound.snapshot.messages.find(
        (message) => message.kind === "result" && message.body === "Y is done.",
      );
      assert.equal(result?.senderId, "grokbot-research");
      assert.equal(result?.recipientId, "b3r-engineering");

      const crossed = yield* submitCollaborationCommand(sql, {
        type: "agent.register",
        commandId: "other-project-agent",
        agentId: "other-project",
        displayName: "Other project",
        origin: "internal",
        role: "engineering",
        capabilities: ["build"],
        projectId: "other-project",
      });
      assert.equal(crossed.outcome, "applied");
      const denied = yield* submitCollaborationCommand(sql, {
        type: "delegate",
        commandId: "denied-cross",
        correlationId: "denied-cross",
        projectId: "owner-project",
        fromAgentId: "b3r-engineering",
        toAgentId: "other-project",
        title: "Cross",
        body: "Work in the other project.",
        acceptance: "Refused.",
        actor: "owner",
      });
      assert.equal(denied.outcome, "rejected");
      assert.equal(denied.code, "cross-project");
      const persisted = yield* readCollaborationSnapshot(sql);
      assert.equal(
        persisted.tasks.some((task) => task.correlationId === "denied-cross"),
        false,
      );
    }),
  );
});
