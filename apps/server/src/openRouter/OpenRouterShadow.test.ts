// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { runOpenRouterShadowObservation } from "./OpenRouterShadow.ts";
import type { OpenRouterTransport } from "./OpenRouterTransport.ts";

const fixture = {
  id: "gen-shadow",
  model: "anthropic/claude-sonnet-4.5",
  choices: [{ message: { role: "assistant", content: "discard-this-completion" } }],
  usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, cost: 0.001 },
  openrouter_metadata: {
    pipeline: [{ type: "router", data: { task_type: "code:debugging" } }],
  },
};

describe("OpenRouter Shadow observation", () => {
  it.effect("stores sanitized fields and discards completion content", () =>
    Effect.gen(function* () {
      const transport: OpenRouterTransport = async () => ({
        status: 200,
        headers: {},
        text: async () => JSON.stringify(fixture),
      });
      const observation = yield* runOpenRouterShadowObservation({
        apiKey: "sk-or-v1-not-a-real-key",
        prompt: "debug this stack trace without secrets",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        costTier: "low",
        base3Model: "gpt-5.5",
        transport,
      });
      expect(observation.status).toBe("observed");
      expect(observation.guidanceMode).toBe("shadow");
      expect(observation.openRouterSuggested).toBe("anthropic/claude-sonnet-4.5");
      expect(observation.agreement).toBe("disagreement");
      expect(JSON.stringify(observation)).not.toContain("discard-this-completion");
      expect(JSON.stringify(observation)).not.toContain("debug this stack trace without secrets");
      expect(JSON.stringify(observation)).not.toContain("sk-or-v1-not-a-real-key");
    }),
  );

  it.effect("shadow transport failure stays a failed observation", () =>
    Effect.gen(function* () {
      const transport: OpenRouterTransport = async () => ({
        status: 401,
        headers: {},
        text: async () => JSON.stringify({ error: { message: "revoked" } }),
      });
      const observation = yield* runOpenRouterShadowObservation({
        apiKey: "sk-or-v1-not-a-real-key",
        prompt: "hello",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        transport,
      });
      expect(observation.status).toBe("failed");
      expect(observation.errorCategory).toBe("authentication_failed");
    }),
  );

  it.effect("interrupting the turn aborts Shadow transport without waiting for timeout", () =>
    Effect.gen(function* () {
      let aborted = false;
      let continuedAfterAbort = false;
      const controller = new AbortController();
      const transport: OpenRouterTransport = async (request) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            continuedAfterAbort = true;
            reject(new Error("timeout"));
          }, 15_000);
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(timer);
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
        return { status: 200, headers: {}, text: async () => "" };
      };
      const fiber = yield* runOpenRouterShadowObservation({
        apiKey: "sk-or-v1-not-a-real-key",
        prompt: "debug this stack trace without secrets",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        transport,
        signal: controller.signal,
      }).pipe(Effect.forkChild);
      controller.abort("cancelled");
      const observation = yield* Fiber.join(fiber);
      expect(aborted).toBe(true);
      expect(continuedAfterAbort).toBe(false);
      expect(observation.status).toBe("skipped");
      expect(observation.skipReason).toBe("cancelled");
      expect(observation.errorCategory).toBe("cancelled");
      expect(JSON.stringify(observation)).not.toContain("debug this stack trace without secrets");
      expect(JSON.stringify(observation)).not.toContain("sk-or-v1-not-a-real-key");
    }),
  );

  it.effect("timeout still aborts Shadow when the user does not cancel", () =>
    Effect.gen(function* () {
      const transport: OpenRouterTransport = async (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        });
      const observation = yield* runOpenRouterShadowObservation({
        apiKey: "sk-or-v1-not-a-real-key",
        prompt: "hello",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        transport,
        timeoutMs: 20,
      });
      expect(observation.status).toBe("skipped");
      expect(observation.skipReason).toBe("timeout");
    }),
  );
});
