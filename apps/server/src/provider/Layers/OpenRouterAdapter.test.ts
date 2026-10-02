// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  OPENROUTER_AUTO_SLUG,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeOpenRouterAdapter } from "./OpenRouterAdapter.ts";
import type { OpenRouterTransport } from "../../openRouter/OpenRouterTransport.ts";

const instanceId = ProviderInstanceId.make("openrouter");
const threadId = ThreadId.make("openrouter-thread");

const chatFixture = (model: string) => ({
  id: "gen-lab",
  model,
  choices: [{ message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  openrouter_metadata: {
    requested: OPENROUTER_AUTO_SLUG,
    attempts: [{ provider: "Anthropic", model, status: 200 }],
    pipeline: [{ type: "router", data: { task_type: "code:debugging" } }],
  },
});

const jsonTransport =
  (status: number, body: unknown): OpenRouterTransport =>
  async () => ({
    status,
    headers: {},
    text: async () => JSON.stringify(body),
  });

const collectCompletedTurn = (streamEvents: Stream.Stream<ProviderRuntimeEvent>) =>
  streamEvents.pipe(
    Stream.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed",
    ),
    Stream.take(1),
    Stream.runCollect,
  );

const collectTurnEvents = (streamEvents: Stream.Stream<ProviderRuntimeEvent>) =>
  streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed"),
    Stream.runCollect,
  );

const streamTransport =
  (chunks: ReadonlyArray<unknown>): OpenRouterTransport =>
  async () => ({
    status: 200,
    headers: {},
    text: async () => "",
    stream: async function* () {
      for (const chunk of chunks) {
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      yield "data: [DONE]\n\n";
    },
  });

describe("OpenRouter adapter", () => {
  it.effect("fails sendTurn without an API key", () =>
    Effect.gen(function* () {
      const adapter = yield* makeOpenRouterAdapter({ instanceId, apiKey: undefined });
      const started = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });
      expect(started.provider).toBe("openrouter");
      const result = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails safely when the actual model is outside the allowlist", () =>
    Effect.gen(function* () {
      const adapter = yield* makeOpenRouterAdapter({
        instanceId,
        apiKey: "sk-or-v1-not-a-real-key",
        transport: jsonTransport(200, chatFixture("openai/gpt-4o")),
        allowedModels: ["anthropic/claude-sonnet-4.5"],
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const pending = yield* collectCompletedTurn(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        openRouter: { allowedModels: ["anthropic/claude-sonnet-4.5"], costTier: "medium" },
      });
      const events = yield* Fiber.join(pending);
      const payload = events[0]?.payload;
      expect(payload?.state).toBe("failed");
      expect(payload?.openRouter?.status).toBe("policy_violation");
      expect(JSON.stringify(payload)).not.toContain("sk-or-v1-not-a-real-key");
      expect(JSON.stringify(payload)).not.toContain("hello");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the actual model and nested OpenRouter attempts as one Base3 attempt", () =>
    Effect.gen(function* () {
      const adapter = yield* makeOpenRouterAdapter({
        instanceId,
        apiKey: "sk-or-v1-not-a-real-key",
        transport: jsonTransport(200, chatFixture("anthropic/claude-sonnet-4.5")),
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const pending = yield* collectCompletedTurn(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.sendTurn({
        threadId,
        input: "debug this stack trace",
        openRouter: { allowedModels: ["anthropic/claude-sonnet-4.5"], costTier: "low" },
      });
      const events = yield* Fiber.join(pending);
      const observation = events[0]?.payload.openRouter;
      expect(events[0]?.payload.state).toBe("completed");
      expect(observation?.actualExecutionModel).toBe("anthropic/claude-sonnet-4.5");
      expect(observation?.nestedFallbacks).toHaveLength(1);
      expect(observation?.nestedFallbacks[0]?.origin).toBe("openrouter_internal");
      expect(JSON.stringify(observation)).not.toContain("sk-or-");
      expect(JSON.stringify(observation)).not.toContain("debug this stack trace");
      expect(JSON.stringify(observation)).not.toContain('"ok"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("emits zero content deltas when a disallowed model follows content", () =>
    Effect.gen(function* () {
      const adapter = yield* makeOpenRouterAdapter({
        instanceId,
        apiKey: "sk-or-v1-not-a-real-key",
        transport: streamTransport([
          { choices: [{ delta: { content: "leaked-content" } }] },
          { model: "openai/gpt-4o", choices: [{ delta: { content: " more" } }] },
        ]),
        allowedModels: ["anthropic/claude-sonnet-4.5"],
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const pending = yield* collectTurnEvents(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        openRouter: { allowedModels: ["anthropic/claude-sonnet-4.5"], costTier: "medium" },
      });
      const events = [...(yield* Fiber.join(pending))];
      expect(events.some((event) => event.type === "content.delta")).toBe(false);
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.type === "turn.completed" ? completed.payload.state : undefined).toBe(
        "failed",
      );
      expect(
        completed?.type === "turn.completed" ? completed.payload.openRouter?.status : undefined,
      ).toBe("policy_violation");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("streams content after an allowed actual model is identified", () =>
    Effect.gen(function* () {
      const adapter = yield* makeOpenRouterAdapter({
        instanceId,
        apiKey: "sk-or-v1-not-a-real-key",
        transport: streamTransport([
          { model: "anthropic/claude-sonnet-4.5", choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
        ]),
        allowedModels: ["anthropic/claude-sonnet-4.5"],
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const pending = yield* collectTurnEvents(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        openRouter: { allowedModels: ["anthropic/claude-sonnet-4.5"], costTier: "low" },
      });
      const events = [...(yield* Fiber.join(pending))];
      const deltas = events.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );
      expect(deltas.join("")).toBe("Hello");
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.type === "turn.completed" ? completed.payload.state : undefined).toBe(
        "completed",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
