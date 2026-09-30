import {
  ProviderInstanceId,
  type ModelRouterDecision,
  type ModelRouterMode,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  modelRouterCatalogFromProviders,
  modelSelectionFromRoute,
  routeModel,
} from "@t3tools/shared/modelRouter";

export function resolveComposerModelRoutingMode(input: {
  readonly modelSelectionExplicit?: boolean | undefined;
}): ModelRouterMode {
  return input.modelSelectionExplicit === true ? "manual" : "auto";
}

function asTarget(selection: ModelSelection): {
  readonly instanceId: ModelSelection["instanceId"];
  readonly model: string;
} {
  return { instanceId: selection.instanceId, model: selection.model };
}

export function routeComposerModel(input: {
  readonly mode: ModelRouterMode;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly preferredProject?: ModelSelection | null;
  readonly preferredEnvironment?: ModelSelection | null;
  readonly manualOverride?: ModelSelection | null;
}): ModelRouterDecision {
  return routeModel({
    mode: input.mode,
    catalog: modelRouterCatalogFromProviders(input.providers),
    preferredTargets: [
      ...(input.preferredProject ? [asTarget(input.preferredProject)] : []),
      ...(input.preferredEnvironment ? [asTarget(input.preferredEnvironment)] : []),
    ],
    ...(input.mode === "manual" && input.manualOverride
      ? { manualOverride: asTarget(input.manualOverride) }
      : {}),
  });
}

export function presentModelRouterWhy(decision: ModelRouterDecision): string {
  return decision.explanation;
}

export function presentModelRouterFallbackLabel(decision: ModelRouterDecision): string | null {
  if (decision.mode === "manual") return null;
  const skipped = decision.candidates.filter(
    (candidate) =>
      !candidate.eligible && candidate.fallbackIndex < (decision.selected?.fallbackIndex ?? 0),
  );
  if (skipped.length > 0) {
    return `Fallback after ${skipped.length} ineligible ${skipped.length === 1 ? "candidate" : "candidates"}`;
  }
  if (decision.fallbacks.length === 0) return null;
  return `${decision.fallbacks.length} ${decision.fallbacks.length === 1 ? "fallback" : "fallbacks"}`;
}

export function routedModelSelection(
  decision: ModelRouterDecision,
  fallback: ModelSelection,
): ModelSelection {
  const selected = modelSelectionFromRoute(decision);
  if (selected === null) return fallback;
  if (fallback.instanceId === selected.instanceId && fallback.model === selected.model) {
    return fallback;
  }
  return {
    instanceId: ProviderInstanceId.make(selected.instanceId),
    model: selected.model,
  };
}
