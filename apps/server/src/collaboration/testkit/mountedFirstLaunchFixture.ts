import {
  CommandId,
  MessageId,
  ThreadId,
  type TaskFirstLaunch,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { withTaskResultLinkageFixture } from "./taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "./agentsTaskCreationFixture.ts";
type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const providers = [
  {
    ...agentsCreationProvider,
    models: [
      ...agentsCreationProvider.models,
      { ...agentsCreationProvider.models[0]!, slug: "manual-choice", name: "Manual choice" },
      { ...agentsCreationProvider.models[0]!, slug: "bbb-preview", name: "Preview candidate" },
    ],
  },
];
function bridge(f: Fixture, defaultThread: ThreadId, completion: Effect.Effect<void, Error>) {
  return {
    taskId: defaultThread,
    providers,
    create: f.dispatch,
    readReview: f.readReview,
    readCreationStatus: f.readStatus,
    preview: f.previewAuto,
    projection: (threadId = defaultThread) => f.orchestrator.getThreadProjection(threadId),
    snapshot: f.readSnapshot,
    start: (input: {
      commandId: CommandId;
      threadId: ThreadId;
      message: { messageId: MessageId; text: string };
      modelSelection: ModelSelection;
      routingMode: "manual" | "auto";
      taskFirstLaunch: TaskFirstLaunch;
    }) =>
      f.dispatch({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: input.message.messageId,
        text: input.message.text,
        attachments: [],
        modelSelection: input.modelSelection,
        routingMode: input.routingMode,
        taskFirstLaunch: input.taskFirstLaunch,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      }),
    readStatus: f.readFirstLaunchStatus,
    changeAutoCandidate: () =>
      f.setProviders([
        {
          ...providers[0]!,
          models: [
            {
              ...agentsCreationProvider.models[0]!,
              slug: "aaa-after-review",
              name: "Actual after review",
            },
            ...providers[0]!.models,
          ],
        },
      ]),
    drain: () =>
      f.worker.drain().pipe(Effect.andThen(completion), Effect.andThen(f.worker.drain())),
    inspect: () =>
      Effect.gen(function* () {
        return {
          opened: yield* Ref.get(f.opened),
          starts: yield* Ref.get(f.started),
          executions: yield* Ref.get(f.executions),
        };
      }),
  };
}
export async function withMountedFirstLaunchFixture(
  check: (
    f: ReturnType<typeof bridge> & { task: import("@t3tools/contracts").CollaborationTask },
  ) => Promise<void>,
) {
  await Effect.runPromise(
    Effect.scoped(
      withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const creation = yield* f.createTask("mounted-generic");
            f.setProviders(providers);
            const task = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === creation.threadId,
            )!;
            const completed = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "run.updated" &&
                  ["completed", "failed", "cancelled", "interrupted"].includes(e.payload.status),
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Effect.promise(() =>
              check({ ...bridge(f, creation.threadId, Fiber.join(completed)), task }),
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          onStart: (input, events, emit) =>
            Effect.forEach(
              events,
              (e) =>
                emit(
                  e.type === "turn_item.updated" && e.turnItem.type === "assistant_message"
                    ? {
                        ...e,
                        turnItem: {
                          ...e.turnItem,
                          text: `Actual generic answer: ${input.message.text}`,
                        },
                      }
                    : e,
                ),
              { discard: true },
            ),
        },
      ),
    ),
  );
}
