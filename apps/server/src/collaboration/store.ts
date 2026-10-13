import {
  CollaborationCommand,
  type CollaborationSnapshot,
  type CollaborationTaskContractReadout,
  type CollaborationTaskRoutingReadout,
  DispatcherTaskRouteBinding,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  TaskContract,
  TaskContractPhase,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { applyCollaboration, foldCollaboration, foldCollaborationState } from "./decide.ts";

const StoredContract = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  providerInstanceId: Schema.optionalKey(Schema.String),
  taskGovernance: Schema.optionalKey(Schema.Literals(["chat", "required"])),
  taskContract: Schema.optionalKey(Schema.NullOr(TaskContract)),
  taskContractPhase: Schema.optionalKey(TaskContractPhase),
  taskAcceptedRevision: Schema.optionalKey(
    Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  ),
});
const decodeStoredContract = Schema.decodeUnknownOption(Schema.fromJsonString(StoredContract));
const contractReadout = (row: {
  readonly thread_id: string;
  readonly project_id: string;
  readonly provider_instance_id: string;
  readonly payload_json: string;
}): CollaborationTaskContractReadout => {
  const decoded = decodeStoredContract(row.payload_json);
  if (decoded._tag === "None") return { status: "unavailable", reason: "invalid_contract" };
  const value = decoded.value;
  if (
    (value.id !== undefined && value.id !== row.thread_id) ||
    (value.projectId !== undefined && value.projectId !== row.project_id) ||
    (value.providerInstanceId !== undefined &&
      value.providerInstanceId !== row.provider_instance_id)
  )
    return { status: "unavailable", reason: "invalid_contract" };
  if (value.taskContract == null)
    return {
      status: "unavailable",
      reason: value.taskGovernance === "required" ? "missing_contract" : "ordinary_chat",
    };
  return {
    status: "available",
    contract: value.taskContract,
    phase: value.taskContractPhase ?? null,
    acceptedRevision: value.taskAcceptedRevision ?? null,
  };
};

const StoredRunEvidence = Schema.Struct({
  id: OrchestrationV2Run.fields.id,
  threadId: OrchestrationV2Run.fields.threadId,
  ordinal: OrchestrationV2Run.fields.ordinal,
  providerInstanceId: OrchestrationV2Run.fields.providerInstanceId,
  modelSelection: OrchestrationV2Run.fields.modelSelection,
  userMessageId: OrchestrationV2Run.fields.userMessageId,
  activeAttemptId: OrchestrationV2Run.fields.activeAttemptId,
  rootNodeId: OrchestrationV2Run.fields.rootNodeId,
  providerThreadId: OrchestrationV2Run.fields.providerThreadId,
  status: OrchestrationV2Run.fields.status,
});
const StoredAttemptEvidence = Schema.Struct({
  id: OrchestrationV2RunAttempt.fields.id,
  runId: OrchestrationV2RunAttempt.fields.runId,
  rootNodeId: OrchestrationV2RunAttempt.fields.rootNodeId,
  providerInstanceId: OrchestrationV2RunAttempt.fields.providerInstanceId,
  providerThreadId: OrchestrationV2RunAttempt.fields.providerThreadId,
  providerTurnId: OrchestrationV2RunAttempt.fields.providerTurnId,
});
const StoredProviderThreadEvidence = Schema.Struct({
  id: OrchestrationV2ProviderThread.fields.id,
  appThreadId: OrchestrationV2ProviderThread.fields.appThreadId,
  providerInstanceId: OrchestrationV2ProviderThread.fields.providerInstanceId,
});
const StoredTurnEvidence = Schema.Struct({
  id: OrchestrationV2ProviderTurn.fields.id,
  providerThreadId: OrchestrationV2ProviderTurn.fields.providerThreadId,
  nodeId: OrchestrationV2ProviderTurn.fields.nodeId,
  runAttemptId: OrchestrationV2ProviderTurn.fields.runAttemptId,
  status: OrchestrationV2ProviderTurn.fields.status,
  startedAt: Schema.NullOr(Schema.String),
});
const decodeRunEvidence = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRunEvidence));
const decodeAttemptEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredAttemptEvidence),
);
const decodeProviderThreadEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredProviderThreadEvidence),
);
const decodeTurnEvidence = Schema.decodeUnknownOption(Schema.fromJsonString(StoredTurnEvidence));
const decodeRouteEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(DispatcherTaskRouteBinding),
);
const unknownExecution = (reason: string) => ({
  status: "unknown" as const,
  reason,
  providerTurnId: null,
  providerStatus: null,
  startedAt: null,
});

const readRoutingEvidence = (
  sql: SqlClient.SqlClient,
  threadId: string,
): Effect.Effect<CollaborationTaskRoutingReadout> =>
  Effect.gen(function* () {
    const runs = yield* sql<{
      run_id: string;
      thread_id: string;
      ordinal: number;
      provider_instance_id: string;
      status: string;
      payload_json: string;
    }>`
      SELECT run_id, thread_id, ordinal, provider_instance_id, status, payload_json
      FROM orchestration_v2_projection_runs WHERE thread_id=${threadId}
      ORDER BY ordinal DESC, run_id DESC LIMIT 1
    `;
    const row = runs[0];
    const parsedRun = row === undefined ? null : decodeRunEvidence(row.payload_json);
    if (parsedRun?._tag === "None")
      return { status: "unavailable" as const, reason: "invalid_run" };
    const run = parsedRun?._tag === "Some" ? parsedRun.value : null;
    if (
      run !== null &&
      row !== undefined &&
      (run.id !== row.run_id ||
        run.threadId !== threadId ||
        row.thread_id !== threadId ||
        run.ordinal !== row.ordinal ||
        run.providerInstanceId !== row.provider_instance_id ||
        run.modelSelection.instanceId !== run.providerInstanceId ||
        run.status !== row.status)
    )
      return { status: "unavailable" as const, reason: "invalid_run" };
    // With a run, require that exact message; never borrow an older route.
    const routes =
      run === null
        ? yield* sql<{
            message_id: string;
            binding_json: string;
          }>`SELECT message_id, binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} ORDER BY created_at DESC, message_id DESC LIMIT 1`
        : yield* sql<{
            message_id: string;
            binding_json: string;
          }>`SELECT message_id, binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${run.userMessageId} LIMIT 1`;
    const routeRow = routes[0];
    if (run === null && routeRow === undefined)
      return { status: "unavailable" as const, reason: "no_dispatch_evidence" };
    const parsedRoute = routeRow === undefined ? null : decodeRouteEvidence(routeRow.binding_json);
    const binding = parsedRoute?._tag === "Some" ? parsedRoute.value : null;
    const decision = binding?.modelRoute;
    const selected =
      decision === undefined ? (binding?.target ?? null) : (decision.selected?.target ?? null);
    const routeConsistent =
      binding !== null &&
      (selected === null ||
        (selected.instanceId === binding.target.instanceId &&
          selected.model === binding.target.model));
    const result = {
      status: "available" as const,
      threadId,
      messageId: run?.userMessageId ?? routeRow!.message_id,
      runId: run?.id ?? null,
      mode: routeConsistent ? (decision?.mode ?? null) : null,
      selected: routeConsistent ? selected : null,
      source: routeConsistent ? binding.source : null,
      reasons: routeConsistent ? (decision?.reasonCodes ?? binding.gate.reasonCodes) : [],
      explanation: routeConsistent ? (decision?.explanation ?? null) : null,
      selectionUnknownReason:
        routeRow === undefined
          ? "route_missing"
          : !routeConsistent
            ? "route_invalid"
            : selected === null
              ? "selection_not_recorded"
              : null,
      configuredModel: run?.modelSelection ?? null,
      execution: unknownExecution(run === null ? "route_only" : "missing_attempt"),
    };
    if (run === null || run.activeAttemptId === null) return result;
    const attempts = yield* sql<{
      attempt_id: string;
      thread_id: string;
      run_id: string;
      provider_instance_id: string;
      payload_json: string;
    }>`SELECT attempt_id, thread_id, run_id, provider_instance_id, payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=${run.activeAttemptId} AND thread_id=${threadId} AND run_id=${run.id} LIMIT 1`;
    const attemptRow = attempts[0];
    if (attemptRow === undefined) return result;
    const parsedAttempt = decodeAttemptEvidence(attemptRow.payload_json);
    if (parsedAttempt._tag === "None")
      return { ...result, execution: unknownExecution("invalid_attempt") };
    const attempt = parsedAttempt.value;
    if (
      attempt.id !== attemptRow.attempt_id ||
      attempt.runId !== run.id ||
      attemptRow.provider_instance_id !== run.providerInstanceId ||
      attempt.providerInstanceId !== run.providerInstanceId ||
      attempt.providerThreadId !== run.providerThreadId ||
      attempt.rootNodeId !== run.rootNodeId
    )
      return { ...result, execution: unknownExecution("invalid_attempt") };
    const providerThreads = yield* sql<{
      provider_thread_id: string;
      thread_id: string;
      provider_instance_id: string;
      payload_json: string;
    }>`SELECT provider_thread_id, thread_id, provider_instance_id, payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=${attempt.providerThreadId} AND thread_id=${threadId} LIMIT 1`;
    const providerThreadRow = providerThreads[0];
    if (providerThreadRow === undefined)
      return { ...result, execution: unknownExecution("missing_provider_thread") };
    const parsedThread = decodeProviderThreadEvidence(providerThreadRow.payload_json);
    if (
      parsedThread._tag === "None" ||
      parsedThread.value.id !== attempt.providerThreadId ||
      parsedThread.value.appThreadId !== threadId ||
      parsedThread.value.providerInstanceId !== run.providerInstanceId ||
      providerThreadRow.provider_instance_id !== run.providerInstanceId
    )
      return { ...result, execution: unknownExecution("invalid_provider_thread") };
    if (attempt.providerTurnId === null)
      return { ...result, execution: unknownExecution("missing_provider_turn") };
    const turns = yield* sql<{
      provider_turn_id: string;
      provider_thread_id: string;
      run_attempt_id: string | null;
      node_id: string;
      status: string;
      started_at: string | null;
      payload_json: string;
    }>`SELECT provider_turn_id, provider_thread_id, run_attempt_id, node_id, status, started_at, payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=${attempt.providerTurnId} AND thread_id=${threadId} LIMIT 1`;
    const turnRow = turns[0];
    if (turnRow === undefined)
      return { ...result, execution: unknownExecution("missing_provider_turn") };
    const parsedTurn = decodeTurnEvidence(turnRow.payload_json);
    if (parsedTurn._tag === "None")
      return { ...result, execution: unknownExecution("invalid_provider_turn") };
    const turn = parsedTurn.value;
    if (
      turn.id !== turnRow.provider_turn_id ||
      turn.providerThreadId !== attempt.providerThreadId ||
      turnRow.provider_thread_id !== attempt.providerThreadId ||
      turn.runAttemptId !== attempt.id ||
      turnRow.run_attempt_id !== attempt.id ||
      turn.nodeId !== attempt.rootNodeId ||
      turnRow.node_id !== attempt.rootNodeId ||
      turn.status !== turnRow.status ||
      turn.startedAt !== turnRow.started_at
    )
      return { ...result, execution: unknownExecution("invalid_provider_turn") };
    if (turn.status === "pending")
      return { ...result, execution: unknownExecution("provider_turn_pending") };
    if (turn.startedAt === null || !Number.isFinite(Date.parse(turn.startedAt)))
      return { ...result, execution: unknownExecution("provider_turn_not_started") };
    return {
      ...result,
      execution: {
        status: "observed" as const,
        reason: null,
        providerTurnId: turn.id,
        providerStatus: turn.status,
        startedAt: turn.startedAt,
      },
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      status: "unavailable" as const,
      reason: "evidence_unavailable",
    })),
  );

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
  const tasks = snapshots.flatMap((snapshot) => snapshot.tasks);
  const ambiguous = new Set(
    tasks
      .filter((task) =>
        tasks.some((other) => other.id === task.id && other.projectId !== task.projectId),
      )
      .map((task) => task.id),
  );
  return {
    ...empty,
    agents: [
      ...empty.agents,
      ...snapshots.flatMap((snapshot) =>
        snapshot.agents.filter((agent) => agent.origin === "internal"),
      ),
    ],
    tasks: tasks.map((task) =>
      ambiguous.has(task.id)
        ? {
            ...task,
            threadId: null,
            state: "blocked" as const,
            gateDecision: "DENY" as const,
            waitReason:
              "The task identity is ambiguous across projects. Explicit repair is required.",
          }
        : task,
    ),
    messages: snapshots
      .flatMap((snapshot) => snapshot.messages)
      .filter((message) => !ambiguous.has(message.taskId)),
  };
};

export const hasCanonicalCollaborationLink = (
  snapshot: CollaborationSnapshot,
  scope: {
    readonly principalId: string;
    readonly projectId: string;
    readonly agentId: string;
    readonly threadId: string;
  },
) =>
  snapshot.agents.some(
    (agent) =>
      agent.origin === "internal" &&
      agent.id === scope.agentId &&
      agent.projectId === scope.projectId &&
      agent.threadId === scope.threadId,
  ) &&
  snapshot.tasks.some(
    (task) =>
      task.id === `task:thread:${scope.threadId}` &&
      task.correlationId === `thread:${scope.threadId}` &&
      task.ownerAgentId === scope.principalId &&
      task.assigneeAgentId === scope.agentId &&
      task.projectId === scope.projectId &&
      task.threadId === scope.threadId,
  );

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
        bindingConflict(commands, principalId, agent.projectId, agent.id, agent.threadId) ||
        !hasCanonicalCollaborationLink(snapshot, {
          principalId,
          projectId: agent.projectId,
          agentId: agent.id,
          threadId: agent.threadId,
        })
      ) {
        invalid.add(agent.threadId);
        return { ...agent, threadId: null };
      }
      return agent;
    });
    const tasks = yield* Effect.forEach(snapshot.tasks, (task) =>
      Effect.gen(function* () {
        const invalidTask = () => ({
          ...task,
          ...(task.threadId === null
            ? {}
            : {
                threadId: null,
                state: "blocked" as const,
                gateDecision: "DENY" as const,
                waitReason: "The thread link is invalid. Explicit repair is required.",
              }),
          routingReadout: { status: "unavailable" as const, reason: "invalid_thread_link" },
          contractReadout: {
            status: "unavailable" as const,
            reason: "invalid_thread_link" as const,
          },
        });
        const linked =
          task.threadId !== null &&
          !invalid.has(task.threadId) &&
          agents.some(
            (agent) =>
              agent.id === task.assigneeAgentId &&
              agent.projectId === task.projectId &&
              agent.threadId === task.threadId,
          );
        if (!linked) return invalidTask();
        // Payload reads happen only after the sealed principal and canonical link checks.
        const payloads = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id=${task.threadId} AND project_id=${task.projectId}
          AND provider_instance_id=${task.assigneeAgentId} AND archived_at IS NULL AND deleted_at IS NULL
        LIMIT 1
      `;
        const payload = payloads[0];
        if (payload === undefined || task.threadId === null) return invalidTask();
        const threadEvidence = decodeStoredContract(payload.payload_json);
        const validThreadEvidence =
          threadEvidence._tag === "Some" &&
          (threadEvidence.value.id === undefined || threadEvidence.value.id === task.threadId) &&
          (threadEvidence.value.projectId === undefined ||
            threadEvidence.value.projectId === task.projectId) &&
          (threadEvidence.value.providerInstanceId === undefined ||
            threadEvidence.value.providerInstanceId === task.assigneeAgentId);
        return {
          ...task,
          routingReadout: validThreadEvidence
            ? yield* readRoutingEvidence(sql, task.threadId)
            : { status: "unavailable" as const, reason: "invalid_thread_evidence" },
          contractReadout: contractReadout({
            thread_id: task.threadId,
            project_id: task.projectId,
            provider_instance_id: task.assigneeAgentId,
            payload_json: payload.payload_json,
          }),
        };
      }),
    );
    return { ...snapshot, agents, tasks };
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
        if (
          command.type === "thread.bind" &&
          !hasCanonicalCollaborationLink(snapshot, {
            principalId,
            projectId: command.projectId ?? "",
            agentId: command.agentId ?? "",
            threadId: command.threadId ?? "",
          })
        )
          return refusal(
            "identity-conflict",
            "The binding cannot be replayed without a consistent canonical task.",
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
      const correlationId =
        command.type === "thread.bind" && command.threadId
          ? `thread:${command.threadId}`
          : command.type === "delegate" || command.type === "resolve"
            ? command.correlationId
            : undefined;
      if (
        correlationId &&
        snapshot.tasks.some(
          (task) => task.correlationId === correlationId && task.projectId !== projectId,
        )
      )
        return refusal(
          "identity-conflict",
          "That task correlation belongs to a different project.",
        );
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
