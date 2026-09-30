import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  MessageId,
  TurnId,
  type AgentProfile,
  type DispatcherTaskRouteBinding,
  type WorkflowArtifact,
  type WorkflowTemplate,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import {
  applyWorkflowMutation,
  emptyWorkflowCatalog,
  initialWorkflowRun,
  validateTemplate,
} from "./Policy.ts";

const projectId = ProjectId.make("project-1");
const at = "2026-09-28T00:00:00.000Z";
const route: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit",
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};
const template = BUILTIN_WORKFLOW_TEMPLATES[0]!;
const started = () =>
  applyWorkflowMutation(emptyWorkflowCatalog(), projectId, {
    type: "run.start",
    run: initialWorkflowRun({
      runId: "run-1",
      projectId,
      template,
      originThreadId: null,
      originMessageId: null,
      at,
    }),
  });
const dispatched = () =>
  applyWorkflowMutation(started(), projectId, {
    type: "stage.dispatch",
    runId: "run-1",
    stageId: "discovery",
    attempt: 1,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    routeBinding: route,
    at,
  });
const artifact = (): WorkflowArtifact => ({
  id: "artifact-1",
  runId: "run-1",
  stageId: "discovery",
  attempt: 1,
  kind: "opportunity_brief",
  sourceTurnId: TurnId.make("turn-1"),
  profileId: "bill",
  profileVersion: 1,
  sections: BUILTIN_AGENT_PROFILES[0]!.requiredOutputSections.map((label) => ({
    label,
    content: "Unknown",
    missing: true,
  })),
  missingSections: [...BUILTIN_AGENT_PROFILES[0]!.requiredOutputSections],
  extractionVersion: 1,
  redacted: false,
  status: "proposed",
  createdAt: at,
  acceptedAt: null,
});

describe("generic workflow policy", () => {
  it("has deterministic built-in profile and template versions", () => {
    expect(BUILTIN_AGENT_PROFILES.map(({ id, version }) => [id, version])).toEqual([
      ["bill", 1],
      ["zackburg", 1],
      ["implementer", 1],
      ["independent-reviewer", 1],
      ["launch-owner", 1],
    ]);
    expect(template.id).toBe("saas-production");
    expect(template.version).toBe(1);
    expect(template.stages.map((stage) => stage.id)).toEqual([
      "discovery",
      "build_gate",
      "architecture",
      "implementation",
      "review",
      "launch",
      "feedback",
    ]);
    expect(() => validateTemplate(template, emptyWorkflowCatalog())).not.toThrow();
  });

  it("rejects duplicate, skipped and unbound agent stages", () => {
    expect(() =>
      validateTemplate(
        { ...template, stages: [template.stages[0]!, template.stages[0]!] },
        emptyWorkflowCatalog(),
      ),
    ).toThrow();
    expect(() =>
      validateTemplate(
        {
          ...template,
          stages: [
            { ...template.stages[0]!, nextStageId: "architecture" },
            ...template.stages.slice(1),
          ],
        },
        emptyWorkflowCatalog(),
      ),
    ).toThrow();
    expect(() =>
      validateTemplate(
        {
          ...template,
          stages: [{ ...template.stages[0]!, profileVersion: 99 }, ...template.stages.slice(1)],
        },
        emptyWorkflowCatalog(),
      ),
    ).toThrow();
  });

  it("rejects executable or credential-shaped task templates", () => {
    for (const taskPromptTemplate of ["```sh\nrm x\n```", "API_KEY=secret-value"]) {
      expect(() =>
        validateTemplate(
          {
            ...template,
            stages: [{ ...template.stages[0]!, taskPromptTemplate }, ...template.stages.slice(1)],
          },
          emptyWorkflowCatalog(),
        ),
      ).toThrow();
    }
  });

  it("versions custom roles and retains archived historical versions", () => {
    const original: AgentProfile = {
      ...BUILTIN_AGENT_PROFILES[0]!,
      id: "custom-role",
      projectId,
      origin: "custom",
      version: 1,
    };
    const first = applyWorkflowMutation(emptyWorkflowCatalog(), projectId, {
      type: "profile.save",
      profile: original,
    });
    const second = applyWorkflowMutation(first, projectId, {
      type: "profile.save",
      profile: { ...original, version: 2, instructions: "Revised bounded role context" },
    });
    expect(second.profiles.map((profile) => profile.version)).toEqual([1, 2]);
    const archived = applyWorkflowMutation(second, projectId, {
      type: "profile.archive",
      profileId: original.id,
      at,
    });
    expect(archived.profiles[0]?.status).toBe("active");
    expect(archived.profiles[1]?.status).toBe("archived");
    expect(() =>
      applyWorkflowMutation(archived, projectId, {
        type: "profile.save",
        profile: { ...original, version: 3 },
      }),
    ).toThrow();
  });

  it("keeps custom profile and template versions scoped to their project", () => {
    const secondProject = ProjectId.make("project-2");
    const customProfile: AgentProfile = {
      ...BUILTIN_AGENT_PROFILES[0]!,
      id: "shared-name",
      projectId,
      origin: "custom",
      version: 1,
    };
    const customTemplate: WorkflowTemplate = {
      ...template,
      id: "shared-template",
      projectId,
      origin: "custom",
      stages: [
        {
          ...template.stages[0]!,
          profileId: customProfile.id,
          profileVersion: 1,
          nextStageId: null,
        },
      ],
    };
    let catalog = applyWorkflowMutation(emptyWorkflowCatalog(), projectId, {
      type: "profile.save",
      profile: customProfile,
    });
    catalog = applyWorkflowMutation(catalog, projectId, {
      type: "template.save",
      template: customTemplate,
    });
    catalog = applyWorkflowMutation(catalog, secondProject, {
      type: "profile.save",
      profile: { ...customProfile, projectId: secondProject },
    });
    catalog = applyWorkflowMutation(catalog, secondProject, {
      type: "template.save",
      template: { ...customTemplate, projectId: secondProject },
    });
    expect(catalog.profiles.filter((entry) => entry.id === "shared-name")).toHaveLength(2);
    expect(catalog.templates.filter((entry) => entry.id === "shared-template")).toHaveLength(2);
  });

  it("binds a version and rejects duplicate dispatch or route rewrites", () => {
    const first = started();
    expect(first.runs[0]?.templateVersion).toBe(1);
    const bound = dispatched();
    expect(bound.runs[0]?.attempts[0]?.routeBinding).toEqual(route);
    expect(bound.runs[0]?.attempts[0]?.runnerBinding).toBeUndefined();
    expect(() =>
      applyWorkflowMutation(bound, projectId, {
        type: "stage.dispatch",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        threadId: ThreadId.make("thread-2"),
        messageId: MessageId.make("message-2"),
        routeBinding: route,
        at,
      }),
    ).toThrow();
    expect(() =>
      applyWorkflowMutation(first, projectId, {
        type: "stage.dispatch",
        runId: "run-1",
        stageId: "architecture",
        attempt: 1,
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-1"),
        routeBinding: route,
        at,
      }),
    ).toThrow();
  });

  it("stores a cursor-cloud runner binding without changing Phase 5 route facts", () => {
    const bound = dispatched();
    const updated = applyWorkflowMutation(bound, projectId, {
      type: "runner.update",
      runId: "run-1",
      stageId: "discovery",
      attempt: 1,
      runnerBinding: {
        provider: ProviderDriverKind.make("cursor"),
        model: "composer-2",
        runnerKind: "cursor-cloud",
        target: {
          mode: "repository",
          repositoryUrl: "https://github.com/charliefq/base3router",
          startingRef: "9d5f2d8e41823acf518e7761a5b916defd5e4b2f",
        },
        cursorAgentId: "bc-00000000-0000-0000-0000-000000000001",
        cursorRunId: "run-00000000-0000-0000-0000-000000000001",
        status: "running",
        createdAt: at,
        updatedAt: at,
        credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
      },
      at,
    });
    expect(updated.runs[0]?.attempts[0]?.routeBinding).toEqual(route);
    expect(updated.runs[0]?.attempts[0]?.runnerBinding?.runnerKind).toBe("cursor-cloud");
    expect(updated.runs[0]?.attempts[0]?.runnerBinding?.cursorAgentId).toBe(
      "bc-00000000-0000-0000-0000-000000000001",
    );
    expect(updated.runs[0]?.attempts[0]?.runnerBinding?.credentialRef).toEqual({
      kind: "env",
      name: "CURSOR_API_KEY",
    });
  });

  it("persists a newer Cursor observation and rejects a stale ACTIVE/RUNNING refresh", () => {
    const running = {
      provider: ProviderDriverKind.make("cursor"),
      model: "composer-2",
      runnerKind: "cursor-cloud" as const,
      target: {
        mode: "repository" as const,
        repositoryUrl: "https://github.com/charliefq/base3router",
        startingRef: "9d5f2d8e41823acf518e7761a5b916defd5e4b2f",
      },
      cursorAgentId: "bc-00000000-0000-0000-0000-000000000001",
      cursorRunId: "run-00000000-0000-0000-0000-000000000001",
      cursorAgentStatus: "ACTIVE" as const,
      cursorRunStatus: "RUNNING" as const,
      status: "running" as const,
      createdAt: at,
      updatedAt: at,
      credentialRef: { kind: "env" as const, name: "CURSOR_API_KEY" as const },
    };
    const finished = {
      ...running,
      cursorAgentStatus: "IDLE" as const,
      cursorRunStatus: "FINISHED" as const,
      status: "finished" as const,
      updatedAt: "2026-09-28T00:00:05.000Z",
    };
    const nextRun = {
      ...running,
      cursorRunId: "run-00000000-0000-0000-0000-000000000002",
      updatedAt: "2026-09-28T00:00:10.000Z",
    };
    const first = applyWorkflowMutation(dispatched(), projectId, {
      type: "runner.update",
      runId: "run-1",
      stageId: "discovery",
      attempt: 1,
      runnerBinding: running,
      at,
    });
    expect(first.runs[0]?.attempts[0]?.runnerBinding?.cursorRunStatus).toBe("RUNNING");
    const terminal = applyWorkflowMutation(first, projectId, {
      type: "runner.update",
      runId: "run-1",
      stageId: "discovery",
      attempt: 1,
      runnerBinding: finished,
      at: finished.updatedAt,
    });
    expect(terminal.runs[0]?.attempts[0]?.runnerBinding?.cursorAgentStatus).toBe("IDLE");
    expect(terminal.runs[0]?.attempts[0]?.runnerBinding?.cursorRunStatus).toBe("FINISHED");
    const replayed = applyWorkflowMutation(terminal, projectId, {
      type: "runner.update",
      runId: "run-1",
      stageId: "discovery",
      attempt: 1,
      runnerBinding: {
        ...finished,
        createdAt: "2026-09-28T00:00:06.000Z",
        updatedAt: "2026-09-28T00:00:06.000Z",
      },
      at: "2026-09-28T00:00:06.000Z",
    });
    expect(replayed.runs[0]?.attempts[0]?.runnerBinding?.cursorRunStatus).toBe("FINISHED");
    expect(() =>
      applyWorkflowMutation(terminal, projectId, {
        type: "runner.update",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        runnerBinding: running,
        at: "2026-09-28T00:00:07.000Z",
      }),
    ).toThrow(/newer Cursor Cloud observation/);
    const followed = applyWorkflowMutation(terminal, projectId, {
      type: "runner.update",
      runId: "run-1",
      stageId: "discovery",
      attempt: 1,
      runnerBinding: nextRun,
      at: nextRun.updatedAt,
    });
    expect(followed.runs[0]?.attempts[0]?.runnerBinding?.cursorRunId).toBe(
      "run-00000000-0000-0000-0000-000000000002",
    );
    expect(followed.runs[0]?.attempts[0]?.runnerBinding?.cursorRunStatus).toBe("RUNNING");
    expect(() =>
      applyWorkflowMutation(followed, projectId, {
        type: "runner.update",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        runnerBinding: finished,
        at: "2026-09-28T00:00:11.000Z",
      }),
    ).toThrow(/newer Cursor Cloud observation/);
  });

  it("requires a bound stage before an artifact and leaves missing sections visible", () => {
    expect(() =>
      applyWorkflowMutation(started(), projectId, {
        type: "artifact.propose",
        artifact: artifact(),
      }),
    ).toThrow();
    const proposed = applyWorkflowMutation(dispatched(), projectId, {
      type: "artifact.propose",
      artifact: artifact(),
    });
    expect(proposed.runs[0]?.artifacts[0]?.missingSections).toHaveLength(12);
    expect(() =>
      applyWorkflowMutation(proposed, projectId, {
        type: "artifact.propose",
        artifact: artifact(),
      }),
    ).toThrow();
  });

  it("advances only after approval and keeps accepted artifacts immutable", () => {
    const proposed = applyWorkflowMutation(dispatched(), projectId, {
      type: "artifact.propose",
      artifact: artifact(),
    });
    const approved = applyWorkflowMutation(proposed, projectId, {
      type: "decision.record",
      decision: {
        id: "decision-1",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        artifactId: "artifact-1",
        value: "approve",
        createdAt: at,
      },
    });
    expect(approved.runs[0]?.currentStageId).toBe("build_gate");
    expect(approved.runs[0]?.artifacts[0]?.status).toBe("accepted");
    expect(() =>
      applyWorkflowMutation(approved, projectId, {
        type: "artifact.propose",
        artifact: artifact(),
      }),
    ).toThrow();
    const gated = applyWorkflowMutation(approved, projectId, {
      type: "decision.record",
      decision: {
        id: "decision-2",
        runId: "run-1",
        stageId: "build_gate",
        attempt: 1,
        artifactId: null,
        value: "approve",
        createdAt: at,
      },
    });
    expect(gated.runs[0]?.currentStageId).toBe("architecture");
    expect(gated.runs[0]?.attempts.at(-1)?.sourceThreadId).toBe(ThreadId.make("thread-1"));
  });

  it("rejects stale decisions and creates new attempts for revision", () => {
    const proposed = applyWorkflowMutation(dispatched(), projectId, {
      type: "artifact.propose",
      artifact: artifact(),
    });
    const revised = applyWorkflowMutation(proposed, projectId, {
      type: "decision.record",
      decision: {
        id: "decision-1",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        artifactId: "artifact-1",
        value: "request_revision",
        createdAt: at,
      },
    });
    expect(revised.runs[0]?.attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(revised.runs[0]?.artifacts[0]?.status).toBe("proposed");
    expect(() =>
      applyWorkflowMutation(revised, projectId, {
        type: "decision.record",
        decision: {
          id: "decision-2",
          runId: "run-1",
          stageId: "discovery",
          attempt: 1,
          artifactId: "artifact-1",
          value: "approve",
          createdAt: at,
        },
      }),
    ).toThrow();
  });

  it("keeps templates project-scoped and immutable by version", () => {
    const custom: WorkflowTemplate = {
      ...template,
      id: "custom-flow",
      version: 1,
      origin: "custom",
      projectId,
    };
    const first = applyWorkflowMutation(emptyWorkflowCatalog(), projectId, {
      type: "template.save",
      template: custom,
    });
    expect(() =>
      applyWorkflowMutation(first, ProjectId.make("other-project"), {
        type: "template.save",
        template: { ...custom, version: 2 },
      }),
    ).toThrow();
    const second = applyWorkflowMutation(first, projectId, {
      type: "template.save",
      template: { ...custom, version: 2, description: "Revised" },
    });
    expect(second.templates[0]?.description).not.toBe(second.templates[1]?.description);
  });

  it("pauses and resumes without rewriting stage lineage", () => {
    const original = started();
    const paused = applyWorkflowMutation(original, projectId, {
      type: "run.pause",
      runId: "run-1",
      at,
    });
    expect(paused.runs[0]?.status).toBe("paused");
    expect(paused.runs[0]?.pausedAt).toBe(at);
    expect(() =>
      applyWorkflowMutation(paused, projectId, {
        type: "stage.dispatch",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-1"),
        routeBinding: route,
        at,
      }),
    ).toThrow();
    const resumed = applyWorkflowMutation(paused, projectId, {
      type: "run.resume",
      runId: "run-1",
      at,
    });
    expect(resumed.runs[0]?.attempts).toEqual(original.runs[0]?.attempts);
    expect(resumed.runs[0]?.pausedAt).toBeNull();
  });
});
