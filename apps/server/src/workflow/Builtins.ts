import type { AgentProfile, WorkflowStage, WorkflowTemplate } from "@t3tools/contracts";

const CREATED_AT = "2026-09-28T00:00:00.000Z";

const profile = (
  input: Omit<
    AgentProfile,
    "version" | "projectId" | "origin" | "status" | "createdAt" | "updatedAt"
  >,
): AgentProfile => ({
  ...input,
  version: 1,
  projectId: null,
  origin: "built-in",
  status: "active",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

export const BUILTIN_AGENT_PROFILES: ReadonlyArray<AgentProfile> = [
  profile({
    id: "bill",
    displayName: "Bill",
    description: "SaaS opportunity discovery",
    artifactKind: "opportunity_brief",
    purpose:
      "Find one evidence-backed SaaS opportunity with a reachable first customer and distribution channel.",
    responsibilities: [
      "Separate sourced evidence from inference",
      "Choose one primary opportunity",
      "Map a reachable distribution channel",
    ],
    exclusions: [
      "Do not invent demand, quotes, revenue, prices, search volume, or market size",
      "Do not present an idea dump as a decision",
    ],
    instructions:
      "Investigate one opportunity. Cite source URLs and dates for current evidence. Mark unsupported conclusions as inference or Unknown. Produce the required headings exactly. A score is your stated assessment, not verified market data. Do not claim a Build Gate decision; the human decides.",
    requiredOutputSections: [
      "Product",
      "First customer",
      "Triggering event",
      "Current evidence with URLs and dates",
      "Alternatives",
      "Advantage over general-purpose AI",
      "Distribution map",
      "Monetization hypothesis",
      "48-hour MVP",
      "Risks",
      "Build Gate score",
      "Downstream handoff",
    ],
    capabilityPreferences: ["web-research"],
  }),
  profile({
    id: "zackburg",
    displayName: "Zackburg",
    description: "Bounded product architecture",
    artifactKind: "build_packet",
    purpose: "Turn an approved opportunity or user objective into a bounded implementation plan.",
    responsibilities: [
      "Define the smallest viable scope",
      "Provide implementation and independent-review prompts",
      "List unresolved risks",
    ],
    exclusions: [
      "Do not expand a narrow MVP into a generalized platform",
      "Do not claim approval, test results, or deployment evidence",
    ],
    instructions:
      "Use only the approved artifact and the task's verified context. Produce the required headings exactly. Keep the MVP boundary narrow. Mark missing evidence Unknown. Route recommendations are preferences, never claims that a runner is installed or authenticated.",
    requiredOutputSections: [
      "Product decision",
      "MVP boundary",
      "User flow",
      "Functional requirements",
      "Non-functional requirements",
      "Architecture",
      "Analytics",
      "Acceptance criteria",
      "Routing recommendation",
      "Implementation prompt",
      "Independent-review prompt",
      "Launch handoff",
      "Open risks",
    ],
    capabilityPreferences: ["long-context-repository"],
  }),
  profile({
    id: "implementer",
    displayName: "Implementer",
    description: "Approved scope implementation",
    artifactKind: "implementation_report",
    purpose:
      "Implement an approved build packet in an authorized repository and isolated feature branch.",
    responsibilities: [
      "Make the scoped change",
      "Run focused verification",
      "Report exact repository state",
    ],
    exclusions: [
      "Do not deploy or merge without authorization",
      "Do not invent test or PR results",
    ],
    instructions:
      "Follow repository instructions and existing task permissions. Produce the required headings exactly. State which tests actually ran and which work remains.",
    requiredOutputSections: [
      "Repository state",
      "Completed work",
      "Changed files",
      "Tests",
      "Remaining work",
      "Commits and PR",
      "Deployment status",
      "Risks",
    ],
    capabilityPreferences: ["backend-correctness"],
  }),
  profile({
    id: "independent-reviewer",
    displayName: "Independent Reviewer",
    description: "Independent verification",
    artifactKind: "review_report",
    purpose:
      "Verify correctness, security, privacy, product claims, model cost, tests, UI behavior, and launch readiness.",
    responsibilities: [
      "Check actual changes and evidence",
      "Separate blocking from non-blocking findings",
      "Report verification performed",
    ],
    exclusions: ["Do not approve unverified claims", "Do not silently expand implementation scope"],
    instructions:
      "Review independently. Produce the required headings exactly. Cite concrete evidence and say Unknown where verification could not be performed.",
    requiredOutputSections: [
      "Blocking findings",
      "Non-blocking findings",
      "Verification performed",
      "Fixes applied",
      "Remaining risks",
      "Approval decision",
    ],
    capabilityPreferences: ["independent-review"],
  }),
  profile({
    id: "launch-owner",
    displayName: "Launch Owner",
    description: "Authorized launch readiness",
    artifactKind: "launch_report",
    purpose: "Verify launch readiness and deploy only when separately authorized.",
    responsibilities: [
      "Verify production identity and anonymous access",
      "Perform smoke tests",
      "Record rollback information",
    ],
    exclusions: [
      "Do not deploy without authorization",
      "Never report environment variable values",
      "Do not invent a production URL",
    ],
    instructions:
      "Produce the required headings exactly. Distinguish planned checks from completed checks. Record environment variable names only, never values. Missing deployment evidence is Unknown.",
    requiredOutputSections: [
      "Production URL",
      "Anonymous-access evidence",
      "Deployment identity",
      "Smoke tests",
      "Environment variable names",
      "Analytics readiness",
      "Rollback information",
      "Remaining risks",
    ],
    capabilityPreferences: [],
  }),
];

const stage = (
  input: Pick<
    WorkflowStage,
    "id" | "label" | "type" | "profileId" | "artifactKind" | "nextStageId"
  > &
    Partial<Pick<WorkflowStage, "requiredOutputSections" | "taskPromptTemplate">>,
): WorkflowStage => {
  const linkedProfile = BUILTIN_AGENT_PROFILES.find((profile) => profile.id === input.profileId);
  return {
    ...input,
    profileVersion: linkedProfile?.version ?? null,
    requiredOutputSections:
      input.requiredOutputSections ?? linkedProfile?.requiredOutputSections ?? [],
    approvalRequired: true,
    capabilityPreferences: linkedProfile?.capabilityPreferences ?? [],
    taskPromptTemplate:
      input.taskPromptTemplate ??
      "Complete this stage using the reviewed workflow context. Use the required output headings and mark missing facts Unknown.",
    maxAttempts: 3,
  };
};

export const BUILTIN_WORKFLOW_TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  {
    id: "saas-production",
    version: 1,
    projectId: null,
    origin: "built-in",
    status: "active",
    displayName: "SaaS Production",
    description:
      "Discovery, human gate, architecture, implementation, review, launch, and feedback.",
    stages: [
      stage({
        id: "discovery",
        label: "Discovery",
        type: "agent",
        profileId: "bill",
        artifactKind: "opportunity_brief",
        nextStageId: "build_gate",
      }),
      stage({
        id: "build_gate",
        label: "Build Gate",
        type: "human_gate",
        profileId: null,
        artifactKind: "build_decision",
        nextStageId: "architecture",
      }),
      stage({
        id: "architecture",
        label: "Architecture",
        type: "agent",
        profileId: "zackburg",
        artifactKind: "build_packet",
        nextStageId: "implementation",
      }),
      stage({
        id: "implementation",
        label: "Implementation",
        type: "agent",
        profileId: "implementer",
        artifactKind: "implementation_report",
        nextStageId: "review",
      }),
      stage({
        id: "review",
        label: "Review",
        type: "agent",
        profileId: "independent-reviewer",
        artifactKind: "review_report",
        nextStageId: "launch",
      }),
      stage({
        id: "launch",
        label: "Launch",
        type: "agent",
        profileId: "launch-owner",
        artifactKind: "launch_report",
        nextStageId: "feedback",
      }),
      stage({
        id: "feedback",
        label: "Feedback",
        type: "agent",
        profileId: "bill",
        artifactKind: "feedback_report",
        nextStageId: null,
        requiredOutputSections: [
          "Acquisition",
          "Activation",
          "Conversion",
          "Qualitative feedback",
          "Evidence and dates",
          "Inferences",
          "Next experiment",
          "Risks",
        ],
        taskPromptTemplate:
          "Analyze only real observed acquisition, activation, conversion, and qualitative feedback. Cite evidence with dates. Mark unavailable metrics Unknown; do not invent numbers. Recommend one bounded next experiment.",
      }),
    ],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
];
