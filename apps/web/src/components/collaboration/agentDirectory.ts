import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type CollaborationAgent,
  type CollaborationSnapshot,
  type CollaborationTask,
  type ServerProvider,
} from "@t3tools/contracts";

export const providerExecutable = (provider: ServerProvider) =>
  provider.installed &&
  provider.enabled &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider) &&
  isProviderTextGenerationCapable(provider) &&
  provider.models.length > 0;

interface AgentDirectoryEntry {
  readonly id: string;
  readonly displayName: string;
  readonly saved: CollaborationAgent | undefined;
  readonly provider: ServerProvider | undefined;
  readonly readiness: "ready" | "unavailable";
  readonly tasks: ReadonlyArray<CollaborationTask>;
}

/** Inputs belong to one environment. Snapshot ownership/link validation remains server-owned. */
export const buildAgentDirectory = (input: {
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly source: {
    readonly environmentId: string | null;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly snapshot: CollaborationSnapshot | null;
  };
}): ReadonlyArray<AgentDirectoryEntry> => {
  if (!input.environmentId || input.source.environmentId !== input.environmentId) return [];
  const entries = new Map<string, { provider?: ServerProvider; saved?: CollaborationAgent }>();
  for (const provider of input.source.providers) {
    // Grokbot remains an external, unconnected identity even if a config reuses its id.
    if (provider.instanceId === "grokbot" || entries.has(provider.instanceId)) continue;
    entries.set(provider.instanceId, { provider });
  }
  for (const agent of input.source.snapshot?.agents ?? []) {
    if (
      agent.origin !== "internal" ||
      agent.id === "grokbot" ||
      input.projectId === null ||
      agent.projectId !== input.projectId
    )
      continue;
    const entry = entries.get(agent.id) ?? {};
    if (entry.saved === undefined) entries.set(agent.id, { ...entry, saved: agent });
  }
  return [...entries].map(([id, entry]) => ({
    id,
    displayName:
      entry.saved?.displayName ?? entry.provider?.displayName ?? entry.provider?.driver ?? id,
    saved: entry.saved,
    provider: entry.provider,
    readiness: entry.provider && providerExecutable(entry.provider) ? "ready" : "unavailable",
    tasks:
      input.projectId === null
        ? []
        : (input.source.snapshot?.tasks ?? []).filter(
            (task) =>
              task.projectId === input.projectId &&
              (task.assigneeAgentId === id || task.ownerAgentId === id),
          ),
  }));
};
