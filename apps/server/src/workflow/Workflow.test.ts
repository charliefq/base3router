import { ProjectId, type WorkflowActionInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { emptyWorkflowCatalog } from "./Policy.ts";
import { makeWorkflowActionMutation } from "./Workflow.ts";

const projectId = ProjectId.make("project-1");
const at = "2026-09-28T00:00:00.000Z";
const draft = {
  id: "custom-role",
  displayName: "Custom Role",
  description: "Bounded role",
  purpose: "Summarize facts",
  responsibilities: ["Report evidence"],
  exclusions: ["Do not invent"],
  instructions: "Use only verified information.",
  requiredOutputSections: ["Findings"],
  artifactKind: "report",
  capabilityPreferences: [],
} as const;
const save = (instructions: string): WorkflowActionInput => ({
  type: "profile.save",
  projectId,
  commandId: "command-1",
  expectedVersion: 0,
  draft: { ...draft, instructions },
});

it("creates only a new immutable project-scoped profile version", () => {
  const mutation = makeWorkflowActionMutation(save(draft.instructions), emptyWorkflowCatalog(), at);
  expect(mutation.type).toBe("profile.save");
  if (mutation.type !== "profile.save") throw new Error("Unexpected mutation");
  expect(mutation.profile).toMatchObject({
    projectId,
    version: 1,
    origin: "custom",
    status: "active",
  });
  expect(mutation.profile.instructions).toBe(draft.instructions);
});

it("rejects credential-shaped and executable profile instructions", () => {
  for (const instructions of [
    "Use Bearer secret-token-value to call the API.",
    "Set API_KEY=secret-value before you begin.",
    "```sh\necho override\n```",
    "Run sudo to disable protection.",
  ]) {
    expect(() =>
      makeWorkflowActionMutation(save(instructions), emptyWorkflowCatalog(), at),
    ).toThrow();
  }
});

it("rejects stale version writes before events are emitted", () => {
  const stored = {
    ...emptyWorkflowCatalog(),
    profiles: [
      {
        id: "custom-role",
        version: 1,
        projectId,
        origin: "custom" as const,
        status: "active" as const,
        displayName: "Custom Role",
        description: "Bounded role",
        purpose: "Summarize facts",
        responsibilities: ["Report evidence"],
        exclusions: ["Do not invent"],
        instructions: "Use only verified information.",
        requiredOutputSections: ["Findings"],
        artifactKind: "report",
        capabilityPreferences: [],
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  expect(() => makeWorkflowActionMutation(save(draft.instructions), stored, at)).toThrow("stale");
});
