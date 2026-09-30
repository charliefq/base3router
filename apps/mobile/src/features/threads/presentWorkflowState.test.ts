import { expect, it } from "vite-plus/test";

import { presentMobileWorkflowState } from "./presentWorkflowState";

it("returns null when the thread has no workflow run", () => {
  expect(
    presentMobileWorkflowState({
      catalog: { profiles: [], templates: [], runs: [] },
      threadId: "thread-1",
    }),
  ).toBeNull();
});

it("presents a read-only local bound route", () => {
  const model = presentMobileWorkflowState({
    threadId: "thread-1",
    catalog: {
      profiles: [],
      templates: [
        {
          id: "review",
          version: 1,
          projectId: null,
          origin: "built-in",
          status: "active",
          displayName: "Review",
          description: "Review work",
          stages: [
            {
              id: "draft",
              label: "Draft",
              type: "agent",
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
          status: "active",
          currentStageId: "draft",
          originatingThreadId: "thread-1" as never,
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
              destinationThreadId: "thread-1" as never,
              destinationMessageId: null,
              destinationTurnId: null,
              routeBinding: {
                policyVersion: "dispatcher.phase-1a.v1",
                target: { instanceId: "codex" as never, model: "gpt-5.4" },
                driver: "codex" as never,
                modelFamily: "openai",
                fallbackIndex: 0,
                source: "explicit",
                gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
              },
              status: "dispatched",
              createdAt: "2026-09-30T00:00:00.000Z",
            },
          ],
          artifacts: [],
          decisions: [],
          createdAt: "2026-09-30T00:00:00.000Z",
          updatedAt: "2026-09-30T00:00:00.000Z",
          endedAt: null,
          pausedAt: null,
        },
      ],
    },
  });

  expect(model?.readOnly).toBe(true);
  expect(model?.runnerKind).toBe("local");
  expect(model?.boundRoute).toBe("codex · gpt-5.4");
  expect(model?.currentStage).toBe("Draft");
});
