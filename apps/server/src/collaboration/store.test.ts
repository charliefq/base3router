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
      const applied = yield* submitCollaborationCommand(sql, bind.command);
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

      const again = yield* submitCollaborationCommand(sql, bind.command);
      assert.equal(again.idempotent, true);
      assert.equal(again.snapshot.tasks.length, 1);

      const restarted = yield* readCollaborationSnapshot(sql);
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
      const afterClient = yield* readCollaborationSnapshot(sql);
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
