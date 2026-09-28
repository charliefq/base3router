import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AgentProfile,
  WorkflowActionInput,
  WorkflowArtifact,
  WorkflowRun,
  WorkflowTemplate,
} from "./workflow.ts";
import { OrchestrationReadModel } from "./orchestration.ts";

const at = "2026-09-28T00:00:00.000Z";
const profile = {
  id: "researcher",
  version: 1,
  projectId: "project-1",
  origin: "custom",
  status: "active",
  displayName: "Researcher",
  description: "Find evidence",
  purpose: "Research a bounded question",
  responsibilities: ["Cite evidence"],
  exclusions: ["Do not invent results"],
  instructions: "Use sources.",
  requiredOutputSections: ["Findings"],
  artifactKind: "research_report",
  capabilityPreferences: ["web-research"],
  createdAt: at,
  updatedAt: at,
};
const stage = {
  id: "research",
  label: "Research",
  type: "agent",
  profileId: "researcher",
  profileVersion: 1,
  artifactKind: "research_report",
  requiredOutputSections: ["Findings"],
  approvalRequired: true,
  nextStageId: null,
  capabilityPreferences: [],
  taskPromptTemplate: "Research the question.",
  maxAttempts: 3,
};
const template = {
  id: "research-flow",
  version: 1,
  projectId: "project-1",
  origin: "custom",
  status: "active",
  displayName: "Research",
  description: "One stage",
  stages: [stage],
  createdAt: at,
  updatedAt: at,
};
const run = {
  id: "run-1",
  projectId: "project-1",
  templateId: "research-flow",
  templateVersion: 1,
  status: "active",
  currentStageId: "research",
  originatingThreadId: null,
  originatingMessageId: null,
  attempts: [],
  artifacts: [],
  decisions: [],
  createdAt: at,
  updatedAt: at,
  endedAt: null,
  pausedAt: null,
};
const artifact = {
  id: "artifact-1",
  runId: "run-1",
  stageId: "research",
  attempt: 1,
  kind: "research_report",
  sourceTurnId: null,
  profileId: "researcher",
  profileVersion: 1,
  sections: [{ label: "Findings", content: "Unknown", missing: true }],
  missingSections: ["Findings"],
  extractionVersion: 1,
  redacted: false,
  status: "proposed",
  createdAt: at,
  acceptedAt: null,
};
describe("workflow contracts", () => {
  it("decodes versioned generic profiles, templates, runs, artifacts and actions", () => {
    expect(Schema.decodeUnknownSync(AgentProfile)(profile).version).toBe(1);
    expect(Schema.decodeUnknownSync(WorkflowTemplate)(template).stages).toHaveLength(1);
    expect(Schema.decodeUnknownSync(WorkflowRun)(run).status).toBe("active");
    expect(Schema.decodeUnknownSync(WorkflowArtifact)(artifact).missingSections).toEqual([
      "Findings",
    ]);
    expect(
      Schema.decodeUnknownSync(WorkflowActionInput)({
        type: "run.start",
        projectId: "project-1",
        commandId: "command-1",
        runId: "run-1",
        templateId: "research-flow",
        templateVersion: 1,
        originatingThreadId: null,
        originatingMessageId: null,
      }).type,
    ).toBe("run.start");
  });

  it("rejects oversized role instructions and collections", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentProfile)({ ...profile, instructions: "x".repeat(8_001) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentProfile)({
        ...profile,
        requiredOutputSections: Array(21).fill("Section"),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTemplate)({ ...template, stages: Array(13).fill(stage) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowRun)({ ...run, attempts: Array(61).fill({}) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowArtifact)({
        ...artifact,
        sections: [{ label: "Findings", content: "x".repeat(2_001), missing: false }],
      }),
    ).toThrow();
  });

  it("rejects unsupported types, invalid versions and malformed IDs", () => {
    expect(() => Schema.decodeUnknownSync(AgentProfile)({ ...profile, version: 0 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTemplate)({
        ...template,
        stages: [{ ...stage, type: "shell" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTemplate)({ ...template, id: "../../escape" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowActionInput)({
        type: "approve-all",
        projectId: "project-1",
        commandId: "command-1",
      }),
    ).toThrow();
  });

  it("decodes a legacy read model with no workflow projection", () => {
    const legacy = Schema.decodeUnknownSync(OrchestrationReadModel)({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: at,
    });
    expect(legacy.workflow).toBeUndefined();
  });
});
