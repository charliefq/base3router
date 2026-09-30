import { describe, expect, it } from "@effect/vitest";

import {
  envCursorCloudCredentialProvider,
  isCursorCloudConfigured,
  isCursorCloudFeatureEnabled,
} from "./CursorCloudCredentials.ts";

describe("Cursor Cloud credential provider", () => {
  it("stays unconfigured without the feature flag or env reference", () => {
    expect(isCursorCloudFeatureEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCursorCloudConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isCursorCloudConfigured({
        T3CODE_CURSOR_CLOUD_ENABLED: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("resolves the env reference at request time without exposing it from configured()", () => {
    const env = {
      T3CODE_CURSOR_CLOUD_ENABLED: "true",
      CURSOR_API_KEY: "test-cursor-token",
    } as NodeJS.ProcessEnv;
    expect(isCursorCloudConfigured(env)).toBe(true);
    const provider = envCursorCloudCredentialProvider(env);
    expect(provider.configured()).toBe(true);
    expect(provider.reference).toEqual({ kind: "env", name: "CURSOR_API_KEY" });
    const resolved = provider.resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.token).toBe("test-cursor-token");
    expect(JSON.stringify(provider.reference)).not.toContain("test-cursor-token");
  });
});
