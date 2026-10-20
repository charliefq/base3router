import {
  ThreadId,
  type CollaborationSnapshot,
  type CollaborationTask,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type TaskContractReviewInput,
  type TaskContractReviewState,
} from "@t3tools/contracts";
import {
  revisionSnapshotTask,
  sameRevisionTask,
  sameRevisionProjection,
  sameRevisionReview,
  revisionRequestFacts,
  taskResultReviewFacts,
} from "@t3tools/shared/taskRevisionRequest";
type Result<A> = { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure" };
export async function readTaskResultReview(
  props: {
    task: CollaborationTask;
    environmentId: EnvironmentId;
    readCollaboration: () => Promise<CollaborationSnapshot>;
  },
  readReview: (args: {
    environmentId: EnvironmentId;
    input: TaskContractReviewInput;
  }) => Promise<Result<TaskContractReviewState>>,
  readProjection: (args: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId };
  }) => Promise<Result<OrchestrationV2ThreadProjection>>,
  purpose: "review" | "revision" = "review",
) {
  if (!props.task.threadId || props.task.contractReadout?.status !== "available") return null;
  const input = {
    environmentId: props.environmentId,
    taskId: props.task.id,
    projectId: props.task.projectId,
    threadId: props.task.threadId,
    revision: props.task.contractReadout.contract.revision,
  };
  const first = await readReview({ environmentId: props.environmentId, input });
  if (first._tag !== "Success" || first.value.status !== "available") return null;
  const before = revisionSnapshotTask(
    await props.readCollaboration(),
    props.environmentId,
    props.task,
  );
  if (!before || !sameRevisionTask(before, props.task)) return null;
  const a = await readProjection({
    environmentId: props.environmentId,
    input: { threadId: ThreadId.make(props.task.threadId) },
  });
  const b = await readProjection({
    environmentId: props.environmentId,
    input: { threadId: ThreadId.make(props.task.threadId) },
  });
  const after = revisionSnapshotTask(
    await props.readCollaboration(),
    props.environmentId,
    props.task,
  );
  const last = await readReview({ environmentId: props.environmentId, input });
  if (
    a._tag !== "Success" ||
    b._tag !== "Success" ||
    last._tag !== "Success" ||
    last.value.status !== "available" ||
    !after ||
    !sameRevisionTask(before, after) ||
    !sameRevisionReview(first.value, last.value) ||
    !sameRevisionProjection(a.value, b.value)
  )
    return null;
  return (purpose === "review" ? taskResultReviewFacts : revisionRequestFacts)(
    after,
    props.environmentId,
    last.value,
    b.value,
  );
}
