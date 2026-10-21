/** Minimal official chat-completions/SSE interface. No retries or provider probes. */
export class OpenRouterTransportError extends Error {
  readonly code: "authentication" | "rate_limit" | "provider" | "protocol" | "interrupted";
  constructor(code: "authentication" | "rate_limit" | "provider" | "protocol" | "interrupted") {
    super(
      `OpenRouter ${code} failure. Remote work and billing may be unknown; no automatic retry was made.`,
    );
    this.code = code;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface OpenRouterChunk {
  readonly text: string;
  readonly model?: string;
  readonly id?: string;
  readonly finished: boolean;
  readonly usage?: { readonly input: number; readonly output: number; readonly cost?: number };
}

function parseChunk(data: string): OpenRouterChunk {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new OpenRouterTransportError("protocol");
  }
  const payload = record(value);
  if (payload.error) throw new OpenRouterTransportError("provider");
  if (!Array.isArray(payload.choices)) throw new OpenRouterTransportError("protocol");
  const choice = record(payload.choices[0]);
  const delta = record(choice.delta);
  if (delta.tool_calls || delta.function_call || delta.images || delta.audio)
    throw new OpenRouterTransportError("protocol");
  if (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string")
    throw new OpenRouterTransportError("protocol");
  const reason = choice.finish_reason;
  if (reason !== undefined && reason !== null && reason !== "stop")
    throw new OpenRouterTransportError("provider");
  const usage = record(payload.usage);
  const numeric = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  const integer = (n: unknown): n is number => numeric(n) && Number.isSafeInteger(n);
  return {
    text: typeof delta.content === "string" ? delta.content : "",
    finished: reason === "stop",
    ...(typeof payload.model === "string" && /^[\w./:@+-]{1,256}$/.test(payload.model)
      ? { model: payload.model }
      : {}),
    ...(typeof payload.id === "string" && /^[\w-]{1,256}$/.test(payload.id)
      ? { id: payload.id }
      : {}),
    ...(integer(usage.prompt_tokens) && integer(usage.completion_tokens)
      ? {
          usage: {
            input: usage.prompt_tokens,
            output: usage.completion_tokens,
            ...(numeric(usage.cost) ? { cost: usage.cost } : {}),
          },
        }
      : {}),
  };
}

export async function* streamOpenRouter(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly signal: AbortSignal;
}): AsyncGenerator<OpenRouterChunk> {
  let response: Response;
  try {
    response = await input.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: input.signal,
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        stream_options: { include_usage: true },
        provider: { require_parameters: true },
      }),
    });
  } catch {
    throw new OpenRouterTransportError("interrupted");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OpenRouterTransportError(
      response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 429
          ? "rate_limit"
          : "provider",
    );
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    throw new OpenRouterTransportError("protocol");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let finished = false;
  let done = false;
  let outputChars = 0;
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > 1_048_576) throw new OpenRouterTransportError("protocol");
      // Normalize CRLF only after accumulating so a split CRLF remains intact.
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue; // comments/keep-alives
        if (data === "[DONE]") {
          done = true;
          break;
        }
        const chunk = parseChunk(data);
        outputChars += chunk.text.length;
        if (outputChars > 2_000_000) throw new OpenRouterTransportError("protocol");
        finished ||= chunk.finished;
        yield chunk;
      }
    }
    if (!done || !finished) throw new OpenRouterTransportError("interrupted");
  } catch (cause) {
    throw cause instanceof OpenRouterTransportError
      ? cause
      : new OpenRouterTransportError("interrupted");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
