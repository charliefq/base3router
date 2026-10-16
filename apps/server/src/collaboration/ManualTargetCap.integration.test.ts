import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  DispatcherTaskRouteBinding,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "./testkit/agentsTaskCreationFixture.ts";

it.live.each([false, true])("Manual target cap persisted execution and Tasks queued=%s", (queued) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const p = agentsCreationProvider;
          f.setProviders([
            {
              ...p,
              models: [
                ...Array.from({ length: 74 }, (_, i) => ({
                  ...p.models[0]!,
                  slug: `aaa-${String(i).padStart(2, "0")}`,
                  isDefault: false,
                })),
                { ...p.models[0]!, isDefault: false },
              ],
            },
          ]);
          const c = yield* f.createTask(`manual-cap-${queued}`);
          const selection: ModelSelection = {
            instanceId: p.instanceId,
            model: p.models[0]!.slug,
            options: [{ id: "reasoningEffort", value: "high" }],
          };
          let foreground: Fiber.Fiber<void, Error> | undefined;
          if (queued) {
            foreground = yield* f
              .execute(c, "foreground", {
                routingMode: "manual",
                modelSelection: { ...selection, model: "aaa-00" },
              })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(reached);
          }
          const key = `manual-cap-message-${queued}`;
          yield* f.execute(
            c,
            key,
            {
              routingMode: "manual",
              modelSelection: selection,
              dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
            },
            () =>
              Effect.gen(function* () {
                const recorded = yield* f.sql<{
                  binding_json: string;
                }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE message_id=${key}`;
                const binding = yield* Schema.decodeEffect(
                  Schema.fromJsonString(DispatcherTaskRouteBinding),
                )(recorded[0]!.binding_json);
                assert.equal(binding.modelRoute?.mode, "manual");
                assert.equal(binding.modelRoute?.selectionBasis?.outcome, "manual-accepted");
                assert.deepEqual(
                  binding.modelRoute?.selectionBasis?.selectedTarget,
                  binding.target,
                );
                assert.deepEqual(binding.modelRoute?.selected?.target, binding.target);
                assert.equal(
                  binding.modelRoute?.candidates.filter((c) => c.target.model === selection.model)
                    .length,
                  1,
                );
                if (queued) {
                  const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
                  assert.equal(
                    projection.runs.find((r) => r.userMessageId === key)?.status,
                    "queued",
                  );
                  yield* Deferred.succeed(release, undefined);
                }
              }),
          );
          if (foreground) yield* Fiber.join(foreground);
          const executions = yield* Ref.get(f.executions);
          const input = executions.find((e) => e.message.text === key)!;
          assert.deepEqual(input.modelSelection, selection);
          const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
          const route = task.routingReadout;
          assert.equal(route?.status, "available");
          if (route?.status !== "available") throw new Error("Missing route");
          assert.equal(route.mode, "manual");
          assert.deepEqual(route.selected, {
            instanceId: selection.instanceId,
            model: selection.model,
          });
          assert.equal(route.selectionBasis?.outcome, "manual-accepted");
          assert.deepEqual(route.selectionBasis?.selectedTarget, route.selected);
          assert.include(route.explanation!, "Manual selection");
          const result = task.resultReadout;
          assert.equal(result?.status, "available");
          if (result?.status !== "available") throw new Error("Missing result");
          assert.equal(result.runId, input.runId);
          assert.equal(result.attemptId, input.attemptId);
          assert.equal(result.messageId, key);
          assert.equal(result.content.status, "output");
          const grants = yield* f.sql<{
            grant_id: string;
            thread_id: string;
            message_id: string;
          }>`SELECT grant_id,thread_id,message_id FROM base3_execution_grants WHERE message_id=${key}`;
          assert.equal(grants.length, 1);
          assert.equal(grants[0]!.grant_id, `grant:message:${c.threadId}:${result.messageId}`);
          assert.equal(grants[0]!.thread_id, input.threadId);

          const bindings = yield* f.sql<{
            binding_json: string;
          }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE message_id=${key}`;
          assert.include(bindings[0]!.binding_json, '"mode":"manual"');
          const writes = yield* f.sql`SELECT total_changes() AS n`;
          assert.deepEqual(
            (yield* f.readSnapshot()).tasks.find((t) => t.id === task.id)?.routingReadout,
            route,
          );
          assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, writes);
          yield* f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId: c.threadId,
            messageId: MessageId.make(key),
            text: key,
            attachments: [],
            routingMode: "manual",
            modelSelection: selection,
            dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, queued ? 2 : 1);
        }),
      {
        onStart: (input, events, emit) =>
          Effect.gen(function* () {
            if (input.message.text === "foreground") {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
            }
            yield* Effect.forEach(events, emit, { discard: true });
          }),
      },
    );
  }),
);
