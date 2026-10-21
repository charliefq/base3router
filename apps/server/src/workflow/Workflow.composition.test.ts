import { expect, it } from "vite-plus/test";
import { ProjectId, type WorkflowCatalog, type WorkflowStage } from "@t3tools/contracts";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { makeWorkflowActionMutation } from "./Workflow.ts";

const projectId = ProjectId.make("project-composition");
const at = "2026-10-19T00:00:00.000Z";
const catalog: WorkflowCatalog = {
  profiles: BUILTIN_AGENT_PROFILES,
  templates: BUILTIN_WORKFLOW_TEMPLATES,
  runs: [],
};
const builtin = BUILTIN_WORKFLOW_TEMPLATES[0]!;
it("rejects a new reusable workflow whose first stage is a human gate", () => {
  expect(() =>
    makeWorkflowActionMutation(
      {
        type: "template.save",
        projectId,
        commandId: "save-invalid-first",
        expectedVersion: 0,
        draft: {
          id: "custom-workflow",
          displayName: "Custom workflow",
          description: "Supervised",
          stages: [{ ...builtin.stages[1]!, nextStageId: null }],
        },
      },
      catalog,
      at,
    ),
  ).toThrow();
});
it("rejects a new reusable workflow that disables mandatory approval", () => {
  expect(() =>
    makeWorkflowActionMutation(
      {
        type: "template.save",
        projectId,
        commandId: "save-invalid-approval",
        expectedVersion: 0,
        draft: {
          id: "custom-workflow",
          displayName: "Custom workflow",
          description: "Supervised",
          stages: [{ ...builtin.stages[2]!, nextStageId: null, approvalRequired: false }],
        },
      },
      catalog,
      at,
    ),
  ).toThrow();
});

it.each([
  "manual",
  "custom role",
  "wrong role version",
  "wrong outputs",
  "wrong artifact",
  "wrong capability",
  "consecutive gates",
  "duplicate ID",
  "branch link",
  "code",
  "oversized instructions",
  "too many stages",
  "empty stages",
])("rejects %s in a new supervised composition", (failure) => {
  let stages: WorkflowStage[] = [{ ...builtin.stages[2]!, nextStageId: null }];
  if (failure === "manual")
    stages[0] = { ...stages[0]!, type: "manual", profileId: null, profileVersion: null };
  if (failure === "custom role") stages[0] = { ...stages[0]!, profileId: "custom-role" };
  if (failure === "wrong role version") stages[0] = { ...stages[0]!, profileVersion: 999 };
  if (failure === "wrong outputs")
    stages[0] = { ...stages[0]!, requiredOutputSections: ["Unrelated"] };
  if (failure === "wrong artifact") stages[0] = { ...stages[0]!, artifactKind: "unrelated" };
  if (failure === "wrong capability") stages[0] = { ...stages[0]!, capabilityPreferences: [] };
  if (failure === "consecutive gates")
    stages = [
      { ...stages[0]!, nextStageId: "gate1" },
      { ...builtin.stages[1]!, id: "gate1", nextStageId: "gate2" },
      { ...builtin.stages[1]!, id: "gate2", nextStageId: null },
    ];
  if (failure === "duplicate ID")
    stages = [{ ...stages[0]!, nextStageId: stages[0]!.id }, stages[0]!];
  if (failure === "branch link") stages[0] = { ...stages[0]!, nextStageId: "missing" };
  if (failure === "code") stages[0] = { ...stages[0]!, taskPromptTemplate: "```sh\nsudo run\n```" };
  if (failure === "oversized instructions")
    stages[0] = { ...stages[0]!, taskPromptTemplate: "x".repeat(4001) };
  if (failure === "too many stages")
    stages = Array.from({ length: 13 }, (_, i) => ({
      ...stages[0]!,
      id: `stage_${i}`,
      nextStageId: i === 12 ? null : `stage_${i + 1}`,
    }));
  if (failure === "empty stages") stages = [];
  expect(() =>
    makeWorkflowActionMutation(
      {
        type: "template.save",
        projectId,
        commandId: "invalid-composition",
        expectedVersion: 0,
        draft: { id: "custom-workflow", displayName: "Custom", description: "Bounded", stages },
      },
      catalog,
      at,
    ),
  ).toThrow();
});

it("preserves legacy built-in stage overrides while custom copies require role-derived contracts", () => {
  expect(
    makeWorkflowActionMutation(
      {
        type: "run.start",
        projectId,
        commandId: "builtin-compatible",
        runId: "builtin-compatible",
        templateId: builtin.id,
        templateVersion: 1,
        originatingThreadId: null,
        originatingMessageId: null,
      },
      catalog,
      at,
    ).type,
  ).toBe("run.start");
  expect(() =>
    makeWorkflowActionMutation(
      {
        type: "template.save",
        projectId,
        commandId: "copy-with-overrides",
        expectedVersion: 0,
        draft: {
          id: "custom-copy",
          displayName: "Copy",
          description: "Unnormalized copy",
          stages: builtin.stages,
        },
      },
      catalog,
      at,
    ),
  ).toThrow();
});
