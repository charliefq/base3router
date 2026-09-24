import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  DISPATCHER_POLICY_VERSION,
  DISPATCHER_REASON_CODES,
  DispatcherRoutePreviewRequest,
} from "./dispatcher.ts";

const decodeRequest = Schema.decodeUnknownExit(DispatcherRoutePreviewRequest);

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
});
