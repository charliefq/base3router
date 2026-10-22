import type { ControllerTransport } from "../../packages/client-runtime/src/controllers/client.ts";

/** Run in a trusted external host, never the owner-session browser. No secret is retained here. */
export function controllerHttpTransport(options: {
  origin: string;
  authorization: () => Promise<string>;
  fetch: typeof fetch;
}): ControllerTransport {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Controller transport requires an HTTPS origin without credentials or a path.");
  }
  return {
    protocol: "http",
    async post(path, input) {
      if (
        !/^\/api\/controller\/v1\/tools\/(create_task|start_task|get_task|get_result|submit_feedback|cancel_task)$/.test(
          path,
        )
      ) {
        throw new Error("Unsupported controller tool path.");
      }
      const authorization = await options.authorization();
      const response = await options.fetch(new URL(path, origin), {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify(input),
      });
      // Shared client decodes bridge failures and successful views; an invalid/absent reply
      // remains uncertain at the adapter boundary. Do not expose HTTP bodies in error messages.
      return response.json();
    },
  };
}
