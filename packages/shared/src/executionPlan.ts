import {
  ACTION_GATE_POLICY_VERSION,
  ActionId,
  EXECUTION_PLAN_VERSION,
  ExecutionPlanId,
  MCP_DESCRIPTOR_VERSION,
  MCP_ROUTER_POLICY_VERSION,
  McpNamespacedToolId,
  McpServerId,
  SKILL_MANIFEST_VERSION,
  SKILL_ROUTER_POLICY_VERSION,
  type EnvironmentId,
  type ExecutionPlanV0,
  type McpRouterDecision,
  type McpServerDescriptorV0,
  type ModelRouterDecision,
  type PlannedActionV0,
  type ProjectId,
  type SkillRouterDecision,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import {
  actionFingerprintOf,
  defaultDecisionForRisk,
  SECRET_EXPOSURE_TOOLS,
} from "./actionGate.ts";
import { digestCanonical } from "./actionCanonical.ts";

export type PlannedActionInput = {
  readonly actionId?: string;
  readonly serverId: string;
  readonly toolId: string;
  readonly arguments: unknown;
  readonly schemaDigest: string;
  readonly riskClass: PlannedActionV0["riskClass"];
  readonly sideEffectClass: PlannedActionV0["sideEffectClass"];
};

export const argumentDigestOf = (value: unknown): string => digestCanonical(value);

const buildPlannedAction = (input: {
  readonly planId: string;
  readonly environmentId: string;
  readonly action: PlannedActionInput;
  readonly index: number;
}): PlannedActionV0 => {
  const actionId = ActionId.make(input.action.actionId ?? `action-${input.index + 1}`);
  const argumentDigest = argumentDigestOf(input.action.arguments);
  const fingerprint = actionFingerprintOf({
    planId: input.planId,
    actionId,
    serverId: input.action.serverId,
    toolId: input.action.toolId,
    argumentDigest,
    schemaDigest: input.action.schemaDigest,
    policyVersion: ACTION_GATE_POLICY_VERSION,
    environmentId: input.environmentId,
  });
  const toolName = input.action.toolId.includes("/")
    ? input.action.toolId.slice(input.action.toolId.lastIndexOf("/") + 1)
    : input.action.toolId;
  const gateDefault = defaultDecisionForRisk({
    riskClass: input.action.riskClass,
    sideEffectClass: input.action.sideEffectClass,
    mayExposeSecrets: SECRET_EXPOSURE_TOOLS.has(toolName),
  });
  return {
    actionId,
    serverId: McpServerId.make(input.action.serverId),
    toolId: McpNamespacedToolId.make(input.action.toolId),
    argumentDigest,
    schemaDigest: input.action.schemaDigest,
    riskClass: input.action.riskClass,
    sideEffectClass: input.action.sideEffectClass,
    fingerprint,
    requiresApproval: gateDefault.decision !== "ALLOW",
  };
};

export const buildExecutionPlan = (input: {
  readonly planId?: string;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly nowIso: string;
  readonly expiresAt?: string;
  readonly modelRoute: ModelRouterDecision | null;
  readonly skillRoute: SkillRouterDecision;
  readonly mcpRoute: McpRouterDecision;
  readonly catalog?: ReadonlyArray<McpServerDescriptorV0>;
  readonly actions?: ReadonlyArray<PlannedActionInput>;
}): ExecutionPlanV0 => {
  const planId = ExecutionPlanId.make(input.planId ?? `plan-${input.turnId}`);
  const selectedTool = input.mcpRoute.selected;
  const catalogTool =
    selectedTool === null
      ? undefined
      : input.catalog
          ?.flatMap((server) => server.tools)
          .find((tool) => tool.toolId === selectedTool.toolId);
  const actionInputs =
    input.actions ??
    (selectedTool === null
      ? []
      : [
          {
            serverId: selectedTool.serverId,
            toolId: selectedTool.toolId,
            arguments: {},
            schemaDigest:
              catalogTool?.schemaDigest ?? digestCanonical({ toolId: selectedTool.toolId }),
            riskClass: selectedTool.riskClass,
            sideEffectClass: selectedTool.sideEffectClass,
          },
        ]);
  const actions = actionInputs.map((action, index) =>
    buildPlannedAction({
      planId,
      environmentId: input.environmentId,
      action,
      index,
    }),
  );
  const selected = input.modelRoute?.selected?.target;
  return {
    planVersion: EXECUTION_PLAN_VERSION,
    planId,
    turnId: input.turnId,
    threadId: input.threadId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    modelRoute:
      selected === undefined
        ? null
        : {
            instanceId: selected.instanceId,
            model: selected.model,
            policyVersion: input.modelRoute?.policyVersion ?? "model-router.v0",
          },
    skillIds: input.skillRoute.selected === null ? [] : [input.skillRoute.selected.skillId],
    skillRoute: input.skillRoute,
    mcpRoute: input.mcpRoute,
    actions,
    policyVersions: [
      SKILL_ROUTER_POLICY_VERSION,
      MCP_ROUTER_POLICY_VERSION,
      ACTION_GATE_POLICY_VERSION,
    ],
    descriptorVersions: [SKILL_MANIFEST_VERSION, MCP_DESCRIPTOR_VERSION],
    provenance: digestCanonical({
      planId,
      turnId: input.turnId,
      skill: input.skillRoute.selected?.skillId ?? null,
      tool: input.mcpRoute.selected?.toolId ?? null,
      actions: actions.map((action) => action.fingerprint),
    }),
    createdAt: input.nowIso,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
};

export const planWasMutated = (original: ExecutionPlanV0, next: ExecutionPlanV0): boolean =>
  original.provenance !== next.provenance ||
  original.planId !== next.planId ||
  original.actions.length !== next.actions.length ||
  original.actions.some((action, index) => action.fingerprint !== next.actions[index]?.fingerprint);

export const rebuildPlanForFallback = (
  previous: ExecutionPlanV0,
  fallback: PlannedActionInput,
  nowIso: string,
): ExecutionPlanV0 =>
  buildExecutionPlan({
    planId: `${previous.planId}-fallback`,
    turnId: previous.turnId,
    threadId: previous.threadId,
    projectId: previous.projectId,
    environmentId: previous.environmentId,
    nowIso,
    ...(previous.expiresAt !== undefined ? { expiresAt: previous.expiresAt } : {}),
    modelRoute: null,
    skillRoute: previous.skillRoute,
    mcpRoute: previous.mcpRoute,
    actions: [fallback],
  });
