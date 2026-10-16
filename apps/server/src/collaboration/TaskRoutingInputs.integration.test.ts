import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  LOCAL_TASK_CLASSIFIER_VERSION,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "./testkit/agentsTaskCreationFixture.ts";

// Read through the public snapshot even on the exact base, where this field is absent.
const inputsOf = (route: unknown) =>
  (route as { recordedInputs?: unknown } | undefined)?.recordedInputs;
const profile = (category: string) => ({
  status: "available",
  category,
  source: "local-heuristic",
  classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
});
const image: ChatAttachment = {
  type: "image",
  id: "original-image",
  name: "/private/secret-filename.png",
  mimeType: "image/png",
  sizeBytes: 1,
};

it.live.each(["auto", "manual"] as const)(
  "recorded routing inputs actual execution %s category and image facts",
  (mode) =>
    withTaskResultLinkageFixture((f) =>
      Effect.gen(function* () {
        const p = agentsCreationProvider;
        f.setProviders([
          { ...p, models: p.models.map((m) => ({ ...m, inputModalities: ["text", "image"] })) },
        ]);
        const c = yield* f.createTask(`inputs-${mode}`);
        for (const [index, text, category, attachments] of [
          [0, "debug stack trace PROMPT_SENTINEL", "debugging", []],
          [1, "write an email PROMPT_SENTINEL", "writing", []],
          [2, "PROMPT_SENTINEL", "unknown", [image]],
        ] as const) {
          const key = `inputs-${mode}-${index}`;
          const routing = {
            routingMode: mode,
            text,
            attachments,
            ...(mode === "manual"
              ? { modelSelection: { instanceId: p.instanceId, model: p.models[0]!.slug } }
              : {}),
          };
          yield* f.execute(c, key, routing);
          const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
          const route = task.routingReadout;
          assert.equal(route?.status, "available");
          if (route?.status !== "available") throw new Error("No route");
          assert.equal(route.messageId, key);
          assert.equal(route.mode, mode);
          assert.deepEqual(inputsOf(route), {
            profile: profile(category),
            facts: {
              status: "available",
              attachmentCount: attachments.length,
              contextKinds: [],
              unsupportedContextKind: false,
              requiredCapabilities: mode === "auto" && attachments.length ? ["vision"] : [],
            },
          });
          if (mode === "auto") assert.equal(route.selectionBasis?.outcome, "single");
          const actual = (yield* Ref.get(f.executions)).find(
            (e) => e.message.text === text && e.runId === route.runId,
          )!;
          assert.exists(actual);
          assert.deepEqual(actual.message.attachments, attachments);
          const result = task.resultReadout;
          assert.equal(result?.status, "available");
          if (result?.status !== "available") throw new Error("No result");
          assert.equal(result.runId, actual.runId);
          assert.equal(result.attemptId, actual.attemptId);
          assert.equal(result.messageId, key);
          const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
          const run = projection.runs.find((r) => r.id === result.runId)!;
          const attempt = projection.attempts.find((a) => a.id === result.attemptId)!;
          assert.equal(run.activeAttemptId, attempt.id);
          assert.equal(attempt.providerTurnId, result.providerTurnId);
          const grants = yield* f.sql`SELECT * FROM base3_execution_grants WHERE message_id=${key}`;
          assert.equal(grants.length, 1);
          const before = yield* f.sql`SELECT total_changes() AS n`;
          const tables =
            yield* f.sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
          assert.isAbove(tables.length, 0);
          assert.deepEqual(
            (yield* f.readSnapshot()).tasks.find((t) => t.id === task.id)?.routingReadout,
            route,
          );
          assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, before);
          const encoded = JSON.stringify(inputsOf(route));
          for (const sentinel of [
            "PROMPT_SENTINEL",
            "/private/",
            "secret-filename",
            "original-image",
            "Linked task output",
          ])
            assert.notInclude(encoded, sentinel);
          yield* f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId: c.threadId,
            messageId: MessageId.make(key),
            ...routing,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, index + 1);
        }
      }),
    ),
);
