export interface CollaborationScopeSearch {
  recordEnvironmentId?: string | undefined;
  recordThreadId?: string | undefined;
  recordRunId?: string | undefined;
  scopeEnvironmentId?: string | undefined;
  scopeProjectId?: string | undefined;
  scopeProviderId?: string | undefined;
  scopeInvalid?: true | undefined;
}
export type CollaborationPage = "agents" | "tasks";
const keys = ["scopeEnvironmentId", "scopeProjectId", "scopeProviderId"] as const;
export function validateCollaborationScope(raw: Record<string, unknown>): CollaborationScopeSearch {
  const scope: CollaborationScopeSearch = {};
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 256) scope.scopeInvalid = true;
    else scope[key] = value;
  }
  for (const key of ["recordEnvironmentId", "recordThreadId", "recordRunId"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) scope[key] = value;
  }
  if (raw.scopeInvalid === true) scope.scopeInvalid = true;
  if ((scope.scopeProjectId || scope.scopeProviderId) && !scope.scopeEnvironmentId)
    scope.scopeInvalid = true;
  return scope;
}
export function validateSetupReturn(
  raw: Record<string, unknown>,
): CollaborationScopeSearch & { returnPage?: CollaborationPage } {
  return raw.returnPage === "agents" || raw.returnPage === "tasks"
    ? { returnPage: raw.returnPage, ...validateCollaborationScope(raw) }
    : {};
}
export function resolveCollaborationScope<
  P extends { id: string },
  T extends { instanceId: string },
>(
  scope: CollaborationScopeSearch,
  environmentId: string | null | undefined,
  projects: readonly P[],
  providers: readonly T[],
) {
  const mismatch = !!scope.scopeEnvironmentId && scope.scopeEnvironmentId !== environmentId;
  const invalid = !!scope.scopeInvalid || mismatch;
  const project = invalid
    ? undefined
    : scope.scopeProjectId
      ? projects.find((p) => p.id === scope.scopeProjectId)
      : projects.length === 1
        ? projects[0]
        : undefined;
  const provider = invalid
    ? undefined
    : scope.scopeProviderId
      ? providers.find((p) => p.instanceId === scope.scopeProviderId)
      : providers.length === 1
        ? providers[0]
        : undefined;
  const issue = invalid
    ? "Saved setup scope does not match the current environment. Choose the current environment to continue."
    : scope.scopeProjectId && !project
      ? "The selected project is no longer available. Choose a project to continue."
      : scope.scopeProviderId && !provider
        ? "The selected provider is no longer ready or available. Choose or set up a provider to continue."
        : null;
  return { project, provider, issue, invalid };
}
