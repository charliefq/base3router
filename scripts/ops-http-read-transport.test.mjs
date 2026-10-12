import * as NodeAssert from "node:assert/strict";
import { assert, describe, it } from "vite-plus/test";
import { createHttpReadTransport } from "./ops-http-read-transport.mjs";
import { normalizePage } from "./ops-evidence-adapters.mjs";

const repository = "fixture-owner/fixture-repo";
const path = `/repos/${repository}/issues/34/comments`;
const request = { method: "GET", path, query: {}, format: "json" };
function setup(response, options = {}) {
  const calls = [];
  const read = createHttpReadTransport({
    repository,
    allowedPaths: [path],
    fetch: async (...args) => {
      calls.push(args);
      return typeof response === "function" ? response(...args) : response;
    },
    ...options,
  });
  return { read, calls };
}
const stream = (start) => new ReadableStream({ start });
const bytes = (value) => new TextEncoder().encode(value);

describe("explicit GET-only HTTP transport", () => {
  it("does not report completeness until the stream closes", async () => {
    let controller;
    const f = setup(
      new Response(
        stream((value) => {
          controller = value;
          value.enqueue(bytes("[]"));
        }),
      ),
    );
    let completed = false;
    const pending = f.read(request).then((value) => {
      completed = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(completed, false);
    controller.close();
    assert.equal((await pending).complete, true);
  });

  it.each([undefined, "not a URL", `https://api.github.com${path}`])(
    "rejects even missing, malformed or same-origin redirect %s",
    async (location) => {
      const f = setup(
        new Response("", { status: 302, headers: location === undefined ? {} : { location } }),
      );
      await NodeAssert.rejects(f.read(request), /redirect-or-source-rejected/);
      assert.equal(f.calls.length, 1);
    },
  );

  it("sanitizes injected network errors and aborts a stalled fetch", async () => {
    const broken = setup(() => {
      throw new Error("Bearer synthetic-secret");
    });
    await NodeAssert.rejects(broken.read(request), /^Error: http-read-failed$/);
    let signal;
    const stalled = setup(
      (_, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
      { timeoutMs: 10 },
    );
    await NodeAssert.rejects(stalled.read(request), /read-timeout/);
    assert.equal(signal.aborted, true);
  });

  it.each(["json", "text"])("reads real Response %s to EOF", async (format) => {
    const body = format === "json" ? '[{"id":1}]' : "hello 世界";
    const f = setup(
      new Response(
        stream((c) => {
          const b = bytes(body);
          c.enqueue(b.slice(0, 4));
          c.enqueue(b.slice(4));
          c.close();
        }),
        { headers: { "content-length": String(bytes(body).length), "x-source": "actual" } },
      ),
    );
    const result = await f.read({ ...request, format });
    assert.equal(result.complete, true);
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-source"], "actual");
    assert.deepEqual(result.data, format === "json" ? [{ id: 1 }] : body);
    assert.equal(f.calls[0][0], `https://api.github.com${path}`);
    assert.equal(f.calls[0][1].credentials, "omit");
    assert.equal(f.calls[0][1].redirect, "manual");
    assert.equal(f.calls[0][1].headers.has("authorization"), false);
  });

  it.each([403, 404, 429])(
    "preserves real %s and its headers without upgrading status",
    async (status) => {
      const f = setup(
        new Response('{"message":"unavailable"}', { status, headers: { "retry-after": "60" } }),
      );
      const result = await f.read(request);
      assert.equal(result.status, status);
      assert.equal(result.complete, true);
      assert.equal(result.headers["retry-after"], "60");
    },
  );

  it.each([
    "broken-json",
    "bad-utf8",
    "interrupted",
    "oversized",
    "declared-oversized",
    "short-body",
    "bad-length",
    "partial",
    "range",
    "normalized",
    "timeout",
  ])("rejects %s without completeness", async (kind) => {
    let response = new Response("[]");
    const options = {};
    if (kind === "broken-json") response = new Response("{oops");
    if (kind === "bad-utf8") response = new Response(new Uint8Array([255]));
    if (kind === "interrupted")
      response = new Response(
        stream((c) => {
          c.enqueue(bytes("["));
          c.error(new Error("private upstream details"));
        }),
      );
    if (kind === "oversized") {
      response = new Response("[1,2,3]");
      options.maxBytes = 3;
    }
    if (kind === "declared-oversized") {
      response = new Response("[]", { headers: { "content-length": "100" } });
      options.maxBytes = 3;
    }
    if (kind === "short-body")
      response = new Response("[]", { headers: { "content-length": "3" } });
    if (kind === "bad-length")
      response = new Response("[]", { headers: { "content-length": "wat" } });
    if (kind === "partial") response = new Response("[]", { status: 206 });
    if (kind === "range")
      response = new Response("[]", { headers: { "content-range": "bytes 0-1/3" } });
    if (kind === "normalized") response = { status: 200, headers: {}, data: [], complete: true };
    if (kind === "timeout") {
      response = new Response(new ReadableStream());
      options.timeoutMs = 10;
    }
    await NodeAssert.rejects(
      setup(response, options).read(request),
      (error) => !error.message.includes("private"),
    );
  });

  it.each([301, 302, 307, 308])(
    "never forwards explicit authorization through %s redirect",
    async (status) => {
      const f = setup(
        new Response("", { status, headers: { location: "https://attacker.invalid/steal" } }),
        { headers: { authorization: "Bearer synthetic-test-only" } },
      );
      await NodeAssert.rejects(f.read(request), /redirect-or-source-rejected/);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0][1].headers.get("authorization"), "Bearer synthetic-test-only");
      assert.equal(f.calls[0][1].redirect, "manual");
      assert.equal(f.calls[0][1].credentials, "omit");
    },
  );

  it("rejects an injected fetch that reports an already-followed redirect", async () => {
    const response = new Response("[]");
    Object.defineProperty(response, "redirected", { value: true });
    await NodeAssert.rejects(setup(response).read(request), /redirect-or-source-rejected/);
  });

  it("preserves real Link pagination and only requests caller-validated next pages", async () => {
    const link = `<https://api.github.com${path}?per_page=100&page=2>; rel="next"`;
    const f = setup(
      (url) =>
        new Response(url.endsWith("page=1") ? '[{"id":1}]' : '[{"id":2}]', {
          headers: url.endsWith("page=1") ? { Link: link } : {},
        }),
    );
    const first = await f.read({ ...request, query: { per_page: 100, page: 1 } });
    assert.equal(first.headers.link, link);
    const page = normalizePage(first, { path, query: { per_page: 100 }, page: 1 });
    assert.equal(page.nextCursor, "2");
    const second = await f.read({
      ...request,
      query: { per_page: 100, page: Number(page.nextCursor) },
    });
    assert.equal(Object.hasOwn(second.headers, "link"), false);
    assert.equal(
      normalizePage(second, { path, query: { per_page: 100 }, page: 2 }).nextCursor,
      null,
    );
  });

  it("does not follow foreign Link headers", async () => {
    const f = setup(
      new Response("[]", { headers: { link: '<https://attacker.invalid/?page=2>; rel="next"' } }),
    );
    const result = await f.read(request);
    assert.throws(() => normalizePage(result, { path, query: {}, page: 1 }));
    assert.equal(f.calls.length, 1);
  });

  it.each([
    { method: "POST" },
    { path: "/repos/elsewhere/repo/pulls/34" },
    { path: `${path}/../comments` },
    { path: `${path}?page=1` },
    { path: `/repos/${repository}/actions/jobs/123` },
    { query: { access_token: "never-send" } },
    { query: { page: "1" } },
    { query: { per_page: 101 } },
    { format: "blob" },
  ])("rejects request outside the explicit capability %j", async (change) => {
    const f = setup(new Response("[]"));
    await NodeAssert.rejects(f.read({ ...request, ...change }));
    assert.equal(f.calls.length, 0);
  });

  it("requires injected fetch and snapshots caller capability/header configuration", async () => {
    assert.throws(
      () => setup(new Response("[]"), { headers: { authorization: "synthetic-secret\ninvalid" } }),
      /^invalid-request-headers$/,
    );
    assert.throws(() => createHttpReadTransport({ repository, allowedPaths: [path] }));
    assert.throws(() => setup(new Response("[]"), { headers: { cookie: "never-send" } }));
    const allowedPaths = [path];
    const headers = { authorization: "Bearer synthetic-test-only" };
    const f = setup(new Response("[]"), { allowedPaths, headers });
    allowedPaths.push(`/repos/${repository}/actions/jobs/123`);
    headers.authorization = "mutated";
    await f.read(request);
    assert.equal(f.calls[0][1].headers.get("authorization"), "Bearer synthetic-test-only");
    await NodeAssert.rejects(f.read({ ...request, path: allowedPaths[1] }));
    assert.equal(f.calls.length, 1);
  });
});
