// @effect-diagnostics globalTimers:off - Framework-neutral UI debounce without an Effect runtime.
import type {
  DispatcherRouteCandidate,
  DispatcherRouteDecision,
  DispatcherRoutePreviewRequest,
  DispatcherTaskRouteBinding,
  ServerProvider,
} from "@t3tools/contracts";

import { resolveProviderInstanceDisplayName } from "./state/providerInstanceDisplay.ts";

export type DispatcherPreviewErrorKind = "unauthorized" | "unavailable" | "error";

export type DispatcherPreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly decision: DispatcherRouteDecision }
  | { readonly status: "error"; readonly kind: DispatcherPreviewErrorKind };

export interface DispatcherRouteLabel {
  readonly provider: string;
  readonly model: string;
}

export interface DispatcherRoutePresentation extends DispatcherRouteLabel {
  readonly reason: string;
  readonly fallbacks: ReadonlyArray<DispatcherRouteLabel>;
}

export function shouldShowDispatcherRoute(input: {
  readonly capabilityAvailable: boolean;
  readonly hasProject: boolean;
  readonly hasBoundRoute: boolean;
}): boolean {
  return input.hasProject && (input.capabilityAvailable || input.hasBoundRoute);
}

function errorTag(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return null;
  return typeof error._tag === "string" ? error._tag : null;
}

export function classifyDispatcherPreviewError(error: unknown): DispatcherPreviewErrorKind {
  const tag = errorTag(error);
  if (tag === "EnvironmentAuthorizationError") return "unauthorized";
  if (
    tag === "EnvironmentRpcUnavailableError" ||
    tag === "EnvironmentNotRegisteredError" ||
    tag === "ConnectionUnavailableError"
  ) {
    return "unavailable";
  }
  return "error";
}

function providerLabel(instanceId: string, providers: ReadonlyArray<ServerProvider>): string {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return provider === undefined ? instanceId : resolveProviderInstanceDisplayName(provider);
}

function candidateLabel(
  candidate: DispatcherRouteCandidate,
  providers: ReadonlyArray<ServerProvider>,
): DispatcherRouteLabel {
  return {
    provider: providerLabel(candidate.target.instanceId, providers),
    model: candidate.target.model,
  };
}

const ROUTE_REASON: Record<DispatcherRouteCandidate["source"], string> = {
  explicit: "Uses your selected provider and model.",
  thread: "Keeps the thread's current route.",
  "project-default": "Uses this project's default route.",
  "environment-default": "Uses the environment default route.",
  "provider-default": "Uses the first available provider route.",
};

export function presentDispatcherDecision(
  decision: DispatcherRouteDecision,
  providers: ReadonlyArray<ServerProvider>,
): DispatcherRoutePresentation | null {
  const selected = decision.selected;
  if (decision.gate.decision !== "ALLOW" || selected === null) return null;
  return {
    ...candidateLabel(selected, providers),
    reason: ROUTE_REASON[selected.source],
    fallbacks: decision.candidates
      .filter((candidate) => candidate.eligible && candidate.fallbackIndex > selected.fallbackIndex)
      .slice(0, 2)
      .map((candidate) => candidateLabel(candidate, providers)),
  };
}

export function presentBoundDispatcherRoute(
  binding: DispatcherTaskRouteBinding,
  providers: ReadonlyArray<ServerProvider>,
): DispatcherRoutePresentation {
  return {
    provider: providerLabel(binding.target.instanceId, providers),
    model: binding.target.model,
    reason: "Persisted for this task.",
    fallbacks: [],
  };
}

export function dispatcherPreviewStatusLabel(state: DispatcherPreviewState): string {
  switch (state.status) {
    case "idle":
      return "Automatic routing is waiting for a project.";
    case "loading":
      return "Checking automatic route…";
    case "success":
      return state.decision.gate.decision === "ALLOW"
        ? "Automatic routing is ready."
        : "Automatic routing could not select a route.";
    case "error":
      return state.kind === "unauthorized"
        ? "Route preview is not authorized for this connection."
        : state.kind === "unavailable"
          ? "Route preview is unavailable while this environment is offline."
          : "Route preview is temporarily unavailable.";
  }
}

export interface DispatcherPreviewController {
  readonly update: (input: DispatcherRoutePreviewRequest | null) => void;
  readonly dispose: () => void;
}

/** Debounces preview reads and makes response publication strictly latest-input-wins. */
export function createDispatcherPreviewController(options: {
  readonly request: (input: DispatcherRoutePreviewRequest) => Promise<DispatcherRouteDecision>;
  readonly onChange: (state: DispatcherPreviewState) => void;
  readonly debounceMs?: number;
}): DispatcherPreviewController {
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    update(input) {
      revision += 1;
      const requestRevision = revision;
      clearTimer();
      if (input === null) {
        options.onChange({ status: "idle" });
        return;
      }
      options.onChange({ status: "loading" });
      timer = setTimeout(() => {
        timer = null;
        void options.request(input).then(
          (decision) => {
            if (!disposed && requestRevision === revision) {
              options.onChange({ status: "success", decision });
            }
          },
          (error: unknown) => {
            if (!disposed && requestRevision === revision) {
              options.onChange({ status: "error", kind: classifyDispatcherPreviewError(error) });
            }
          },
        );
      }, options.debounceMs ?? 180);
    },
    dispose() {
      disposed = true;
      revision += 1;
      clearTimer();
    },
  };
}
