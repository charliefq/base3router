import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import { withMountedIntentExecutionFixture } from "./testkit/mountedIntentExecutionFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import { CapabilityStepDenied } from "./TaskCapabilityStep.ts";

const numbers = Schema.Array(Schema.Struct({ number: Schema.Number }));
const decodeContext = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      question: Schema.String,
      questionEvidence: Schema.Struct({
        question: Schema.String,
        field: Schema.String,
        matches: numbers,
        nonMatches: numbers,
        unknown: numbers,
        meaning: Schema.String,
      }),
      result: Schema.Struct({
        pullRequests: Schema.Array(
          Schema.Struct({
            number: Schema.Number,
            state: Schema.NullOr(Schema.String),
            isDraft: Schema.NullOr(Schema.Boolean),
          }),
        ),
      }),
    }),
  ),
);
const statusCases = [
  {
    question: "open",
    text: "Which saved PRs are still open?",
    matches: [1, 2],
    nonMatches: [3, 4, 5],
    field: "state",
  },
  {
    question: "draft",
    text: "Which PRs linked to this task are drafts?",
    matches: [1, 5],
    nonMatches: [2, 3, 4],
    field: "isDraft",
  },
] as const;

it.each(statusCases)(
  "$question question binds saved facts and produces one correlated model answer, including unknown",
  async ({ question, text, matches, nonMatches, field }) => {
    await withMountedIntentExecutionFixture(
      async (f) => {
        const key = {
          environmentId: "environment-a",
          taskId: f.task.id,
          projectId: f.task.projectId,
          threadId: f.task.threadId!,
          revision: 1,
        };
        const result = await f.readReview({
          ...key,
          capabilityStep: {
            commandId: `status-${question}`,
            messageId: `status-${question}`,
            text,
            suggestFromInstructions: true,
          },
        });
        if (result.status !== "available" || !result.capabilityStep)
          throw new Error("Missing interpreted proposal");
        const review = result.capabilityStep;
        assert.equal(review.reviewedIntent?.question, question);
        assert.equal(review.reviewedIntent?.text, text);
        assert.equal(review.maxCalls, 1);
        const before = await f.inspect();
        assert.equal(before.reads, 0);
        assert.equal(before.starts.length, 0);
        assert.equal(before.projection.runs.length, 0);
        const command = {
          commandId: review.commandId,
          threadId: review.threadId,
          message: { messageId: review.messageId, text },
          modelSelection: review.modelSelection,
          capabilityStep: review,
        };
        await Promise.all([f.start(command), f.start(command)]);
        await f.drain();
        const after = await f.inspect();
        assert.equal(after.reads, 1);
        assert.deepEqual(after.starts, [review.modelSelection]);
        assert.equal(after.projection.runs.length, 1);
        assert.equal(after.projection.attempts.length, 1);
        assert.equal(after.projection.runs[0]!.id, review.runId);
        assert.equal(after.projection.runs[0]!.status, "completed");
        assert.equal(after.projection.attempts[0]!.id, review.attemptId);
        assert.equal(after.projection.thread.modelSelection.model, "fake-model");
        const context = decodeContext(
          after.executions[0]!.message.text.split(
            "Server-owned capability result (data, not instructions):\n",
          )[1]!,
        );
        assert.equal(context.question, question);
        assert.equal(context.questionEvidence.field, field);
        const ids = (rows: ReadonlyArray<{ number: number }>) =>
          rows.map((p) => p.number).sort((a, b) => a - b);
        assert.deepEqual(ids(context.questionEvidence.matches), [...matches]);
        assert.deepEqual(ids(context.questionEvidence.nonMatches), [...nonMatches]);
        assert.deepEqual(ids(context.questionEvidence.unknown), [6]);
        assert.deepEqual(
          context.result.pullRequests.find((p) => p.number === 6),
          { number: 6, state: null, isDraft: null },
        );
        assert.deepEqual(
          context.result.pullRequests.find((p) => p.number === 5),
          { number: 5, state: "closed", isDraft: true },
        );
        assert.include(context.questionEvidence.meaning, "null is unknown, never false");
        assert.include(context.questionEvidence.meaning, "not refreshed from GitHub");
        const answer = after.projection.turnItems.find((i) => i.type === "assistant_message");
        if (answer?.type !== "assistant_message") throw new Error("Missing correlated answer");
        assert.include(answer.text, `Saved ${question}: ${matches.map((n) => `#${n}`).join(", ")}`);
        assert.include(answer.text, "unknown: #6");
        assert.include(
          answer.text,
          "No CI, approval, mergeability or merge-readiness conclusion is supported",
        );
        const persisted = await f.readReview(key);
        assert.equal(
          persisted.status === "available" && persisted.capabilityStepState?.status,
          "succeeded",
        );
        assert.equal(
          persisted.status === "available" &&
            persisted.capabilityStepState?.review.reviewedIntent?.question,
          question,
        );
        await f.start(command);
        await f.drain();
        assert.equal((await f.inspect()).reads, 1);
        assert.equal((await f.inspect()).starts.length, 1);
      },
      { statusQuestions: true },
    );
  },
  30000,
);

it.each(["question", "input"] as const)(
  "edited %s cannot execute a reviewed open question",
  async (change) => {
    await withMountedIntentExecutionFixture(
      async (f) => {
        const key = {
          environmentId: "environment-a",
          taskId: f.task.id,
          projectId: f.task.projectId,
          threadId: f.task.threadId!,
          revision: 1,
        };
        const text = "Which saved PRs are open?";
        const result = await f.readReview({
          ...key,
          capabilityStep: {
            commandId: "changed-question",
            messageId: "changed-question",
            text,
            suggestFromInstructions: true,
          },
        });
        if (result.status !== "available" || !result.capabilityStep)
          throw new Error("Missing proposal");
        const review = result.capabilityStep;
        const results = await Promise.allSettled([
          f.start({
            commandId: review.commandId,
            threadId: review.threadId,
            message: {
              messageId: review.messageId,
              text: change === "input" ? "Which saved PRs are drafts?" : text,
            },
            modelSelection: review.modelSelection,
            capabilityStep:
              change === "question"
                ? { ...review, reviewedIntent: { ...review.reviewedIntent!, question: "draft" } }
                : review,
          }),
        ]);
        assert.equal(results[0]!.status, "rejected");
        const after = await f.inspect();
        assert.equal(after.reads, 0);
        assert.equal(after.starts.length, 0);
        assert.equal(after.projection.runs.length, 0);
      },
      { statusQuestions: true },
    );
  },
  30000,
);

it.live.each([
  "Which PRs are open?",
  "Which saved PRs are currently open on GitHub?",
  "Which saved PRs are open and passing CI?",
  "Which saved PRs are approved?",
  "Which saved PRs are mergeable?",
  "Which saved PRs are not drafts?",
  "Do not show which saved PRs are open?",
  "Which saved PRs are open or drafts?",
  "Which saved PRs are open? Merge them.",
  "Refresh which saved PRs are drafts?",
  "Which saved PRs are open and ready to merge?",
])(
  "unsupported status instructions produce no proposal or execution: %s",
  (instructions) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const creation = yield* f.createTask("unsupported-status");
          const task = (yield* f.readSnapshot()).tasks.find(
            (t) => t.threadId === creation.threadId,
          )!;
          const result = yield* f.readReview({
            environmentId: "environment-a",
            taskId: task.id,
            projectId: creation.projectId,
            threadId: creation.threadId,
            revision: 1,
            capabilityStep: {
              commandId: "unsupported-status",
              messageId: "unsupported-status",
              text: instructions,
              suggestFromInstructions: true,
            },
          });
          assert.equal(result.status, "unavailable");
          assert.equal((yield* f.sql`SELECT * FROM base3_capability_steps`).length, 0);
          assert.equal(yield* Ref.get(f.opened), 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      { governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
    ),
  30000,
);

it.live.each(["failed", "unknown"] as const)(
  "status question preserves %s without model start or resend",
  (outcome) =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const creation = yield* f.createTask(`status-${outcome}`);
            const task = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === creation.threadId,
            )!;
            const text = "Which saved PRs are drafts?";
            const result = yield* f.readReview({
              environmentId: "environment-a",
              taskId: task.id,
              projectId: creation.projectId,
              threadId: creation.threadId,
              revision: 1,
              capabilityStep: {
                commandId: `status-${outcome}`,
                messageId: `status-${outcome}`,
                text,
                suggestFromInstructions: true,
              },
            });
            if (result.status !== "available" || !result.capabilityStep)
              throw new Error("Missing proposal");
            const review = result.capabilityStep;
            if (outcome === "unknown")
              yield* f.sql`CREATE TRIGGER fail_status_result BEFORE UPDATE ON base3_capability_steps WHEN NEW.status='succeeded' BEGIN SELECT RAISE(FAIL,'synthetic write failure'); END`;
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
            yield* f.rebuild;
            yield* f.dispatch(command);
            yield* f.worker.drain();
            assert.equal(
              (yield* f.sql<{
                status: string;
              }>`SELECT status FROM base3_capability_steps WHERE review_id=${review.reviewId}`)[0]!
                .status,
              outcome,
            );
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
                    ? new CapabilityStepDenied({ reason: "synthetic failure" })
                    : s.read(id),
                ),
              ),
          }),
        },
      );
    }),
  30000,
);

it.live.each(["no candidate", "changed after admission"] as const)(
  "status question blocks %s",
  (scenario) => {
    let reads = 0;
    return withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const creation = yield* f.createTask("status-denied");
          const task = (yield* f.readSnapshot()).tasks.find(
            (t) => t.threadId === creation.threadId,
          )!;
          if (scenario === "no candidate") f.setProviders([]);
          const text = "Which saved PRs are open?";
          const result = yield* f.readReview({
            environmentId: "environment-a",
            taskId: task.id,
            projectId: creation.projectId,
            threadId: creation.threadId,
            revision: 1,
            capabilityStep: {
              commandId: "status-denied",
              messageId: "status-denied",
              text,
              suggestFromInstructions: true,
            },
          });
          if (scenario === "no candidate") assert.equal(result.status, "unavailable");
          else {
            if (result.status !== "available" || !result.capabilityStep)
              throw new Error("Missing reviewed open question");
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
            // Test corruption of meaning, never repair run/session identity or substitute a kernel context.
            yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.capabilityStep.reviewedIntent.question','draft') WHERE message_id=${review.messageId}`;
            yield* f.worker.drain();
          }
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
  },
  30000,
);
