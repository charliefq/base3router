import {
  EnvironmentId,
  TaskResultContinuation,
  TaskContinuationResult,
  isProviderAvailable,
  isProviderTaskExecutionCapable,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { revisionRequestFacts, continuationResult } from "@t3tools/shared/taskRevisionRequest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { readCollaborationSnapshot, readTaskReview } from "./store.ts";
import {
  reviewedDispatchMatches,
  reviewedTaskPrincipal,
  commitReviewedTaskDispatch,
} from "./FirstTaskLaunch.ts";
export class ResultContinuationDenied extends Schema.TaggedError<ResultContinuationDenied>()(
  "ResultContinuationDenied",
  { reason: Schema.String },
) {}
const deny = () =>
  new ResultContinuationDenied({
    reason:
      "Completed result, current contract, ownership, model or idle task changed. Refresh and review; no replacement was sent.",
  });
const validMarker = Schema.is(TaskResultContinuation);
const sameResult = Schema.toEquivalence(TaskContinuationResult);
const sameContract = Schema.toEquivalence(TaskResultContinuation.fields.contract);
const sameReference = Schema.toEquivalence(TaskResultContinuation.fields.reference);
type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
export const validateResultContinuation = Effect.fn("ResultContinuation.validate")(function* (
  sql: SqlClient.SqlClient,
  c: Dispatch,
  readProjection: ProjectionStoreV2Shape["getThreadProjection"],
  authorized = false,
) {
  const m = c.taskResultContinuation;
  if (!m) return;
  const actor = yield* reviewedTaskPrincipal;
  if (!validMarker(m) || !reviewedDispatchMatches(c, authorized, "continuation"))
    return yield* deny();
  if (authorized || m.routingMode === "manual") {
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    const p = Option.isSome(registry)
      ? (yield* registry.value.getProviders).find(
          (p) => p.instanceId === c.modelSelection?.instanceId,
        )
      : undefined;
    if (
      !p ||
      !p.enabled ||
      !p.installed ||
      p.status !== "ready" ||
      p.auth.status === "unauthenticated" ||
      !isProviderAvailable(p) ||
      !isProviderTaskExecutionCapable(p) ||
      !p.models.some((model) => model.slug === c.modelSelection?.model)
    )
      return yield* deny();
  }
  const review = yield* readTaskReview(sql, {
    ...m.reference,
    threadId: c.threadId,
    revision: m.contract.revision,
  });
  const snapshot = yield* readCollaborationSnapshot(sql, actor.actorId, {
    environmentId: m.reference.environmentId,
    canOperate: true,
  });
  const task = snapshot.tasks.find(
    (t) =>
      t.id === m.reference.taskId &&
      t.threadId === c.threadId &&
      t.projectId === m.reference.projectId,
  );
  if (!task) return yield* deny();
  const projection = yield* readProjection(c.threadId);
  const facts = revisionRequestFacts(
    task,
    EnvironmentId.make(m.reference.environmentId),
    review,
    projection,
  );
  if (
    !facts ||
    !sameContract(facts.review.contract, m.contract) ||
    !sameReference(facts.review.reference, m.reference) ||
    !sameResult(continuationResult(facts), m.priorResult) ||
    projection.thread.runtimeMode !== m.runtimeMode ||
    projection.thread.interactionMode !== m.interactionMode
  )
    return yield* deny();
});
export const commitResultContinuation = Effect.fn("ResultContinuation.commit")(function* (
  sql: SqlClient.SqlClient,
  c: Dispatch,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  readProjection: ProjectionStoreV2Shape["getThreadProjection"],
) {
  if (!c.taskResultContinuation) return;
  yield* validateResultContinuation(sql, c, readProjection, true);
  yield* commitReviewedTaskDispatch(sql, c, events, "continuation");
});
