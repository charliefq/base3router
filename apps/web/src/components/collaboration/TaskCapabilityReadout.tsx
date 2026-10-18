import type { TaskCapabilityPlan, TaskCapabilityEvidence } from "@t3tools/contracts";

export function TaskCapabilityReadout({
  plan,
  evidence,
  historical = false,
}: {
  readonly plan?: TaskCapabilityPlan | undefined;
  readonly evidence?: TaskCapabilityEvidence | undefined;
  readonly historical?: boolean;
}) {
  const reviewed = evidence?.reviewed ?? plan;
  if (!reviewed) return null;
  return (
    <section aria-label="Task capability recommendations" className="space-y-2 text-sm">
      <h3 className="font-medium">Capability plan — review only</h3>
      <p>{reviewed.explanation}</p>
      <p>
        No automatic skill invocation, MCP connection or access grant. Existing manual capability
        controls remain available.
      </p>
      {evidence ? (
        <p role="status">
          {historical
            ? evidence.observation === "provider-start"
              ? "Before provider start"
              : "At dispatch"
            : "Review now"}
          : {evidence.status}: {evidence.reason}
        </p>
      ) : null}
      {evidence?.observedAt ? (
        <p>
          Cached inventory observed at {evidence.observedAt}; this is not a permission or
          capability-usage attestation.
        </p>
      ) : null}
      <p>
        Provider: {reviewed.providerId}. Project: {reviewed.projectId}. Workspace:{" "}
        {reviewed.workspace ?? "Unknown"}.
      </p>
      <details>
        <summary>
          Inspect recommendations and exclusions (
          {reviewed.entries.filter((e) => e.selected).length} reviewed recommendations)
        </summary>
        <ul>
          {reviewed.entries.map((entry) => (
            <li key={entry.id}>
              <strong>
                {entry.selected && (!evidence || evidence.status === "current")
                  ? "Recommended"
                  : "Excluded"}
                : {entry.name}
              </strong>{" "}
              ({entry.kind}; reviewed availability: {entry.availability}). {entry.reason}
              <span className="block text-xs text-muted-foreground">
                Provenance: {entry.provenance}
              </span>
            </li>
          ))}
        </ul>
      </details>
      {evidence && evidence.status !== "current" ? (
        <p>
          Previous recommendations are invalidated, not an executable selection. Review available
          capabilities manually.
        </p>
      ) : null}
    </section>
  );
}
