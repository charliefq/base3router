/** Explicit, defaultless HTTP capability. Never discovers credentials or follows redirects. */
const fail = (reason) => {
  throw new Error(reason);
};
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const resourcePattern =
  /^(?:pulls\/[1-9]\d*|issues\/[1-9]\d*\/comments|actions\/runs\/[1-9]\d*(?:\/jobs)?|actions\/jobs\/[1-9]\d*(?:\/logs)?|check-runs\/[1-9]\d*|git\/commits\/[a-f0-9]{40})$/;

export function createHttpReadTransport({
  repository,
  fetch: fetchImpl,
  allowedPaths,
  headers = {},
  maxBytes = 8 * 1024 * 1024,
  timeoutMs = 30_000,
}) {
  if (
    !repositoryPattern.test(repository) ||
    typeof fetchImpl !== "function" ||
    !Array.isArray(allowedPaths) ||
    allowedPaths.length === 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 300_000
  )
    fail("invalid-transport-configuration");
  const root = `/repos/${repository}/`;
  const validPath = (path) =>
    typeof path === "string" &&
    path.startsWith(root) &&
    resourcePattern.test(path.slice(root.length));
  if (!allowedPaths.every(validPath)) fail("invalid-path-capability");
  const paths = new Set(allowedPaths);
  let requestHeaders;
  try {
    requestHeaders = new Headers(headers);
  } catch {
    fail("invalid-request-headers");
  }
  for (const name of requestHeaders.keys()) {
    if (!["accept", "authorization", "x-github-api-version", "user-agent"].includes(name))
      fail("unsupported-request-header");
  }

  return async function readTransport({ method, path, query = {}, format }) {
    if (
      method !== "GET" ||
      !validPath(path) ||
      !paths.has(path) ||
      !["json", "text"].includes(format)
    )
      fail("request-outside-capability");
    if (!query || Object.getPrototypeOf(query) !== Object.prototype) fail("invalid-query");
    const url = new URL(`https://api.github.com${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (
        !["page", "per_page"].includes(key) ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        (key === "per_page" && value > 100)
      )
        fail("invalid-query");
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    let reader;
    let response;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("read-timeout"));
      }, timeoutMs);
    });
    try {
      response = await Promise.race([
        fetchImpl(url.href, {
          method: "GET",
          headers: new Headers(requestHeaders),
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!(response instanceof Response)) fail("not-a-response");
      // A fetch implementation that already followed a redirect violates this capability.
      if (
        response.redirected ||
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== url.href)
      )
        fail("redirect-or-source-rejected");
      if (response.status === 206 || response.headers.has("content-range"))
        fail("partial-response-rejected");
      if (!response.body || response.bodyUsed) fail("body-unavailable");
      const length = response.headers.get("content-length");
      if (length !== null && !/^\d+$/.test(length)) fail("invalid-content-length");
      const declared = length === null ? null : Number(length);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared > maxBytes))
        fail("body-too-large");
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        if (!(value instanceof Uint8Array)) fail("invalid-body-chunk");
        bytes += value.byteLength;
        if (bytes > maxBytes) fail("body-too-large");
        chunks.push(value);
      }
      // Fetch may decode content-encoding; wire Content-Length then describes other bytes.
      const encoding = response.headers.get("content-encoding");
      if ((!encoding || encoding === "identity") && declared !== null && bytes !== declared)
        fail("body-length-mismatch");
      const joined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let data;
      try {
        const body = new TextDecoder("utf-8", { fatal: true }).decode(joined);
        data = format === "json" ? JSON.parse(body) : body;
      } catch {
        fail("invalid-response-body");
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        complete: true,
        data,
      };
    } catch (error) {
      // Never expose fetch errors, URLs, response bodies or supplied authorization headers.
      const reasons = new Set([
        "read-timeout",
        "not-a-response",
        "redirect-or-source-rejected",
        "partial-response-rejected",
        "body-unavailable",
        "invalid-content-length",
        "body-too-large",
        "invalid-body-chunk",
        "body-length-mismatch",
        "invalid-response-body",
      ]);
      // eslint-disable-next-line preserve-caught-error -- Upstream causes can contain credentials; expose only fixed reasons.
      throw new Error(reasons.has(error?.message) ? error.message : "http-read-failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (response instanceof Response && response.body && !response.body.locked) {
        void response.body.cancel().catch(() => {});
      }
    }
  };
}
