// Tightens egress for the disposable verification process; never changes app auth.
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
const root = process.env.B3R_LOCAL_PRODUCT_ROOT;
if (!root?.startsWith("/tmp/b3r-local-product-"))
  throw new Error("Disposable fixture root required");
const allowed = (host) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
const refuse = (host) => {
  NodeFS.appendFileSync(
    root + "/blocked-egress.ndjson",
    JSON.stringify({ host, pid: process.pid }) + "\n",
  );
  throw new Error(`LOCAL verification blocks non-loopback egress: ${host}`);
};
const connect = NodeNet.Socket.prototype.connect;
NodeNet.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    if (first.path ? !String(first.path).startsWith(root) : !allowed(first.host ?? "localhost"))
      refuse(first.path ?? first.host);
  } else if (typeof first === "string" && !/^\d+$/.test(first)) {
    if (!first.startsWith(root)) refuse(first);
  } else if (!allowed(typeof args[1] === "string" ? args[1] : "localhost")) refuse(args[1]);
  return connect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) {
    try {
      refuse(url.hostname);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return originalFetch(input, init);
};
NodeModule.syncBuiltinESMExports();
