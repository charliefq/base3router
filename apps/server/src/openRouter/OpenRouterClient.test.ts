// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import {
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_AUTO_ROUTER_PLUGIN_ID,
  OPENROUTER_CHAT_COMPLETIONS_PATH,
  OPENROUTER_METADATA_HEADER,
} from "@t3tools/contracts";

import { createOpenRouterClient } from "./OpenRouterClient.ts";
import type { OpenRouterTransport } from "./OpenRouterTransport.ts";
import * as Effect from "effect/Effect";

import {
  catalogFreshness,
  loadOpenRouterCatalog,
  makeOpenRouterCatalogStore,
  refreshOpenRouterCatalog,
} from "./OpenRouterCatalog.ts";

const chatFixture = {
  id: "gen-lab",
  model: "anthropic/claude-sonnet-4.5",
  choices: [{ message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
  openrouter_metadata: {
    requested: "openrouter/auto",
    strategy: "auto",
    attempts: [{ provider: "Anthropic", model: "anthropic/claude-sonnet-4.5", status: 200 }],
    pipeline: [{ type: "router", data: { task_type: "code:debugging" } }],
  },
};

const fakeTransport = (handler: OpenRouterTransport): OpenRouterTransport => handler;

describe("OpenRouter client", () => {
  it("sends ZDR privacy defaults and captures terminal streaming metadata", async () => {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    const client = createOpenRouterClient({
      apiKey: "sk-or-v1-not-a-real-key",
      transport: fakeTransport(async (request) => {
        capturedBody = request.body ?? "";
        capturedHeaders = { ...request.headers };
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
          `data: ${JSON.stringify(chatFixture)}\n\n`,
          "data: [DONE]\n\n",
        ];
        return {
          status: 200,
          headers: {},
          text: async () => JSON.stringify(chatFixture),
          stream: async function* () {
            for (const frame of frames) yield frame;
          },
        };
      }),
    });
    const result = await client.chat({
      prompt: "debug this stack trace",
      allowedModels: ["anthropic/claude-sonnet-4.5"],
      costTier: "medium",
      stream: true,
      shadow: false,
    });
    const body = JSON.parse(capturedBody) as {
      readonly provider: { readonly zdr: boolean; readonly data_collection: string };
      readonly plugins: ReadonlyArray<{ readonly id: string }>;
    };
    expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(body.plugins.map((plugin) => plugin.id)).toEqual([OPENROUTER_AUTO_ROUTER_PLUGIN_ID]);
    expect(capturedBody).not.toContain("tools");
    expect(capturedHeaders[OPENROUTER_METADATA_HEADER]).toBe("enabled");
    expect(capturedHeaders.Authorization).toContain("Bearer ");
    expect(result.model).toBe("anthropic/claude-sonnet-4.5");
    expect(result.content).toContain("Hel");
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-not-a-real-key");
  });

  it("paginates models and keeps last-known-good stale catalog", async () => {
    const pages = [
      Array.from({ length: 500 }, (_, index) => ({ id: `openai/page-0-${index}` })),
      [{ id: "openai/page-1-0" }],
    ];
    let page = 0;
    const client = createOpenRouterClient({
      apiKey: "sk-or-v1-not-a-real-key",
      transport: fakeTransport(async (request) => {
        if (request.url.includes("/api/v1/models")) {
          const data = pages[page] ?? [];
          page += 1;
          return {
            status: 200,
            headers: {},
            text: async () => JSON.stringify({ data }),
          };
        }
        if (request.url.includes("/api/v1/classifications/task")) {
          return {
            status: 200,
            headers: {},
            text: async () =>
              JSON.stringify({
                data: { as_of: "2026-06-17", window_days: 7, classifications: [] },
              }),
          };
        }
        return { status: 500, headers: {}, text: async () => "" };
      }),
    });
    const models = await client.listModels();
    expect(models.data).toHaveLength(501);
    const fresh = await refreshOpenRouterCatalog({
      client,
      nowIso: "2026-10-01T00:00:00.000Z",
      previous: null,
    });
    expect(fresh.asOf).toBe("2026-06-17");
    expect(fresh.freshness).toBe("fresh");
    const failing = createOpenRouterClient({
      apiKey: "sk-or-v1-not-a-real-key",
      transport: fakeTransport(async () => ({ status: 500, headers: {}, text: async () => "" })),
    });
    const stale = await refreshOpenRouterCatalog({
      client: failing,
      nowIso: "2026-10-01T01:00:00.000Z",
      previous: fresh,
    });
    expect(stale.freshness).toBe("stale");
    expect(stale.asOf).toBe("2026-06-17");
    expect(catalogFreshness({ fetchedAtMs: 0, nowMs: 10 })).toBe("unknown");
    expect(catalogFreshness({ fetchedAtMs: 1, nowMs: 3, ttlMs: 5 })).toBe("fresh");
    expect(catalogFreshness({ fetchedAtMs: 1, nowMs: 10, ttlMs: 5 })).toBe("stale");
  });

  it.effect("caches catalog within TTL and does not block on a later refresh", () =>
    Effect.gen(function* () {
      let modelPages = 0;
      const client = createOpenRouterClient({
        apiKey: "sk-or-v1-not-a-real-key",
        transport: fakeTransport(async (request) => {
          if (request.url.includes("/api/v1/models")) {
            modelPages += 1;
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
        }),
      });
      const store = yield* makeOpenRouterCatalogStore();
      const first = yield* loadOpenRouterCatalog({ client, store, nowMs: 1_000, ttlMs: 5_000 });
      const cached = yield* loadOpenRouterCatalog({ client, store, nowMs: 2_000, ttlMs: 5_000 });
      expect(first.freshness).toBe("fresh");
      expect(cached.freshness).toBe("fresh");
      expect(modelPages).toBe(1);
      expect(JSON.stringify(cached)).not.toContain("sk-or-v1-not-a-real-key");
    }),
  );

  it("normalizes HTTP failures without leaking the key", async () => {
    for (const status of [401, 402, 403, 404, 429, 503]) {
      const client = createOpenRouterClient({
        apiKey: "sk-or-v1-not-a-real-key",
        transport: fakeTransport(async () => ({
          status,
          headers: {},
          text: async () => JSON.stringify({ error: { message: "denied" } }),
        })),
      });
      const result = await client.chat({
        prompt: "hello",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        costTier: "low",
        stream: false,
        shadow: true,
      });
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("sk-or-v1-not-a-real-key");
    }
    expect(OPENROUTER_AUTO_SLUG).toBe("openrouter/auto");
    expect(OPENROUTER_CHAT_COMPLETIONS_PATH).toBe("/api/v1/chat/completions");
  });

  it("honors cancellation and timeout without leaking the key", async () => {
    const cancelled = createOpenRouterClient({
      apiKey: "sk-or-v1-not-a-real-key",
      timeoutMs: 50,
      transport: fakeTransport(async (request) => {
        await new Promise<never>((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        });
        return { status: 200, headers: {}, text: async () => "" };
      }),
    });
    const controller = new AbortController();
    const pending = cancelled.chat({
      prompt: "hello",
      allowedModels: ["anthropic/claude-sonnet-4.5"],
      costTier: "low",
      stream: false,
      shadow: true,
      signal: controller.signal,
    });
    controller.abort("cancelled");
    await expect(pending).rejects.toThrow();
    await expect(
      createOpenRouterClient({
        apiKey: "sk-or-v1-not-a-real-key",
        timeoutMs: 10,
        transport: fakeTransport(
          async (request) =>
            new Promise((_, reject) => {
              request.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
                once: true,
              });
            }),
        ),
      }).chat({
        prompt: "hello",
        allowedModels: ["anthropic/claude-sonnet-4.5"],
        costTier: "low",
        stream: false,
        shadow: true,
      }),
    ).rejects.toThrow();
  });
});
