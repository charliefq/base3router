import { CollaborationCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { applyCollaboration, foldCollaboration, initialCollaboration } from "./decide.ts";

const CommandJson = Schema.fromJsonString(CollaborationCommand);
const decodeCommand = Schema.decodeUnknownEffect(CommandJson);
const encodeCommand = Schema.encodeEffect(CommandJson);

const readCommands = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly command_id: string;
      readonly payload_json: string;
    }>`
      SELECT command_id, payload_json
      FROM collaboration_commands
      ORDER BY sequence
    `;
    return yield* Effect.forEach(rows, (row) => decodeCommand(row.payload_json));
  });

export const readCollaborationSnapshot = (sql: SqlClient.SqlClient) =>
  Effect.map(readCommands(sql), foldCollaboration);

export const submitCollaborationCommand = (
  sql: SqlClient.SqlClient,
  command: CollaborationCommand,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const commands = yield* readCommands(sql);
      if (commands.some((item) => item.commandId === command.commandId)) {
        const snapshot = foldCollaboration(commands);
        return {
          outcome: "applied" as const,
          code: null,
          detail: "This command was already applied.",
          idempotent: true,
          gateDecision: null,
          snapshot,
        };
      }
      let state = initialCollaboration();
      for (const existing of commands) {
        const prior = applyCollaboration(state, existing);
        if (prior.outcome !== "applied") continue;
        state = {
          agents: prior.snapshot.agents.map((agent) => ({
            id: agent.id,
            displayName: agent.displayName,
            origin: agent.origin,
            role: agent.role,
            capabilities: [...agent.capabilities],
            connection: agent.connection,
            projectId: agent.projectId,
          })),
          tasks: prior.snapshot.tasks,
          messages: prior.snapshot.messages,
          appliedCommandIds: state.appliedCommandIds.includes(existing.commandId)
            ? state.appliedCommandIds
            : [...state.appliedCommandIds, existing.commandId],
        };
      }
      const result = applyCollaboration(state, command);
      if (result.outcome === "rejected") return result;
      const sequenceRows = yield* sql<{ readonly next: number | string }>`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM collaboration_commands
      `;
      const sequence = Number(sequenceRows[0]?.next ?? 1);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO collaboration_commands (command_id, sequence, payload_json, created_at)
        VALUES (
          ${command.commandId},
          ${sequence},
          ${yield* encodeCommand(command)},
          ${createdAt}
        )
      `;
      return result;
    }),
  );
