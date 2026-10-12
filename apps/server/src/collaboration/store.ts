import { CollaborationCommand, type CollaborationSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { applyCollaboration, foldCollaboration, foldCollaborationState } from "./decide.ts";

const CommandJson = Schema.fromJsonString(CollaborationCommand);
const decodeCommand = Schema.decodeUnknownEffect(CommandJson);
const encodeCommand = Schema.encodeEffect(CommandJson);

export const readCommands = (sql: SqlClient.SqlClient) =>
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

const owner = (command: CollaborationCommand) =>
  command.admissionSource === "server" ? command.admittedBy : undefined;

// A ledger row with no verifiable seal is never assigned to the current reader.
export const ownedCommands = (commands: ReadonlyArray<CollaborationCommand>, principalId: string) =>
  commands.filter((command) => principalId.length > 0 && owner(command) === principalId);

const projectFor = (
  commands: ReadonlyArray<CollaborationCommand>,
  command: CollaborationCommand,
) => {
  if (command.projectId) return command.projectId;
  if (!command.taskId) return undefined;
  const projects = new Set(
    commands
      .filter(
        (item) =>
          item.projectId &&
          ((item.type === "thread.bind" && command.taskId === `task:thread:${item.threadId}`) ||
            (item.correlationId && command.taskId === `task:${item.correlationId}`)),
      )
      .map((item) => item.projectId),
  );
  return projects.size === 1 ? [...projects][0] : undefined;
};

const scopedSnapshot = (commands: ReadonlyArray<CollaborationCommand>, principalId: string) => {
  const owned = ownedCommands(commands, principalId);
  const projects = new Set(owned.map((command) => projectFor(owned, command)).filter(Boolean));
  const empty = foldCollaboration([]);
  const snapshots = [...projects].map((projectId) =>
    foldCollaboration(owned.filter((command) => projectFor(owned, command) === projectId)),
  );
  return {
    ...empty,
    agents: [
      ...empty.agents,
      ...snapshots.flatMap((snapshot) =>
        snapshot.agents.filter((agent) => agent.origin === "internal"),
      ),
    ],
    tasks: snapshots.flatMap((snapshot) => snapshot.tasks),
    messages: snapshots.flatMap((snapshot) => snapshot.messages),
  };
};

const validateThreadLinks = (
  sql: SqlClient.SqlClient,
  snapshot: CollaborationSnapshot,
  commands: ReadonlyArray<CollaborationCommand>,
  principalId: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly provider_instance_id: string;
      readonly archived_at: string | null;
      readonly deleted_at: string | null;
    }>`SELECT thread_id, project_id, provider_instance_id, archived_at, deleted_at
     FROM orchestration_v2_projection_threads`;
    const invalid = new Set<string>();
    const agents = snapshot.agents.map((agent) => {
      if (agent.origin !== "internal" || !agent.threadId || !agent.projectId) return agent;
      const thread = rows.find((row) => row.thread_id === agent.threadId);
      if (
        !thread ||
        thread.project_id !== agent.projectId ||
        thread.provider_instance_id !== agent.id ||
        thread.archived_at !== null ||
        thread.deleted_at !== null ||
        bindingConflict(commands, principalId, agent.projectId, agent.id, agent.threadId)
      ) {
        invalid.add(agent.threadId);
        return { ...agent, threadId: null };
      }
      return agent;
    });
    return {
      ...snapshot,
      agents,
      tasks: snapshot.tasks.map((task) =>
        task.threadId &&
        (invalid.has(task.threadId) ||
          !agents.some(
            (agent) =>
              agent.id === task.assigneeAgentId &&
              agent.projectId === task.projectId &&
              agent.threadId === task.threadId,
          ))
          ? {
              ...task,
              threadId: null,
              state: "blocked" as const,
              gateDecision: "DENY" as const,
              waitReason: "The thread link is invalid. Explicit repair is required.",
            }
          : task,
      ),
    };
  });

export const readCollaborationSnapshot = (sql: SqlClient.SqlClient, principalId: string) =>
  Effect.gen(function* () {
    const commands = yield* readCommands(sql);
    return yield* validateThreadLinks(
      sql,
      scopedSnapshot(commands, principalId),
      commands,
      principalId,
    );
  });

// Server seals carry all semantic fields. Property order is not command semantics.
const semanticKey = (command: CollaborationCommand) =>
  JSON.stringify(
    Object.entries(command)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

export const bindingConflict = (
  commands: ReadonlyArray<CollaborationCommand>,
  principalId: string,
  projectId: string,
  agentId: string,
  threadId?: string,
) => {
  const bindings = commands.filter((item) => item.type === "thread.bind");
  const tuple = bindings.filter((item) => item.projectId === projectId && item.agentId === agentId);
  if (tuple.some((item) => !owner(item))) return true;
  const own = tuple.filter((item) => owner(item) === principalId);
  if (new Set(own.map((item) => item.threadId)).size > 1) return true;
  if (threadId && own.some((item) => item.threadId !== threadId)) return true;
  const candidateIds = new Set(own.map((item) => item.threadId));
  if (threadId) candidateIds.add(threadId);
  return bindings.some(
    (item) =>
      candidateIds.has(item.threadId) &&
      (owner(item) !== principalId || item.projectId !== projectId || item.agentId !== agentId),
  );
};

export const submitCollaborationCommand = (
  sql: SqlClient.SqlClient,
  command: CollaborationCommand,
  // Only the server recovery service supplies this after verifying a scoped create receipt.
  options: { readonly allowNewBinding: boolean } = { allowNewBinding: false },
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const commands = yield* readCommands(sql);
      const principalId = owner(command) ?? "";
      const snapshot = yield* validateThreadLinks(
        sql,
        scopedSnapshot(commands, principalId),
        commands,
        principalId,
      );
      const refusal = (code: "unauthorized" | "identity-conflict", detail: string) => ({
        outcome: "rejected" as const,
        code,
        detail,
        idempotent: false,
        gateDecision: "DENY" as const,
        snapshot,
      });
      if (!principalId) return refusal("unauthorized", "The server admission seal is required.");
      const prior = commands.find((item) => item.commandId === command.commandId);
      if (prior) {
        if (owner(prior) !== principalId || semanticKey(prior) !== semanticKey(command))
          return refusal(
            "identity-conflict",
            "The command identity cannot be replayed with different ownership or semantics.",
          );
        return {
          outcome: "applied" as const,
          code: null,
          detail: "This command was already applied.",
          idempotent: true,
          gateDecision: null,
          snapshot,
        };
      }
      const owned = ownedCommands(commands, principalId);
      const projectId = projectFor(owned, command);
      if (!projectId)
        return refusal("unauthorized", "The command does not identify one owned project.");
      if (
        command.type === "thread.bind" &&
        !options.allowNewBinding &&
        !owned.some(
          (item) =>
            item.type === "thread.bind" &&
            item.projectId === projectId &&
            item.agentId === command.agentId &&
            item.threadId === command.threadId,
        )
      )
        return refusal(
          "unauthorized",
          "An unowned thread cannot be adopted. Use server conversation recovery.",
        );
      if (
        command.type === "thread.bind" &&
        command.agentId &&
        bindingConflict(commands, principalId, projectId, command.agentId, command.threadId)
      )
        return refusal(
          "identity-conflict",
          "The binding has unknown, conflicting, or different ownership.",
        );
      if (command.type === "thread.bind") {
        const rows = yield* sql<{
          readonly project_id: string;
          readonly provider_instance_id: string;
          readonly archived_at: string | null;
          readonly deleted_at: string | null;
        }>`
          SELECT project_id, provider_instance_id, archived_at, deleted_at
          FROM orchestration_v2_projection_threads WHERE thread_id = ${command.threadId ?? ""}
        `;
        const thread = rows[0];
        if (
          !thread ||
          thread.project_id !== projectId ||
          thread.provider_instance_id !== command.agentId ||
          thread.archived_at !== null ||
          thread.deleted_at !== null
        )
          return refusal("identity-conflict", "The thread is missing, invalid, or archived.");
      }
      const state = foldCollaborationState(
        owned.filter((item) => projectFor(owned, item) === projectId),
      );
      const result = applyCollaboration(state, command);
      if (result.outcome === "rejected") return { ...result, snapshot };
      const sequenceRows = yield* sql<{ readonly next: number | string }>`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM collaboration_commands
      `;
      const sequence = Number(sequenceRows[0]?.next ?? 1);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO collaboration_commands (command_id, sequence, payload_json, created_at)
        VALUES (${command.commandId}, ${sequence}, ${yield* encodeCommand(command)}, ${createdAt})
      `;
      return {
        ...result,
        snapshot: yield* validateThreadLinks(
          sql,
          scopedSnapshot([...commands, command], principalId),
          [...commands, command],
          principalId,
        ),
      };
    }),
  );
