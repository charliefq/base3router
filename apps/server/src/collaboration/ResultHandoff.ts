import { EnvironmentId, TaskResultHandoff } from "@t3tools/contracts";
import { acceptedResultFacts, resultHandoffReference } from "@t3tools/shared/taskResultHandoff";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import { readCollaborationSnapshot, readTaskReviewForActor } from "./store.ts";
export class ResultHandoffDenied extends Schema.TaggedError<ResultHandoffDenied>()(
  "ResultHandoffDenied",
  { reason: Schema.String },
) {}
const same = Schema.toEquivalence(TaskResultHandoff);
export const validateAcceptedSource = Effect.fn("ResultHandoff.validateAcceptedSource")(function* (
  sql: SqlClient.SqlClient,
  source: TaskResultHandoff,
  actorId: string,
  readProjection: ProjectionStoreV2Shape["getThreadProjection"] | undefined,
) {
  if (!readProjection)
    return yield* new ResultHandoffDenied({ reason: "Source projection unavailable." });
  const review = yield* readTaskReviewForActor(
    sql,
    { ...source.reference, threadId: source.threadId, revision: source.revision },
    actorId,
  );
  const snapshot = yield* readCollaborationSnapshot(sql, actorId, {
    environmentId: source.reference.environmentId,
    canOperate: true,
  });
  const tasks = snapshot.tasks.filter(
    (t) =>
      t.id === source.reference.taskId &&
      t.projectId === source.reference.projectId &&
      t.threadId === source.threadId,
  );
  const projection = yield* readProjection(source.threadId);
  const facts =
    tasks.length === 1
      ? acceptedResultFacts(
          tasks[0]!,
          EnvironmentId.make(source.reference.environmentId),
          review,
          projection,
        )
      : null;
  const current = facts ? yield* Effect.try(() => resultHandoffReference(facts)) : null;
  if (!current || !same(source, current))
    return yield* new ResultHandoffDenied({
      reason: "Accepted source ownership, revision, idle state or exact output changed.",
    });
});
