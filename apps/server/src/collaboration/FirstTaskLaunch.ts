import {
  TaskReferenceFileReview,
  TaskReferenceFileReviewInput,
  type TaskReferenceFileReviewState,
} from "@t3tools/contracts";
import {
  taskReferenceFileBinding,
  taskReferenceDeliveryMatches,
  verifyTaskReferenceFile,
  taskReferenceTargetAvailable,
} from "@t3tools/shared/taskReferenceFile";
import { readTaskReferenceFile } from "./TaskReferenceFile.ts";
import {
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";
import * as NodeCrypto from "node:crypto";
import {
  ChatAttachmentId,
  TaskInstructionSkillReview,
  TaskInstructionSkillReviewInput,
  type TaskInstructionSkillReviewState,
} from "@t3tools/contracts";
import {
  taskInstructionSkillBinding,
  taskInstructionSkillTargetAvailable,
  resolveTaskInstructionSkill,
  verifyTaskInstructionSkillReview as verifyInstructionSkillReview,
} from "@t3tools/shared/taskInstructionSkills";
import {
  AuthOrchestrationOperateScope,
  TaskFirstLaunch,
  TaskResultContinuation,
  TaskContract,
  TaskContractReviewReference,
  isProviderAvailable,
  isProviderTaskExecutionCapable,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2RunJson,
  OrchestrationV2RunAttemptJson,
  type TaskFirstLaunchStatus,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import { readTaskReview, readCollaborationSnapshot } from "./store.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Option from "effect/Option";
import { argumentHash } from "../policy/grantArguments.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { readDispatcherTaskRoute } from "../dispatcher/Dispatcher.ts";

export class FirstTaskLaunchDenied extends Schema.TaggedError<FirstTaskLaunchDenied>()(
  "FirstTaskLaunchDenied",
  { reason: Schema.String },
) {}
const deny = () =>
  new FirstTaskLaunchDenied({
    reason:
      "First launch facts changed, identity mismatched or task is not an owned empty active root. Refresh and review; no replacement was sent.",
  });
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeAttempt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJson),
);
const IssuedFile = Schema.fromJsonString(
  Schema.Struct({
    review: TaskReferenceFileReview,
    sessionId: Schema.String,
    launchSha256: Schema.String,
  }),
);
const decodeIssuedFile = Schema.decodeUnknownOption(IssuedFile);
const encodeIssuedFile = Schema.encodeSync(IssuedFile);
export const validateTaskReferenceIssuance = Effect.fn("TaskReferenceFile.validateIssuance")(
  function* (sql: SqlClient.SqlClient, launch: TaskFirstLaunch) {
    const actor = yield* reviewedTaskPrincipal;
    const now = DateTime.formatIso(yield* DateTime.now);
    const proof = yield* Effect.try({
      try: () => verifyTaskReferenceFile(launch, actor.actorId, now),
      catch: () => deny(),
    });
    const rows = yield* sql<{
      issued: string | null;
    }>`SELECT json_extract(payload_json,'$.__taskReferenceFileReview') AS issued FROM orchestration_v2_projection_threads WHERE thread_id=${launch.threadId}`;
    const issued = rows[0]?.issued ? decodeIssuedFile(rows[0].issued) : Option.none();
    const { referenceFile: _file, ...base } = launch;
    if (
      Option.isNone(issued) ||
      issued.value.sessionId !== actor.sessionId ||
      argumentHash(issued.value.review) !== argumentHash(proof) ||
      issued.value.launchSha256 !== argumentHash(base)
    )
      return yield* deny();
    return proof;
  },
);
export const prepareTaskReferenceClaim = Effect.fn("TaskReferenceFile.prepareClaim")(function* (
  sql: SqlClient.SqlClient,
  c: Dispatch,
) {
  if (!c.taskFirstLaunch?.referenceFile) return undefined;
  const proof = yield* validateTaskReferenceIssuance(sql, c.taskFirstLaunch);
  if (argumentHash(c.attachments) !== argumentHash([proof.source])) return yield* deny();
  const { referenceFile: _file, ...base } = c.taskFirstLaunch;
  yield* validateFirstTaskLaunch(sql, { ...c, taskFirstLaunch: base, attachments: [] });
  yield* readTaskReferenceFile(proof.source, proof.contentSha256).pipe(
    Effect.mapError(() => deny()),
  );
  return { [proof.source.id]: { id: proof.attachment.id, sha256: proof.contentSha256 } };
});
const sameMarker = Schema.toEquivalence(TaskFirstLaunch);
const decodeSkillReviewInput = Schema.decodeUnknownOption(TaskInstructionSkillReviewInput);
const decodeStrictLaunch = Schema.decodeUnknownOption(TaskFirstLaunch);
const validLaunch = (raw: unknown) =>
  Option.isSome(decodeStrictLaunch(raw, { onExcessProperty: "error" }));
// A single bounded pending issuance lives with the task. Projection replacement/rebuild
// retires it fail-closed; committed receipts and native delivery never depend on this cache.
const IssuedInstructionReview = Schema.fromJsonString(
  Schema.Struct({
    review: TaskInstructionSkillReview,
    sessionId: Schema.String,
    launchSha256: Schema.String,
  }),
);
const decodeIssuedInstructionReview = Schema.decodeUnknownOption(IssuedInstructionReview);
const encodeIssuedInstructionReview = Schema.encodeSync(IssuedInstructionReview);
const validContinuation = Schema.is(TaskResultContinuation);
const sameContinuation = Schema.toEquivalence(TaskResultContinuation);
type Kind = "first" | "continuation";
const marker = (c: Dispatch, kind: Kind) =>
  kind === "first" ? c.taskFirstLaunch : c.taskResultContinuation;
const markerMessage = (
  message: {
    readonly taskFirstLaunch?: Dispatch["taskFirstLaunch"];
    readonly taskResultContinuation?: Dispatch["taskResultContinuation"];
  },
  kind: Kind,
) => (kind === "first" ? message.taskFirstLaunch : message.taskResultContinuation);
const equalMarker = (
  a: NonNullable<Dispatch["taskFirstLaunch"]>,
  b: NonNullable<Dispatch["taskFirstLaunch"]>,
  kind: Kind,
) =>
  kind === "first"
    ? sameMarker(a, b)
    : validContinuation(a) && validContinuation(b) && sameContinuation(a, b);
const sameContract = Schema.toEquivalence(TaskContract);
const sameReference = Schema.toEquivalence(TaskContractReviewReference);
type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
export const reviewedTaskPrincipal = Effect.gen(function* () {
  const c = yield* PolicyExecutionContext;
  if (
    c.kind !== "session" ||
    !c.actorId.trim() ||
    !c.sessionId.trim() ||
    !c.scopes.includes(AuthOrchestrationOperateScope) ||
    (c.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(c.expiresAt)) ||
        c.expiresAt <= DateTime.formatIso(yield* DateTime.now)))
  )
    return yield* deny();
  return c;
});
export const reviewedDispatchMatches = (c: Dispatch, authorized: boolean, kind: Kind = "first") => {
  const m = marker(c, kind);
  const file = kind === "first" ? c.taskFirstLaunch?.referenceFile : undefined;
  return (
    m !== undefined &&
    (kind === "first" ? c.taskResultContinuation === undefined : c.taskFirstLaunch === undefined) &&
    m.commandId === c.commandId &&
    m.messageId === c.messageId &&
    m.threadId === c.threadId &&
    m.text === c.text &&
    m.routingMode === c.routingMode &&
    ((authorized && m.routingMode === "auto") ||
      argumentHash(m.modelSelection) === argumentHash(c.modelSelection)) &&
    c.createdBy === "user" &&
    c.dispatchMode.type === "start_immediately" &&
    (file && kind === "first"
      ? argumentHash(c.attachments) === argumentHash([file.source]) ||
        argumentHash(c.attachments) === argumentHash([file.attachment])
      : c.attachments.length === 0) &&
    c.context === undefined &&
    c.capabilityStep === undefined &&
    c.sourcePlanRef === undefined &&
    c.scheduledTaskId === undefined &&
    c.senderThreadId === undefined &&
    c.notification === undefined &&
    c.titleSeed === undefined &&
    c.modelRouteConstraints === undefined &&
    c.manualContinuationOfRunId === undefined &&
    c.restartContinuationOfRunId === undefined &&
    c.usageLimitContinuationOfRunId === undefined &&
    c.usageLimitRecoveryRequestId === undefined &&
    c.deliveryIntent === undefined &&
    c.delegatedCompletion === undefined &&
    c.text.trim().length > 0
  );
};

export const validateFirstTaskLaunch = Effect.fn("FirstTaskLaunch.validate")(function* (
  sql: SqlClient.SqlClient,
  c: Dispatch,
  authorized = false,
) {
  if (!c.taskFirstLaunch) return;
  const principal = yield* reviewedTaskPrincipal;
  if (!reviewedDispatchMatches(c, authorized)) return yield* deny();
  const m = c.taskFirstLaunch;
  if (!validLaunch(m)) return yield* deny();
  if (m.referenceFile) {
    const proof = yield* validateTaskReferenceIssuance(sql, m);
    if (argumentHash(c.attachments) !== argumentHash([proof.attachment])) return yield* deny();
    yield* readTaskReferenceFile(proof.attachment, proof.contentSha256).pipe(
      Effect.mapError(() => deny()),
    );
  }
  let reviewedModule: ReturnType<typeof verifyInstructionSkillReview> | undefined;
  if (m.instructionSkill) {
    const rows = yield* sql<{
      issued_json: string | null;
    }>`SELECT json_extract(payload_json,'$.__taskInstructionSkillReview') AS issued_json FROM orchestration_v2_projection_threads WHERE thread_id=${m.threadId}`;
    const issued = rows[0]?.issued_json
      ? decodeIssuedInstructionReview(rows[0].issued_json)
      : Option.none();
    const { instructionSkill: _proof, ...originalLaunch } = m;
    if (
      Option.isNone(issued) ||
      issued.value.sessionId !== principal.sessionId ||
      argumentHash(issued.value.review) !== argumentHash(m.instructionSkill) ||
      issued.value.launchSha256 !== argumentHash(originalLaunch)
    )
      return yield* deny();
    const skillNow = DateTime.formatIso(yield* DateTime.now);
    reviewedModule = yield* Effect.try({
      try: () => verifyInstructionSkillReview(m, principal.actorId, skillNow),
      catch: () => deny(),
    });
  }
  if (authorized || m.routingMode === "manual") {
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    const provider = Option.isSome(registry)
      ? (yield* registry.value.getProviders).find(
          (p) => p.instanceId === c.modelSelection?.instanceId,
        )
      : undefined;
    if (
      !provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated" ||
      !isProviderAvailable(provider) ||
      !isProviderTaskExecutionCapable(provider) ||
      !provider.models.some((p) => p.slug === c.modelSelection?.model) ||
      (m.referenceFile !== undefined &&
        (!c.modelSelection || !taskReferenceTargetAvailable(provider, c.modelSelection))) ||
      // Auto proof binds intent/preference; the atomic admission checks the actual routed target.
      (reviewedModule !== undefined &&
        (!c.modelSelection ||
          !taskInstructionSkillTargetAvailable(reviewedModule, provider, c.modelSelection)))
    )
      return yield* deny();
  }
  const facts = yield* readTaskReview(sql, {
    ...m.reference,
    threadId: c.threadId,
    revision: m.contract.revision,
  });
  if (
    facts.status !== "available" ||
    facts.phase !== "active" ||
    facts.acceptedRevision !== null ||
    !facts.actions.includes("accept") ||
    !sameContract(facts.contract, m.contract) ||
    !sameReference(facts.reference, m.reference)
  )
    return yield* deny();
  const rows = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${c.threadId}`;
  if (!rows[0]) return yield* deny();
  const t = yield* decodeThread(rows[0].payload_json);
  const configured = t.agentsTaskCreation?.review;
  if (configured?.configuration && m.text !== configured.effectiveInstructions)
    return yield* deny();
  if (
    t.projectId !== m.reference.projectId ||
    t.taskGovernance !== "required" ||
    t.taskContractPhase !== "active" ||
    t.taskAcceptedRevision !== null ||
    t.lineage.rootThreadId !== t.id ||
    t.lineage.parentThreadId !== null ||
    t.lineage.relationshipToParent !== null ||
    t.forkedFrom !== null ||
    t.archivedAt !== null ||
    t.deletedAt !== null ||
    t.activeProviderThreadId !== null ||
    t.runtimeMode !== m.runtimeMode ||
    t.interactionMode !== m.interactionMode
  )
    return yield* deny();
  for (const table of [
    "messages",
    "runs",
    "run_attempts",
    "nodes",
    "provider_threads",
    "provider_turns",
    "provider_sessions",
    "runtime_requests",
  ] as const) {
    const count = yield* sql.unsafe<{ n: number }>(
      `SELECT COUNT(*) AS n FROM orchestration_v2_projection_${table} WHERE thread_id=?`,
      [c.threadId],
    );
    if (count[0]?.n !== 0) return yield* deny();
  }
});

export const reviewTaskInstructionSkill = Effect.fn("TaskInstructionSkill.review")(
  function* (
    sql: SqlClient.SqlClient,
    input: TaskInstructionSkillReviewInput,
  ): Effect.fn.Return<TaskInstructionSkillReviewState, unknown> {
    if (Option.isNone(decodeSkillReviewInput(input, { onExcessProperty: "error" })))
      return { status: "unavailable", reason: "Invalid or expanded instruction module review." };
    const launch = input.launch;
    if (launch.instructionSkill || launch.referenceFile)
      return {
        status: "unavailable",
        reason: "Choose Manual or Auto and review a first launch without an existing skill proof.",
      };
    const actor = yield* reviewedTaskPrincipal;
    const module = yield* Effect.try({
      try: () => resolveTaskInstructionSkill(input.module),
      catch: () => deny(),
    });
    const command: Dispatch = {
      type: "message.dispatch",
      commandId: launch.commandId,
      messageId: launch.messageId,
      threadId: launch.threadId,
      text: launch.text,
      attachments: [],
      routingMode: launch.routingMode,
      modelSelection: launch.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      taskFirstLaunch: launch,
    };
    yield* validateFirstTaskLaunch(sql, command);
    const now = yield* DateTime.now;
    const binding = {
      reviewId: NodeCrypto.randomUUID(),
      module: input.module,
      actorId: actor.actorId,
      reviewedAt: DateTime.formatIso(now),
      expiresAt: DateTime.formatIso(
        DateTime.makeUnsafe(
          Math.min(
            DateTime.toEpochMillis(now) + 300000,
            actor.expiresAt === undefined ? Infinity : Date.parse(actor.expiresAt),
          ),
        ),
      ),
    };
    const review = { ...binding, bindingSha256: taskInstructionSkillBinding(launch, binding) };
    const record = encodeIssuedInstructionReview({
      review,
      sessionId: actor.sessionId,
      launchSha256: argumentHash(launch),
    });
    if (new TextEncoder().encode(record).length > 4096) return yield* deny();
    const stored = yield* sql<{
      thread_id: string;
    }>`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.__taskInstructionSkillReview',json(${record})) WHERE thread_id=${launch.threadId} RETURNING thread_id`;
    if (stored.length !== 1) return yield* deny();
    return { status: "available", module, review };
  },
  Effect.catchCause(() =>
    Effect.succeed({
      status: "unavailable" as const,
      reason:
        "Owned first-launch facts, exact model or instruction module changed. Refresh and review.",
    }),
  ),
);

const isTaskReferenceFileReviewInput = Schema.is(TaskReferenceFileReviewInput);
export const reviewTaskReferenceFile = Effect.fn("TaskReferenceFile.review")(
  function* (
    sql: SqlClient.SqlClient,
    input: TaskReferenceFileReviewInput,
  ): Effect.fn.Return<TaskReferenceFileReviewState, unknown> {
    if (
      !isTaskReferenceFileReviewInput(input) ||
      input.launch.referenceFile ||
      input.launch.instructionSkill ||
      parseThreadSegmentFromAttachmentId(input.attachment.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    )
      return yield* deny();
    const launch = input.launch;
    const actor = yield* reviewedTaskPrincipal;
    yield* validateFirstTaskLaunch(sql, {
      type: "message.dispatch",
      commandId: launch.commandId,
      messageId: launch.messageId,
      threadId: launch.threadId,
      text: launch.text,
      attachments: [],
      routingMode: launch.routingMode,
      modelSelection: launch.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      taskFirstLaunch: launch,
    });
    yield* readTaskReferenceFile(input.attachment, input.contentSha256);
    const id = createAttachmentId(launch.threadId, ".txt");
    if (!id) return yield* deny();
    const now = yield* DateTime.now;
    const binding = {
      reviewId: NodeCrypto.randomUUID(),
      source: input.attachment,
      attachment: { ...input.attachment, id: ChatAttachmentId.make(id) },
      contentSha256: input.contentSha256,
      actorId: actor.actorId,
      reviewedAt: DateTime.formatIso(now),
      expiresAt: DateTime.formatIso(
        DateTime.makeUnsafe(
          Math.min(
            DateTime.toEpochMillis(now) + 300000,
            actor.expiresAt ? Date.parse(actor.expiresAt) : Infinity,
          ),
        ),
      ),
    };
    const review = { ...binding, bindingSha256: taskReferenceFileBinding(launch, binding) };
    const record = encodeIssuedFile({
      review,
      sessionId: actor.sessionId,
      launchSha256: argumentHash(launch),
    });
    if (new TextEncoder().encode(record).length > 4096) return yield* deny();
    const stored =
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.__taskReferenceFileReview',json(${record})) WHERE thread_id=${launch.threadId} RETURNING thread_id`;
    if (stored.length !== 1) return yield* deny();
    return { status: "available", review };
  },
  Effect.catchCause(() =>
    Effect.succeed({
      status: "unavailable" as const,
      reason:
        "Owned task, reference file bytes, scope or session could not be confirmed. No work started.",
    }),
  ),
);

export const commitFirstTaskLaunch = Effect.fn("FirstTaskLaunch.commit")(function* (
  sql: SqlClient.SqlClient,
  c: Dispatch,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  if (!c.taskFirstLaunch) return;
  yield* validateFirstTaskLaunch(sql, c, true);
  yield* commitReviewedTaskDispatch(sql, c, events, "first");
  if (c.taskFirstLaunch.referenceFile) {
    const retired =
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_remove(payload_json,'$.__taskReferenceFileReview') WHERE thread_id=${c.threadId} AND json_extract(payload_json,'$.__taskReferenceFileReview.review.reviewId')=${c.taskFirstLaunch.referenceFile.reviewId} RETURNING thread_id`;
    if (retired.length !== 1) return yield* deny();
  }
  if (c.taskFirstLaunch.instructionSkill) {
    const retired = yield* sql<{
      thread_id: string;
    }>`UPDATE orchestration_v2_projection_threads SET payload_json=json_remove(payload_json,'$.__taskInstructionSkillReview') WHERE thread_id=${c.threadId} AND json_extract(payload_json,'$.__taskInstructionSkillReview.review.reviewId')=${c.taskFirstLaunch.instructionSkill.reviewId} RETURNING thread_id`;
    if (retired.length !== 1) return yield* deny();
  }
});

export const commitReviewedTaskDispatch = Effect.fn("ReviewedTaskDispatch.commit")(function* (
  sql: SqlClient.SqlClient,
  c: Dispatch,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  kind: Kind,
) {
  const m = marker(c, kind)!;
  const selectedInstruction = kind === "first" ? c.taskFirstLaunch?.instructionSkill : undefined;
  const message = events.find((e) => e.type === "message.updated" && e.payload.id === c.messageId);
  const run = events.find(
    (e) => e.type === "run.created" && e.payload.userMessageId === c.messageId,
  );
  const attempt = events.find(
    (e) =>
      e.type === "run-attempt.created" &&
      e.payload.id === (run?.type === "run.created" ? run.payload.activeAttemptId : null),
  );
  if (
    message?.type !== "message.updated" ||
    !markerMessage(message.payload, kind) ||
    !equalMarker(markerMessage(message.payload, kind)!, m, kind) ||
    message.payload.text !== m.text ||
    run?.type !== "run.created" ||
    message.payload.runId !== run.payload.id ||
    (selectedInstruction
      ? !run.payload.instructionSkillSelection ||
        argumentHash(selectedInstruction) !== argumentHash(run.payload.instructionSkillSelection)
      : run.payload.instructionSkillSelection !== undefined) ||
    attempt?.type !== "run-attempt.created" ||
    attempt.payload.runId !== run.payload.id ||
    argumentHash(run.payload.modelSelection) !== argumentHash(c.modelSelection) ||
    attempt.payload.providerInstanceId !== run.payload.providerInstanceId
  )
    return yield* deny();
  const route = yield* readDispatcherTaskRoute({
    threadId: c.threadId,
    messageId: c.messageId,
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  if (
    Option.isNone(route) ||
    route.value.gate.decision !== "ALLOW" ||
    route.value.target.instanceId !== run.payload.modelSelection.instanceId ||
    route.value.target.model !== run.payload.modelSelection.model ||
    (m.routingMode === "auto" && route.value.modelRoute?.mode !== "auto")
  )
    return yield* deny();
});

export const readFirstTaskLaunchStatus = Effect.fn("FirstTaskLaunch.status")(
  function* (
    sql: SqlClient.SqlClient,
    c: OrchestrationV2Command,
    kind: Kind = "first",
  ): Effect.fn.Return<TaskFirstLaunchStatus, unknown> {
    if (
      c.type !== "message.dispatch" ||
      !marker(c, kind) ||
      !reviewedDispatchMatches(c, false, kind)
    )
      return {
        status: "unknown",
        reason: "Original launch command is unavailable or inconsistent.",
      };
    const original = marker(c, kind)! as TaskFirstLaunch;
    const actor = yield* reviewedTaskPrincipal;
    const env = yield* Effect.serviceOption(ServerEnvironment);
    if (
      Option.isNone(env) ||
      (yield* env.value.getEnvironmentId) !== original.reference.environmentId
    )
      return { status: "unavailable", reason: "Original environment unavailable." };
    const snapshot = yield* readCollaborationSnapshot(sql, actor.actorId, {
      environmentId: original.reference.environmentId,
      canOperate: false,
    });
    const task = snapshot.tasks.find(
      (t) =>
        t.id === original.reference.taskId &&
        t.threadId === c.threadId &&
        t.projectId === original.reference.projectId,
    );
    if (!task) return { status: "unknown", reason: "Original task ownership unavailable." };
    const receipts = yield* sql<{
      aggregate_kind: string;
      aggregate_id: string;
      command_type: string;
      status: string;
      error: string | null;
    }>`SELECT * FROM orchestration_command_receipts WHERE command_id=${c.commandId}`;
    const r = receipts[0];
    if (
      !r ||
      r.aggregate_kind !== "thread" ||
      r.aggregate_id !== c.threadId ||
      r.command_type !== c.type
    )
      return { status: "unknown", reason: "No matching durable command receipt. Do not resend." };
    if (r.status === "rejected")
      return {
        status: "rejected",
        reason: "The original command identity was durably rejected. No automatic retry was sent.",
      };
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=${c.threadId} AND message_id=${c.messageId}`;
    if (r.status !== "accepted" || !rows[0])
      return {
        status: "unknown",
        reason: "Admission lacks correlated message evidence. Do not resend.",
      };
    const message = yield* decodeMessage(rows[0].payload_json);
    const grants = yield* sql<{
      actor_id: string;
    }>`SELECT actor_id FROM base3_execution_grants WHERE grant_id=${`grant:message:${c.threadId}:${c.messageId}`}`;
    if (
      !markerMessage(message, kind) ||
      !equalMarker(markerMessage(message, kind)!, original, kind) ||
      message.text !== c.text ||
      (original.referenceFile &&
        argumentHash(message.attachments) !== argumentHash([original.referenceFile.attachment])) ||
      message.runId === null ||
      grants[0]?.actor_id !== actor.actorId
    )
      return { status: "unknown", reason: "Persisted original input or actor does not match." };
    const runs = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=${c.threadId} AND run_id=${message.runId}`;
    if (!runs[0]) return { status: "unknown", reason: "Original run unavailable." };
    const run = yield* decodeRun(runs[0].payload_json);
    const attempts = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=${c.threadId} AND attempt_id=${run.activeAttemptId}`;
    if (!attempts[0] || run.userMessageId !== c.messageId || run.activeAttemptId === null)
      return { status: "unknown", reason: "Original run/attempt linkage unavailable." };
    const attempt = yield* decodeAttempt(attempts[0].payload_json);
    if (attempt.runId !== run.id || attempt.providerInstanceId !== run.providerInstanceId)
      return { status: "unknown", reason: "Original attempt does not match." };
    const result = task.resultReadout;
    const preview =
      result?.status === "available" &&
      result.runId === run.id &&
      result.messageId === c.messageId &&
      result.attemptId === run.activeAttemptId &&
      result.content.status === "output"
        ? result.content.preview
        : null;
    return {
      status: "admitted",
      runId: run.id,
      attemptId: run.activeAttemptId,
      actualModelSelection: run.modelSelection,
      ...(original.referenceFile ? { referenceFileSelection: original.referenceFile } : {}),
      ...(taskReferenceDeliveryMatches(original.referenceFile, run.referenceFileDelivery, {
        runId: run.id,
        attemptId: run.activeAttemptId,
        messageId: c.messageId,
        modelSelection: run.modelSelection,
      })
        ? { referenceFileDelivery: run.referenceFileDelivery }
        : {}),
      ...(run.instructionSkillSelection
        ? { instructionSkillSelection: run.instructionSkillSelection }
        : {}),
      ...(run.instructionSkillDelivery
        ? { instructionSkillDelivery: run.instructionSkillDelivery }
        : {}),
      runStatus: run.status,
      resultPreview: preview,
    };
  },
  Effect.catch(() =>
    Effect.succeed({
      status: "unavailable" as const,
      reason: "Original launch evidence could not be read. Do not resend.",
    }),
  ),
);
