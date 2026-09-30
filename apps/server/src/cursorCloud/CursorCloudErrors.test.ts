import { describe, expect, it } from "@effect/vitest";

import { sanitizeCursorCloudText, sanitizeCursorCloudUnknown } from "./CursorCloudErrors.ts";

const underscoreToken = "crsr_test_secret_value";
const hyphenToken = "crsr-live-secret-value";

describe("Cursor Cloud credential redaction", () => {
  it("redacts underscore and hyphen tokens including the suffix", () => {
    expect(sanitizeCursorCloudText(underscoreToken)).toBe("[redacted]");
    expect(sanitizeCursorCloudText(underscoreToken)).not.toContain("secret_value");
    expect(sanitizeCursorCloudText(hyphenToken)).toBe("[redacted]");
    expect(sanitizeCursorCloudText(hyphenToken)).not.toContain("secret-value");
  });

  it("redacts raw token text, Bearer form, and assignment form", () => {
    expect(sanitizeCursorCloudText(`Bearer ${underscoreToken}`)).not.toContain("secret_value");
    expect(sanitizeCursorCloudText(`Authorization: Bearer ${hyphenToken}`)).not.toContain(
      "secret-value",
    );
    expect(sanitizeCursorCloudText(`CURSOR_API_KEY=${underscoreToken}`)).not.toContain(
      "secret_value",
    );
    expect(sanitizeCursorCloudText(`CURSOR_API_KEY=${underscoreToken}`)).not.toContain(
      underscoreToken,
    );
  });

  it("redacts JSON error bodies and nested unknown errors", () => {
    const json = sanitizeCursorCloudUnknown({
      error: { message: `Invalid key ${underscoreToken}`, nested: { token: hyphenToken } },
    });
    expect(json).not.toContain("secret_value");
    expect(json).not.toContain("secret-value");
    expect(json).not.toContain(underscoreToken);
    expect(json).not.toContain(hyphenToken);
    const fromError = sanitizeCursorCloudUnknown(
      new Error(`upstream said ${underscoreToken} and ${hyphenToken}`),
    );
    expect(fromError).not.toContain("secret_value");
    expect(fromError).not.toContain("secret-value");
  });

  it("redacts tokens from log lines", () => {
    const log = sanitizeCursorCloudText(
      `cursor-cloud POST /v1/agents authorization=Bearer ${underscoreToken} extra=${hyphenToken}`,
    );
    expect(log).not.toContain("secret_value");
    expect(log).not.toContain("secret-value");
    expect(log).not.toContain(underscoreToken);
    expect(log).not.toContain(hyphenToken);
  });
});
