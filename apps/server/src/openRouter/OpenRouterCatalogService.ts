import {
  OPENROUTER_CATALOG_TTL_MS,
  type OpenRouterFreshnessStatus,
  type OpenRouterMarketPriorV0,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerSettingsService } from "../serverSettings.ts";
import { createOpenRouterClient, type OpenRouterClient } from "./OpenRouterClient.ts";
import {
  catalogFreshness,
  loadOpenRouterCatalog,
  makeOpenRouterCatalogStore,
  type OpenRouterCatalogStore,
} from "./OpenRouterCatalog.ts";
import { resolveOpenRouterApiKey } from "./OpenRouterCredentials.ts";
import type { OpenRouterTransport } from "./OpenRouterTransport.ts";

export type OpenRouterCatalogFreshness = {
  readonly status: OpenRouterFreshnessStatus;
  readonly asOf?: string;
  readonly observedAt?: string;
};

export class OpenRouterCatalogService extends Context.Service<
  OpenRouterCatalogService,
  {
    readonly peek: Effect.Effect<OpenRouterMarketPriorV0 | null>;
    readonly ensureFresh: Effect.Effect<OpenRouterMarketPriorV0 | null>;
    readonly freshness: Effect.Effect<OpenRouterCatalogFreshness>;
    readonly awaitIdle: Effect.Effect<void>;
  }
>()("t3/openRouter/OpenRouterCatalogService") {}

export type OpenRouterCatalogServiceOptions = {
  readonly transport?: OpenRouterTransport;
  readonly apiKey?: string;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
};

/**
 * Server-owned market-prior catalog.
 *
 * Lifecycle: lazy refresh on first configured capability/prior read. Fresh
 * cache returns immediately. Expired cache returns last-known-good and
 * refreshes in the background. One in-flight refresh. Unconfigured OpenRouter
 * makes zero network calls. Shutdown aborts the in-flight request. Failures
 * never block Phase 8 routing.
 */
export const makeOpenRouterCatalogService = Effect.fn("makeOpenRouterCatalogService")(function* (
  options?: OpenRouterCatalogServiceOptions,
) {
  const store: OpenRouterCatalogStore = yield* makeOpenRouterCatalogStore();
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const abort = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort("shutdown")),
  );
  const inFlight = yield* Ref.make<Deferred.Deferred<OpenRouterMarketPriorV0, never> | null>(null);

  const resolveKey = Effect.gen(function* () {
    if (options?.apiKey !== undefined) {
      const trimmed = options.apiKey.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (Option.isNone(settingsService)) return undefined;
    const settings = yield* settingsService.value.getSettings.pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return resolveOpenRouterApiKey({
      ...(settings !== undefined ? { providerInstances: settings.providerInstances } : {}),
    });
  });

  const ttlMs = Effect.gen(function* () {
    if (options?.ttlMs !== undefined) return options.ttlMs;
    if (Option.isNone(settingsService)) return OPENROUTER_CATALOG_TTL_MS;
    const settings = yield* settingsService.value.getSettings.pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return settings?.openRouter.catalogTtlMs ?? OPENROUTER_CATALOG_TTL_MS;
  });

  const nowMs = () =>
    options?.nowMs !== undefined ? Effect.sync(options.nowMs) : Clock.currentTimeMillis;

  const clientForKey = (apiKey: string): OpenRouterClient =>
    createOpenRouterClient({
      apiKey,
      ...(options?.transport !== undefined ? { transport: options.transport } : {}),
    });

  const refreshInBackground = (client: OpenRouterClient) =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(inFlight);
      if (existing !== null) return;
      const deferred = yield* Deferred.make<OpenRouterMarketPriorV0>();
      const claimed = yield* Ref.modify(inFlight, (current) => {
        if (current !== null) return [false, current] as const;
        return [true, deferred] as const;
      });
      if (!claimed) return;
      yield* Effect.gen(function* () {
        const now = yield* nowMs();
        const snapshot = yield* loadOpenRouterCatalog({
          client,
          store,
          nowMs: now,
          ttlMs: yield* ttlMs,
          signal: abort.signal,
        }).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              const current = yield* store.get;
              if (current.snapshot !== null) {
                return { ...current.snapshot, freshness: "stale" as const };
              }
              const observedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
              return {
                version: "openrouter-market-prior.v0" as const,
                source: "openrouter_classifications" as const,
                sampled: true as const,
                observedAt,
                freshness: "unknown" as const,
                classifications: [],
                catalog: [],
              } satisfies OpenRouterMarketPriorV0;
            }),
          ),
        );
        yield* Ref.set(inFlight, null);
        yield* Deferred.succeed(deferred, snapshot);
      }).pipe(Effect.ensuring(Ref.set(inFlight, null)), Effect.forkScoped);
    });

  const peek = store.peek;

  const ensureFresh = Effect.gen(function* () {
    if (abort.signal.aborted) return yield* peek;
    const apiKey = yield* resolveKey;
    if (apiKey === undefined) return yield* peek;
    const now = yield* nowMs();
    const current = yield* store.get;
    const freshness = catalogFreshness({
      fetchedAtMs: current.fetchedAtMs,
      nowMs: now,
      ttlMs: yield* ttlMs,
    });
    if (current.snapshot !== null && freshness === "fresh") return current.snapshot;
    const client = clientForKey(apiKey);
    // Last-known-good (or unknown) is returned immediately. Refresh is
    // background so Phase 8 routing and descriptor reads never wait on OpenRouter.
    yield* refreshInBackground(client);
    if (current.snapshot !== null) {
      return { ...current.snapshot, freshness: "stale" as const };
    }
    return current.snapshot;
  }).pipe(Effect.catch(() => peek));

  const freshness = Effect.gen(function* () {
    const snapshot = yield* ensureFresh;
    if (snapshot === null) {
      return { status: "unknown" as const } satisfies OpenRouterCatalogFreshness;
    }
    return {
      status: snapshot.freshness,
      ...(snapshot.asOf !== undefined ? { asOf: snapshot.asOf } : {}),
      observedAt: snapshot.observedAt,
    } satisfies OpenRouterCatalogFreshness;
  });

  const awaitIdle = Effect.gen(function* () {
    for (;;) {
      const deferred = yield* Ref.get(inFlight);
      if (deferred === null) return;
      yield* Deferred.await(deferred);
    }
  });

  return OpenRouterCatalogService.of({
    peek,
    ensureFresh,
    freshness,
    awaitIdle,
  });
});

export const layer = Layer.effect(OpenRouterCatalogService, makeOpenRouterCatalogService());
