import { WorkflowTemplateDraft, type AgentProfile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const validDraft = Schema.is(WorkflowTemplateDraft);
/** Validates only new supervised compositions; historical event replay keeps its original rules. */
export function workflowCompositionIssue(
  draft: WorkflowTemplateDraft,
  profiles: ReadonlyArray<AgentProfile>,
): string | null {
  if (!validDraft(draft)) return "Workflow name, description or stages exceed the allowed bounds.";
  if (draft.stages[0]?.type !== "agent") return "The first stage must be an agent.";
  for (const [index, stage] of draft.stages.entries()) {
    if (draft.stages.some((other, i) => i !== index && other.id === stage.id))
      return "Stage IDs must be unique.";
    if (stage.nextStageId !== (draft.stages[index + 1]?.id ?? null))
      return "Stages must form one ordered sequence.";
    if (!stage.approvalRequired) return "Every stage requires human approval.";
    if (
      /```|^\s*#!|\b(?:sudo|eval|child_process|execSync)\b/m.test(stage.taskPromptTemplate) ||
      /\bBearer\s+\S+|\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,})\b|\b[A-Z][A-Z0-9_]{2,}=\S+/i.test(
        stage.taskPromptTemplate,
      )
    )
      return "Stage instructions must be plain task context without executable or credential-shaped values.";
    if (stage.type === "agent") {
      const role = profiles.find(
        (p) =>
          p.origin === "built-in" &&
          p.projectId === null &&
          p.status === "active" &&
          p.id === stage.profileId &&
          p.version === stage.profileVersion,
      );
      if (!role) return "An exact active built-in role version is unavailable.";
      if (
        stage.artifactKind !== role.artifactKind ||
        JSON.stringify(stage.requiredOutputSections) !==
          JSON.stringify(role.requiredOutputSections) ||
        JSON.stringify(stage.capabilityPreferences) !== JSON.stringify(role.capabilityPreferences)
      )
        return "Output and capability contracts must match the exact built-in role.";
    } else if (
      stage.type !== "human_gate" ||
      draft.stages[index - 1]?.type !== "agent" ||
      stage.profileId !== null ||
      stage.profileVersion !== null ||
      stage.requiredOutputSections.length ||
      stage.capabilityPreferences.length
    )
      return "A human gate must immediately follow an agent and cannot bind a role or output contract.";
  }
  return null;
}
