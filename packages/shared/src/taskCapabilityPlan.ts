import {
  isProviderAvailable,
  type ModelSelection,
  type ServerProvider,
  type TaskCapabilityPlan,
  type TaskContractFields,
} from "@t3tools/contracts";
import { digestCanonical } from "./actionCanonical.ts";
import { skillManifestFromProviderSkill } from "./skillCatalog.ts";
import { firstPartyMcpCatalog } from "./mcpCatalog.ts";

const suspicious =
  /ignore.{0,40}(instructions|rules)|system\s+prompt|sk-[A-Za-z0-9_-]+|crsr[_-][A-Za-z0-9_-]+|Bearer\s+\S+|api[_-]?key\s*[=:]|<\/?(script|system)>/i;
const label = (s: string) =>
  suspicious.test(s) ? "[untrusted metadata]" : s.slice(0, 512) || "Unknown";
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g)
      ?.filter(
        (x) =>
          !["the", "and", "for", "with", "this", "that", "from", "task", "should", "must"].includes(
            x,
          ),
      ) ?? [],
  );

export function planTaskCapabilities(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly workspace: string | null;
  readonly modelSelection: ModelSelection;
  readonly contract: TaskContractFields;
  readonly provider: ServerProvider | undefined;
}): TaskCapabilityPlan {
  const p = input.provider;
  const snapshots = p?.workspaceSnapshots?.filter((s) => s.cwd === input.workspace) ?? [];
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined;
  const ready =
    !!p &&
    p.instanceId === input.modelSelection.instanceId &&
    p.enabled &&
    p.installed &&
    p.status === "ready" &&
    p.auth.status === "authenticated" &&
    isProviderAvailable(p) &&
    p.models.some((m) => m.slug === input.modelSelection.model);
  const skills = [...(snapshot?.skills ?? p?.skills ?? [])].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const manifests = skills.map((skill) =>
    skillManifestFromProviderSkill({ skill, driver: p?.driver ?? null }),
  );
  const counts = new Map<string, number>();
  for (const m of manifests) counts.set(m.skillId, (counts.get(m.skillId) ?? 0) + 1);
  const intent = words(`${input.contract.goal} ${input.contract.acceptance}`.slice(0, 8192));
  const entries: TaskCapabilityPlan["entries"][number][] = skills
    .slice(0, 64)
    .map<TaskCapabilityPlan["entries"][number]>((s, i) => {
      const m = manifests[i]!;
      const description = s.description ?? s.shortDescription ?? "";
      const available = ready && snapshot !== undefined;
      const bad =
        suspicious.test(`${s.name} ${s.path} ${description}`) || description.length > 4096;
      const match = [...words(`${s.name} ${description}`)].some((w) => intent.has(w));
      const reason = !s.enabled
        ? "Disabled in the native catalog."
        : !available
          ? "Exact project/provider workspace availability is unknown."
          : bad
            ? "Untrusted or oversized metadata excluded."
            : counts.get(m.skillId)! > 1
              ? "Ambiguous native skill identity excluded."
              : !description.trim()
                ? "No description; cannot establish task relevance."
                : !match
                  ? "No task-specific keyword match; use manual selection if needed."
                  : "Task keywords match the native description; recommendation only, no invocation or access grant.";
      return {
        id: `skill:${digestCanonical({ nativeId: m.skillId, name: s.name, provider: p?.instanceId ?? null, workspace: input.workspace, path: s.path })}`,
        kind: "skill",
        name: label(m.name),
        provenance: label(m.provenance),
        availability: !s.enabled ? "disabled" : available ? "available" : "unknown",
        selected:
          s.enabled &&
          available &&
          !bad &&
          counts.get(m.skillId) === 1 &&
          !!description.trim() &&
          match,
        reason,
      };
    })
    .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
  for (const server of firstPartyMcpCatalog("1970-01-01T00:00:00.000Z")) {
    for (const tool of server.tools) {
      if (entries.length >= 96) break;
      entries.push({
        id: tool.toolId,
        kind: "mcp",
        name: tool.name,
        provenance: `first-party catalog: ${server.serverId}`,
        availability: "setup-required",
        selected: false,
        reason:
          "Registration metadata does not prove an authorized project/provider MCP connection. Not selected or invoked.",
      });
    }
  }
  return {
    version: "task-capability-review.v1",
    mode: "review-only",
    grantsAccess: false,
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspace: input.workspace,
    providerId: input.modelSelection.instanceId,
    model: input.modelSelection.model,
    intentDigest: digestCanonical({
      goal: input.contract.goal,
      redirect: input.contract.redirect,
      acceptance: input.contract.acceptance,
      brake: input.contract.brake,
    }),
    inventoryDigest: digestCanonical({
      project: input.projectId,
      workspace: input.workspace,
      model: input.modelSelection,
      provider: p
        ? {
            id: p.instanceId,
            driver: p.driver,
            enabled: p.enabled,
            installed: p.installed,
            status: p.status,
            auth: p.auth.status,
            availability: p.availability ?? "available",
            models: p.models.map((m) => m.slug),
            skills,
            scoped: !!snapshot,
          }
        : null,
    }),
    entries,
    explanation: entries.some((e) => e.selected)
      ? "Review-only recommendations from the exact cached workspace. Nothing is automatically invoked; existing permissions are unchanged."
      : "No eligible task-specific match. Continue with manual capability choice; nothing is automatically invoked or granted.",
  };
}
