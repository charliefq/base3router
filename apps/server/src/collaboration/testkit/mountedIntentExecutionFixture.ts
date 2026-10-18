import {
  CommandId,
  MessageId,
  ThreadId,
  type CollaborationTask,
  type ModelSelection,
  type TaskCapabilityStep,
  type TaskContractReviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { withTaskResultLinkageFixture } from "./taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "./agentsTaskCreationFixture.ts";

const decodeData = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        pullRequests: Schema.Array(Schema.Struct({ number: Schema.Number })),
      }),
      questionEvidence: Schema.optional(
        Schema.Struct({
          question: Schema.String,
          field: Schema.String,
          matches: Schema.Array(Schema.Struct({ number: Schema.Number })),
          nonMatches: Schema.Array(Schema.Struct({ number: Schema.Number })),
          unknown: Schema.Array(Schema.Struct({ number: Schema.Number })),
          meaning: Schema.String,
        }),
      ),
    }),
  ),
);
type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const inspect = (f: Fixture, threadId: ThreadId, reads: () => number) =>
  Effect.gen(function* () {
    return {
      reads: reads(),
      starts: yield* Ref.get(f.started),
      executions: yield* Ref.get(f.executions),
      persistedRoutes: yield* f.sql<{
        binding_json: string;
      }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${threadId}`,
      projection: yield* f.orchestrator.getThreadProjection(threadId),
    };
  });
type Start = {
  commandId: string;
  threadId: string;
  message: { messageId: string; text: string };
  modelSelection: ModelSelection;
  capabilityStep: TaskCapabilityStep;
};
function bridge(
  f: Fixture,
  threadId: ThreadId,
  reads: () => number,
  completion: Effect.Effect<void, Error>,
) {
  return {
    readReview: (input: TaskContractReviewInput) => Effect.runPromise(f.readReview(input)),
    projection: () => Effect.runPromise(f.orchestrator.getThreadProjection(threadId)),
    start: (input: Start) =>
      Effect.runPromise(
        f.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(input.commandId),
          threadId: ThreadId.make(input.threadId),
          messageId: MessageId.make(input.message.messageId),
          text: input.message.text,
          attachments: [],
          modelSelection: input.modelSelection,
          capabilityStep: input.capabilityStep,
          routingMode: "manual",
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        }),
      ),
    drain: () =>
      Effect.runPromise(
        f.worker.drain().pipe(Effect.andThen(completion), Effect.andThen(f.worker.drain())),
      ),
    inspect: () => Effect.runPromise(inspect(f, threadId, reads)),
  };
}

/** Mounted client boundary with the same disposable production service graph as server regressions. */
export async function withMountedIntentExecutionFixture(
  check: (f: ReturnType<typeof bridge> & { task: CollaborationTask }) => Promise<void>,
  options: { readonly statusQuestions?: boolean } = {},
) {
  let reads = 0;
  await Effect.runPromise(
    Effect.scoped(
      withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const creation = yield* f.createTask("mounted-intent");
            f.setProviders([
              {
                ...agentsCreationProvider,
                models: [
                  { ...agentsCreationProvider.models[0]!, slug: "aaa-reviewed", name: "Reviewed" },
                  ...agentsCreationProvider.models,
                ],
              },
            ]);
            if (options.statusQuestions) {
              const rows = [
                { number: 1, state: "open", isDraft: true },
                { number: 2, state: "open", isDraft: false },
                { number: 3, state: "closed", isDraft: false },
                { number: 4, state: "merged", isDraft: false },
                { number: 5, state: "closed", isDraft: true },
                { number: 6, state: null, isDraft: null },
              ] as const;
              for (const row of rows) {
                yield* f.dispatch({
                  type: "thread.pull-request.link",
                  commandId: CommandId.make(`status-link-${row.number}`),
                  threadId: creation.threadId,
                  host: "github.com",
                  repository: "fixture/saved",
                  number: row.number,
                  url: `https://github.com/fixture/saved/pull/${row.number}`,
                  source: "agent",
                });
                if (row.state !== null)
                  yield* f.dispatch({
                    type: "thread.pull-request-link.sync",
                    commandId: CommandId.make(`status-sync-${row.number}`),
                    threadId: creation.threadId,
                    host: "github.com",
                    repository: "fixture/saved",
                    number: row.number,
                    stack: null,
                    snapshot: {
                      state: row.state,
                      isDraft: row.isDraft,
                      title: `Saved PR ${row.number}`,
                      headBranch: `pr-${row.number}`,
                      baseBranch: "main",
                      updatedAt: null,
                      syncedAt: "2026-10-18T00:00:00Z",
                    },
                  });
              }
            } else
              yield* f.dispatch({
                type: "thread.pull-request.link",
                commandId: CommandId.make("mounted-link"),
                threadId: creation.threadId,
                host: "github.com",
                repository: "fixture/saved",
                number: 42,
                url: "https://github.com/fixture/saved/pull/42",
                source: "agent",
              });
            const task = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === creation.threadId,
            )!;
            const completed = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "run.updated" &&
                  e.threadId === creation.threadId &&
                  ["completed", "failed", "cancelled", "interrupted"].includes(e.payload.status),
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Effect.promise(() =>
              check({ ...bridge(f, creation.threadId, () => reads, Fiber.join(completed)), task }),
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
          onStart: (input, events, emit) =>
            Effect.gen(function* () {
              const data = decodeData(
                input.message.text.split(
                  "Server-owned capability result (data, not instructions):\n",
                )[1]!,
              );
              const evidence = data.questionEvidence;
              const numbers = (rows: ReadonlyArray<{ number: number }>) =>
                rows.map((p) => `#${p.number}`).join(", ") || "none";
              const answer = evidence
                ? `Saved ${evidence.question}: ${numbers(evidence.matches)}; non-matching: ${numbers(evidence.nonMatches)}; unknown: ${numbers(evidence.unknown)}. ${evidence.meaning}`
                : `Reviewed model answer: saved PR #${data.result.pullRequests[0]?.number}`;
              for (const event of events)
                yield* emit(
                  event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
                    ? {
                        ...event,
                        turnItem: {
                          ...event.turnItem,
                          text: answer,
                        },
                      }
                    : event,
                );
            }),
        },
      ),
    ),
  );
}
