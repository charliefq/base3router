import {
  HYBRID_MIN_SAMPLE_RATE,
  MCP_ROUTER_MAX_CANDIDATES,
  MCP_ROUTER_POLICY_VERSION,
  type ActionRiskClass,
  type McpNamespacedToolId,
  type McpRouterCandidate,
  type McpRouterConstraints,
  type McpRouterDecision,
  type McpRouterEvidence,
  type McpRouterMode,
  type McpRouterReasonCode,
  type McpServerDescriptorV0,
  type McpServerId,
  type ModelRouterCapability,
} from "@t3tools/contracts";

import { SECRET_EXPOSURE_TOOLS } from "./actionGate.ts";

export type McpRouterInput = {
  readonly mode: McpRouterMode;
  readonly nowIso: string;
  readonly requiredCapabilities?: ReadonlyArray<McpRouterCandidate["capabilities"][number]>;
  readonly modelCapabilities?: ReadonlyArray<ModelRouterCapability>;
  readonly denyRiskClasses?: ReadonlyArray<ActionRiskClass>;
  readonly constraints?: McpRouterConstraints;
  readonly catalog: ReadonlyArray<McpServerDescriptorV0>;
  readonly manualOverride?: McpNamespacedToolId | null;
  readonly evidence?: ReadonlyArray<McpRouterEvidence>;
};

const RISK_RANK: ReadonlyArray<ActionRiskClass> = [
  "read-only-local",
  "local-mutation",
  "network-access",
  "external-write",
  "unclassified",
  "administrative",
  "credential",
  "financial",
  "destructive",
];

const riskRank = (risk: ActionRiskClass): number => {
  const index = RISK_RANK.indexOf(risk);
  return index === -1 ? RISK_RANK.length : index;
};

const uniqueReasons = (
  codes: ReadonlyArray<McpRouterReasonCode>,
): ReadonlyArray<McpRouterReasonCode> => [...new Set(codes)].slice(0, 16);

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const hasId = (list: ReadonlyArray<string> | undefined, value: string): boolean =>
  list !== undefined && list.includes(value);

const toolName = (toolId: string): string =>
  toolId.includes("/") ? toolId.slice(toolId.lastIndexOf("/") + 1) : toolId;

const filterTool = (
  server: McpServerDescriptorV0,
  tool: McpServerDescriptorV0["tools"][number],
  input: McpRouterInput,
): { readonly eligible: boolean; readonly reasonCodes: ReadonlyArray<McpRouterReasonCode> } => {
  const reasons: McpRouterReasonCode[] = [];
  const required = input.requiredCapabilities ?? input.constraints?.requiredCapabilities ?? [];
  if (required.some((capability) => !tool.capabilities.includes(capability))) {
    reasons.push("REQUIRED_CAPABILITY_MISSING");
  }
  if (!server.configured) reasons.push("NOT_CONFIGURED");
  if (!server.enabled) reasons.push("DISABLED");
  if (!server.connected) reasons.push("NOT_CONNECTED");
  if (server.runtimeState === "degraded") reasons.push("DEGRADED");
  if (server.trustState === "untrusted" && input.constraints?.allowUntrusted !== true) {
    reasons.push("FILTERED_UNTRUSTED");
  }
  if (server.trustState === "unknown" && input.constraints?.allowUnknownTrust !== true) {
    reasons.push("FILTERED_TRUST_UNKNOWN");
  }
  if (server.transportKind === "stdio" || server.transportKind === "unsupported") {
    reasons.push("UNSUPPORTED_TRANSPORT");
  }
  if (server.stale) reasons.push("STALE_DISCOVERY");
  if (tool.metadataOversized) reasons.push("OVERSIZED_METADATA");
  if (tool.promptInjectionShaped) reasons.push("PROMPT_INJECTION_SHAPED");
  const modelCapabilities = input.modelCapabilities ?? [];
  if (
    tool.compatibleModelCapabilities.length > 0 &&
    modelCapabilities.length > 0 &&
    !tool.compatibleModelCapabilities.some((capability) => modelCapabilities.includes(capability))
  ) {
    reasons.push("MODEL_SKILL_INCOMPATIBLE");
  }
  if (input.denyRiskClasses?.includes(tool.riskClass) === true) {
    reasons.push("ACTION_GATE_DENY");
  }
  if (hasId(input.constraints?.excludedServerIds, server.serverId)) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  if (hasId(input.constraints?.excludedToolIds, tool.toolId)) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  if (
    input.constraints?.allowedServerIds !== undefined &&
    !hasId(input.constraints.allowedServerIds, server.serverId)
  ) {
    reasons.push("CONSTRAINT_NOT_ALLOWED");
  }
  if (
    input.constraints?.allowedToolIds !== undefined &&
    !hasId(input.constraints.allowedToolIds, tool.toolId)
  ) {
    reasons.push("CONSTRAINT_NOT_ALLOWED");
  }
  return { eligible: reasons.length === 0, reasonCodes: uniqueReasons(reasons) };
};

const toCandidate = (
  server: McpServerDescriptorV0,
  tool: McpServerDescriptorV0["tools"][number],
  filter: { readonly eligible: boolean; readonly reasonCodes: ReadonlyArray<McpRouterReasonCode> },
): McpRouterCandidate => ({
  toolId: tool.toolId,
  serverId: server.serverId,
  name: tool.name,
  eligible: filter.eligible,
  reasonCodes: filter.reasonCodes,
  trustState: server.trustState,
  riskClass: tool.riskClass,
  sideEffectClass: tool.sideEffectClass,
  capabilities: [...tool.capabilities],
  costAttribution: tool.costAttribution,
});

const evidenceRank = (
  toolId: McpNamespacedToolId,
  evidence: ReadonlyArray<McpRouterEvidence> | undefined,
): number | null => {
  const row = evidence?.find((entry) => entry.toolId === toolId);
  if (row === undefined || !row.valid || row.successTrials < HYBRID_MIN_SAMPLE_RATE) return null;
  return row.successCount / row.successTrials;
};

const compareCandidates = (
  left: McpRouterCandidate,
  right: McpRouterCandidate,
  evidence: ReadonlyArray<McpRouterEvidence> | undefined,
): number => {
  const leftRank = evidenceRank(left.toolId, evidence);
  const rightRank = evidenceRank(right.toolId, evidence);
  if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
    return rightRank - leftRank;
  }
  const byRisk = riskRank(left.riskClass) - riskRank(right.riskClass);
  if (byRisk !== 0) return byRisk;
  const leftExpose = SECRET_EXPOSURE_TOOLS.has(toolName(left.toolId)) ? 1 : 0;
  const rightExpose = SECRET_EXPOSURE_TOOLS.has(toolName(right.toolId)) ? 1 : 0;
  if (leftExpose !== rightExpose) return leftExpose - rightExpose;
  const byTool = compareUtf16(left.toolId, right.toolId);
  if (byTool !== 0) return byTool;
  return compareUtf16(left.serverId, right.serverId);
};

export const flattenMcpCatalog = (
  catalog: ReadonlyArray<McpServerDescriptorV0>,
): ReadonlyArray<{
  readonly server: McpServerDescriptorV0;
  readonly tool: McpServerDescriptorV0["tools"][number];
}> => catalog.flatMap((server) => server.tools.map((tool) => ({ server, tool })));

export const routeMcp = (input: McpRouterInput): McpRouterDecision => {
  const pairs = flattenMcpCatalog(input.catalog).slice(0, MCP_ROUTER_MAX_CANDIDATES);
  const candidates = pairs.map(({ server, tool }) =>
    toCandidate(server, tool, filterTool(server, tool, input)),
  );
  const eligible = candidates
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => compareCandidates(left, right, input.evidence));
  const filtered = candidates.filter((candidate) => !candidate.eligible);
  const evidenceUsed = eligible.some(
    (candidate) => evidenceRank(candidate.toolId, input.evidence) !== null,
  );

  let selected: McpRouterCandidate | null = null;
  const selectionReasons: McpRouterReasonCode[] = [];

  if (input.mode === "manual" && input.manualOverride) {
    const match = candidates.find((candidate) => candidate.toolId === input.manualOverride) ?? null;
    selected = match;
    selectionReasons.push("MANUAL_OVERRIDE");
    if (match) {
      selected = {
        ...match,
        reasonCodes: uniqueReasons([...match.reasonCodes, "MANUAL_OVERRIDE", "SELECTED"]),
      };
    }
  } else if (pairs.length === 0) {
    selectionReasons.push("NO_MCP_CONFIGURED", "NO_TOOL_REQUIRED");
  } else if (eligible.length === 0) {
    selectionReasons.push("NO_ELIGIBLE_CANDIDATES", "NO_TOOL_REQUIRED");
  } else {
    selected = {
      ...eligible[0]!,
      reasonCodes: uniqueReasons([
        ...eligible[0]!.reasonCodes,
        "SELECTED",
        "POLICY_TIE_BREAK",
        ...(evidenceUsed ? [] : (["METRICS_UNKNOWN"] as const)),
      ]),
    };
    selectionReasons.push("SELECTED", "POLICY_TIE_BREAK");
    if (!evidenceUsed) selectionReasons.push("METRICS_UNKNOWN");
  }

  const noTool = selected === null;
  return {
    policyVersion: MCP_ROUTER_POLICY_VERSION,
    mode: input.mode,
    selected,
    eligible,
    filtered,
    candidates,
    reasonCodes: uniqueReasons(
      noTool && !selectionReasons.includes("MANUAL_OVERRIDE")
        ? [...selectionReasons, "NO_TOOL_REQUIRED"]
        : selectionReasons,
    ),
    explanation: noTool
      ? pairs.length === 0
        ? "No MCP servers are configured. Continuing without a tool."
        : "No eligible MCP tool. Continuing without a tool."
      : `Selected ${selected?.toolId ?? "none"} by ${MCP_ROUTER_POLICY_VERSION} tie-break.`,
    evidenceUsed,
    tieBreak:
      "ascending risk class, then namespaced toolId lexicographic, then serverId. Display names and discovery order are ignored.",
    createdAt: input.nowIso,
  };
};

export const mcpServerIds = (
  catalog: ReadonlyArray<McpServerDescriptorV0>,
): ReadonlyArray<McpServerId> => catalog.map((server) => server.serverId);
