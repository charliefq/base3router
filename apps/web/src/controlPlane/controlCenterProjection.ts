import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { ControlCenterCapabilities } from "./presentControlCenter";

export type ControlCenterSurface = "unpaired" | "offline" | "loading" | "ready";

export type ControlCenterSource = {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly surface: ControlCenterSurface;
  readonly capabilities: ControlCenterCapabilities;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
};

export type ControlCenterSourceInput = {
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly catalogReady: boolean;
  readonly bootstrapped: boolean;
  readonly connectionPhase: EnvironmentConnectionPhase | null;
  readonly serverConfig: ServerConfig | null;
  readonly incomingEnvironmentId?: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
};

const EMPTY_CAPABILITIES: ControlCenterCapabilities = {
  dispatcher: false,
  workflow: false,
  cursorCloud: false,
};

/** Prefer the paired/active environment, then the catalog primary. */
export function resolveControlCenterEnvironmentId(
  activeEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  return activeEnvironmentId ?? primaryEnvironmentId;
}

/**
 * Drop values that belong to a different environment than the one currently
 * selected. A stale in-flight response cannot overwrite the new selection.
 */
export function acceptEnvironmentScopedValue<T>(
  selectedEnvironmentId: EnvironmentId | null,
  incomingEnvironmentId: EnvironmentId | null,
  value: T,
): T | null {
  if (selectedEnvironmentId === null) {
    return null;
  }
  if (incomingEnvironmentId !== null && incomingEnvironmentId !== selectedEnvironmentId) {
    return null;
  }
  return value;
}

export function scopeRecordsToEnvironment<T extends { readonly environmentId: EnvironmentId }>(
  selectedEnvironmentId: EnvironmentId | null,
  records: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (selectedEnvironmentId === null) {
    return [];
  }
  return records.filter((record) => record.environmentId === selectedEnvironmentId);
}

export function capabilitiesFromServerConfig(
  serverConfig: ServerConfig | null,
): ControlCenterCapabilities {
  const capabilities = serverConfig?.environment.capabilities;
  return {
    dispatcher: capabilities?.dispatcherRoutePreview === true,
    workflow: capabilities?.workflowOs === true,
    cursorCloud: capabilities?.cursorCloudRunner === true,
  };
}

function resolveSurface(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly catalogReady: boolean;
  readonly bootstrapped: boolean;
  readonly connectionPhase: EnvironmentConnectionPhase | null;
}): ControlCenterSurface {
  if (input.selectedEnvironmentId === null) {
    return "unpaired";
  }
  if (
    input.connectionPhase === "offline" ||
    input.connectionPhase === "error" ||
    input.connectionPhase === "unsupported"
  ) {
    return "offline";
  }
  if (!input.catalogReady || !input.bootstrapped) {
    return "loading";
  }
  return "ready";
}

export function selectControlCenterSource(input: ControlCenterSourceInput): ControlCenterSource {
  const selectedEnvironmentId = resolveControlCenterEnvironmentId(
    input.activeEnvironmentId,
    input.primaryEnvironmentId,
  );
  const serverConfig = acceptEnvironmentScopedValue(
    selectedEnvironmentId,
    input.incomingEnvironmentId ?? input.serverConfig?.environment.environmentId ?? null,
    input.serverConfig,
  );
  const projects = scopeRecordsToEnvironment(selectedEnvironmentId, input.projects);
  const threads = scopeRecordsToEnvironment(selectedEnvironmentId, input.threads);

  return {
    selectedEnvironmentId,
    surface: resolveSurface({
      selectedEnvironmentId,
      catalogReady: input.catalogReady,
      bootstrapped: input.bootstrapped,
      connectionPhase: input.connectionPhase,
    }),
    capabilities:
      selectedEnvironmentId === null
        ? EMPTY_CAPABILITIES
        : capabilitiesFromServerConfig(serverConfig),
    projects,
    threads,
  };
}
