import {
  HYBRID_MIN_SAMPLE_RATE,
  SKILL_ROUTER_MAX_CANDIDATES,
  SKILL_ROUTER_POLICY_VERSION,
  type ActionRiskClass,
  type ModelRouterCapability,
  type SkillId,
  type SkillManifestV0,
  type SkillRouterCandidate,
  type SkillRouterConstraints,
  type SkillRouterDecision,
  type SkillRouterEvidence,
  type SkillRouterMode,
  type SkillRouterReasonCode,
  type TaskMacroCategory,
} from "@t3tools/contracts";

import { trustedSkillInstructionRef } from "./skillCatalog.ts";

export type SkillRouterInput = {
  readonly mode: SkillRouterMode;
  readonly nowIso: string;
  readonly requiredCapabilities?: ReadonlyArray<SkillManifestV0["capabilities"][number]>;
  readonly taskClass?: TaskMacroCategory;
  readonly modelCapabilities?: ReadonlyArray<ModelRouterCapability>;
  readonly availableMcpToolIds?: ReadonlyArray<string>;
  readonly constraints?: SkillRouterConstraints;
  readonly catalog: ReadonlyArray<SkillManifestV0>;
  readonly manualOverride?: SkillId | null;
  readonly evidence?: ReadonlyArray<SkillRouterEvidence>;
};

const uniqueReasons = (
  codes: ReadonlyArray<SkillRouterReasonCode>,
): ReadonlyArray<SkillRouterReasonCode> => [...new Set(codes)].slice(0, 16);

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

const hasSkill = (list: ReadonlyArray<SkillId> | undefined, id: SkillId): boolean =>
  list !== undefined && list.includes(id);

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const filterManifest = (
  manifest: SkillManifestV0,
  input: SkillRouterInput,
): { readonly eligible: boolean; readonly reasonCodes: ReadonlyArray<SkillRouterReasonCode> } => {
  const reasons: SkillRouterReasonCode[] = [];
  const required = input.requiredCapabilities ?? input.constraints?.requiredCapabilities ?? [];
  if (required.some((capability) => !manifest.capabilities.includes(capability))) {
    reasons.push("REQUIRED_CAPABILITY_MISSING");
  }
  if (!manifest.enabled) reasons.push("DISABLED");
  if (!manifest.available) reasons.push("UNAVAILABLE");
  if (manifest.trustState === "untrusted" && input.constraints?.allowUntrusted !== true) {
    reasons.push("FILTERED_UNTRUSTED");
  }
  if (
    manifest.trustState === "unknown" &&
    !(input.constraints?.allowUnknownLocalTrust === true && manifest.source === "local-filesystem")
  ) {
    reasons.push("FILTERED_TRUST_UNKNOWN");
  }
  const modelCapabilities = input.modelCapabilities ?? [];
  if (
    manifest.compatibleModelCapabilities.length > 0 &&
    modelCapabilities.length > 0 &&
    !manifest.compatibleModelCapabilities.some((capability) =>
      modelCapabilities.includes(capability),
    )
  ) {
    reasons.push("PROVIDER_MODEL_INCOMPATIBLE");
  }
  if (
    manifest.compatibleTaskClasses.length > 0 &&
    input.taskClass !== undefined &&
    input.taskClass !== "unknown" &&
    !manifest.compatibleTaskClasses.includes(input.taskClass)
  ) {
    reasons.push("TASK_CLASS_INCOMPATIBLE");
  }
  const availableTools = input.availableMcpToolIds ?? [];
  if (manifest.requiredMcpTools.some((toolId) => !availableTools.includes(toolId))) {
    reasons.push("MCP_DEPENDENCY_MISSING");
  }
  if (hasSkill(input.constraints?.excludedSkillIds, manifest.skillId)) {
    reasons.push("CONSTRAINT_EXCLUDED");
  }
  if (
    input.constraints?.allowedSkillIds !== undefined &&
    !hasSkill(input.constraints.allowedSkillIds, manifest.skillId)
  ) {
    reasons.push("CONSTRAINT_NOT_ALLOWED");
  }
  return { eligible: reasons.length === 0, reasonCodes: uniqueReasons(reasons) };
};

const toCandidate = (
  manifest: SkillManifestV0,
  filter: {
    readonly eligible: boolean;
    readonly reasonCodes: ReadonlyArray<SkillRouterReasonCode>;
  },
): SkillRouterCandidate => ({
  skillId: manifest.skillId,
  name: manifest.name,
  version: manifest.version,
  eligible: filter.eligible,
  reasonCodes: filter.reasonCodes,
  trustState: manifest.trustState,
  capabilities: [...manifest.capabilities],
  costHint: manifest.costHint,
  riskClass: manifest.riskClass,
});

const evidenceRank = (
  skillId: SkillId,
  evidence: ReadonlyArray<SkillRouterEvidence> | undefined,
): number | null => {
  const row = evidence?.find((entry) => entry.skillId === skillId);
  if (row === undefined || !row.valid || row.successTrials < HYBRID_MIN_SAMPLE_RATE) return null;
  return row.successCount / row.successTrials;
};

const tieBreakCandidates = (
  left: SkillRouterCandidate,
  right: SkillRouterCandidate,
  evidence: ReadonlyArray<SkillRouterEvidence> | undefined,
): number => {
  const leftRank = evidenceRank(left.skillId, evidence);
  const rightRank = evidenceRank(right.skillId, evidence);
  if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
    return rightRank - leftRank;
  }
  const byRisk = riskRank(left.riskClass) - riskRank(right.riskClass);
  if (byRisk !== 0) return byRisk;
  const byId = compareUtf16(left.skillId, right.skillId);
  if (byId !== 0) return byId;
  return compareUtf16(left.version, right.version);
};

export const routeSkills = (input: SkillRouterInput): SkillRouterDecision => {
  const catalog = input.catalog.slice(0, SKILL_ROUTER_MAX_CANDIDATES);
  const candidates = catalog.map((manifest) =>
    toCandidate(manifest, filterManifest(manifest, input)),
  );
  const eligible = candidates
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => tieBreakCandidates(left, right, input.evidence));
  const filtered = candidates.filter((candidate) => !candidate.eligible);
  const evidenceUsed = eligible.some(
    (candidate) => evidenceRank(candidate.skillId, input.evidence) !== null,
  );

  let selected: SkillRouterCandidate | null = null;
  const selectionReasons: SkillRouterReasonCode[] = [];

  if (input.mode === "manual" && input.manualOverride) {
    const match =
      candidates.find((candidate) => candidate.skillId === input.manualOverride) ?? null;
    selected = match;
    selectionReasons.push("MANUAL_OVERRIDE");
    if (match) {
      selected = {
        ...match,
        reasonCodes: uniqueReasons([...match.reasonCodes, "MANUAL_OVERRIDE", "SELECTED"]),
      };
    }
  } else if (catalog.length === 0) {
    selectionReasons.push("NO_SKILLS_CONFIGURED", "NO_SKILL_REQUIRED");
  } else if (eligible.length === 0) {
    selectionReasons.push("NO_ELIGIBLE_CANDIDATES", "NO_SKILL_REQUIRED");
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

  const instructionRef =
    selected === null
      ? null
      : (catalog
          .map((manifest) => trustedSkillInstructionRef({ manifest, selected }))
          .find((ref) => ref !== null) ?? null);

  const noSkill = selected === null;
  const explanation = noSkill
    ? catalog.length === 0
      ? "No skills are configured. Continuing without a skill."
      : "No eligible skill. Continuing without a skill."
    : `Selected ${selected.skillId} by ${SKILL_ROUTER_POLICY_VERSION} tie-break.`;

  return {
    policyVersion: SKILL_ROUTER_POLICY_VERSION,
    mode: input.mode,
    selected,
    instructionRef,
    eligible,
    filtered,
    candidates,
    reasonCodes: uniqueReasons(
      noSkill && !selectionReasons.includes("MANUAL_OVERRIDE")
        ? [...selectionReasons, "NO_SKILL_REQUIRED"]
        : selectionReasons,
    ),
    explanation,
    evidenceUsed,
    tieBreak:
      "ascending risk class, then skillId lexicographic, then version. Display names and discovery order are ignored.",
    createdAt: input.nowIso,
  };
};
