import {
  OPENROUTER_CATALOG_TTL_MS,
  type OpenRouterFreshnessStatus,
  type OpenRouterMarketPriorV0,
} from "@t3tools/contracts";
import { buildOpenRouterMarketPrior } from "@t3tools/shared/openRouterMarketPriors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { OpenRouterClient } from "./OpenRouterClient.ts";

export type OpenRouterCatalogCache = {
  readonly snapshot: OpenRouterMarketPriorV0 | null;
  readonly fetchedAtMs: number;
};

const createOpenRouterCatalogCache = (): OpenRouterCatalogCache => ({
  snapshot: null,
  fetchedAtMs: 0,
});

export const catalogFreshness = (input: {
  readonly fetchedAtMs: number;
  readonly nowMs: number;
  readonly ttlMs?: number;
}): OpenRouterFreshnessStatus => {
  if (input.fetchedAtMs === 0) return "unknown";
  const ttl = input.ttlMs ?? OPENROUTER_CATALOG_TTL_MS;
  return input.nowMs - input.fetchedAtMs <= ttl ? "fresh" : "stale";
};

export const refreshOpenRouterCatalog = async (input: {
  readonly client: OpenRouterClient;
  readonly nowIso: string;
  readonly previous: OpenRouterMarketPriorV0 | null;
  readonly signal?: AbortSignal;
}): Promise<OpenRouterMarketPriorV0> => {
  try {
    const [models, classifications] = await Promise.all([
      input.client.listModels(input.signal),
      input.client.classifications(input.signal),
    ]);
    if (models.status >= 400 && classifications.status >= 400) {
      if (input.previous !== null) return { ...input.previous, freshness: "stale" };
      return buildOpenRouterMarketPrior({
        observedAt: input.nowIso,
        freshness: "unknown",
        classifications: [],
        catalog: [],
      });
    }
    const classificationData =
      classifications.data !== null &&
      typeof classifications.data === "object" &&
      "data" in (classifications.data as object)
        ? (classifications.data as { readonly data: Record<string, unknown> }).data
        : {};
    const asOf =
      typeof classificationData.as_of === "string" ? classificationData.as_of : undefined;
    const windowDays =
      typeof classificationData.window_days === "number"
        ? classificationData.window_days
        : undefined;
    return buildOpenRouterMarketPrior({
      observedAt: input.nowIso,
      freshness: "fresh",
      classifications: Array.isArray(classificationData.classifications)
        ? classificationData.classifications
        : [],
      catalog: models.data,
      ...(asOf !== undefined ? { asOf } : {}),
      ...(windowDays !== undefined ? { windowDays } : {}),
    });
  } catch {
    if (input.previous !== null) return { ...input.previous, freshness: "stale" };
    return buildOpenRouterMarketPrior({
      observedAt: input.nowIso,
      freshness: "unknown",
      classifications: [],
      catalog: [],
    });
  }
};

export const makeOpenRouterCatalogStore = Effect.fn("makeOpenRouterCatalogStore")(function* () {
  const cache = yield* Ref.make<OpenRouterCatalogCache>(createOpenRouterCatalogCache());
  return {
    get: Ref.get(cache),
    peek: Effect.map(Ref.get(cache), (state) => state.snapshot),
    put: (snapshot: OpenRouterMarketPriorV0, fetchedAtMs: number) =>
      Ref.set(cache, { snapshot, fetchedAtMs }),
  };
});

export type OpenRouterCatalogStore = {
  readonly get: Effect.Effect<OpenRouterCatalogCache>;
  readonly peek: Effect.Effect<OpenRouterMarketPriorV0 | null>;
  readonly put: (snapshot: OpenRouterMarketPriorV0, fetchedAtMs: number) => Effect.Effect<void>;
};

export const loadOpenRouterCatalog = Effect.fn("loadOpenRouterCatalog")(function* (input: {
  readonly client: OpenRouterClient;
  readonly store: OpenRouterCatalogStore;
  readonly ttlMs?: number;
  readonly nowMs: number;
  readonly signal?: AbortSignal;
}) {
  const current = yield* input.store.get;
  const freshness = catalogFreshness({
    fetchedAtMs: current.fetchedAtMs,
    nowMs: input.nowMs,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
  if (current.snapshot !== null && freshness === "fresh") return current.snapshot;
  const nowIso = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const snapshot = yield* Effect.tryPromise({
    try: () =>
      refreshOpenRouterCatalog({
        client: input.client,
        nowIso,
        previous: current.snapshot,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
    catch: () => "catalog_refresh_failed" as const,
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        current.snapshot !== null
          ? { ...current.snapshot, freshness: "stale" as const }
          : buildOpenRouterMarketPrior({
              observedAt: nowIso,
              freshness: "unknown",
              classifications: [],
              catalog: [],
            }),
      ),
    ),
  );
  yield* input.store.put(snapshot, input.nowMs);
  return snapshot;
});
