import { ProjectId, TurnId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { buildExecutionPlan } from "@t3tools/shared/executionPlan";
import {
  FIRST_PARTY_DEVICE_TOOLS,
  FIRST_PARTY_PREVIEW_TOOLS,
  FIRST_PARTY_PULL_REQUEST_TOOLS,
  firstPartyMcpCatalog,
} from "@t3tools/shared/mcpCatalog";
import { routeMcp } from "@t3tools/shared/mcpRouter";
import { routeSkills } from "@t3tools/shared/skillRouter";

const FIRST_PARTY_TOOLS = [
  ...FIRST_PARTY_PREVIEW_TOOLS,
  ...FIRST_PARTY_DEVICE_TOOLS,
  ...FIRST_PARTY_PULL_REQUEST_TOOLS,
];

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/**
 * Authorize and post-queue revalidation must hash the same recipe. Timestamps
 * are plan metadata only; they are not part of the action fingerprint.
 */
export const planMcpToolAction = (input: {
  readonly toolName: string;
  readonly args: unknown;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly nowIso?: string;
  readonly expiresAt?: string;
}) => {
  const nowIso = input.nowIso ?? EPOCH_ISO;
  const spec = FIRST_PARTY_TOOLS.find((tool) => tool.name === input.toolName);
  const serverId =
    spec?.capability === "device"
      ? "t3-device"
      : spec?.capability === "pull-requests"
        ? "t3-pull-requests"
        : "t3-preview";
  const toolId = `${serverId}/${input.toolName}`;
  const plan = buildExecutionPlan({
    turnId: TurnId.make(input.threadId),
    threadId: input.threadId,
    projectId: ProjectId.make("unbound"),
    environmentId: input.environmentId,
    nowIso,
    expiresAt: input.expiresAt ?? nowIso,
    modelRoute: null,
    skillRoute: routeSkills({ mode: "auto", nowIso, catalog: [] }),
    mcpRoute: routeMcp({
      mode: "auto",
      nowIso,
      catalog: firstPartyMcpCatalog(nowIso),
    }),
    actions: [
      {
        serverId,
        toolId,
        arguments: input.args,
        schemaDigest: spec?.name ?? "unknown",
        riskClass: spec?.riskClass ?? "unclassified",
        sideEffectClass: spec?.sideEffectClass ?? "unknown",
      },
    ],
  });
  return { spec, action: plan.actions[0], plan };
};
