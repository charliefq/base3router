import {
  cursorCloudError,
  sanitizeCursorCloudText,
  type CursorCloudError,
} from "./CursorCloudErrors.ts";

export const CURSOR_CLOUD_API_BASE_URL = "https://api.cursor.com";
export const CURSOR_CLOUD_DEFAULT_TIMEOUT_MS = 15_000;
export const CURSOR_CLOUD_CREATE_TIMEOUT_MS = 30_000;

export type CursorCloudHttpMethod = "GET" | "POST";

export type CursorCloudHttpRequest = {
  readonly method: CursorCloudHttpMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly authorization: string;
};

export type CursorCloudHttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
};

export type CursorCloudHttpTransport = (
  request: CursorCloudHttpRequest,
) => Promise<CursorCloudHttpResponse>;

const headerRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") return;
    record[key.toLowerCase()] = sanitizeCursorCloudText(value);
  });
  return record;
};

export const parseRetryAfterMs = (
  headers: Readonly<Record<string, string>>,
): number | undefined => {
  const raw = headers["retry-after"];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1_000), 120_000);
};

export const makeFetchCursorCloudTransport = (
  input: {
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
  } = {},
): CursorCloudHttpTransport => {
  const baseUrl = input.baseUrl ?? CURSOR_CLOUD_API_BASE_URL;
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetchImpl(new URL(request.path, baseUrl), {
        method: request.method,
        headers: {
          authorization: `Bearer ${request.authorization}`,
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
      return {
        status: response.status,
        headers: headerRecord(response.headers),
        bodyText: await response.text(),
      };
    } catch (cause) {
      if (controller.signal.aborted) {
        throw cursorCloudError(
          "timeout",
          `Cursor Cloud request timed out after ${request.timeoutMs}ms.`,
        );
      }
      throw cursorCloudError("transport", sanitizeCursorCloudText(String(cause)));
    } finally {
      clearTimeout(timer);
    }
  };
};

export const toCursorCloudHttpError = (
  response: CursorCloudHttpResponse,
  fallback: string,
): CursorCloudError => {
  if (response.status === 409) {
    const busy = /agent_busy/i.test(response.bodyText);
    return cursorCloudError(
      busy ? "agent_busy" : "rejected",
      busy ? "The Cursor agent is busy with another run." : fallback,
      { httpStatus: 409 },
    );
  }
  if (response.status === 429) {
    return cursorCloudError("rate_limited", "Cursor Cloud rate-limited the request.", {
      httpStatus: 429,
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }
  if (response.status === 401 || response.status === 403) {
    return cursorCloudError("unauthorized", "Cursor Cloud rejected the credential reference.", {
      httpStatus: response.status,
    });
  }
  if (response.status === 404) {
    return cursorCloudError("not_found", "Cursor Cloud agent or run was not found.", {
      httpStatus: 404,
    });
  }
  return cursorCloudError("rejected", fallback, { httpStatus: response.status });
};
