import { expect, it } from "vite-plus/test";
import { controllerHttpTransport } from "./http.ts";

it("restricts HTTP to the existing HTTPS bridge without cookies, redirects or retries", async () => {
  const calls: RequestInit[] = [];
  const transport = controllerHttpTransport({
    origin: "https://b3r.invalid",
    authorization: async () => "Bearer fixture-not-a-credential",
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://b3r.invalid/api/controller/v1/tools/get_task");
      calls.push(init!);
      return new Response(JSON.stringify({ version: 1, error: "denied" }), { status: 403 });
    },
  });
  if (transport.protocol !== "http") throw new Error("Expected HTTP transport");
  expect(
    await transport.post("/api/controller/v1/tools/get_task", { taskId: "synthetic" }),
  ).toEqual({ version: 1, error: "denied" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    method: "POST",
  });
  await expect(transport.post("/api/access/grants", {})).rejects.toThrow("Unsupported");
  expect(calls).toHaveLength(1);
  expect(() =>
    controllerHttpTransport({ origin: "http://localhost", authorization: async () => "", fetch }),
  ).toThrow("HTTPS origin");
  expect(() =>
    controllerHttpTransport({
      origin: "https://user:secret@b3r.invalid",
      authorization: async () => "",
      fetch,
    }),
  ).toThrow("HTTPS origin");
});
