import {
  OPENROUTER_CATALOG_TTL_MS,
  type OpenRouterFreshnessStatus,
  type OpenRouterMarketPriorV0,
} from "@t3tools/contracts";
import { buildOpenRouterMarketPrior } from "@t3tools/shared/openRouterMarketPriors";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import { ServerSettingsService } from "../serverSettings.ts";
import { createOpenRouterClient, type OpenRouterClient } from "./OpenRouterClient.ts";
import {
  catalogFreshness,
  loadOpenRouterCatalog,
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

const unknownPrior = (observedAt: string): OpenRouterMarketPriorV0 =>
  buildOpenRouterMarketPrior({
    observedAt,
    freshness: "unknown",
    classifications: [],
    catalog: [],
  });

const makeStore = (): Effect.Effect<OpenRouterCatalogStore> =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<{
      snapshot: OpenRouterMarketPriorV0 | null;
      fetchedAtMs: number;
    }>({ snapshot: null, fetchedAtMs: 0 });
    return {
      get: Ref.get(cache),
      peek: Effect.map(Ref.get(cache), (state) => state.snapshot),
      put: (snapshot: OpenRouterMarketPriorV0, fetchedAtMs: number) =>
        Ref.set(cache, { snapshot, fetchedAtMs }),
    };
  });

/**
 * Server-owned market-prior catalog.
 *
 * Lifecycle: lazy refresh on first configured capability/prior read. Fresh
 * cache returns immediately. Expired cache returns last-known-good and
 * refreshes in the background. One in-flight refresh. Unconfigured or
 * guidance-off OpenRouter makes zero network calls. Refresh fibers are forked
 * into the service scope (`Effect.forkIn`) so `getDescriptor` does not require
 * Scope and shutdown interrupts in-flight HTTP. Failures never block Phase 8.
 */
export const makeOpenRouterCatalogService = (
  options?: OpenRouterCatalogServiceOptions,
): Effect.Effect<OpenRouterCatalogService["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* makeStore();
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const serviceScope = yield* Effect.scope;
    const abort = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort("shutdown")),
    );
    const inFlight = yield* Ref.make<Deferred.Deferred<OpenRouterMarketPriorV0, never> | null>(
      null,
    );

    const readSettings = Effect.gen(function* () {
      if (Option.isNone(settingsService)) return undefined;
      return yield* settingsService.value.getSettings.pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
    });

    const resolveRefreshKey = Effect.gen(function* () {
      if (options?.apiKey !== undefined) {
        const trimmed = options.apiKey.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
      const settings = yield* readSettings;
      if (settings === undefined) return undefined;
      if ((settings.openRouter.guidanceMode ?? "off") === "off") return undefined;
      return resolveOpenRouterApiKey({
        providerInstances: settings.providerInstances,
      });
    });

    const ttlMs = Effect.gen(function* () {
      if (options?.ttlMs !== undefined) return options.ttlMs;
      const settings = yield* readSettings;
      return settings?.openRouter.catalogTtlMs ?? OPENROUTER_CATALOG_TTL_MS;
    });

    const nowMs = (): Effect.Effect<number> =>
      options?.nowMs !== undefined ? Effect.sync(options.nowMs) : Clock.currentTimeMillis;

    const clientForKey = (apiKey: string): OpenRouterClient =>
      createOpenRouterClient({
        apiKey,
        ...(options?.transport !== undefined ? { transport: options.transport } : {}),
      });

    const refreshInBackground = (client: OpenRouterClient): Effect.Effect<void> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<OpenRouterMarketPriorV0>();
        const claimed = yield* Ref.modify(inFlight, (current) => {
          if (current !== null) return [false, current] as const;
          return [true, deferred] as const;
        });
        if (!claimed) return;
        const work: Effect.Effect<OpenRouterMarketPriorV0> = Effect.gen(function* () {
          const now = yield* nowMs();
          return yield* loadOpenRouterCatalog({
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
                return unknownPrior(observedAt);
              }),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.set(inFlight, null);
              const current = yield* store.peek;
              const observedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
              yield* Deferred.done(deferred, Exit.succeed(current ?? unknownPrior(observedAt)));
            }),
          ),
        );
        yield* Effect.forkIn(work, serviceScope);
      });

    const peek: Effect.Effect<OpenRouterMarketPriorV0 | null> = store.peek;

    const ensureFresh: Effect.Effect<OpenRouterMarketPriorV0 | null> = Effect.gen(function* () {
      if (abort.signal.aborted) return yield* peek;
      const apiKey = yield* resolveRefreshKey;
      if (apiKey === undefined) return yield* peek;
      const now = yield* nowMs();
      const current = yield* store.get;
      const freshnessStatus = catalogFreshness({
        fetchedAtMs: current.fetchedAtMs,
        nowMs: now,
        ttlMs: yield* ttlMs,
      });
      if (current.snapshot !== null && freshnessStatus === "fresh") return current.snapshot;
      // Last-known-good (or unknown) is returned immediately. Refresh is
      // background so Phase 8 routing and descriptor reads never wait on OpenRouter.
      yield* refreshInBackground(clientForKey(apiKey));
      if (current.snapshot !== null) {
        return { ...current.snapshot, freshness: "stale" as const };
      }
      return current.snapshot;
    }).pipe(Effect.catch(() => peek));

    const freshness: Effect.Effect<OpenRouterCatalogFreshness> = Effect.gen(function* () {
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

    const awaitIdle: Effect.Effect<void> = Effect.gen(function* () {
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
