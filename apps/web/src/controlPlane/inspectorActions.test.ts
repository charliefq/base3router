import { ProviderDriverKind, type CursorCloudRunnerBinding } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  pickDefinedInspectorHandlers,
  resolveCursorCloudInspectorActions,
} from "./inspectorActions";

const running: CursorCloudRunnerBinding = {
  runnerKind: "cursor-cloud",
  provider: ProviderDriverKind.make("cursor"),
  model: "composer-2",
  target: {
    mode: "repository",
    repositoryUrl: "https://github.com/charliefq/base3router",
    startingRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  credentialRef: { kind: "env", name: "CURSOR_API_KEY" },
  status: "running",
  cursorAgentId: "bc-11111111-1111-5111-8111-111111111111",
  cursorRunId: "run-1",
  cursorAgentStatus: "ACTIVE",
  cursorRunStatus: "RUNNING",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

const followUpReady: CursorCloudRunnerBinding = {
  ...running,
  status: "finished",
  cursorAgentStatus: "IDLE",
  cursorRunStatus: "FINISHED",
};

const handlers = {
  onFollowUp: () => {},
  onCancel: () => {},
  onRefresh: () => {},
  onFollowUpChange: () => {},
};

it("enables only actions that have a real handler and a legal Cursor Cloud state", () => {
  const actions = resolveCursorCloudInspectorActions({
    binding: followUpReady,
    busy: false,
    followUp: "Continue the review",
    handlers,
  });

  expect(actions.readOnly).toBe(false);
  expect(actions.followUp).toEqual({ available: true, enabled: true });
  expect(actions.cancel).toEqual({ available: true, enabled: true });
  expect(actions.refresh).toEqual({ available: true, enabled: true });
  expect(actions.followUpEditable).toBe(true);
});

it("keeps follow-up disabled while a run is active even when handlers exist", () => {
  const actions = resolveCursorCloudInspectorActions({
    binding: running,
    busy: false,
    followUp: "Continue the review",
    handlers,
  });

  expect(actions.followUp.enabled).toBe(false);
  expect(actions.cancel.enabled).toBe(true);
  expect(actions.refresh.enabled).toBe(true);
});

it("disables every mutation while busy", () => {
  const actions = resolveCursorCloudInspectorActions({
    binding: followUpReady,
    busy: true,
    followUp: "Continue the review",
    handlers,
  });

  expect(actions.followUp.enabled).toBe(false);
  expect(actions.cancel.enabled).toBe(false);
  expect(actions.refresh.enabled).toBe(false);
});

it("marks the inspector read-only when a binding has no handlers", () => {
  const actions = resolveCursorCloudInspectorActions({
    binding: followUpReady,
    busy: false,
    followUp: "Continue the review",
    handlers: {},
  });

  expect(actions.readOnly).toBe(true);
  expect(actions.followUp).toEqual({ available: false, enabled: false });
  expect(actions.cancel).toEqual({ available: false, enabled: false });
  expect(actions.refresh).toEqual({ available: false, enabled: false });
  expect(actions.followUpEditable).toBe(false);
});

it("never enables an action whose handler is missing", () => {
  const actions = resolveCursorCloudInspectorActions({
    binding: followUpReady,
    busy: false,
    followUp: "Continue the review",
    handlers: { onRefresh: () => {} },
  });

  expect(actions.readOnly).toBe(false);
  expect(actions.followUp.enabled).toBe(false);
  expect(actions.cancel.enabled).toBe(false);
  expect(actions.refresh.enabled).toBe(true);
});

it("omits undefined handler keys instead of passing no-ops", () => {
  const picked = pickDefinedInspectorHandlers({
    onRefresh: handlers.onRefresh,
  });
  expect(Object.keys(picked)).toEqual(["onRefresh"]);
  expect(picked.onRefresh).toBe(handlers.onRefresh);
  expect(pickDefinedInspectorHandlers({})).toEqual({});
});
