// @effect-diagnostics globalFetch:off - injectable Promise transport; unit tests replace fetch.
export type OpenRouterTransportRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
};

export type OpenRouterTransportResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: () => Promise<string>;
  readonly stream?: () => AsyncIterable<string>;
};

export type OpenRouterTransport = (
  request: OpenRouterTransportRequest,
) => Promise<OpenRouterTransportResponse>;

export const fetchOpenRouterTransport: OpenRouterTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
  const headerRecord: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerRecord[key] = value;
  });
  return {
    status: response.status,
    headers: headerRecord,
    text: () => response.text(),
    stream: async function* () {
      if (response.body === null) {
        yield await response.text();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    },
  };
};
