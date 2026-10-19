import { describe, expect, it } from "vite-plus/test";
import {
  resolveCollaborationScope,
  validateCollaborationScope,
  validateSetupReturn,
} from "./collaborationScope";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../settings/settingsScopeNavigation";

const scope = {
  scopeEnvironmentId: "a",
  scopeProjectId: "second",
  scopeProviderId: "native-second",
};
describe("validated setup scope", () => {
  it("keeps only minimal nonsecret identifiers and internal return destinations", () => {
    expect(
      validateSetupReturn({
        ...scope,
        returnPage: "tasks",
        token: "secret",
        taskText: "private",
        returnUrl: "https://evil.invalid",
      }),
    ).toEqual({ ...scope, returnPage: "tasks" });
    expect(validateSetupReturn({ ...scope, returnPage: "https://evil.invalid" })).toEqual({});
  });
  it.each([null, 4, "", "x".repeat(257)])(
    "retains a fail-closed signal for malformed scope %s",
    (value) => {
      expect(
        validateCollaborationScope({ scopeEnvironmentId: "a", scopeProjectId: value }).scopeInvalid,
      ).toBe(true);
    },
  );
  it("does not reinterpret unscoped IDs in another environment", () => {
    expect(validateCollaborationScope({ scopeProjectId: "same-id" }).scopeInvalid).toBe(true);
    expect(
      resolveCollaborationScope(scope, "b", [{ id: "second" }], [{ instanceId: "native-second" }]),
    ).toMatchObject({ invalid: true, project: undefined, provider: undefined });
  });
  it("never substitutes the singleton for a retained missing ID", () => {
    expect(
      resolveCollaborationScope(
        scope,
        "a",
        [{ id: "replacement" }],
        [{ instanceId: "replacement" }],
      ),
    ).toMatchObject({ project: undefined, provider: undefined });
  });
  it("a newer detour clears absent old axes while category changes retain exact context", () => {
    const previous = { ...scope, returnPage: "agents" as const, machine: "a" };
    expect(
      retainSettingsScope({
        search: previous,
        next: () => ({ returnPage: "tasks", scopeEnvironmentId: "b", environmentId: "b" }),
      }),
    ).toEqual({ returnPage: "tasks", scopeEnvironmentId: "b", environmentId: "b" });
    expect(retainSettingsScope({ search: previous, next: () => ({}) })).toEqual({
      ...scope,
      returnPage: "agents",
      machine: "a",
    });
    expect(
      validateSettingsRouteSearch({
        ...scope,
        environmentId: "a",
        instanceId: "native-second",
        returnPage: "tasks",
      }),
    ).toMatchObject({ ...scope, machine: "a", returnPage: "tasks" });
  });
});
