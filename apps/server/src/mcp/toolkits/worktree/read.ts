import {
  WorktreeMcpFailure,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isWorktreeFailure = Schema.is(WorktreeMcpFailure);
type RecordedThread = Pick<
  OrchestrationV2ThreadShell,
  "projectId" | "worktreePath" | "branch" | "deletedAt"
>;
/** Shared recorded-metadata operation. Readers must not enrich from disk, Git or network. */
export const readRecordedWorktreeStatus = Effect.fn("Worktree.readRecordedStatus")(function* <
  ThreadError,
  ProjectError,
  SettingsError,
>(
  threadId: ThreadId,
  readers: {
    readonly thread: (id: ThreadId) => Effect.Effect<RecordedThread | null, ThreadError>;
    readonly project: (
      id: ProjectId,
    ) => Effect.Effect<{ readonly workspaceRoot: string } | null, ProjectError>;
    readonly defaultStartFromOrigin: Effect.Effect<boolean, SettingsError>;
  },
) {
  const unavailable = (error: unknown) =>
    isWorktreeFailure(error)
      ? error
      : new WorktreeMcpFailure({
          code: "operation_failed",
          message: "Recorded workspace metadata is unavailable.",
        });
  const thread = yield* readers.thread(threadId).pipe(Effect.mapError(unavailable));
  if (!thread || thread.deletedAt !== null)
    return yield* new WorktreeMcpFailure({
      code: "thread_not_found",
      message: "The recorded thread is unavailable.",
    });
  const project = yield* readers.project(thread.projectId).pipe(Effect.mapError(unavailable));
  if (!project)
    return yield* new WorktreeMcpFailure({
      code: "project_not_found",
      message: "The recorded project is unavailable.",
    });
  const defaultStartFromOrigin = yield* readers.defaultStartFromOrigin.pipe(
    Effect.mapError(unavailable),
  );
  return {
    attached: thread.worktreePath !== null,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    projectWorkspaceRoot: project.workspaceRoot,
    defaultStartFromOrigin,
  } satisfies WorktreeMcpStatusResult;
});
