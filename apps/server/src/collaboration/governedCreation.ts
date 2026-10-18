import { planTaskCapabilities } from "@t3tools/shared/taskCapabilityPlan";
import {
  AgentsTaskCreationReview,
  TaskCapabilityPlan,
  OrchestrationV2Command,
  AuthOrchestrationOperateScope,
  OrchestrationV2AppThreadJson,
  TaskContractFields,
  ModelSelection,
  isProviderAvailable,
  isProviderTaskExecutionCapable,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import { readTaskReview } from "./store.ts";

type Create = Extract<OrchestrationV2Command, { type: "thread.create" }>;
const isContract = Schema.is(TaskContractFields);
const isReview = Schema.is(AgentsTaskCreationReview);
const sameReview = Schema.toEquivalence(AgentsTaskCreationReview);
const sameSelection = Schema.toEquivalence(ModelSelection);
const sameContract = Schema.toEquivalence(TaskContractFields);
const decodeThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
export const reviewedCreateMatchesThread = (command: Create, thread: OrchestrationV2AppThread) =>
  command.taskCreationReview !== undefined &&
  command.taskContract !== undefined &&
  thread.agentsTaskCreation !== undefined &&
  sameReview(thread.agentsTaskCreation.review, command.taskCreationReview) &&
  thread.agentsTaskCreation.title === command.title &&
  sameContract(thread.agentsTaskCreation.taskContract, command.taskContract) &&
  thread.id === command.threadId &&
  thread.projectId === command.projectId &&
  thread.title === command.title &&
  thread.createdBy === command.createdBy &&
  thread.creationSource === command.creationSource &&
  thread.runtimeMode === command.runtimeMode &&
  thread.interactionMode === command.interactionMode &&
  thread.branch === command.branch &&
  thread.worktreePath === command.worktreePath &&
  command.importedNativeThread === undefined &&
  thread.taskGovernance === command.taskGovernance &&
  thread.taskContract !== null &&
  thread.taskContract !== undefined &&
  thread.taskContract.revision === 1 &&
  thread.taskContractPhase === "active" &&
  thread.taskAcceptedRevision === null &&
  thread.archivedAt === null &&
  thread.deletedAt === null &&
  thread.activeProviderThreadId === null &&
  sameContract(thread.taskContract, command.taskContract) &&
  sameSelection(thread.modelSelection, command.modelSelection) &&
  thread.providerInstanceId === command.modelSelection.instanceId &&
  thread.lineage.rootThreadId === command.threadId &&
  thread.lineage.parentThreadId === null &&
  thread.lineage.relationshipToParent === null &&
  thread.forkedFrom === null;
export class AgentsTaskCreationDenied extends Schema.TaggedError<AgentsTaskCreationDenied>()(
  "AgentsTaskCreationDenied",
  { reason: Schema.String },
) {}
const principal = Effect.gen(function* () {
  const context = yield* PolicyExecutionContext;
  const now = yield* DateTime.now;
  if (
    context.kind !== "session" ||
    !context.actorId.trim() ||
    !context.sessionId.trim() ||
    !context.scopes.includes(AuthOrchestrationOperateScope) ||
    (context.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(context.expiresAt)) ||
        Date.parse(context.expiresAt) <= DateTime.toEpochMillis(now)))
  )
    return yield* new AgentsTaskCreationDenied({
      reason: "Authenticated operate authority is required.",
    });
  return context.actorId;
});

export const validateReviewedCreate = Effect.fn("governedCreation.validateReviewedCreate")(
  function* (sql: SqlClient.SqlClient, command: Create) {
    const review = command.taskCreationReview;
    if (review === undefined) return;
    const actorId = yield* principal;
    const refuse = () =>
      new AgentsTaskCreationDenied({
        reason:
          "Refresh the environment, project and ready provider/model before creating this task.",
      });
    if (
      !isReview(review) ||
      !isContract(command.taskContract) ||
      command.taskGovernance !== "required" ||
      command.createdBy !== "user" ||
      command.creationSource !== "web" ||
      !command.title.trim() ||
      command.runtimeMode !== "approval-required" ||
      command.interactionMode !== "default" ||
      command.branch !== null ||
      command.worktreePath !== null ||
      command.importedNativeThread !== undefined ||
      command.projectId !== review.projectId ||
      !sameSelection(command.modelSelection, review.modelSelection) ||
      command.modelSelection.options !== undefined ||
      !Number.isSafeInteger(command.taskContract.brake.maxProviderStarts) ||
      (command.taskContract.brake.maxTokens !== undefined &&
        !Number.isSafeInteger(command.taskContract.brake.maxTokens)) ||
      (command.taskContract.brake.maxCostUsd !== undefined &&
        !Number.isFinite(command.taskContract.brake.maxCostUsd)) ||
      (command.taskContract.brake.deadlineAt !== undefined &&
        (!Number.isFinite(Date.parse(command.taskContract.brake.deadlineAt)) ||
          !command.taskContract.brake.deadlineAt.endsWith("Z")))
    )
      return yield* refuse();
    const environment = yield* Effect.serviceOption(ServerEnvironment);
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    if (Option.isNone(environment) || Option.isNone(registry)) return yield* refuse();
    if ((yield* environment.value.getEnvironmentId) !== review.environmentId)
      return yield* refuse();
    const provider = (yield* registry.value.getProviders).find(
      (item) => item.instanceId === review.modelSelection.instanceId,
    );
    if (
      !provider ||
      provider.instanceId === "grokbot" ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated" ||
      !isProviderAvailable(provider) ||
      !isProviderTaskExecutionCapable(provider) ||
      !provider.models.some((model) => model.slug === review.modelSelection.model) ||
      (provider.supportedRuntimeModes !== undefined &&
        !provider.supportedRuntimeModes.includes(command.runtimeMode))
    )
      return yield* refuse();
    const projects =
      yield* sql`SELECT project_id,workspace_root FROM projection_projects WHERE project_id=${command.projectId} AND deleted_at IS NULL`;
    if (projects.length !== 1) return yield* refuse();
    if (review.capabilityPlan !== undefined) {
      const expected = planTaskCapabilities({
        environmentId: review.environmentId,
        projectId: command.projectId,
        workspace:
          review.capabilityPlan.workspace === null ? null : String(projects[0]!.workspace_root),
        modelSelection: command.modelSelection,
        contract: command.taskContract,
        provider,
      });
      if (!Schema.toEquivalence(TaskCapabilityPlan)(expected, review.capabilityPlan))
        return yield* refuse();
    }
    return {
      commandId: command.commandId,
      actorId,
      review,
      title: command.title,
      taskContract: command.taskContract,
    };
  },
);

export const verifyReviewedCreateReplay = Effect.fn("governedCreation.verifyReviewedCreateReplay")(
  function* (sql: SqlClient.SqlClient, command: Create) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_events WHERE command_id=${command.commandId} AND stream_id=${command.threadId} AND aggregate_kind='thread' AND application_event_version=2 AND event_type='thread.created'`;
    const decoded = rows.length === 1 ? decodeThread(rows[0]!.payload_json) : Option.none();
    const original = Option.isSome(decoded) ? decoded.value : undefined;
    const proof = original?.agentsTaskCreation;
    if (proof === undefined && command.taskCreationReview === undefined) return;
    const actorId = yield* principal;
    const environment = yield* Effect.serviceOption(ServerEnvironment);
    const refuse = () =>
      new AgentsTaskCreationDenied({
        reason: "The original reviewed task creation does not match this identity or intent.",
      });
    if (
      !original ||
      !proof ||
      !command.taskCreationReview ||
      !command.taskContract ||
      !reviewedCreateMatchesThread(command, original) ||
      Option.isNone(environment) ||
      (yield* environment.value.getEnvironmentId) !== proof.review.environmentId ||
      proof.actorId !== actorId ||
      proof.commandId !== command.commandId ||
      !sameReview(proof.review, command.taskCreationReview) ||
      original.id !== command.threadId ||
      original.projectId !== command.projectId ||
      original.title !== command.title ||
      original.createdBy !== command.createdBy ||
      original.creationSource !== command.creationSource ||
      original.runtimeMode !== command.runtimeMode ||
      original.interactionMode !== command.interactionMode ||
      original.branch !== command.branch ||
      original.worktreePath !== command.worktreePath ||
      command.importedNativeThread !== undefined ||
      original.taskGovernance !== command.taskGovernance ||
      !original.taskContract ||
      original.taskContract.revision !== 1 ||
      !sameContract(original.taskContract, command.taskContract) ||
      !sameSelection(original.modelSelection, command.modelSelection)
    )
      return yield* refuse();
    const current = yield* sql<{
      payload_json: string;
      thread_id: string;
      project_id: string;
      provider_instance_id: string;
    }>`SELECT t.thread_id,t.project_id,t.provider_instance_id,t.payload_json FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=${command.threadId} AND t.project_id=${command.projectId} AND t.archived_at IS NULL AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
    const root = current.length === 1 ? decodeThread(current[0]!.payload_json) : Option.none();
    const owners =
      yield* sql`SELECT command_id FROM collaboration_commands WHERE command_id=${`task:enroll:${command.commandId}`} AND json_extract(payload_json,'$.type')='task.enroll' AND json_extract(payload_json,'$.admittedBy')=${actorId} AND json_extract(payload_json,'$.projectId')=${command.projectId} AND json_extract(payload_json,'$.threadId')=${command.threadId}`;
    if (
      Option.isNone(root) ||
      root.value.id !== current[0]!.thread_id ||
      root.value.projectId !== current[0]!.project_id ||
      root.value.providerInstanceId !== current[0]!.provider_instance_id ||
      root.value.modelSelection.instanceId !== current[0]!.provider_instance_id ||
      root.value.forkedFrom !== null ||
      root.value.archivedAt !== null ||
      root.value.deletedAt !== null ||
      root.value.taskGovernance !== "required" ||
      root.value.lineage.rootThreadId !== command.threadId ||
      root.value.lineage.parentThreadId !== null ||
      root.value.lineage.relationshipToParent !== null ||
      root.value.providerInstanceId !== original.providerInstanceId ||
      owners.length !== 1
    )
      return yield* refuse();
    const facts = yield* readTaskReview(sql, {
      environmentId: proof.review.environmentId,
      taskId: `task:governed:thread:${command.threadId}`,
      projectId: command.projectId,
      threadId: command.threadId,
      revision: root.value.taskContract?.revision ?? 0,
    });
    if (facts.status !== "available") return yield* refuse();
  },
);

const encodeCommand = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2Command.members[0]));
const decodeCommand = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2Command.members[0]),
);
const sameCommand = Schema.toEquivalence(OrchestrationV2Command.members[0]);

/** Only the winning rejection transaction calls this. No legacy receipt gains ownership. */
export const persistReviewedCreateRejection = Effect.fn("governedCreation.persistRejection")(
  function* (
    sql: SqlClient.SqlClient,
    command: Create,
    rejectedAt: string,
    resultSequence: number,
  ) {
    if (
      !command.taskCreationReview ||
      !command.taskContract ||
      command.taskGovernance !== "required"
    )
      return;
    const actor = yield* principal.pipe(Effect.option);
    const environment = yield* Effect.serviceOption(ServerEnvironment);
    if (Option.isNone(actor) || Option.isNone(environment)) return;
    const environmentId = yield* environment.value.getEnvironmentId;
    if (environmentId !== command.taskCreationReview.environmentId) return;
    yield* sql`INSERT INTO agents_task_creation_rejections
      (command_id,actor_id,environment_id,command_json,rejected_at,result_sequence)
      VALUES (${command.commandId},${actor.value},${environmentId},${encodeCommand(command)},${rejectedAt},${resultSequence})`;
  },
);

/** Absence and unbound legacy receipts say nothing about an attempt's outcome. */
export const readAgentsCreationStatus = Effect.fn("governedCreation.readStatus")(
  function* (sql: SqlClient.SqlClient, command: OrchestrationV2Command) {
    if (command.type !== "thread.create" || !command.taskCreationReview || !command.taskContract)
      return { status: "unknown" as const };
    const actorId = yield* principal;
    const environment = yield* Effect.serviceOption(ServerEnvironment);
    if (Option.isNone(environment)) return { status: "unavailable" as const };
    const environmentId = yield* environment.value.getEnvironmentId;
    if (environmentId !== command.taskCreationReview.environmentId)
      return { status: "unknown" as const };
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const receipts = yield* sql<{
          aggregate_kind: string;
          aggregate_id: string;
          command_type: string;
          status: string;
          accepted_at: string;
          result_sequence: number;
          error: string | null;
        }>`
        SELECT aggregate_kind,aggregate_id,command_type,status,accepted_at,result_sequence,error
        FROM orchestration_command_receipts WHERE command_id=${command.commandId}`;
        const receipt = receipts.length === 1 ? receipts[0] : undefined;
        if (
          !receipt ||
          receipt.aggregate_kind !== "thread" ||
          receipt.aggregate_id !== command.threadId ||
          receipt.command_type !== "thread.create"
        )
          return { status: "unknown" as const };
        const proofs = yield* sql<{
          actor_id: string;
          environment_id: string;
          command_json: string;
          rejected_at: string;
          result_sequence: number;
        }>`
        SELECT actor_id,environment_id,command_json,rejected_at,result_sequence
        FROM agents_task_creation_rejections WHERE command_id=${command.commandId}`;
        const events = yield* sql<{
          sequence: number;
          occurred_at: string;
        }>`SELECT sequence,occurred_at FROM orchestration_events WHERE command_id=${command.commandId}`;
        if (receipt.status === "accepted") {
          if (
            proofs.length !== 0 ||
            events.length !== 1 ||
            events[0]!.sequence !== receipt.result_sequence ||
            events[0]!.occurred_at !== receipt.accepted_at ||
            receipt.error !== null
          )
            return { status: "unknown" as const };
          const verified = yield* verifyReviewedCreateReplay(sql, command).pipe(
            Effect.as(true),
            Effect.catchTag("AgentsTaskCreationDenied", () => Effect.succeed(false)),
          );
          return {
            status: verified ? ("committed" as const) : ("unknown" as const),
          };
        }
        const proof = proofs.length === 1 ? proofs[0] : undefined;
        const intent = proof ? decodeCommand(proof.command_json) : Option.none();
        if (
          receipt.status !== "rejected" ||
          !proof ||
          events.length !== 0 ||
          proof.actor_id !== actorId ||
          proof.environment_id !== environmentId ||
          proof.rejected_at !== receipt.accepted_at ||
          proof.result_sequence !== receipt.result_sequence ||
          Option.isNone(intent) ||
          !sameCommand(intent.value, command)
        )
          return { status: "unknown" as const };
        return { status: "rejected" as const };
      }),
    );
  },
  Effect.catch(() => Effect.succeed({ status: "unavailable" as const })),
);
