import { planMcpToolAction } from "../actionGate/mcpToolPlan.ts";
// Authority digests must keep their persisted canonical JSON representation.
// @effect-diagnostics preferSchemaOverJson:off
import {
  ActionApprovalRecord,
  AuthOrchestrationOperateScope,
  contractGrantFields,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2Run,
  OrchestrationV2RunJson,
  type OrchestrationV2Subagent,
  OrchestrationV2SubagentJson,
  type OrchestrationV2ConversationMessage,
  OrchestrationV2ConversationMessageJson,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { Base3PolicyDeniedError } from "./Base3PolicyDeniedError.ts";
import { argumentHash, messageArguments } from "./grantArguments.ts";
import { loadTaskState, taskBlocksStart, validateMailboxTaskBudget } from "./TaskContract.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import { delegatedCompletionText } from "../orchestration-v2/NotificationMailbox.ts";

type Delegation = Extract<OrchestrationV2Command, { type: "delegated_task.request" }>;
type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
export interface ApprovedDelegation {
  readonly command: Delegation;
  readonly actorId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: string | null;
  readonly approvalId: string | null;
  readonly contractHash: string;
}
type DeliveryIdentity = Extract<
  import("./executionContext.ts").PolicyExecutionContext,
  { kind: "delegated-completion" }
>;
const refuse = (detail: string) =>
  new Base3PolicyDeniedError({
    commandType: "delegated-completion",
    reason: "delegation-authority",
    detail,
  });
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2SubagentJson));
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeApproval = Schema.decodeUnknownEffect(Schema.fromJsonString(ActionApprovalRecord));
const decodeScopes = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const contract = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const state = yield* loadTaskState(sql, threadId);
    const blocked = taskBlocksStart(state);
    if (blocked !== null) return yield* refuse(blocked);
    yield* validateMailboxTaskBudget(sql, state);
    return contractGrantFields(state.governance === "required" ? state.contract : null);
  });
const readGrant = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      actor_id: string;
      scopes_json: string;
      expires_at: string | null;
      revoked_at: string | null;
      argument_hash: string;
      approval_id: string | null;
      run_id: string | null;
      message_id: string;
      operation: string;
    }>`SELECT * FROM base3_execution_grants WHERE grant_id=${id}`;
    const row = rows[0];
    if (
      row === undefined ||
      row.revoked_at !== null ||
      (row.expires_at !== null && row.expires_at <= (yield* nowIso)) ||
      !(yield* decodeScopes(row.scopes_json)).includes(AuthOrchestrationOperateScope)
    )
      return yield* refuse("Missing, revoked or expired source authority.");
    return row;
  });
const putGrant = (
  sql: SqlClient.SqlClient,
  input: {
    id: string;
    threadId: string;
    messageId: string;
    runId: string;
    operation: string;
    actorId: string;
    scopesJson: string;
    expiresAt: string | null;
    hash: string;
    approvalId: string | null;
  },
) =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    yield* sql`INSERT INTO base3_execution_grants
  (grant_id,thread_id,message_id,run_id,operation,actor_id,scopes_json,expires_at,argument_hash,approval_id,revoked_at,created_at)
  VALUES (${input.id},${input.threadId},${input.messageId},${input.runId},${input.operation},${input.actorId},${input.scopesJson},${input.expiresAt},${input.hash},${input.approvalId},NULL,${now})`;
  });

const sourceArguments = (
  task: OrchestrationV2Subagent,
  child: OrchestrationV2AppThread,
  parent: OrchestrationV2Run,
  fields: ReturnType<typeof contractGrantFields>,
) => ({
  taskId: task.id,
  childThreadId: child.id,
  parentThreadId: task.threadId,
  parentRunId: task.runId,
  parentNodeId: task.parentNodeId,
  task: task.prompt,
  childTarget: child.modelSelection,
  parentTarget: parent.modelSelection,
  contract: fields,
});

/** Only the successful SQL command commit can mint authority for its actual child. */
export const commitApprovedDelegation = (
  sql: SqlClient.SqlClient,
  proof: ApprovedDelegation,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    const command = proof.command;
    if (
      context.kind !== "session" ||
      context.actorId !== proof.actorId ||
      !context.scopes.includes(AuthOrchestrationOperateScope)
    )
      return yield* refuse("Delegation principal changed before commit.");
    const fields = yield* contract(sql, command.parentThreadId);
    if (argumentHash(fields) !== proof.contractHash)
      return yield* refuse("Delegation contract changed before commit.");
    const taskEvent = events.find(
      (event) => event.type === "subagent.updated" && event.payload.runId === command.parentRunId,
    );
    if (taskEvent?.type !== "subagent.updated")
      return yield* refuse("Delegation has no committed child.");
    const task = taskEvent.payload;
    const childEvent = events.find(
      (event) => event.type === "thread.created" && event.payload.id === task.childThreadId,
    );
    const messageEvent = events.find(
      (event) => event.type === "message.updated" && event.threadId === task.childThreadId,
    );
    if (
      childEvent?.type !== "thread.created" ||
      messageEvent?.type !== "message.updated" ||
      task.threadId !== command.parentThreadId ||
      task.parentNodeId !== command.parentNodeId ||
      task.prompt !== command.task ||
      argumentHash(childEvent.payload.modelSelection) !== argumentHash(command.modelSelection)
    )
      return yield* refuse("Delegation child binding changed.");
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=${command.parentRunId} AND thread_id=${command.parentThreadId}`;
    if (!rows[0]) return yield* refuse("Delegation parent missing.");
    const parent = yield* decodeRun(rows[0].payload_json);
    const owner = yield* readGrant(sql, `grant:message:${parent.threadId}:${parent.userMessageId}`);
    if (owner.actor_id !== proof.actorId)
      return yield* refuse("Delegation does not own its parent.");
    if (proof.expiresAt !== null && proof.expiresAt <= (yield* nowIso))
      return yield* refuse("Delegation session expired before commit.");
    if (proof.approvalId === null)
      return yield* refuse("Delegation requires a persisted approval.");
    const approvals = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM action_gate_approvals WHERE approval_id=${proof.approvalId}`;
    if (!approvals[0]) return yield* refuse("Delegation approval missing.");
    const approval = yield* decodeApproval(approvals[0].payload_json);
    if (
      approval.status !== "consumed" ||
      approval.threadId !== parent.threadId ||
      approval.fingerprint !==
        planMcpToolAction({
          toolName: "delegate_task",
          args: { task: command.task, model: command.modelSelection, ...fields },
          environmentId: approval.environmentId,
          threadId: parent.threadId,
        }).action?.fingerprint
    )
      return yield* refuse("Delegation approval is not consumed for this parent.");
    const expiresAt =
      [proof.expiresAt, owner.expires_at]
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null;
    const child = childEvent.payload;
    const leases = yield* sql<{
      lease_id: string;
      environment_id: string;
    }>`SELECT lease_id,environment_id FROM base3_capacity_leases
      WHERE thread_id=${parent.threadId} AND message_id=${command.commandId}
        AND workload_class='child-agent' AND status='active' AND released_at IS NULL AND run_id IS NULL`;
    if (leases.length !== 1 || leases[0]!.environment_id !== approval.environmentId)
      return yield* refuse("Delegation has no exact admitted child slot.");
    yield* sql`INSERT INTO base3_delegated_child_authorities
      (task_id,child_thread_id,parent_thread_id,parent_run_id,source_command_id,source_lease_id)
      VALUES (${task.id},${child.id},${parent.threadId},${parent.id},${command.commandId},${leases[0]!.lease_id})`;
    yield* putGrant(sql, {
      id: `grant:delegated-task:${task.id}`,
      threadId: parent.threadId,
      messageId: task.id,
      runId: parent.id,
      operation: "delegation",
      actorId: proof.actorId,
      scopesJson: JSON.stringify(proof.scopes),
      expiresAt,
      hash: argumentHash(sourceArguments(task, child, parent, fields)),
      approvalId: proof.approvalId,
    });
    yield* putGrant(sql, {
      id: `grant:message:${child.id}:${messageEvent.payload.id}`,
      threadId: child.id,
      messageId: messageEvent.payload.id,
      runId: parent.id,
      operation: "delegated-child",
      actorId: proof.actorId,
      scopesJson: JSON.stringify(proof.scopes),
      expiresAt,
      hash: argumentHash({
        ...messageArguments({
          type: "message.dispatch",
          commandId: command.commandId,
          text: command.task,
          modelSelection: command.modelSelection,
          attachments: [],
        }),
        ...fields,
      }),
      approvalId: proof.approvalId,
    });
  });

const sourceAuthority = (
  sql: SqlClient.SqlClient,
  taskId: string,
  threadId: string,
  parent: OrchestrationV2Run,
  fields: ReturnType<typeof contractGrantFields>,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id=${taskId} AND thread_id=${threadId}`;
    if (!rows[0]) return yield* refuse("Delegated child missing.");
    const task = yield* decodeTask(rows[0].payload_json);
    const provenance = yield* sql`SELECT task_id FROM base3_delegated_child_authorities
      WHERE task_id=${task.id} AND child_thread_id=${task.childThreadId}
        AND parent_thread_id=${threadId} AND parent_run_id=${parent.id}`;
    if (provenance.length !== 1)
      return yield* refuse("Delegation has no exact approved child provenance.");
    if (task.origin !== "app_owned" || task.runId !== parent.id || task.childThreadId === null)
      return yield* refuse("Child belongs to another cohort.");
    const children = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${task.childThreadId}`;
    if (!children[0]) return yield* refuse("Delegated child thread missing.");
    const child = yield* decodeThread(children[0].payload_json);
    const grant = yield* readGrant(sql, `grant:delegated-task:${task.id}`);
    if (
      grant.operation !== "delegation" ||
      grant.run_id !== parent.id ||
      grant.message_id !== task.id ||
      grant.approval_id === null ||
      grant.argument_hash !== argumentHash(sourceArguments(task, child, parent, fields))
    )
      return yield* refuse("Delegation binding or contract changed.");
    const approvals = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM action_gate_approvals WHERE approval_id=${grant.approval_id}`;
    const approval =
      approvals[0] === undefined ? undefined : yield* decodeApproval(approvals[0].payload_json);
    if (
      approval === undefined ||
      approval.status !== "consumed" ||
      approval.threadId !== parent.threadId ||
      approval.fingerprint !==
        planMcpToolAction({
          toolName: "delegate_task",
          args: { task: task.prompt, model: child.modelSelection, ...fields },
          environmentId: approval.environmentId,
          threadId: parent.threadId,
        }).action?.fingerprint
    )
      return yield* refuse("Delegation approval is no longer valid.");
    return { task, grant, child };
  });

export const verifyDelegationReplay = (sql: SqlClient.SqlClient, command: Delegation) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind === "kernel-test") return;
    if (
      context.kind !== "session" ||
      !context.scopes.includes(AuthOrchestrationOperateScope) ||
      (context.expiresAt !== undefined && context.expiresAt <= (yield* nowIso))
    )
      return yield* refuse("Delegation replay requires its original authenticated owner.");
    const rows = yield* sql<{
      task_id: string;
    }>`SELECT task_id FROM base3_delegated_child_authorities WHERE source_command_id=${command.commandId} AND parent_thread_id=${command.parentThreadId} AND parent_run_id=${command.parentRunId}`;
    const parents = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=${command.parentRunId} AND thread_id=${command.parentThreadId}`;
    if (rows.length !== 1 || !parents[0])
      return yield* refuse("Delegation replay has no exact persisted source.");
    const parent = yield* decodeRun(parents[0].payload_json);
    const { task, grant } = yield* sourceAuthority(
      sql,
      rows[0]!.task_id,
      command.parentThreadId,
      parent,
      yield* contract(sql, command.parentThreadId),
    );
    const children = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${task.childThreadId}`;
    if (
      !children[0] ||
      grant.actor_id !== context.actorId ||
      task.parentNodeId !== command.parentNodeId ||
      task.prompt !== command.task ||
      argumentHash((yield* decodeThread(children[0].payload_json)).modelSelection) !==
        argumentHash(command.modelSelection)
    )
      return yield* refuse("Delegation replay principal or arguments changed.");
  });

export const validateMailboxAuthority = (sql: SqlClient.SqlClient, identity: DeliveryIdentity) =>
  Effect.gen(function* () {
    const threads = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${identity.threadId}`;
    if (!threads[0]) return yield* refuse("Parent thread missing.");
    const thread = yield* decodeThread(threads[0].payload_json);
    if (thread.archivedAt !== null || thread.deletedAt !== null)
      return yield* refuse("Parent thread is closed.");
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=${identity.parentRunId} AND thread_id=${identity.threadId}`;
    if (!rows[0]) return yield* refuse("Parent run missing.");
    const parent = yield* decodeRun(rows[0].payload_json);
    const cohort = parent.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      cohort?.disposition !== "open" ||
      !delivery ||
      delivery.generation !== identity.generation ||
      delivery.messageId !== identity.messageId ||
      delivery.taskIds.length === 0
    )
      return yield* refuse("Stale completion identity.");
    const fields = yield* contract(sql, identity.threadId);
    const owner = yield* readGrant(sql, `grant:message:${parent.threadId}:${parent.userMessageId}`);
    for (const taskId of delivery.taskIds) {
      const { task, grant } = yield* sourceAuthority(
        sql,
        taskId,
        identity.threadId,
        parent,
        fields,
      );
      if (
        grant.actor_id !== owner.actor_id ||
        !["completed", "failed", "cancelled", "interrupted"].includes(task.status)
      )
        return yield* refuse("Completion has no terminal approved child owned by this parent.");
    }
    return { parent, delivery, owner, fields };
  });

/** Validates the internal offer; callers cannot choose the text, target or task list. */
export const authorizeMailboxDispatch = (sql: SqlClient.SqlClient, command: Dispatch) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (
      context.kind !== "delegated-completion" ||
      command.threadId !== context.threadId ||
      command.messageId !== context.messageId ||
      command.delegatedCompletion?.parentRunId !== context.parentRunId ||
      command.delegatedCompletion.generation !== context.generation ||
      command.createdBy !== "agent" ||
      command.creationSource !== "server" ||
      command.dispatchMode.type !== "queue_after_active" ||
      command.attachments.length !== 0 ||
      command.context !== undefined ||
      command.notification !== undefined ||
      command.sourcePlanRef !== undefined ||
      command.scheduledTaskId !== undefined ||
      command.senderThreadId !== undefined ||
      command.routingMode !== undefined ||
      command.modelRouteConstraints !== undefined ||
      command.restartContinuationOfRunId !== undefined ||
      command.usageLimitContinuationOfRunId !== undefined ||
      command.manualContinuationOfRunId !== undefined ||
      command.usageLimitRecoveryRequestId !== undefined ||
      command.deliveryIntent !== undefined ||
      command.titleSeed !== undefined
    )
      return yield* refuse("Only an exact internal mailbox offer is authorized.");
    const authority = yield* validateMailboxAuthority(sql, context);
    const attempted =
      yield* sql`SELECT message_id FROM base3_delegated_mailbox_deliveries WHERE message_id=${context.messageId}`;
    if (attempted.length > 0)
      return yield* refuse(
        "Native acceptance is accepted or unknown; this offer cannot be dispatched again.",
      );
    if (
      argumentHash(command.delegatedCompletion.taskIds) !==
        argumentHash(authority.delivery.taskIds) ||
      command.text !== delegatedCompletionText(authority.delivery.taskIds) ||
      (command.modelSelection !== undefined &&
        argumentHash(command.modelSelection) !== argumentHash(authority.parent.modelSelection))
    )
      return yield* refuse("Completion arguments or target changed.");
    return { ...command, modelSelection: authority.parent.modelSelection };
  });

/** Receipt replay reads historical dispatch truth; it does not authorize another delivery. */
export const verifyMailboxReplay = (sql: SqlClient.SqlClient, command: Dispatch) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind === "kernel-test") return;
    if (
      context.kind !== "delegated-completion" ||
      context.threadId !== command.threadId ||
      context.messageId !== command.messageId ||
      context.parentRunId !== command.delegatedCompletion?.parentRunId ||
      context.generation !== command.delegatedCompletion.generation
    )
      return yield* refuse("Mailbox receipt belongs to another internal delivery.");
    const messages = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=${context.threadId} AND message_id=${context.messageId}`;
    const parents = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=${context.threadId} AND run_id=${context.parentRunId}`;
    if (!messages[0] || !parents[0]) return yield* refuse("Mailbox replay provenance missing.");
    const message = yield* decodeMessage(messages[0].payload_json);
    const parent = yield* decodeRun(parents[0].payload_json);
    const fields = yield* contract(sql, context.threadId);
    const grant = yield* readGrant(sql, `grant:message:${context.threadId}:${context.messageId}`);
    const owner = yield* readGrant(sql, `grant:message:${parent.threadId}:${parent.userMessageId}`);
    if (
      message.delegatedCompletion?.parentRunId !== context.parentRunId ||
      message.delegatedCompletion.generation !== context.generation ||
      grant.actor_id !== owner.actor_id ||
      grant.argument_hash !==
        argumentHash({ identity: context, parentTarget: parent.modelSelection, ...fields }) ||
      command.createdBy !== "agent" ||
      command.creationSource !== "server" ||
      command.dispatchMode.type !== "queue_after_active" ||
      command.text !== delegatedCompletionText(command.delegatedCompletion.taskIds) ||
      command.delegatedCompletion.taskIds.length === 0 ||
      command.delegatedCompletion.taskIds.some(
        (id) => !message.delegatedCompletion!.taskIds.includes(id),
      )
    )
      return yield* refuse("Mailbox replay arguments changed.");
    for (const taskId of message.delegatedCompletion.taskIds) {
      const { grant: source } = yield* sourceAuthority(
        sql,
        taskId,
        context.threadId,
        parent,
        fields,
      );
      if (source.actor_id !== owner.actor_id) return yield* refuse("Mailbox replay owner changed.");
    }
  });

/** Runs before event projection in the same SQL transaction as the receipt/outbox. */
export const commitMailboxAuthority = (
  sql: SqlClient.SqlClient,
  message: OrchestrationV2ConversationMessage,
) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (
      context.kind !== "delegated-completion" ||
      message.id !== context.messageId ||
      message.threadId !== context.threadId
    )
      return yield* refuse("Mailbox commit has no exact internal identity.");
    const { parent, delivery, owner, fields } = yield* validateMailboxAuthority(sql, context);
    if (
      message.delegatedCompletion?.parentRunId !== parent.id ||
      message.delegatedCompletion.generation !== delivery.generation ||
      argumentHash(message.delegatedCompletion.taskIds) !== argumentHash(delivery.taskIds) ||
      message.text !== delegatedCompletionText(delivery.taskIds)
    )
      return yield* refuse("Mailbox commit arguments changed.");
    const id = `grant:message:${context.threadId}:${context.messageId}`;
    const hash = argumentHash({
      identity: context,
      parentTarget: parent.modelSelection,
      ...fields,
    });
    const existing = yield* sql<{
      argument_hash: string;
      revoked_at: string | null;
    }>`SELECT argument_hash,revoked_at FROM base3_execution_grants WHERE grant_id=${id}`;
    if (existing[0]) {
      if (existing[0].argument_hash !== hash || existing[0].revoked_at !== null)
        return yield* refuse("Mailbox grant is immutable.");
      const attempts =
        yield* sql`SELECT message_id FROM base3_delegated_mailbox_deliveries WHERE message_id=${message.id}`;
      if (attempts.length > 0)
        return yield* refuse("Previous native delivery is accepted or uncertain; do not resend.");
      return;
    }
    yield* putGrant(sql, {
      id,
      threadId: context.threadId,
      messageId: context.messageId,
      runId: parent.id,
      operation: "delegated-completion",
      actorId: owner.actor_id,
      scopesJson: owner.scopes_json,
      expiresAt: owner.expires_at,
      hash,
      approvalId: null,
    });
  });

/** Re-derives authority at delivery, including source revocation and current contract. */
export const revalidateDelegatedMessage = (
  sql: SqlClient.SqlClient,
  threadId: string,
  messageId: string,
  execution?: {
    readonly runId: string;
    readonly target?: ModelSelection;
    readonly providerInstanceId?: string;
  },
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=${threadId} AND message_id=${messageId}`;
    if (!rows[0]) return;
    const message = yield* decodeMessage(rows[0].payload_json);
    if (!message.delegatedCompletion) {
      const rows = yield* sql<{
        operation: string;
        run_id: string | null;
      }>`SELECT operation,run_id FROM base3_execution_grants WHERE grant_id=${`grant:message:${threadId}:${messageId}`}`;
      if (rows[0]?.operation !== "delegated-child") return;
      const children = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
      const parents = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=${rows[0].run_id}`;
      if (!children[0] || !parents[0]) return yield* refuse("Delegated child provenance missing.");
      const child = yield* decodeThread(children[0].payload_json);
      const parent = yield* decodeRun(parents[0].payload_json);
      const tasks = yield* sql<{
        subagent_id: string;
      }>`SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE thread_id=${parent.threadId} AND json_extract(payload_json,'$.childThreadId')=${child.id}`;
      if (tasks.length !== 1) return yield* refuse("Delegated child has no exact owning task.");
      const fields = yield* contract(sql, parent.threadId);
      const {
        grant: source,
        task,
        child: approvedChild,
      } = yield* sourceAuthority(sql, tasks[0]!.subagent_id, parent.threadId, parent, fields);
      const owner = yield* readGrant(
        sql,
        `grant:message:${parent.threadId}:${parent.userMessageId}`,
      );
      const grant = yield* readGrant(sql, `grant:message:${threadId}:${messageId}`);
      if (
        grant.actor_id !== source.actor_id ||
        grant.actor_id !== owner.actor_id ||
        message.text !== task.prompt ||
        message.attachments.length !== 0 ||
        message.context !== undefined ||
        grant.argument_hash !==
          argumentHash({
            ...messageArguments({
              type: "message.dispatch",
              commandId: "child",
              text: task.prompt,
              modelSelection: approvedChild.modelSelection,
              attachments: [],
            }),
            ...fields,
          })
      )
        return yield* refuse("Delegated child authority changed.");
      if (execution !== undefined)
        yield* verifyStartTarget(sql, message, approvedChild.modelSelection, execution);
      return;
    }
    const identity = {
      kind: "delegated-completion" as const,
      threadId,
      parentRunId: message.delegatedCompletion.parentRunId,
      generation: message.delegatedCompletion.generation,
      messageId,
    };
    const { parent, fields, owner, delivery } = yield* validateMailboxAuthority(sql, identity);
    const grant = yield* readGrant(sql, `grant:message:${threadId}:${messageId}`);
    if (
      grant.operation !== "delegated-completion" ||
      grant.run_id !== parent.id ||
      grant.actor_id !== owner.actor_id ||
      grant.argument_hash !==
        argumentHash({ identity, parentTarget: parent.modelSelection, ...fields }) ||
      message.text !== delegatedCompletionText(delivery.taskIds) ||
      argumentHash(message.delegatedCompletion.taskIds) !== argumentHash(delivery.taskIds)
    )
      return yield* refuse("Mailbox delivery grant changed.");
    if (execution !== undefined)
      yield* verifyStartTarget(sql, message, parent.modelSelection, execution);
    return { identity, parent, owner };
  });

const verifyStartTarget = (
  sql: SqlClient.SqlClient,
  message: OrchestrationV2ConversationMessage,
  target: ModelSelection,
  delivery: {
    readonly runId: string;
    readonly target?: ModelSelection;
    readonly providerInstanceId?: string;
  },
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=${message.threadId} AND run_id=${delivery.runId}`;
    if (!rows[0]) return yield* refuse("Delegated start target is missing.");
    const run = yield* decodeRun(rows[0].payload_json);
    if (
      run.userMessageId !== message.id ||
      argumentHash(run.modelSelection) !== argumentHash(target) ||
      (delivery.target !== undefined && argumentHash(delivery.target) !== argumentHash(target)) ||
      (delivery.providerInstanceId !== undefined &&
        delivery.providerInstanceId !== target.instanceId)
    )
      return yield* refuse("Delegated requested and executed targets differ.");
  });

export const claimMailboxSteer = (
  sql: SqlClient.SqlClient,
  input: {
    threadId: string;
    messageId: string;
    runId: string;
    attemptId: string;
    sessionId: string;
    turnId: string;
  },
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const authority = yield* revalidateDelegatedMessage(sql, input.threadId, input.messageId);
      if (!authority) return;
      if (
        authority.parent.id !== input.runId ||
        authority.parent.activeAttemptId !== input.attemptId ||
        authority.parent.status !== "running"
      )
        return yield* refuse("Mailbox native target changed.");
      const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
      const environmentId = Option.isSome(environment)
        ? yield* environment.value.getEnvironmentId
        : "local";
      const current = yield* sql`SELECT lease.lease_id FROM base3_capacity_leases AS lease
        JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.run_id=lease.run_id AND attempt.thread_id=lease.thread_id
        JOIN orchestration_v2_projection_provider_turns AS turn ON turn.run_attempt_id=attempt.attempt_id AND turn.thread_id=attempt.thread_id
        JOIN orchestration_v2_projection_provider_threads AS provider ON provider.provider_thread_id=turn.provider_thread_id
        WHERE lease.thread_id=${input.threadId} AND lease.run_id=${input.runId}
          AND lease.environment_id=${environmentId} AND lease.workload_class='foreground-turn' AND lease.status='active' AND lease.released_at IS NULL
          AND lease.interrupt_requested=0 AND lease.disconnect_unconfirmed=0
          AND attempt.attempt_id=${input.attemptId} AND attempt.status='running'
          AND turn.provider_turn_id=${input.turnId} AND turn.status='running'
          AND json_extract(provider.payload_json,'$.providerSessionId')=${input.sessionId}`;
      if (current.length !== 1) return yield* refuse("Mailbox native lease or session changed.");
      const rows =
        yield* sql`INSERT INTO base3_delegated_mailbox_deliveries (message_id,thread_id,parent_run_id,generation,attempt_id,session_id,turn_id,status)
    VALUES (${input.messageId},${input.threadId},${input.runId},${authority.identity.generation},${input.attemptId},${input.sessionId},${input.turnId},'unknown') ON CONFLICT DO NOTHING RETURNING message_id`;
      if (rows.length !== 1)
        return yield* refuse("Native mailbox delivery is accepted or unknown; no blind retry.");
    }),
  );

export const acceptMailboxSteer = (sql: SqlClient.SqlClient, messageId: string) =>
  sql`UPDATE base3_delegated_mailbox_deliveries SET status='accepted' WHERE message_id=${messageId} AND status='unknown'`;

export const mailboxSteerAlreadyAccepted = (
  sql: SqlClient.SqlClient,
  input: { threadId: string; messageId: string; sessionId: string; turnId: string },
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      status: string;
      session_id: string;
      turn_id: string;
      thread_id: string;
    }>`SELECT status,session_id,turn_id,thread_id FROM base3_delegated_mailbox_deliveries WHERE message_id=${input.messageId}`;
    const row = rows[0];
    if (row === undefined) return false;
    if (
      row.thread_id !== input.threadId ||
      row.session_id !== input.sessionId ||
      row.turn_id !== input.turnId ||
      row.status !== "accepted"
    )
      return yield* refuse(
        "Native mailbox acceptance is unknown or belongs to a different target. No resend is authorized.",
      );
    return true;
  });
