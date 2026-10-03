import {
  type DispatcherTaskRouteBinding,
  type EnvironmentId,
  type McpServerDescriptorV0,
  type ProjectId,
  type ServerProvider,
  type SkillManifestV0,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import { buildExecutionPlan } from "./executionPlan.ts";
import { firstPartyMcpCatalog } from "./mcpCatalog.ts";
import { routeMcp } from "./mcpRouter.ts";
import { skillCatalogFromProviders } from "./skillCatalog.ts";
import { routeSkills } from "./skillRouter.ts";

export const attachPhase12Routes = (input: {
  readonly binding: DispatcherTaskRouteBinding;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly extraSkills?: ReadonlyArray<SkillManifestV0>;
  readonly extraMcp?: ReadonlyArray<McpServerDescriptorV0>;
  readonly nowIso: string;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
}): DispatcherTaskRouteBinding => {
  const skills = [...skillCatalogFromProviders(input.providers), ...(input.extraSkills ?? [])];
  const mcp = [...firstPartyMcpCatalog(input.nowIso), ...(input.extraMcp ?? [])];
  const modelCapabilities = input.binding.modelRoute?.selected?.capabilities ?? ["code", "tools"];
  const skillRoute = routeSkills({
    mode: "auto",
    nowIso: input.nowIso,
    catalog: skills,
    modelCapabilities,
  });
  const mcpRoute = routeMcp({
    mode: "auto",
    nowIso: input.nowIso,
    catalog: mcp,
    modelCapabilities,
  });
  const executionPlan = buildExecutionPlan({
    turnId: input.turnId,
    threadId: input.threadId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    nowIso: input.nowIso,
    modelRoute: input.binding.modelRoute ?? null,
    skillRoute,
    mcpRoute,
    catalog: mcp,
  });
  return {
    ...input.binding,
    skillRoute,
    mcpRoute,
    executionPlan,
  };
};
