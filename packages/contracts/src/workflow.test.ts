import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AgentProfile,
  WorkflowActionInput,
  WorkflowArtifact,
  WorkflowDispatchStageInput,
  WorkflowRun,
  WorkflowDecision,
  WorkflowRevisionFeedback,
  WorkflowTemplate,
} from "./workflow.ts";

const decodeAgentProfile = Schema.decodeUnknownSync(AgentProfile);
const decodeWorkflowTemplate = Schema.decodeUnknownSync(WorkflowTemplate);
const decodeWorkflowRun = Schema.decodeUnknownSync(WorkflowRun);
const decodeWorkflowArtifact = Schema.decodeUnknownSync(WorkflowArtifact);
const decodeWorkflowActionInput = Schema.decodeUnknownSync(WorkflowActionInput);
const decodeWorkflowDispatchStageInput = Schema.decodeUnknownSync(WorkflowDispatchStageInput);
const decodeWorkflowDecision = Schema.decodeUnknownSync(WorkflowDecision);
const decodeWorkflowRevisionFeedback = Schema.decodeUnknownSync(WorkflowRevisionFeedback);
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
    expect(decodeAgentProfile(profile).version).toBe(1);
    expect(decodeWorkflowTemplate(template).stages).toHaveLength(1);
    expect(decodeWorkflowRun(run).status).toBe("active");
    expect(decodeWorkflowArtifact(artifact).missingSections).toEqual(["Findings"]);
    expect(
      decodeWorkflowActionInput({
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
    expect(() => decodeAgentProfile({ ...profile, instructions: "x".repeat(8_001) })).toThrow();
    expect(() =>
      decodeAgentProfile({
        ...profile,
        requiredOutputSections: Array(21).fill("Section"),
      }),
    ).toThrow();
    expect(() => decodeWorkflowTemplate({ ...template, stages: Array(13).fill(stage) })).toThrow();
    expect(() => decodeWorkflowRun({ ...run, attempts: Array(61).fill({}) })).toThrow();
    expect(() =>
      decodeWorkflowArtifact({
        ...artifact,
        sections: [{ label: "Findings", content: "x".repeat(2_001), missing: false }],
      }),
    ).toThrow();
  });

  it("rejects unsupported types, invalid versions and malformed IDs", () => {
    expect(() => decodeAgentProfile({ ...profile, version: 0 })).toThrow();
    expect(() =>
      decodeWorkflowTemplate({
        ...template,
        stages: [{ ...stage, type: "shell" }],
      }),
    ).toThrow();
    expect(() => decodeWorkflowTemplate({ ...template, id: "../../escape" })).toThrow();
    expect(() =>
      decodeWorkflowActionInput({
        type: "approve-all",
        projectId: "project-1",
        commandId: "command-1",
      }),
    ).toThrow();
  });

  it("decodes a Phase 5 dispatch payload without cursor-cloud runner fields", () => {
    const decoded = decodeWorkflowDispatchStageInput({
      environmentId: "environment-1",
      projectId: "project-1",
      runId: "run-1",
      stageId: "research",
      attempt: 1,
      dispatchId: "dispatch-1",
      target: { instanceId: "codex_work", model: "gpt-5.4" },
      additionalInstruction: "",
    });
    expect(decoded.runnerKind).toBeUndefined();
    expect(decoded.cursorCloudTarget).toBeUndefined();
  });
});

it("preserves exact bounded feedback and provenance while decoding legacy decisions without inventions", () => {
  const feedback = {
    text: "  Keep these exact requested changes.\n",
    source: { runId: "run-1", stageId: "research", attempt: 1, artifactId: "artifact-1" },
  };
  expect(decodeWorkflowRevisionFeedback(feedback)).toEqual(feedback);
  const decision = {
    id: "legacy-decision",
    runId: "run-1",
    stageId: "research",
    attempt: 1,
    artifactId: "artifact-1",
    value: "request_revision",
    createdAt: at,
  };
  expect(decodeWorkflowDecision(decision).revisionFeedback).toBeUndefined();
  expect(
    decodeWorkflowDecision({ ...decision, revisionFeedback: feedback }).revisionFeedback,
  ).toEqual(feedback);
});
it.each(["", " \n\t", "x".repeat(2001)])("rejects blank or oversized saved feedback", (text) => {
  expect(() =>
    decodeWorkflowRevisionFeedback({
      text,
      source: { runId: "run-1", stageId: "research", attempt: 1, artifactId: "artifact-1" },
    }),
  ).toThrow();
});

const briefAction = (brief: unknown) => ({
  type: "run.start",
  projectId: "project-1",
  commandId: "brief-create",
  runId: "brief-run",
  templateId: "research-flow",
  templateVersion: 1,
  originatingThreadId: null,
  originatingMessageId: null,
  brief,
});
it("preserves exact bounded run brief Unicode, whitespace and legacy absence", () => {
  const brief = "  原始要求 e\u0301 😀\r\nKeep this requirement.  ";
  expect(decodeWorkflowActionInput(briefAction(brief))).toMatchObject({ brief });
  expect(decodeWorkflowRun({ ...run, brief })).toMatchObject({ brief });
  expect(decodeWorkflowRun(run)).not.toHaveProperty("brief");
  expect(decodeWorkflowActionInput(briefAction("😀".repeat(1000)))).toMatchObject({
    brief: "😀".repeat(1000),
  });
});
it.each([
  "",
  " \r\n\t",
  "a".repeat(2001),
  "😀".repeat(1000) + "x",
  "bad\u0000text",
  "bad\ud800text",
  "bad\udc00text",
  123,
  null,
  {},
])("rejects invalid new run brief before mutation: %j", (brief) => {
  expect(() => decodeWorkflowActionInput(briefAction(brief))).toThrow();
  expect(() => decodeWorkflowRun({ ...run, brief })).toThrow();
});
