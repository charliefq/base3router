export const CURSOR_CLOUD_ERROR_CODES = [
  "unconfigured",
  "timeout",
  "rate_limited",
  "agent_busy",
  "run_not_cancellable",
  "malformed_response",
  "unauthorized",
  "not_found",
  "cancelled",
  "transport",
  "rejected",
] as const;
export type CursorCloudErrorCode = (typeof CURSOR_CLOUD_ERROR_CODES)[number];

export type CursorCloudError = {
  readonly _tag: "CursorCloudError";
  readonly code: CursorCloudErrorCode;
  readonly message: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
};

const CREDENTIAL_SHAPED =
  /Bearer\s+[A-Za-z0-9._~+/=-]+|crsr_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|CURSOR_API_KEY\s*=\s*\S+/gi;

export const sanitizeCursorCloudText = (value: string): string =>
  value
    .replace(CREDENTIAL_SHAPED, "[redacted]")
    .replace(/authorization\s*[:=]\s*\S+/gi, "authorization=[redacted]");

export const sanitizeCursorCloudUnknown = (value: unknown): string => {
  if (typeof value === "string") return sanitizeCursorCloudText(value).slice(0, 400);
  if (value instanceof Error) return sanitizeCursorCloudText(value.message).slice(0, 400);
  try {
    return sanitizeCursorCloudText(JSON.stringify(value)).slice(0, 400);
  } catch {
    return "Cursor Cloud request failed.";
  }
};

export const cursorCloudError = (
  code: CursorCloudErrorCode,
  message: string,
  extras: { readonly httpStatus?: number; readonly retryAfterMs?: number } = {},
): CursorCloudError => ({
  _tag: "CursorCloudError",
  code,
  message: sanitizeCursorCloudText(message).slice(0, 400),
  ...(extras.httpStatus === undefined ? {} : { httpStatus: extras.httpStatus }),
  ...(extras.retryAfterMs === undefined ? {} : { retryAfterMs: extras.retryAfterMs }),
});

export const isCursorCloudError = (value: unknown): value is CursorCloudError =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "CursorCloudError";
