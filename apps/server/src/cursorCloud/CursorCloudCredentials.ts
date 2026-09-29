import {
  CURSOR_CLOUD_CREDENTIAL_ENV_NAME,
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  type CursorCloudCredentialReference,
} from "@t3tools/contracts";

import { cursorCloudError, type CursorCloudError } from "./CursorCloudErrors.ts";

export type CursorCloudCredentialProvider = {
  readonly reference: CursorCloudCredentialReference;
  configured(): boolean;
  resolve():
    | { readonly ok: true; readonly token: string }
    | { readonly ok: false; readonly error: CursorCloudError };
};

export const isCursorCloudFeatureEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T3CODE_CURSOR_CLOUD_ENABLED === "true";

export const isCursorCloudCredentialConfigured = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const value = env[CURSOR_CLOUD_CREDENTIAL_ENV_NAME];
  return typeof value === "string" && value.length > 0;
};

export const isCursorCloudConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  isCursorCloudFeatureEnabled(env) && isCursorCloudCredentialConfigured(env);

/** Resolves CURSOR_API_KEY at request time. The value is never stored. */
export const envCursorCloudCredentialProvider = (
  env: NodeJS.ProcessEnv = process.env,
): CursorCloudCredentialProvider => ({
  reference: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  configured: () => isCursorCloudCredentialConfigured(env),
  resolve: () => {
    const token = env[CURSOR_CLOUD_CREDENTIAL_ENV_NAME];
    if (typeof token !== "string" || token.length === 0) {
      return {
        ok: false,
        error: cursorCloudError("unconfigured", "Cursor Cloud is not configured on this server."),
      };
    }
    return { ok: true, token };
  },
});

export const staticCursorCloudCredentialProvider = (
  token: string,
): CursorCloudCredentialProvider => ({
  reference: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  configured: () => token.length > 0,
  resolve: () =>
    token.length > 0
      ? { ok: true, token }
      : {
          ok: false,
          error: cursorCloudError("unconfigured", "Cursor Cloud is not configured on this server."),
        },
});
