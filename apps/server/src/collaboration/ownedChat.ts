import {
  AuthOrchestrationOperateScope,
  CommandId,
  CollaborationCommand,
  IsoDateTime,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RawEventId,
  TaskEnrollmentOutcome,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { PolicyExecutionContext } from "../policy/executionContext.ts";

const Origin = Schema.Struct({
  kind: Schema.Literal("owned-chat-origin.v1"),
  source: Schema.Literal("server"),
  ownerId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  createdAt: IsoDateTime,
  creationCommandId: CommandId,
});
type Origin = typeof Origin.Type;
const Outcome = Schema.Struct({
  kind: Schema.Literal("task-enrollment-result.v1"),
  source: Schema.Literal("server"),
  actorId: TrimmedNonEmptyString,
  threadId: ThreadId,
  commandId: CommandId,
  taskEnrollment: TaskEnrollmentOutcome,
});
const privateKind = Schema.Struct({
  kind: Schema.Literals(["owned-chat-origin.v1", "task-enrollment-result.v1"]),
});
const decodePrivateKind = Schema.decodeUnknownOption(Schema.fromJsonString(privateKind));
const decodeOrigin = Schema.decodeUnknownOption(Schema.fromJsonString(Origin));
const encodeOrigin = Schema.encodeEffect(Schema.fromJsonString(Origin));
const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(Outcome));
const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(Outcome));
const decodeThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(CollaborationCommand));
const decodeMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      runId: Schema.optionalKey(OrchestrationV2Run.fields.id),
      nodeId: Schema.optionalKey(OrchestrationV2ExecutionNode.fields.id),
      driver: Schema.optionalKey(OrchestrationV2ProviderThread.fields.driver),
      providerInstanceId: Schema.optionalKey(ProviderInstanceId),
      rawEventId: Schema.optionalKey(RawEventId),
    }),
  ),
);
const originId = (threadId: string) => `thread:origin:${threadId}`;
const outcomeId = (commandId: string) => `task:enrollment-result:${commandId}`;
const isRoot = (thread: OrchestrationV2AppThreadJson) =>
  thread.creationSource !== "provider" &&
  thread.lineage.parentThreadId === null &&
  thread.lineage.relationshipToParent === null &&
  thread.lineage.rootThreadId === thread.id &&
  thread.forkedFrom === null;
const active = (thread: OrchestrationV2AppThreadJson) =>
  thread.archivedAt === null && thread.deletedAt === null;

export class OwnedChatPersistenceError extends Schema.TaggedError<OwnedChatPersistenceError>()(
  "OwnedChatPersistenceError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "Owned chat provenance or enrollment outcome is inconsistent.";
  }
}

/** Private proof/outcome records do not participate in the public collaboration fold. */
export const isPrivateRecord = (row: {
  readonly command_id: string;
  readonly payload_json: string;
}) =>
  decodePrivateKind(row.payload_json)._tag === "Some" ||
  ((row.command_id.startsWith("thread:origin:") ||
    row.command_id.startsWith("task:enrollment-result:")) &&
    decodeCommand(row.payload_json)._tag === "None");

const insertRecord = Effect.fn("ownedChat.insertRecord")(function* (
  sql: SqlClient.SqlClient,
  id: string,
  payload: string,
) {
  const next = yield* sql<{
    next: number;
  }>`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM collaboration_commands`;
  yield* sql`INSERT INTO collaboration_commands(command_id,sequence,payload_json,created_at) VALUES (${id},${Number(next[0]?.next ?? 1)},${payload},${DateTime.formatIso(yield* DateTime.now)})`;
});
const rootRow = Effect.fn("ownedChat.rootRow")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const rows = yield* sql<{
    thread_id: string;
    project_id: string;
    provider_instance_id: string;
    created_at: string;
    archived_at: string | null;
    deleted_at: string | null;
    payload_json: string;
    project_deleted_at: string | null;
  }>`SELECT t.thread_id,t.project_id,t.provider_instance_id,t.created_at,t.archived_at,t.deleted_at,t.payload_json,p.deleted_at AS project_deleted_at FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=${threadId}`;
  const row = rows[0];
  const decoded = row === undefined ? undefined : decodeThread(row.payload_json);
  if (!row || decoded?._tag !== "Some") return undefined;
  const thread = decoded.value;
  if (
    thread.id !== row.thread_id ||
    thread.projectId !== row.project_id ||
    thread.providerInstanceId !== row.provider_instance_id ||
    thread.modelSelection.instanceId !== row.provider_instance_id ||
    DateTime.formatIso(thread.createdAt) !== row.created_at
  )
    return undefined;
  return { row, thread };
});
const originRows = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{
    command_id: string;
    payload_json: string;
  }>`SELECT command_id,payload_json FROM collaboration_commands WHERE command_id=${originId(threadId)} OR (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.kind')='owned-chat-origin.v1' AND json_extract(payload_json,'$.threadId')=${threadId} ELSE 0 END)`;

const receiptMatches = Effect.fn("ownedChat.receiptMatches")(function* (
  sql: SqlClient.SqlClient,
  commandId: string,
  threadId: string,
  type: string,
  sequence: number,
) {
  const rows = yield* sql<{
    aggregate_kind: string;
    aggregate_id: string;
    command_type: string;
    status: string;
    result_sequence: number;
  }>`SELECT aggregate_kind,aggregate_id,command_type,status,result_sequence FROM orchestration_command_receipts WHERE command_id=${commandId}`;
  const receipt = rows[0];
  return (
    receipt !== undefined &&
    receipt.aggregate_kind === "thread" &&
    receipt.aggregate_id === threadId &&
    receipt.command_type === type &&
    receipt.status === "accepted" &&
    Number(receipt.result_sequence) >= sequence
  );
});
const selectionMatches = Effect.fn("ownedChat.selectionMatches")(function* (
  sql: SqlClient.SqlClient,
  thread: OrchestrationV2AppThreadJson,
) {
  const rows = yield* sql<{
    payload_json: string;
    metadata_json: string;
  }>`SELECT payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND application_event_version=2 AND stream_id=${thread.id} AND event_type IN ('thread.created','thread.provider-switched','thread.model-selection-updated') ORDER BY sequence DESC LIMIT 1`;
  const row = rows[0];
  const payload = row === undefined ? undefined : decodeThread(row.payload_json);
  const metadata = row === undefined ? undefined : decodeMetadata(row.metadata_json);
  return (
    payload?._tag === "Some" &&
    metadata?._tag === "Some" &&
    isRoot(payload.value) &&
    payload.value.id === thread.id &&
    payload.value.projectId === thread.projectId &&
    DateTime.toEpochMillis(payload.value.createdAt) === DateTime.toEpochMillis(thread.createdAt) &&
    payload.value.providerInstanceId === thread.providerInstanceId &&
    payload.value.modelSelection.instanceId === thread.providerInstanceId &&
    (metadata.value.providerInstanceId === undefined ||
      metadata.value.providerInstanceId === thread.providerInstanceId)
  );
});
const validOrigin = Effect.fn("ownedChat.validOrigin")(function* (
  sql: SqlClient.SqlClient,
  origin: Origin,
  thread: OrchestrationV2AppThreadJson,
) {
  if (
    origin.threadId !== thread.id ||
    origin.projectId !== thread.projectId ||
    origin.createdAt !== DateTime.formatIso(thread.createdAt)
  )
    return false;
  const rows = yield* sql<{
    sequence: number;
    payload_json: string;
    metadata_json: string;
  }>`SELECT sequence,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND application_event_version=2 AND stream_id=${thread.id} AND command_id=${origin.creationCommandId} AND event_type='thread.created'`;
  const row = rows[0];
  const birth = row === undefined ? undefined : decodeThread(row.payload_json);
  const metadata = row === undefined ? undefined : decodeMetadata(row.metadata_json);
  return (
    rows.length === 1 &&
    row !== undefined &&
    birth?._tag === "Some" &&
    metadata?._tag === "Some" &&
    isRoot(birth.value) &&
    active(birth.value) &&
    birth.value.taskGovernance !== "required" &&
    birth.value.taskContract == null &&
    birth.value.id === origin.threadId &&
    birth.value.projectId === origin.projectId &&
    DateTime.formatIso(birth.value.createdAt) === origin.createdAt &&
    birth.value.providerInstanceId === origin.providerInstanceId &&
    birth.value.modelSelection.instanceId === origin.providerInstanceId &&
    (metadata.value.providerInstanceId === undefined ||
      metadata.value.providerInstanceId === origin.providerInstanceId) &&
    (yield* receiptMatches(
      sql,
      origin.creationCommandId,
      origin.threadId,
      "thread.create",
      Number(row.sequence),
    )) &&
    (yield* selectionMatches(sql, thread))
  );
});

export const captureOrigin = Effect.fn("ownedChat.captureOrigin")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly creationCommandId: string;
    readonly actorId: string;
  },
) {
  const context = yield* PolicyExecutionContext;
  const root = yield* rootRow(sql, input.threadId);
  if (
    context.kind !== "session" ||
    context.actorId !== input.actorId ||
    !context.scopes.includes(AuthOrchestrationOperateScope) ||
    !input.actorId.trim() ||
    !root ||
    !isRoot(root.thread) ||
    !active(root.thread) ||
    root.row.project_deleted_at !== null ||
    root.thread.taskGovernance === "required" ||
    root.thread.taskContract != null ||
    (yield* originRows(sql, input.threadId)).length > 0
  )
    return yield* new OwnedChatPersistenceError({ threadId: input.threadId });
  yield* insertRecord(
    sql,
    originId(input.threadId),
    yield* encodeOrigin({
      kind: "owned-chat-origin.v1",
      source: "server",
      ownerId: input.actorId,
      threadId: root.thread.id,
      projectId: root.thread.projectId,
      providerInstanceId: root.thread.providerInstanceId,
      createdAt: DateTime.formatIso(root.thread.createdAt),
      creationCommandId: CommandId.make(input.creationCommandId),
    }),
  );
});

export const upgradeEligibility = Effect.fn("ownedChat.upgradeEligibility")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly actorId: string },
) {
  const no = (reason: Extract<TaskEnrollmentOutcome, { status: "not-enrolled" }>["reason"]) => ({
    status: "not-enrolled" as const,
    reason,
  });
  const root = yield* rootRow(sql, input.threadId);
  if (
    !root ||
    !active(root.thread) ||
    root.row.archived_at !== null ||
    root.row.deleted_at !== null ||
    root.row.project_deleted_at !== null
  )
    return { outcome: no("inactive-root") };
  if (!isRoot(root.thread)) return { outcome: no("not-root") };
  const existing = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM collaboration_commands WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.type')='task.enroll' AND json_extract(payload_json,'$.threadId')=${input.threadId} ELSE 0 END`;
  if (existing.length > 0) {
    const enrollment = existing.length === 1 ? decodeCommand(existing[0]!.payload_json) : undefined;
    return {
      outcome:
        enrollment?._tag === "Some" &&
        enrollment.value.admissionSource === "server" &&
        enrollment.value.admittedBy === input.actorId &&
        enrollment.value.projectId === root.thread.projectId &&
        root.thread.taskGovernance === "required" &&
        ((enrollment.value.upgradeEventId === undefined &&
          enrollment.value.originCommandId === undefined &&
          enrollment.value.upgradeCommandId === undefined) ||
          (yield* verifyUpgrade(sql, enrollment.value, root.thread)))
          ? {
              status: "already-enrolled" as const,
              taskId: `task:governed:thread:${input.threadId}`,
            }
          : no("ownership-mismatch"),
    };
  }
  const rows = yield* originRows(sql, input.threadId);
  if (rows.length === 0) return { outcome: no("origin-unavailable") };
  const decoded = rows.length === 1 ? decodeOrigin(rows[0]!.payload_json) : undefined;
  if (
    decoded?._tag !== "Some" ||
    rows[0]!.command_id !== originId(input.threadId) ||
    !(yield* validOrigin(sql, decoded.value, root.thread))
  )
    return { outcome: no("origin-invalid") };
  if (decoded.value.ownerId !== input.actorId) return { outcome: no("ownership-mismatch") };
  // Agents' canonical conversation already has its own card. Do not add another identity.
  const bound =
    yield* sql`SELECT command_id FROM collaboration_commands WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.type')='thread.bind' AND json_extract(payload_json,'$.threadId')=${input.threadId} ELSE 0 END LIMIT 1`;
  if (bound.length > 0) return { outcome: no("existing-conversation-link") };
  return { origin: decoded.value };
});

export const recordOutcome = Effect.fn("ownedChat.recordOutcome")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly commandId: string;
    readonly threadId: string;
    readonly actorId: string;
    readonly taskEnrollment: TaskEnrollmentOutcome;
  },
) {
  yield* insertRecord(
    sql,
    outcomeId(input.commandId),
    yield* encodeOutcome({
      kind: "task-enrollment-result.v1",
      source: "server",
      actorId: input.actorId,
      threadId: ThreadId.make(input.threadId),
      commandId: CommandId.make(input.commandId),
      taskEnrollment: input.taskEnrollment,
    }),
  );
});
export const readOutcome = Effect.fn("ownedChat.readOutcome")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly commandId: string; readonly threadId: string; readonly actorId: string },
) {
  const rows = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM collaboration_commands WHERE command_id=${outcomeId(input.commandId)}`;
  if (!rows[0]) {
    if (yield* hasOrigin(sql, input.threadId))
      return yield* new OwnedChatPersistenceError({ threadId: input.threadId });
    return undefined;
  }
  const outcome = decodeOutcome(rows[0].payload_json);
  if (
    outcome._tag !== "Some" ||
    outcome.value.commandId !== input.commandId ||
    outcome.value.threadId !== input.threadId ||
    outcome.value.actorId !== input.actorId ||
    (outcome.value.taskEnrollment.status !== "not-enrolled" &&
      outcome.value.taskEnrollment.taskId !== `task:governed:thread:${input.threadId}`)
  )
    return yield* new OwnedChatPersistenceError({ threadId: input.threadId });
  return outcome.value.taskEnrollment;
});
export const verifyOriginReplay = Effect.fn("ownedChat.verifyOriginReplay")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly commandId: string; readonly actorId: string },
) {
  const rows = yield* originRows(sql, input.threadId);
  if (!rows.length) return;
  const origin = rows.length === 1 ? decodeOrigin(rows[0]!.payload_json) : undefined;
  if (
    origin?._tag !== "Some" ||
    rows[0]!.command_id !== originId(input.threadId) ||
    origin.value.creationCommandId !== input.commandId ||
    origin.value.ownerId !== input.actorId
  )
    return yield* new OwnedChatPersistenceError({ threadId: input.threadId });
});
export const hasOrigin = Effect.fn("ownedChat.hasOrigin")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  return (yield* originRows(sql, threadId)).length > 0;
});

export const verifyUpgrade = Effect.fn("ownedChat.verifyUpgrade")(function* (
  sql: SqlClient.SqlClient,
  enrollment: CollaborationCommand,
  thread: OrchestrationV2AppThreadJson,
) {
  if (
    !enrollment.originCommandId ||
    !enrollment.upgradeCommandId ||
    !enrollment.upgradeEventId ||
    enrollment.admissionSource !== "server" ||
    !enrollment.admittedBy
  )
    return false;
  const origins = yield* originRows(sql, thread.id);
  const origin = origins.length === 1 ? decodeOrigin(origins[0]!.payload_json) : undefined;
  if (
    origin?._tag !== "Some" ||
    origins[0]!.command_id !== originId(thread.id) ||
    origin.value.ownerId !== enrollment.admittedBy ||
    origin.value.creationCommandId !== enrollment.originCommandId ||
    !(yield* validOrigin(sql, origin.value, thread))
  )
    return false;
  const rows = yield* sql<{
    sequence: number;
    payload_json: string;
    metadata_json: string;
  }>`SELECT sequence,payload_json,metadata_json FROM orchestration_events WHERE event_id=${enrollment.upgradeEventId} AND aggregate_kind='thread' AND application_event_version=2 AND stream_id=${thread.id} AND command_id=${enrollment.upgradeCommandId} AND event_type='thread.metadata-updated'`;
  const row = rows[0];
  const payload = row === undefined ? undefined : decodeThread(row.payload_json);
  const metadata = row === undefined ? undefined : decodeMetadata(row.metadata_json);
  if (
    !row ||
    payload?._tag !== "Some" ||
    metadata?._tag !== "Some" ||
    !isRoot(payload.value) ||
    !active(payload.value) ||
    payload.value.id !== thread.id ||
    payload.value.projectId !== thread.projectId ||
    DateTime.toEpochMillis(payload.value.createdAt) !== DateTime.toEpochMillis(thread.createdAt) ||
    payload.value.taskGovernance !== "required" ||
    payload.value.taskContract == null ||
    payload.value.providerInstanceId !== enrollment.agentId ||
    payload.value.modelSelection.instanceId !== payload.value.providerInstanceId ||
    (metadata.value.providerInstanceId !== undefined &&
      metadata.value.providerInstanceId !== payload.value.providerInstanceId)
  )
    return false;
  const decision = payload.value.taskDecisions?.at(-1);
  return (
    decision?.kind === "set" &&
    decision.actorId === origin.value.ownerId &&
    decision.revision === payload.value.taskContract.revision &&
    (yield* receiptMatches(
      sql,
      enrollment.upgradeCommandId,
      thread.id,
      "thread.task-contract.set",
      Number(row.sequence),
    ))
  );
});

/** Final persisted proof check stays inside the same transaction as the accepted receipt. */
export const verifyCommittedUpgrade = Effect.fn("ownedChat.verifyCommittedUpgrade")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly commandId: string; readonly threadId: string; readonly actorId: string },
) {
  const root = yield* rootRow(sql, input.threadId);
  const rows = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM collaboration_commands WHERE command_id=${`task:enroll:${input.commandId}`}`;
  const enrollment = rows[0] === undefined ? undefined : decodeCommand(rows[0].payload_json);
  if (
    !root ||
    !active(root.thread) ||
    root.row.archived_at !== null ||
    root.row.deleted_at !== null ||
    root.row.project_deleted_at !== null ||
    enrollment?._tag !== "Some" ||
    enrollment.value.type !== "task.enroll" ||
    enrollment.value.threadId !== input.threadId ||
    enrollment.value.projectId !== root.thread.projectId ||
    enrollment.value.admittedBy !== input.actorId ||
    enrollment.value.upgradeCommandId !== input.commandId ||
    !(yield* verifyUpgrade(sql, enrollment.value, root.thread))
  )
    return yield* new OwnedChatPersistenceError({ threadId: input.threadId });
});
