import type { EnvironmentId, GovernanceSnapshot } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { governanceEnvironment } from "../../state/governance";

function useGovernanceSnapshot(environmentId: EnvironmentId | null, threadId?: string) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : governanceEnvironment.snapshot({
          environmentId,
          input: threadId === undefined ? {} : { threadId },
        }),
  );
}

function GovernanceProjectionView(props: {
  readonly surface: "control-center" | "inspector";
  readonly snapshot: GovernanceSnapshot | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
}) {
  const snapshot = props.snapshot;
  return (
    <section className="space-y-3" data-governance-surface={props.surface}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            {props.surface === "control-center" ? "Control Center" : "Governance"}
          </h2>
          <p className="text-xs text-muted-foreground">
            Protocol {snapshot?.protocolVersion ?? 2}. Identity comes from the signed-in session.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          data-governance-refresh=""
          onClick={props.onRefresh}
        >
          Refresh
        </Button>
      </div>
      {props.pending ? <p className="text-xs text-muted-foreground">Loading governance.</p> : null}
      {props.error !== null ? (
        <p className="text-xs text-destructive" data-governance-error="">
          {props.error}
        </p>
      ) : null}
      {snapshot === null ? null : (
        <div className="grid gap-3 md:grid-cols-2">
          <article className="rounded-md border border-border/60 p-3" data-governance-routes="">
            <h3 className="text-xs font-medium">Route bindings</h3>
            {snapshot.routes.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No bound routes.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.routes.map((route) => (
                  <li key={`${route.threadId}:${route.messageId}`}>
                    {route.mode} · {route.model ?? "unselected"} ·{" "}
                    {route.instanceId ?? "no instance"}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="rounded-md border border-border/60 p-3" data-governance-leases="">
            <h3 className="text-xs font-medium">Capacity</h3>
            {snapshot.leases.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No active leases.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.leases.map((lease) => (
                  <li key={lease.leaseId} data-governance-lease={lease.leaseId}>
                    {lease.workloadClass} · {lease.occupied ? "occupied" : "free"}
                    {lease.interruptRequested ? " · interrupt requested" : ""}
                    {lease.disconnectUnconfirmed ? " · disconnect unconfirmed" : ""}
                    {lease.runStatus !== null ? ` · run ${lease.runStatus}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="rounded-md border border-border/60 p-3" data-governance-approvals="">
            <h3 className="text-xs font-medium">Approvals</h3>
            {snapshot.approvals.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No approvals.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.approvals.map((approval) => (
                  <li key={approval.approvalId}>
                    {approval.status}
                    {approval.consumedAt !== null ? " · consumed" : ""}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="rounded-md border border-border/60 p-3" data-governance-memory="">
            <h3 className="text-xs font-medium">Memory</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {snapshot.deletedSourceCount} deleted sources stay deleted.
            </p>
            {snapshot.memories.length === 0 ? null : (
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.memories.map((memory) => (
                  <li key={memory.memoryId}>
                    {memory.status} · {memory.scopeKind}
                    {memory.contentPresent ? "" : " · content absent"}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

export function GovernanceControlCenter(props: { readonly environmentId: EnvironmentId | null }) {
  const query = useGovernanceSnapshot(props.environmentId);
  return (
    <GovernanceProjectionView
      surface="control-center"
      snapshot={query.data}
      pending={query.isPending}
      error={query.error}
      onRefresh={query.refresh}
    />
  );
}

export function GovernanceInspector(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const query = useGovernanceSnapshot(props.environmentId, props.threadId);
  return (
    <GovernanceProjectionView
      surface="inspector"
      snapshot={query.data}
      pending={query.isPending}
      error={query.error}
      onRefresh={query.refresh}
    />
  );
}
