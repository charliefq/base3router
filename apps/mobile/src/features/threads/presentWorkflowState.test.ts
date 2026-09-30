import { CURSOR_CLOUD_CREDENTIAL_REFERENCE, type WorkflowCatalog } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { presentMobileWorkflowState } from "./presentWorkflowState";

const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function catalogWithAttempt(input: {
  readonly threadId: string;
  readonly status: "active" | "paused" | "rejected" | "cancelled" | "completed";
  readonly attemptStatus?: "pending" | "dispatched" | "proposed" | "accepted" | "rejected";
  readonly secretTitle?: string;
  readonly runner?: {
    readonly status: "running" | "finished" | "error" | "cancelled";
    readonly cursorRunStatus?: "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED";
    readonly agentId?: string;
    readonly runId?: string;
  };
  readonly artifactContent?: string;
}): WorkflowCatalog {
  return {
    profiles: [],
    templates: [
      {
        id: "review",
        version: 1,
        projectId: null,
        origin: "built-in" as const,
        status: "active" as const,
        displayName: input.secretTitle ?? "Review",
        description: "Review work",
        stages: [
          {
            id: "draft",
            label: "Draft",
            type: "agent" as const,
            profileId: null,
            profileVersion: null,
            artifactKind: "report",
            requiredOutputSections: ["Result"],
            approvalRequired: false,
            nextStageId: null,
            capabilityPreferences: [],
            taskPromptTemplate: "Do the work",
            maxAttempts: 3,
          },
        ],
        createdAt: "2026-09-30T00:00:00.000Z",
        updatedAt: "2026-09-30T00:00:00.000Z",
      },
    ],
    runs: [
      {
        id: "run-1",
        projectId: "project-1" as never,
        templateId: "review",
        templateVersion: 1,
        status: input.status,
        currentStageId: "draft",
        originatingThreadId: input.threadId as never,
        originatingMessageId: null,
        attempts: [
          {
            stageId: "draft",
            attempt: 1,
            profileId: null,
            profileVersion: null,
            sourceThreadId: null,
            sourceMessageId: null,
            sourceTurnId: null,
            destinationThreadId: input.threadId as never,
            destinationMessageId: null,
            destinationTurnId: null,
            routeBinding: {
              policyVersion: "dispatcher.phase-1a.v1" as const,
              target: { instanceId: "codex" as never, model: "gpt-5.4" },
              driver: "codex" as never,
              modelFamily: "openai",
              fallbackIndex: 0,
              source: "explicit" as const,
              gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED"] },
            },
            runnerBinding: input.runner
              ? {
                  provider: "cursor" as never,
                  model: "composer-2",
                  runnerKind: "cursor-cloud" as const,
                  target: {
                    mode: "repository" as const,
                    repositoryUrl: "https://github.com/charliefq/base3router",
                    startingRef: sha,
                  },
                  cursorAgentId: input.runner.agentId ?? "bc-agent",
                  cursorRunId: input.runner.runId ?? "run-cloud-1",
                  status: input.runner.status,
                  cursorRunStatus: input.runner.cursorRunStatus,
                  createdAt: "2026-09-30T00:00:00.000Z",
                  updatedAt: "2026-09-30T00:00:00.000Z",
                  credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
                }
              : undefined,
            status: input.attemptStatus ?? "dispatched",
            createdAt: "2026-09-30T00:00:00.000Z",
          },
        ],
        artifacts: input.artifactContent
          ? [
              {
                id: "artifact-1" as never,
                runId: "run-1" as never,
                stageId: "draft",
                attempt: 1,
                kind: "report",
                sourceTurnId: null,
                profileId: null,
                profileVersion: null,
                sections: [{ label: "Result", content: input.artifactContent, missing: false }],
                missingSections: [],
                extractionVersion: 1 as const,
                redacted: false,
                status: "proposed" as const,
                createdAt: "2026-09-30T00:00:00.000Z",
                acceptedAt: null,
              },
            ]
          : [],
        decisions: [],
        createdAt: "2026-09-30T00:00:00.000Z",
        updatedAt: "2026-09-30T00:00:00.000Z",
        endedAt: null,
        pausedAt: null,
      },
    ],
  } as WorkflowCatalog;
}

it("returns null when the thread has no workflow run", () => {
  expect(
    presentMobileWorkflowState({
      catalog: { profiles: [], templates: [], runs: [] },
      threadId: "thread-1",
    }),
  ).toBeNull();
});

it("presents a read-only local bound route from shared catalog state", () => {
  const model = presentMobileWorkflowState({
    threadId: "thread-1",
    catalog: catalogWithAttempt({ threadId: "thread-1", status: "active" }),
  });

  expect(model?.readOnly).toBe(true);
  expect(model?.runnerKind).toBe("local");
  expect(model?.boundRoute).toBe("codex · gpt-5.4");
  expect(model?.currentStage).toBe("Draft");
  expect(model?.title).toBe("Review");
  expect(model && "onCancel" in model).toBe(false);
  expect(model && "onFollowUp" in model).toBe(false);
});

it("presents Cursor Cloud identity and terminal cancelled/error states", () => {
  const cancelled = presentMobileWorkflowState({
    threadId: "thread-1",
    catalog: catalogWithAttempt({
      threadId: "thread-1",
      status: "cancelled",
      runner: {
        status: "cancelled",
        cursorRunStatus: "CANCELLED",
        agentId: "bc-agent",
        runId: "run-9",
      },
    }),
  });
  expect(cancelled?.readOnly).toBe(true);
  expect(cancelled?.runnerKind).toBe("cursor-cloud");
  expect(cancelled?.cancelled).toBe(true);
  expect(cancelled?.terminal).toBe(true);
  expect(cancelled?.agentId).toBe("bc-agent");
  expect(cancelled?.runId).toBe("run-9");
  expect(cancelled?.cursorCloudStatus).toBe("cancelled");

  const failed = presentMobileWorkflowState({
    threadId: "thread-1",
    catalog: catalogWithAttempt({
      threadId: "thread-1",
      status: "rejected",
      runner: { status: "error", cursorRunStatus: "ERROR" },
    }),
  });
  expect(failed?.error).toBe(true);
  expect(failed?.terminal).toBe(true);
});

it("redacts secret-shaped text and never exposes mutation handlers", () => {
  const model = presentMobileWorkflowState({
    threadId: "thread-1",
    catalog: catalogWithAttempt({
      threadId: "thread-1",
      status: "active",
      secretTitle: "CURSOR_API_KEY=do-not-show",
      runner: {
        status: "running",
        cursorRunStatus: "RUNNING",
        agentId: "crsr_live_secret_value",
        runId: "sk-secret-model-key",
      },
      artifactContent: "Authorization: Bearer leaked-token",
    }),
  });

  expect(model?.readOnly).toBe(true);
  expect(model?.title).toBe("[redacted]");
  expect(model?.agentId).toBe("[redacted]");
  expect(model?.runId).toBe("[redacted]");
  expect(model?.artifact?.sections[0]?.content).toBe("[redacted]");
  expect(JSON.stringify(model)).not.toMatch(/Bearer\s+\S+|CURSOR_API_KEY|crsr_|sk-secret/);
  expect(model && Object.keys(model).some((key) => key.startsWith("on"))).toBe(false);
});
