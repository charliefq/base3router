import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  DISPATCHER_POLICY_VERSION,
  DISPATCHER_REASON_CODES,
  DISPATCHER_HANDOFF_MAX_PACKET_CHARS,
  DISPATCHER_HANDOFF_UNAVAILABLE_REASON_CODES,
  DispatcherHandoffTurnStartRequest,
  DispatcherRoutePreviewRequest,
  DispatcherTaskRouteBinding,
} from "./dispatcher.ts";

const decodeRequest = Schema.decodeUnknownExit(DispatcherRoutePreviewRequest);
const decodeTaskRouteBinding = Schema.decodeUnknownExit(DispatcherTaskRouteBinding);
const decodeHandoffRequest = Schema.decodeUnknownExit(DispatcherHandoffTurnStartRequest);

describe("dispatcher contracts", () => {
  it("keeps policy and reason codes stable", () => {
    expect(DISPATCHER_POLICY_VERSION).toBe("dispatcher.phase-1a.v1");
    expect(DISPATCHER_REASON_CODES).toEqual([
      "ACTION_ALLOWED",
      "ENVIRONMENT_MISMATCH",
      "PROJECT_SELECTOR_REQUIRED",
      "THREAD_NOT_FOUND",
      "THREAD_DELETED",
      "PROJECT_NOT_FOUND",
      "PROJECT_DELETED",
      "PROJECT_AMBIGUOUS",
      "PROJECT_MISMATCH",
      "MESSAGE_NOT_FOUND",
      "NO_ROUTE_CANDIDATES",
      "PROVIDER_INSTANCE_NOT_FOUND",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_DISABLED",
      "PROVIDER_NOT_INSTALLED",
      "PROVIDER_UNAUTHENTICATED",
      "PROVIDER_ERROR",
      "MODEL_NOT_FOUND",
    ]);
  });

  it("accepts a bounded request with a project selector", () => {
    const decoded = decodeRequest({
      environmentId: "environment-1",
      projectId: "project-1",
      preferredRoute: { instanceId: "codex_work", model: "gpt-5.4" },
      actionKind: "workspace-write",
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("rejects missing selectors and message ids without a thread", () => {
    expect(
      Exit.isFailure(decodeRequest({ environmentId: "environment-1", actionKind: "read" })),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRequest({
          environmentId: "environment-1",
          projectId: "project-1",
          messageId: "message-1",
          actionKind: "read",
        }),
      ),
    ).toBe(true);
  });

  it("rejects oversized path and model inputs", () => {
    expect(
      Exit.isFailure(
        decodeRequest({
          environmentId: "environment-1",
          workspaceRoot: `/${"w".repeat(2_048)}`,
          actionKind: "read",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRequest({
          environmentId: "environment-1",
          projectId: "project-1",
          preferredRoute: { instanceId: "codex", model: "m".repeat(257) },
          actionKind: "read",
        }),
      ),
    ).toBe(true);
  });

  it("decodes a compact task binding without sensitive context fields", () => {
    const binding = decodeTaskRouteBinding({
      policyVersion: DISPATCHER_POLICY_VERSION,
      target: { instanceId: "codex_work", model: "gpt-5.4" },
      driver: "codex",
      modelFamily: "openai",
      fallbackIndex: 1,
      source: "provider-default",
      gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
    });
    expect(Exit.isSuccess(binding)).toBe(true);
    if (Exit.isSuccess(binding)) {
      expect(Object.keys(binding.value).sort()).toEqual([
        "driver",
        "fallbackIndex",
        "gate",
        "modelFamily",
        "policyVersion",
        "source",
        "target",
      ]);
    }
  });

  it("keeps handoff unavailability codes stable and bounds reviewed packet text", () => {
    expect(DISPATCHER_HANDOFF_UNAVAILABLE_REASON_CODES).toEqual([
      "DISPATCHER_DISABLED",
      "SOURCE_TURN_NOT_FOUND",
      "SOURCE_TURN_NOT_SETTLED",
      "SOURCE_SESSION_ACTIVE",
      "SOURCE_ROUTE_NOT_FOUND",
      "TARGET_SAME_AS_SOURCE",
      "TARGET_RUNNER_UNAVAILABLE",
      "HANDOFF_ALREADY_EXISTS",
    ]);
    const valid = {
      handoffId: "handoff-1",
      sourceTurnId: "turn-1",
      target: { instanceId: "claude-work", model: "claude-sonnet" },
      packetText: "Reviewed context",
    };
    expect(Exit.isSuccess(decodeHandoffRequest(valid))).toBe(true);
    expect(
      Exit.isFailure(
        decodeHandoffRequest({
          ...valid,
          packetText: "x".repeat(DISPATCHER_HANDOFF_MAX_PACKET_CHARS + 1),
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeHandoffRequest({ ...valid, handoffId: "x".repeat(257) }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeHandoffRequest({ ...valid, sourceTurnId: "x".repeat(257) }))).toBe(
      true,
    );
  });
});
