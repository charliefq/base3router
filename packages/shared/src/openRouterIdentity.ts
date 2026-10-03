import {
  type OpenRouterCatalogModelV0,
  type OpenRouterModelIdentity,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

/**
 * Documented aliases only. Keys are `driver:normalizedBase3Model`.
 * Similarly named models are not assumed identical.
 */
const OPENROUTER_DOCUMENTED_ALIASES: Readonly<Record<string, string>> = {
  "openrouter:openrouter/auto": "openrouter/auto",
};

export type OpenRouterIdentityCatalog = {
  readonly byId: ReadonlyMap<string, OpenRouterCatalogModelV0>;
  readonly byCanonical: ReadonlyMap<string, OpenRouterCatalogModelV0>;
};

export const indexOpenRouterCatalog = (
  models: ReadonlyArray<OpenRouterCatalogModelV0>,
): OpenRouterIdentityCatalog => {
  const byId = new Map<string, OpenRouterCatalogModelV0>();
  const byCanonical = new Map<string, OpenRouterCatalogModelV0>();
  for (const model of models) {
    const id = normalizeSlug(model.id);
    if (!byId.has(id)) byId.set(id, model);
    const canonical = model.canonicalSlug ? normalizeSlug(model.canonicalSlug) : id;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, model);
  }
  return { byId, byCanonical };
};

const aliasKey = (driver: string, model: string): string =>
  `${normalizeSlug(driver)}:${normalizeSlug(model)}`;

export const resolveOpenRouterSlug = (input: {
  readonly driver: ProviderDriverKind | string | null;
  readonly model: string;
  readonly catalog?: OpenRouterIdentityCatalog;
}): OpenRouterModelIdentity => {
  const model = input.model.trim();
  const driver = input.driver === null ? undefined : String(input.driver);
  const documented =
    driver !== undefined ? OPENROUTER_DOCUMENTED_ALIASES[aliasKey(driver, model)] : undefined;
  const candidate = documented ?? (model.includes("/") ? model : undefined);
  if (candidate === undefined) {
    return {
      ...(driver !== undefined ? { driver: driver as ProviderDriverKind } : {}),
      base3Model: model,
      resolved: false,
    };
  }
  const normalized = normalizeSlug(candidate);
  const catalog = input.catalog;
  if (catalog !== undefined) {
    const hit = catalog.byId.get(normalized) ?? catalog.byCanonical.get(normalized);
    if (hit === undefined) {
      return {
        ...(driver !== undefined ? { driver: driver as ProviderDriverKind } : {}),
        base3Model: model,
        openRouterSlug: candidate,
        resolved: false,
      };
    }
    return {
      ...(driver !== undefined ? { driver: driver as ProviderDriverKind } : {}),
      base3Model: model,
      openRouterSlug: hit.id,
      canonicalSlug: hit.canonicalSlug ?? hit.id,
      resolved: true,
    };
  }
  return {
    ...(driver !== undefined ? { driver: driver as ProviderDriverKind } : {}),
    base3Model: model,
    openRouterSlug: candidate,
    canonicalSlug: documented ?? candidate,
    resolved: true,
  };
};

export const mapEligibleCandidatesToOpenRouter = (input: {
  readonly candidates: ReadonlyArray<{
    readonly eligible: boolean;
    readonly driver: ProviderDriverKind | string | null;
    readonly target: { readonly instanceId: ProviderInstanceId | string; readonly model: string };
  }>;
  readonly catalog?: OpenRouterIdentityCatalog;
}): {
  readonly allowedModels: ReadonlyArray<string>;
  readonly mappings: ReadonlyArray<OpenRouterModelIdentity>;
  readonly unresolved: ReadonlyArray<OpenRouterModelIdentity>;
} => {
  const mappings: OpenRouterModelIdentity[] = [];
  const allowed = new Set<string>();
  const unresolved: OpenRouterModelIdentity[] = [];
  for (const candidate of input.candidates) {
    if (!candidate.eligible) continue;
    const mapped = resolveOpenRouterSlug({
      driver: candidate.driver,
      model: candidate.target.model,
      ...(input.catalog !== undefined ? { catalog: input.catalog } : {}),
    });
    mappings.push({
      ...mapped,
      instanceId: candidate.target.instanceId as ProviderInstanceId,
    });
    if (mapped.resolved && mapped.openRouterSlug !== undefined) {
      allowed.add(mapped.openRouterSlug);
    } else {
      unresolved.push(mapped);
    }
  }
  return {
    allowedModels: [...allowed].sort(),
    mappings,
    unresolved,
  };
};

export const actualModelIsAllowed = (
  actualModel: string,
  allowedModels: ReadonlyArray<string>,
): boolean => {
  const actual = normalizeSlug(actualModel);
  return allowedModels.some((allowed) => {
    const pattern = normalizeSlug(allowed);
    if (pattern.endsWith("/*")) {
      return actual.startsWith(pattern.slice(0, -1));
    }
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(actual);
    }
    return actual === pattern;
  });
};
