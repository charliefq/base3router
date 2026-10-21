import { describe, expect, it } from "vite-plus/test";
import { streamOpenRouter } from "./OpenRouterTransport.ts";

const encoder = new TextEncoder();
const reply = (body: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        // Byte-at-a-time fixtures cover split delimiters, UTF-8 and comments.
        for (const byte of encoder.encode(body)) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const read = async (response: Response) => {
  const chunks = [];
  for await (const chunk of streamOpenRouter({
    fetch: async () => response,
    apiKey: "fixture-only",
    model: "openrouter/auto",
    messages: [{ role: "user", content: "test" }],
    signal: new AbortController().signal,
  }))
    chunks.push(chunk);
  return chunks;
};
describe("LOCAL/FIXTURE OpenRouter transport", () => {
  it("streams UTF-8, preserves only reported identity and leaves missing usage unknown", async () => {
    const chunks = await read(
      reply(
        ': keepalive\r\n\r\ndata: {"model":"fixture/model","choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
      ),
    );
    expect(chunks).toEqual([{ text: "你好", model: "fixture/model", finished: true }]);
  });
  it.each([401, 403, 429, 500])("settles HTTP %s with sanitized failure", async (status) => {
    await expect(read(new Response("private server response", { status }))).rejects.toMatchObject({
      code: status === 429 ? "rate_limit" : status === 500 ? "provider" : "authentication",
    });
  });
  it.each([
    ["data: nope\n\n", "protocol"],
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', "interrupted"],
    ['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', "provider"],
    ['data: {"error":{"message":"private"},"choices":[]}\n\n', "provider"],
    ['data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n', "protocol"],
  ])("rejects incomplete, malformed or unsupported stream %#", async (body, code) => {
    await expect(read(reply(body))).rejects.toMatchObject({ code });
  });
});
