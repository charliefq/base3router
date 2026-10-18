import type {
  CollaborationTask,
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  TaskContractReviewInput,
  TaskContractReviewState,
  TaskFirstLaunchStatus,
  TaskFirstLaunch,
  ModelSelection,
  ServerProvider,
  ThreadId,
  CollaborationSnapshot,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
type Fixture = {
  task: CollaborationTask;
  providers: ReadonlyArray<ServerProvider>;
  preview: (
    input: import("@t3tools/contracts").TaskAutoPreviewInput,
  ) => Effect.Effect<import("@t3tools/contracts").TaskAutoPreviewState, Error>;
  projection: (thread?: ThreadId) => Effect.Effect<OrchestrationV2ThreadProjection, Error>;
  readReview: (input: TaskContractReviewInput) => Effect.Effect<TaskContractReviewState, Error>;
  readStatus: (command: Dispatch) => Effect.Effect<TaskFirstLaunchStatus>;
  readCreationStatus: (command: OrchestrationV2Command) => Effect.Effect<{ status: string }, Error>;
  snapshot: () => Effect.Effect<CollaborationSnapshot, Error>;
  create: (command: OrchestrationV2Command) => Effect.Effect<unknown, Error>;
  start: (input: {
    commandId: Dispatch["commandId"];
    threadId: ThreadId;
    message: { messageId: Dispatch["messageId"]; text: string };
    modelSelection: ModelSelection;
    routingMode: "manual" | "auto";
    taskFirstLaunch: TaskFirstLaunch;
  }) => Effect.Effect<unknown, Error>;
  changeAutoCandidate: () => void;
  drain: () => Effect.Effect<void, Error>;
  inspect: () => Effect.Effect<{
    opened: number;
    starts: ReadonlyArray<ModelSelection>;
    executions: ReadonlyArray<{ threadId: ThreadId; message: { text: string } }>;
  }>;
};
export async function withFirstLaunchFixture(check: (f: Fixture) => Promise<void>) {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../../server/src/collaboration/testkit/mountedFirstLaunchFixture.ts",
      import.meta.url,
    ).href
  )) as { withMountedFirstLaunchFixture: (check: (f: Fixture) => Promise<void>) => Promise<void> };
  await module.withMountedFirstLaunchFixture(check);
}
