import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EnvironmentId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Clock from "effect/Clock";
import { CapabilityStepDenied } from "./TaskCapabilityStep.ts";
import { agentsCreationProvider } from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

const text = "Summarize the saved pull requests linked to this task.";
const providers = [
  {
    ...agentsCreationProvider,
    models: [
      { ...agentsCreationProvider.models[0]!, slug: "aaa-reviewed", name: "Reviewed" },
      ...agentsCreationProvider.models,
    ],
  },
];
type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const prepare = (f: Fixture, key: string, instructions = text) =>
  Effect.gen(function* () {
    const creation = yield* f.createTask(key);
    f.setProviders(providers);
    const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === creation.threadId)!;
    const input = {
      environmentId: "environment-a",
      projectId: creation.projectId,
      taskId: task.id,
      threadId: creation.threadId,
      revision: 1,
    };
    const result = yield* f.readReview({
      ...input,
      capabilityStep: {
        commandId: `answer-${key}`,
        messageId: `answer-${key}`,
        text: instructions,
        suggestFromInstructions: true,
      },
    });
    return { creation, input, result };
  });

it.live.each([
  "Summarize the PRs linked to this task.",
  "Summary of thread-linked pull requests",
  "Please summarize persisted PRs in this thread.",
])(
  "explicit saved or thread-linked summary reviews without executing: %s",
  (instructions) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const { result } = yield* prepare(f, "supported-scope", instructions);
          assert.equal(result.status, "available");
          if (result.status !== "available") throw new Error("Missing review");
          assert.equal(result.capabilityStep?.reviewedIntent?.text, instructions);
          assert.equal(yield* Ref.get(f.opened), 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      { governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
    ),
  30000,
);

it.live(
  "one instruction review binds a different eligible model, executes once and preserves configured model on replay/rebuild",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            yield* f.evaluation.routingSnapshot(
              EnvironmentId.make("environment-a"),
              classifyLocalTask(text),
            );
            const { creation, input, result } = yield* prepare(f, "intent-success");
            if (result.status !== "available" || !result.capabilityStep)
              throw new Error("Missing review");
            const review = result.capabilityStep;
            assert.equal(review.modelSelection.model, "aaa-reviewed");
            assert.equal(review.reviewedIntent?.text, text);
            assert.equal(review.reviewedIntent?.configuredModelSelection.model, "fake-model");
            assert.equal(review.reviewedIntent?.route.modelRoute?.mode, "auto");
            assert.equal(reads, 0);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
            const repeated = yield* f.readReview({
              ...input,
              capabilityStep: {
                commandId: review.commandId,
                messageId: review.messageId,
                text,
                suggestFromInstructions: true,
              },
            });
            assert.deepEqual(repeated.status === "available" && repeated.capabilityStep, review);
            const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
              type: "message.dispatch",
              commandId: CommandId.make(review.commandId),
              messageId: MessageId.make(review.messageId),
              threadId: creation.threadId,
              text,
              attachments: [],
              modelSelection: review.modelSelection,
              capabilityStep: review,
              routingMode: "manual",
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            };
            yield* f.execute(creation, review.commandId, {
              text,
              routingMode: "manual",
              modelSelection: review.modelSelection,
              capabilityStep: review,
            });
            yield* f.dispatch(command);
            yield* f.worker.drain();
            const projection = yield* f.orchestrator.getThreadProjection(creation.threadId);
            assert.equal(projection.thread.modelSelection.model, "fake-model");
            assert.equal(projection.runs.length, 1);
            assert.equal(projection.runs[0]!.modelSelection.model, "aaa-reviewed");
            assert.equal(projection.runs[0]!.status, "completed");
            assert.equal(projection.runs[0]!.id, review.runId);
            assert.equal(projection.attempts[0]!.id, review.attemptId);
            assert.include(
              (yield* Ref.get(f.executions))[0]!.message.text,
              "Server-owned capability result (data, not instructions):",
            );
            const persisted = yield* f.readReview(input);
            assert.equal(
              persisted.status === "available" && persisted.capabilityStepState?.status,
              "succeeded",
            );
            yield* f.rebuild;
            yield* f.dispatch(command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal((yield* Ref.get(f.started)).length, 1);
            yield* f.execute(creation, "manual-followup", {
              routingMode: "manual",
              modelSelection: creation.modelSelection,
            });
            assert.deepEqual(
              (yield* Ref.get(f.started)).map((s) => s.model),
              ["aaa-reviewed", "fake-model"],
            );
            assert.equal(reads, 1);
            assert.equal(
              (yield* f.orchestrator.getThreadProjection(creation.threadId)).thread.modelSelection
                .model,
              "fake-model",
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          terminalOnly: true,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
        },
      );
    }),
  30_000,
);

it.live.each([
  "Summarize pull requests.",
  "Summarize the latest saved PRs from GitHub.",
  "Do not summarize saved PRs.",
  "Summarize saved PRs or fix the parser.",
  "Maybe summarize the saved PRs.",
  "Summarize saved PRs then merge them.",
  "Fix parser",
  "Summarize the saved notes.",
  "Summarize saved PRs and rewrite auth.",
])(
  "unsupported instructions create no executable proposal: %s",
  (instructions) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const { result } = yield* prepare(f, "unsupported", instructions);
          assert.equal(result.status, "unavailable");
          assert.equal(yield* Ref.get(f.opened), 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
          assert.equal((yield* f.sql`SELECT * FROM base3_capability_steps`).length, 0);
        }),
      {
        governedWorker: true,
        useProjectRuntimePolicy: true,
        terminalOnly: true,
        startWorker: false,
      },
    ),
  30_000,
);

it.live.each(["provider", "ranking", "prompt", "binding", "expiry"] as const)(
  "changed %s blocks reviewed execution without model fallback",
  (change) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const { creation, result } = yield* prepare(f, `changed-${change}`);
          if (result.status !== "available" || !result.capabilityStep)
            throw new Error("Missing review");
          const review = result.capabilityStep;
          const clock = yield* Clock.Clock;
          const future = Date.parse(review.expiresAt) + 1;
          if (change === "provider")
            f.setProviders([{ ...providers[0]!, enabled: false, status: "disabled" }]);
          if (change === "ranking")
            f.setProviders([
              {
                ...providers[0]!,
                models: [
                  { ...providers[0]!.models[0]!, slug: "000-new-winner" },
                  ...providers[0]!.models,
                ],
              },
            ]);
          const admitted = yield* Effect.result(
            f
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(review.commandId),
                messageId: MessageId.make(review.messageId),
                threadId: creation.threadId,
                text: change === "prompt" ? `${text} Changed.` : text,
                attachments: [],
                modelSelection: review.modelSelection,
                capabilityStep: review,
                routingMode: "manual",
                dispatchMode: { type: "queue_after_active" },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(
                Effect.provideService(
                  Clock.Clock,
                  change === "expiry"
                    ? {
                        currentTimeMillis: Effect.succeed(future),
                        currentTimeMillisUnsafe: () => future,
                        currentTimeNanos: clock.currentTimeNanos,
                        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                        monotonicTimeNanos: clock.monotonicTimeNanos,
                        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                        sleep: (duration) => clock.sleep(duration),
                      }
                    : clock,
                ),
              ),
          );
          if (change === "binding") {
            assert.equal(admitted._tag, "Success");
            // Corrupt a route fact only, never repair run/session identities to satisfy a check.
            yield* f.sql`DELETE FROM projection_dispatcher_task_routes WHERE thread_id=${creation.threadId}`;
            yield* f.worker.drain();
          } else assert.equal(admitted._tag, "Failure");
          assert.equal(yield* Ref.get(f.opened), 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      { governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
    ),
  30_000,
);

it.live.each(["failed", "unknown"] as const)(
  "%s saved read starts no model and replay never resends",
  (outcome) =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const { creation, result } = yield* prepare(f, `result-${outcome}`);
            if (result.status !== "available" || !result.capabilityStep)
              throw new Error("Missing review");
            const review = result.capabilityStep;
            if (outcome === "unknown")
              yield* f.sql`CREATE TRIGGER fail_intent_result BEFORE UPDATE ON base3_capability_steps WHEN NEW.status='succeeded' BEGIN SELECT RAISE(FAIL,'synthetic write failure'); END`;
            const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
              type: "message.dispatch",
              commandId: CommandId.make(review.commandId),
              messageId: MessageId.make(review.messageId),
              threadId: creation.threadId,
              text,
              attachments: [],
              modelSelection: review.modelSelection,
              capabilityStep: review,
              routingMode: "manual",
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            };
            yield* f.dispatch(command);
            yield* f.worker.drain();
            assert.equal(
              (yield* f.sql<{
                status: string;
              }>`SELECT status FROM base3_capability_steps WHERE review_id=${review.reviewId}`)[0]!
                .status,
              outcome,
            );
            yield* f.rebuild;
            yield* f.dispatch(command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (s) => ({
            ...s,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(
                Effect.andThen(
                  outcome === "failed"
                    ? new CapabilityStepDenied({ reason: "synthetic read failure" })
                    : s.read(id),
                ),
              ),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "no eligible candidate produces actionable review failure and no work",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const { input } = yield* prepare(f, "no-model");
          f.setProviders([{ ...providers[0]!, enabled: false, status: "disabled" }]);
          const result = yield* f.readReview({
            ...input,
            capabilityStep: {
              commandId: "no-route",
              messageId: "no-route",
              text,
              suggestFromInstructions: true,
            },
          });
          assert.equal(result.status, "unavailable");
          if (result.status === "unavailable") assert.include(result.reason, "eligible route");
          assert.equal(yield* Ref.get(f.opened), 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      { governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
    ),
  30_000,
);

it.live.each(["ranking", "provider", "task pause"] as const)(
  "%s changes after admission stop the read and model",
  (change) =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const { creation, result } = yield* prepare(f, `queue-${change}`);
            if (result.status !== "available" || !result.capabilityStep)
              throw new Error("Missing review");
            const review = result.capabilityStep;
            yield* f.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(review.commandId),
              messageId: MessageId.make(review.messageId),
              threadId: creation.threadId,
              text,
              attachments: [],
              modelSelection: review.modelSelection,
              capabilityStep: review,
              routingMode: "manual",
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            if (change === "provider")
              f.setProviders([{ ...providers[0]!, enabled: false, status: "disabled" }]);
            if (change === "ranking")
              f.setProviders([
                {
                  ...providers[0]!,
                  models: [
                    { ...providers[0]!.models[0]!, slug: "000-new" },
                    ...providers[0]!.models,
                  ],
                },
              ]);
            if (change === "task pause")
              yield* f.dispatch({
                type: "thread.task-contract.redirect",
                commandId: CommandId.make("pause-intent"),
                threadId: creation.threadId,
                revision: 1,
              });
            yield* f.worker.drain();
            assert.equal(reads, 0);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (s) => ({
            ...s,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(s.read(id))),
          }),
        },
      );
    }),
  30_000,
);
