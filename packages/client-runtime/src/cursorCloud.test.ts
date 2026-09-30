import {
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  ProviderDriverKind,
  type CursorCloudDispatchPreview,
  type CursorCloudRunnerBinding,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  cursorCloudAgentFinishingBackgroundWork,
  cursorCloudDispatchAllowed,
  cursorCloudFollowUpDisabled,
  emptyCursorCloudTargetDraft,
  parseCursorCloudTarget,
  presentCursorCloudBinding,
  presentCursorCloudPayload,
  textOmitsCursorSecrets,
  valueOmitsCursorSecrets,
} from "./cursorCloud.ts";

const sha = "9d5f2d8e41823acf518e7761a5b916defd5e4b2f";
const allow: CursorCloudDispatchPreview = {
  available: true,
  configured: true,
  target: {
    mode: "repository",
    repositoryUrl: "https://github.com/charliefq/base3router",
    startingRef: sha,
  },
  payload: {
    runnerKind: "cursor-cloud",
    provider: ProviderDriverKind.make("cursor"),
    model: "composer-2",
    target: {
      mode: "repository",
      repositoryUrl: "https://github.com/charliefq/base3router",
      startingRef: sha,
    },
    workOnCurrentBranch: false,
    autoCreatePR: false,
    credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  },
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};

it("parses an exact repository starting SHA and rejects main", () => {
  expect(
    parseCursorCloudTarget({
      ...emptyCursorCloudTargetDraft(),
      repositoryUrl: "https://github.com/charliefq/base3router",
      startingRef: sha,
    }),
  ).toEqual({
    mode: "repository",
    repositoryUrl: "https://github.com/charliefq/base3router",
    startingRef: sha,
  });
  expect(
    parseCursorCloudTarget({
      ...emptyCursorCloudTargetDraft(),
      repositoryUrl: "https://github.com/charliefq/base3router",
      startingRef: "main",
    }),
  ).toBeNull();
});

it("parses a named environment without inventing repos", () => {
  expect(
    parseCursorCloudTarget({
      mode: "named-environment",
      repositoryUrl: "https://github.com/charliefq/base3router",
      startingRef: sha,
      environmentName: "prod-env",
    }),
  ).toEqual({ mode: "named-environment", environmentName: "prod-env" });
});

it("requires ActionGate ALLOW plus an immutable payload before dispatch", () => {
  expect(cursorCloudDispatchAllowed(allow)).toBe(true);
  expect(cursorCloudDispatchAllowed({ ...allow, payload: null })).toBe(false);
  expect(
    cursorCloudDispatchAllowed({
      ...allow,
      gate: { decision: "DENY", reasonCodes: ["PROVIDER_UNAVAILABLE"] },
    }),
  ).toBe(false);
});

it("disables follow-up while a Cursor run is active or the agent is still ACTIVE", () => {
  const binding: CursorCloudRunnerBinding = {
    ...allow.payload!,
    status: "running",
    cursorAgentId: "bc-agent",
    cursorRunId: "run-1",
    cursorAgentStatus: "ACTIVE",
    cursorRunStatus: "RUNNING",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  };
  expect(cursorCloudFollowUpDisabled(binding)).toBe(true);
  expect(cursorCloudAgentFinishingBackgroundWork(binding)).toBe(false);
  expect(
    cursorCloudFollowUpDisabled({
      ...binding,
      cursorRunStatus: "FINISHED",
      cursorAgentStatus: "ACTIVE",
      status: "busy",
    }),
  ).toBe(true);
  expect(
    cursorCloudAgentFinishingBackgroundWork({
      ...binding,
      cursorRunStatus: "FINISHED",
      cursorAgentStatus: "ACTIVE",
      status: "busy",
    }),
  ).toBe(true);
  expect(
    cursorCloudFollowUpDisabled({
      ...binding,
      cursorRunStatus: "FINISHED",
      cursorAgentStatus: "IDLE",
      status: "finished",
    }),
  ).toBe(false);
  expect(
    cursorCloudFollowUpDisabled({ ...binding, cursorRunStatus: "FINISHED", status: "idle" }),
  ).toBe(true);
});

it("presents sanitized binding metadata without secret-shaped fields", () => {
  const presented = presentCursorCloudBinding({
    ...allow.payload!,
    status: "finished",
    cursorAgentId: "bc-agent",
    cursorRunId: "run-1",
    cursorAgentUrl: "https://cursor.com/agents/bc-agent",
    sanitizedResult: "Done",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:01.000Z",
    credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  });
  expect(presented.runner).toBe("Cursor Cloud");
  expect(presented.startingRef).toBe(sha);
  expect(presented.credentialReference).toBe("env");
  expect(presentCursorCloudPayload(allow.payload!).workOnCurrentBranch).toBe(false);
  expect(valueOmitsCursorSecrets(presented)).toBe(true);
  expect(textOmitsCursorSecrets("Authorization: Bearer crsr_live_secret")).toBe(false);
  expect(textOmitsCursorSecrets("CURSOR_API_KEY=secret")).toBe(false);
  expect(textOmitsCursorSecrets("crsr_test_secret_value")).toBe(false);
  expect(textOmitsCursorSecrets("crsr-live-secret-value")).toBe(false);
  expect(textOmitsCursorSecrets('{"token":"crsr_test_secret_value"}')).toBe(false);
});
