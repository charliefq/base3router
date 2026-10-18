import {
  TaskCapabilityPlan,
  type TaskCapabilityEvidence,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { planTaskCapabilities } from "@t3tools/shared/taskCapabilityPlan";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

const same = Schema.toEquivalence(TaskCapabilityPlan);
/** Reads cached inventory only. This evidence can never authorize or invoke a capability. */
export const readTaskCapabilityEvidence = Effect.fn("collaboration.readTaskCapabilityEvidence")(
  function* (
    sql: SqlClient.SqlClient,
    thread: Pick<
      OrchestrationV2AppThread,
      "agentsTaskCreation" | "taskContract" | "projectId" | "modelSelection"
    >,
  ) {
    const reviewed = thread.agentsTaskCreation?.review.capabilityPlan;
    if (!reviewed) return undefined;
    const evidence = (
      status: TaskCapabilityEvidence["status"],
      reason: string,
    ): TaskCapabilityEvidence => ({ mode: "review-only", status, reason, reviewed });
    if (reviewed.workspace === null)
      return evidence(
        "unknown",
        "The reviewed project workspace inventory was unknown. No capability selection is executable.",
      );
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    const environment = yield* Effect.serviceOption(ServerEnvironment);
    if (registry._tag === "None" || environment._tag === "None" || !thread.taskContract)
      return evidence(
        "unknown",
        "Current inventory or task contract is unavailable. Recommendations are invalidated and not executable.",
      );
    const projects = yield* sql<{
      workspace_root: string;
    }>`SELECT workspace_root FROM projection_projects WHERE project_id=${thread.projectId} AND deleted_at IS NULL`;
    const providers = yield* registry.value.getProviders;
    const current = planTaskCapabilities({
      environmentId: yield* environment.value.getEnvironmentId,
      projectId: thread.projectId,
      workspace: projects[0]?.workspace_root ?? null,
      modelSelection: thread.modelSelection,
      contract: thread.taskContract,
      provider: providers.find((p) => p.instanceId === thread.modelSelection.instanceId),
    });
    return same(reviewed, current)
      ? evidence(
          "current",
          "Reviewed advisory snapshot still matches cached task/project/provider inventory. This advisory plan cannot invoke capabilities or grant access.",
        )
      : evidence(
          "stale",
          "Task, project, provider or catalog changed. Reviewed recommendations are invalidated; use manual review. This advisory plan cannot invoke capabilities or grant access.",
        );
  },
);
