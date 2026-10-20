import { ProjectId, type WorkflowCatalog } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun, applyWorkflowMutation } from "./Policy.ts";
import { buildWorkflowTaskPacket } from "./Workflow.ts";
const projectId = ProjectId.make("brief-project");
const at = "2026-10-19T00:00:00Z";
function fixture(brief?: string) {
  const template = BUILTIN_WORKFLOW_TEMPLATES[0]!;
  const run = initialWorkflowRun({
    runId: "brief-run",
    projectId,
    template,
    originThreadId: null,
    originMessageId: null,
    at,
    ...(brief !== undefined ? { brief } : {}),
  });
  const catalog: WorkflowCatalog = {
    profiles: BUILTIN_AGENT_PROFILES,
    templates: [template],
    runs: [run],
  };
  return { run, catalog, template };
}
it("carries exact immutable brief independently of prior artifact excerpts and preserves legacy absence", () => {
  const brief = "  Original e\u0301 😀\r\nNever lose this.  ";
  const f = fixture(brief);
  expect(buildWorkflowTaskPacket(f.catalog, projectId, f.run.id).packetText).toContain(brief);
  expect(buildWorkflowTaskPacket(fixture().catalog, projectId, f.run.id).packetText).toContain(
    "Run brief not recorded.",
  );
  let catalog = f.catalog;
  for (const type of ["run.pause", "run.resume", "run.cancel"] as const) {
    catalog = applyWorkflowMutation(catalog, projectId, { type, runId: f.run.id, at });
    expect(catalog.runs[0]?.brief).toBe(brief);
  }
  expect(catalog.runs[0]?.status).toBe("cancelled");
  expect(f.catalog.runs[0]?.brief).toBe(brief);
});
it("fails the unchanged aggregate packet bound instead of truncating the saved brief", () => {
  const f = fixture();
  const profile = f.catalog.profiles.find((p) => p.id === f.template.stages[0]!.profileId)!;
  const catalog: WorkflowCatalog = {
    ...f.catalog,
    profiles: [
      {
        ...profile,
        id: "oversize-role",
        projectId,
        origin: "custom",
        instructions: "i".repeat(8000),
      },
    ],
    templates: [
      {
        ...f.template,
        id: "oversize-template",
        projectId,
        origin: "custom",
        stages: [
          {
            ...f.template.stages[0]!,
            profileId: "oversize-role",
            taskPromptTemplate: "s".repeat(4000),
          },
        ],
      },
    ],
    runs: [
      {
        ...f.run,
        templateId: "oversize-template",
        artifacts: [
          {
            id: "prior",
            runId: f.run.id,
            stageId: "prior",
            attempt: 1,
            kind: "artifact",
            sourceTurnId: null,
            profileId: profile.id,
            profileVersion: profile.version,
            sections: [{ label: "Previous", content: "a".repeat(1500), missing: false }],
            missingSections: [],
            extractionVersion: 1,
            redacted: false,
            status: "accepted",
            createdAt: at,
            acceptedAt: at,
          },
        ],
      },
    ],
  };
  const legacy = buildWorkflowTaskPacket(catalog, projectId, f.run.id).packetText;
  expect(legacy.length).toBeLessThanOrEqual(16000);
  const withBrief = { ...catalog, runs: [{ ...catalog.runs[0]!, brief: "😀".repeat(1000) }] };
  expect(() => buildWorkflowTaskPacket(withBrief, projectId, f.run.id)).toThrow(
    "exceeds the allowed bound",
  );
  expect(withBrief.runs[0]!.brief.length).toBe(2000);
});
