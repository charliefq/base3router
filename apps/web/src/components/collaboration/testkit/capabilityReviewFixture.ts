import type {
  CollaborationTask,
  OrchestrationV2Command,
  OrchestrationV2DispatchCommandResult,
  TaskContractReviewInput,
  TaskContractReviewState,
  CollaborationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type Creation = Extract<OrchestrationV2Command, { type: "thread.create" }>;
type Fixture = {
  dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestrationV2DispatchCommandResult, Error>;
  readReview: (input: TaskContractReviewInput) => Effect.Effect<TaskContractReviewState, Error>;
  readSnapshot: () => Effect.Effect<CollaborationSnapshot, Error>;
  noExecution: () => Effect.Effect<
    { runs: number; grants: number; outbox: number; messages: number },
    Error
  >;
};
/** Dynamic boundary keeps server implementation out of the web TypeScript project. */
export async function withCapabilityReviewFixture(
  check: (f: Fixture & { task: CollaborationTask; creation: Creation }) => Promise<void>,
) {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../../server/src/collaboration/testkit/agentsTaskCreationFixture.ts",
      import.meta.url,
    ).href
  )) as {
    agentsCreationCommand: (key: string) => Creation;
    withAgentsTaskCreationFixture: (
      check: (f: Fixture) => Effect.Effect<void, Error>,
    ) => Effect.Effect<void, Error>;
  };
  await Effect.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      Effect.promise(async () => {
        const base = module.agentsCreationCommand("mounted-capability-root");
        const creation = {
          ...base,
          taskContract: {
            ...base.taskContract!,
            brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
          },
        };
        await Effect.runPromise(f.dispatch(creation));
        const task = (await Effect.runPromise(f.readSnapshot())).tasks.find(
          (t) => t.threadId === creation.threadId,
        )!;
        await check({ ...f, task, creation });
      }),
    ),
  );
}

type IntentFixture = {
  task: CollaborationTask;
  readReview: (input: TaskContractReviewInput) => Promise<TaskContractReviewState>;
  projection: () => Promise<import("@t3tools/contracts").OrchestrationV2ThreadProjection>;
  start: (input: {
    commandId: string;
    threadId: string;
    message: { messageId: string; text: string };
    modelSelection: import("@t3tools/contracts").ModelSelection;
    capabilityStep: import("@t3tools/contracts").TaskCapabilityStep;
  }) => Promise<OrchestrationV2DispatchCommandResult>;
  drain: () => Promise<void>;
  inspect: () => Promise<{
    reads: number;
    starts: ReadonlyArray<import("@t3tools/contracts").ModelSelection>;
    projection: import("@t3tools/contracts").OrchestrationV2ThreadProjection;
  }>;
};
export async function withIntentExecutionFixture(
  check: (f: IntentFixture) => Promise<void>,
  options: { readonly statusQuestions?: boolean } = {},
) {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../../server/src/collaboration/testkit/mountedIntentExecutionFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withMountedIntentExecutionFixture: (
      check: (f: IntentFixture) => Promise<void>,
      options: { readonly statusQuestions?: boolean },
    ) => Promise<void>;
  };
  await module.withMountedIntentExecutionFixture(check, options);
}
