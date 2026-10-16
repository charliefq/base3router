import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeOpenRouterAdapter } from "./OpenRouterAdapterV2.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2TurnInput } from "../ProviderAdapter.ts";

const instanceId = ProviderInstanceId.make("openrouter-fixture");
const threadId = ThreadId.make("openrouter-fixture-thread");
const modelSelection = { instanceId, model: "openrouter/auto" };
const runtimePolicy = {
  cwd: "/tmp",
  interactionMode: "default" as const,
  runtimeMode: "approval-required" as const,
};
const fixture = (options: {
  key?: string | null;
  keyEffect?: Effect.Effect<string | null>;
  enabled?: boolean;
  fetch: typeof globalThis.fetch;
}) =>
  Effect.gen(function* () {
    const adapter = makeOpenRouterAdapter({
      instanceId,
      enabled: options.enabled ?? true,
      models: [modelSelection.model],
      apiKey:
        options.keyEffect ??
        Effect.succeed(options.key === undefined ? "synthetic-key" : options.key),
      fetch: options.fetch,
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("fixture-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("fixture-project"),
      title: "LOCAL/FIXTURE",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const input: ProviderAdapterV2TurnInput = {
      appThread,
      threadId,
      runId: RunId.make("fixture-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("fixture-attempt"),
      rootNodeId: NodeId.make("fixture-root"),
      providerThread,
      message: {
        messageId: MessageId.make("fixture-message"),
        text: "LOCAL/FIXTURE prompt",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection,
      runtimePolicy,
    };
    const events: ProviderAdapterV2Event[] = [];
    const complete = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") yield* Deferred.succeed(complete, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    return { adapter, runtime, input, events, complete };
  });

it.live.each([401, 429, 500, 200])(
  "LOCAL/FIXTURE adapter failure settles once without inventing success (%s)",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        let requests = 0;
        const f = yield* fixture({
          fetch: async () => {
            requests++;
            return new Response("data: broken\n\n", {
              status,
              headers: { "content-type": "text/event-stream" },
            });
          },
        });
        yield* f.runtime.startTurn(f.input);
        yield* Deferred.await(f.complete);
        yield* f.runtime.startTurn(f.input); // exact attempt replay
        assert.equal(requests, 1);
        const terminal = f.events.filter((e) => e.type === "turn.terminal");
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0]?.status, "failed");
        const turn = f.events.filter((e) => e.type === "provider_turn.updated").at(-1);
        assert.equal(turn?.providerTurn.terminationConfirmed, false);
        assert.deepEqual(turn?.providerTurn.modelIdentity, { requested: "openrouter/auto" });
        assert.isUndefined(turn?.providerTurn.reportedCostUsd);
      }),
    ),
);

it.live.each(["missing-key", "disabled", "image", "plan", "options"])(
  "LOCAL/FIXTURE %s rejects before HTTP",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        let requests = 0;
        const f = yield* fixture({
          key: reason === "missing-key" ? null : "fixture-key",
          enabled: reason !== "disabled",
          fetch: async () => {
            requests++;
            throw new Error("must not dispatch");
          },
        });
        const input = {
          ...f.input,
          ...(reason === "image"
            ? {
                message: {
                  ...f.input.message,
                  attachments: [
                    {
                      type: "image" as const,
                      id: "fixture-image",
                      name: "fixture.png",
                      mimeType: "image/png",
                      sizeBytes: 1,
                    },
                  ],
                },
              }
            : {}),
          ...(reason === "plan"
            ? { runtimePolicy: { ...runtimePolicy, interactionMode: "plan" as const } }
            : {}),
          ...(reason === "options"
            ? { modelSelection: { ...modelSelection, options: [{ id: "tools", value: true }] } }
            : {}),
        };
        const result = yield* Effect.exit(f.runtime.startTurn(input));
        assert.equal(result._tag, "Failure");
        assert.equal(requests, 0);
      }),
    ),
);

it.live(
  "LOCAL/FIXTURE cancellation aborts once, retains unknown termination, and replay never starts again",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let requests = 0;
        let aborted = false;
        const received = yield* Deferred.make<void>();
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          requests++;
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => {
              aborted = true;
              reject(new Error("abort"));
            };
            init?.signal?.addEventListener("abort", abort, { once: true });
            if (init?.signal?.aborted) abort();
            Deferred.doneUnsafe(received, Effect.void);
          });
        };
        const f = yield* fixture({ fetch });
        yield* f.runtime.startTurn(f.input);
        yield* Deferred.await(received);
        const turn = f.events.find((e) => e.type === "provider_turn.updated");
        if (!turn || turn.type !== "provider_turn.updated") throw new Error("Missing turn");
        yield* f.runtime.interruptTurn({
          providerThread: f.input.providerThread,
          providerTurnId: turn.providerTurn.id,
        });
        yield* Deferred.await(f.complete);
        yield* f.runtime.startTurn(f.input);
        assert.isTrue(aborted);
        assert.equal(requests, 1);
        assert.equal(f.events.filter((e) => e.type === "turn.terminal").length, 1);
      }),
    ),
);

it.live.each([undefined, "openrouter/auto"])(
  "LOCAL/FIXTURE missing or echoed router identity remains unknown (%s)",
  (model) =>
    Effect.scoped(
      Effect.gen(function* () {
        const body =
          model === undefined
            ? 'data: {"choices":[{"delta":{"content":"fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            : 'data: {"model":"openrouter/auto","choices":[{"delta":{"content":"fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
        const f = yield* fixture({
          fetch: async () =>
            new Response(body, { headers: { "content-type": "text/event-stream" } }),
        });
        yield* f.runtime.startTurn(f.input);
        yield* Deferred.await(f.complete);
        const turn = f.events.filter((event) => event.type === "provider_turn.updated").at(-1);
        assert.equal(turn?.providerTurn.status, "completed");
        assert.isUndefined(turn?.providerTurn.modelIdentity?.resolved);
        assert.isUndefined(turn?.providerTurn.turnTokenUsage);
        assert.isUndefined(turn?.providerTurn.reportedCostUsd);
      }),
    ),
);

it.live(
  "LOCAL/FIXTURE concurrent replay reserves the attempt before credential access yields",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const key = yield* Deferred.make<string>();
        let requests = 0;
        const f = yield* fixture({
          keyEffect: Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(key))),
          fetch: async () => {
            requests++;
            return new Response(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
        const first = yield* f.runtime.startTurn(f.input).pipe(Effect.forkScoped);
        yield* Deferred.await(reading);
        yield* f.runtime.startTurn(f.input);
        yield* Deferred.succeed(key, "fixture-key");
        yield* Fiber.join(first);
        yield* Deferred.await(f.complete);
        assert.equal(requests, 1);
      }),
    ),
);

it.live(
  "LOCAL/FIXTURE interrupted output persists as failed partial text without a streaming spinner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture({
          fetch: async () =>
            new Response('data: {"choices":[{"delta":{"content":"partial fixture"}}]}\n\n', {
              headers: { "content-type": "text/event-stream" },
            }),
        });
        yield* f.runtime.startTurn(f.input);
        yield* Deferred.await(f.complete);
        const items = f.events.filter((e) => e.type === "turn_item.updated");
        const last = items.at(-1)?.turnItem;
        assert.equal(last?.status, "failed");
        if (last?.type !== "assistant_message") throw new Error("Missing partial assistant text");
        assert.isFalse(last.streaming);
        assert.equal(last.text, "partial fixture");
      }),
    ),
);
