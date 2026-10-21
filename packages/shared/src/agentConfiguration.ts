import type { AgentProfile, AgentConfigurationSnapshot } from "@t3tools/contracts";
export function configurationSnapshot(profile: AgentProfile): AgentConfigurationSnapshot | null {
  const binding = profile.taskConfiguration;
  return binding && profile.projectId
    ? {
        id: profile.id,
        revision: profile.version,
        name: profile.displayName,
        projectId: profile.projectId,
        environmentId: binding.environmentId,
        ownerId: binding.ownerId,
        modelSelection: binding.modelSelection,
        instructions: profile.instructions,
      }
    : null;
}
export const configurationInput = (instructions: string, goal: string) =>
  `${instructions}\n\nTask goal:\n${goal}`;
