// @effect-diagnostics preferSchemaOverJson:off
import { OPENROUTER_API_KEY_ENV, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { createOpenRouterClient } from "./OpenRouterClient.ts";
import { makeOpenRouterCatalogService } from "./OpenRouterCatalogService.ts";
import type { OpenRouterTransport } from "./OpenRouterTransport.ts";

const okTransport =
  (calls: { count: number }): OpenRouterTransport =>
  async (request) => {
    calls.count += 1;
    if (request.url.includes("/api/v1/models")) {
      return {
        status: 200,
        headers: {},
        text: async () => JSON.stringify({ data: [{ id: "openai/gpt-5" }] }),
      };
    }
    return {
      status: 200,
      headers: {},
      text: async () =>
        JSON.stringify({
          data: { as_of: "2026-06-17", window_days: 7, classifications: [] },
        }),
    };
  };

describe("OpenRouter catalog runtime lifecycle", () => {
  it.effect("makes zero network calls when OpenRouter is unconfigured", () =>
    Effect.gen(function* () {
      const calls = { count: 0 };
      const service = yield* makeOpenRouterCatalogService({
        transport: okTransport(calls),
      });
      const first = yield* service.ensureFresh;
      const freshness = yield* service.freshness;
      yield* service.awaitIdle;
      expect(first).toBeNull();
      expect(freshness.status).toBe("unknown");
      expect(calls.count).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("makes zero network calls when guidance mode is off even with a key", () =>
    Effect.gen(function* () {
      const calls = { count: 0 };
      const service = yield* makeOpenRouterCatalogService({
        transport: okTransport(calls),
      });
      yield* service.ensureFresh;
      yield* service.awaitIdle;
      expect(calls.count).toBe(0);
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({
          openRouter: { guidanceMode: "off" },
          providerInstances: {
            [ProviderInstanceId.make("openrouter")]: {
              driver: ProviderDriverKind.make("openrouter"),
              environment: [
                { name: OPENROUTER_API_KEY_ENV, value: "sk-or-v1-not-a-real-key", sensitive: true },
              ],
            },
          },
        }),
      ),
      Effect.scoped,
    ),
  );

  it.effect("refreshes once on first configured access and deduplicates concurrent reads", () =>
    Effect.gen(function* () {
      const calls = { count: 0 };
      const service = yield* makeOpenRouterCatalogService({
        apiKey: "sk-or-v1-not-a-real-key",
        transport: okTransport(calls),
        ttlMs: 5_000,
        nowMs: () => 1_000,
      });
      const [a, b] = yield* Effect.all([service.ensureFresh, service.ensureFresh], {
        concurrency: 2,
      });
      expect(a).toBeNull();
      expect(b).toBeNull();
      yield* service.awaitIdle;
      const snapshot = yield* service.peek;
      expect(snapshot?.freshness).toBe("fresh");
      expect(snapshot?.asOf).toBe("2026-06-17");
      expect(calls.count).toBe(2);
      const cached = yield* service.ensureFresh;
      expect(cached?.freshness).toBe("fresh");
      expect(calls.count).toBe(2);
      expect(JSON.stringify(snapshot)).not.toContain("sk-or-v1-not-a-real-key");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "returns last-known-good immediately and refreshes expired cache in the background",
    () =>
      Effect.gen(function* () {
        const calls = { count: 0 };
        let now = 1_000;
        const service = yield* makeOpenRouterCatalogService({
          apiKey: "sk-or-v1-not-a-real-key",
          transport: okTransport(calls),
          ttlMs: 5_000,
          nowMs: () => now,
        });
        yield* service.ensureFresh;
        yield* service.awaitIdle;
        expect(calls.count).toBe(2);
        now = 10_000;
        const stale = yield* service.ensureFresh;
        expect(stale?.asOf).toBe("2026-06-17");
        yield* service.awaitIdle;
        expect(calls.count).toBe(4);
      }).pipe(Effect.scoped),
  );

  it.effect("preserves stale last-known-good and uses unknown when there is no prior data", () =>
    Effect.gen(function* () {
      let fail = false;
      const calls = { count: 0 };
      let now = 1_000;
      const transport: OpenRouterTransport = async (request) => {
        calls.count += 1;
        if (fail) return { status: 500, headers: {}, text: async () => "" };
        return okTransport({ count: 0 })(request);
      };
      const empty = yield* makeOpenRouterCatalogService({
        apiKey: "sk-or-v1-not-a-real-key",
        transport: async () => ({ status: 500, headers: {}, text: async () => "" }),
        ttlMs: 5_000,
        nowMs: () => 1_000,
      });
      yield* empty.ensureFresh;
      yield* empty.awaitIdle;
      const unknown = yield* empty.peek;
      expect(unknown?.freshness ?? "unknown").toBe("unknown");

      const service = yield* makeOpenRouterCatalogService({
        apiKey: "sk-or-v1-not-a-real-key",
        transport,
        ttlMs: 5_000,
        nowMs: () => now,
      });
      yield* service.ensureFresh;
      yield* service.awaitIdle;
      fail = true;
      now = 10_000;
      const previous = yield* service.ensureFresh;
      expect(previous?.asOf).toBe("2026-06-17");
      yield* service.awaitIdle;
      const stale = yield* service.peek;
      expect(stale?.freshness).toBe("stale");
      expect(stale?.asOf).toBe("2026-06-17");
    }).pipe(Effect.scoped),
  );

  it.effect("does not block the caller while a refresh is in flight and cancels on shutdown", () =>
    Effect.gen(function* () {
      let aborted = false;
      let entered = false;
      let releaseEnter: (() => void) | undefined;
      const enteredPromise = new Promise<void>((resolve) => {
        releaseEnter = resolve;
      });
      const transport: OpenRouterTransport = async (request) => {
        entered = true;
        releaseEnter?.();
        return await new Promise((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      };
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeOpenRouterCatalogService({
            apiKey: "sk-or-v1-not-a-real-key",
            transport,
            ttlMs: 5_000,
            nowMs: () => 1_000,
          });
          const immediate = yield* service.ensureFresh;
          yield* Effect.promise(() => enteredPromise);
          return immediate;
        }),
      );
      expect(snapshot).toBeNull();
      expect(entered).toBe(true);
      expect(aborted).toBe(true);
    }),
  );

  it("does not construct a live fetch client in catalog unit tests", () => {
    const client = createOpenRouterClient({
      apiKey: "sk-or-v1-not-a-real-key",
      transport: okTransport({ count: 0 }),
    });
    expect(typeof client.listModels).toBe("function");
  });
});
