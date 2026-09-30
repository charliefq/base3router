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

function latestProjectedEnvironmentId(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentId | null {
  let latest: { readonly environmentId: EnvironmentId; readonly updatedAt: string } | null = null;
  for (const record of projects) {
    if (latest === null || record.updatedAt > latest.updatedAt) {
      latest = record;
    }
  }
  for (const record of threads) {
    if (latest === null || record.updatedAt > latest.updatedAt) {
      latest = record;
    }
  }
  return latest?.environmentId ?? null;
}

/**
 * Prefer an active environment that owns projected workspace data, then the
 * primary environment when it owns data. If both are empty, follow the newest
 * project/thread visible in the sidebar before falling back to connection
 * identity alone.
 */
export function resolveControlCenterEnvironmentId(
  activeEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
  projects: ReadonlyArray<EnvironmentProject> = [],
  threads: ReadonlyArray<EnvironmentThreadShell> = [],
): EnvironmentId | null {
  if (activeEnvironmentId === null && primaryEnvironmentId === null) {
    return null;
  }
  const projectedEnvironmentIds = new Set<EnvironmentId>();
  for (const project of projects) projectedEnvironmentIds.add(project.environmentId);
  for (const thread of threads) projectedEnvironmentIds.add(thread.environmentId);

  if (activeEnvironmentId !== null && projectedEnvironmentIds.has(activeEnvironmentId)) {
    return activeEnvironmentId;
  }
  if (primaryEnvironmentId !== null && projectedEnvironmentIds.has(primaryEnvironmentId)) {
    return primaryEnvironmentId;
  }
  return (
    latestProjectedEnvironmentId(projects, threads) ?? activeEnvironmentId ?? primaryEnvironmentId
  );
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
    input.projects,
    input.threads,
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
