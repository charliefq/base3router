import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, type ControllerStatus } from "@t3tools/contracts";
import { createControllerManagement, controllerOwnerRequest } from "./owner.ts";
import { connectionLabel } from "./onboarding.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
const status: typeof ControllerStatus.Type = {
  version: 1,
  environmentId: "environment-a",
  configuration: "configured",
  lastAuthenticatedAt: "2026-10-22T01:00:00Z",
  identity: {
    id: "concrete-grok-42",
    displayName: "Owner Grok",
    projects: ["p1"],
    actions: ["get_task"],
    generation: 1,
    expiresAt: "2027-01-01T00:00:00Z",
    revokedAt: null,
    supervisedTasks: 0,
  },
  tasks: [],
};
describe("owner controller administration boundary", () => {
  it("uses concrete identities and never interprets configured/recent traffic as LIVE", async () => {
    const calls: unknown[] = [];
    const management = createControllerManagement("environment-a", async (request) => {
      calls.push(request);
      return {
        status: 200,
        body:
          request.operation === "identities"
            ? { version: 1, identities: [status.identity] }
            : request.operation === "revoke"
              ? { version: 1, revoked: true }
              : status,
      };
    });
    expect((await management.list())[0]?.id).toBe("concrete-grok-42");
    expect(connectionLabel(await management.read("concrete-grok-42"))).toBe(
      "Configured — live connection untested",
    );
    await management.revoke("concrete-grok-42");
    expect(calls).toEqual([
      { operation: "identities" },
      { operation: "status", controllerId: "concrete-grok-42" },
      { operation: "revoke", controllerId: "concrete-grok-42" },
    ]);
  });
  it("rejects foreign environments and identities, and reports denial/expiry/uncertainty", async () => {
    for (const body of [
      { ...status, environmentId: "other" },
      { ...status, identity: { ...status.identity!, id: "other" } },
    ]) {
      const management = createControllerManagement("environment-a", async () => ({
        status: 200,
        body,
      }));
      await expect(management.read("concrete-grok-42")).rejects.toMatchObject({
        code: "incompatible_response",
      });
    }
    for (const error of ["unauthorized", "denied"] as const) {
      const management = createControllerManagement("environment-a", async () => ({
        status: error === "denied" ? 403 : 401,
        body: { version: 1, error },
      }));
      await expect(management.revoke("concrete-grok-42")).rejects.toMatchObject({ code: error });
    }
    const management = createControllerManagement("environment-a", async () => {
      throw new Error("timeout");
    });
    await expect(management.revoke("concrete-grok-42")).rejects.toMatchObject({
      code: "uncertain",
    });
    expect(connectionLabel({ ...status, configuration: "expired" })).toContain("Expired");
    expect(connectionLabel({ ...status, configuration: "revoked" })).toBe("Revoked");
  });
});

effectIt.effect(
  "sends owner-session HTTP to the selected environment with plain identity bodies and no controller credential",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("fixture-env");
      for (const authorization of [
        null,
        { _tag: "Bearer" as const, token: "fixture-owner-session-only" },
      ]) {
        const prepared: PreparedConnection = {
          environmentId,
          label: "Fixture",
          httpBaseUrl: "https://selected.fixture.invalid",
          socketUrl: "wss://selected.fixture.invalid/ws",
          target: new RelayConnectionTarget({ environmentId, label: "Fixture" }),
          httpAuthorization: authorization,
        };
        const requests: {
          url: string;
          method: string;
          authorization: string | null;
          credentials: RequestCredentials;
          body: string;
        }[] = [];
        yield* Effect.gen(function* () {
          const reference = yield* SubscriptionRef.make(Option.some(prepared));
          const layer = Layer.mergeAll(
            Layer.mock(EnvironmentSupervisor)({
              prepared: reference,
              target: prepared.target,
              state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
              session: yield* SubscriptionRef.make(
                Option.none<import("../rpc/session.ts").RpcSession>(),
              ),
            }),
            remoteHttpClientLayer(async (input, init) => {
              const request = new Request(input, init);
              requests.push({
                url: request.url,
                method: request.method,
                authorization: request.headers.get("authorization"),
                credentials: request.credentials,
                body: await request.text(),
              });
              return Response.json({ version: 1, revoked: true });
            }),
          );
          yield* controllerOwnerRequest(environmentId, { operation: "identities" }).pipe(
            Effect.provide(layer),
          );
          yield* controllerOwnerRequest(environmentId, {
            operation: "status",
            controllerId: "concrete-grok-42",
          }).pipe(Effect.provide(layer));
          yield* controllerOwnerRequest(environmentId, {
            operation: "revoke",
            controllerId: "concrete-grok-42",
          }).pipe(Effect.provide(layer));
          const wrong = yield* controllerOwnerRequest(EnvironmentId.make("other"), {
            operation: "identities",
          }).pipe(Effect.provide(layer), Effect.result);
          expect(wrong._tag).toBe("Failure");
        });
        expect(requests.map((request) => request.url)).toEqual(
          ["identities", "status", "revoke"].map(
            (operation) => `https://selected.fixture.invalid/api/controller/v1/${operation}`,
          ),
        );
        expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "POST"]);
        expect(requests[1]?.body).toBe('{"controllerId":"concrete-grok-42"}');
        expect(requests[2]?.body).toBe(requests[1]?.body);
        expect(
          requests.every(
            (request) =>
              request.authorization ===
              (authorization ? "Bearer fixture-owner-session-only" : null),
          ),
        ).toBe(true);
        if (!authorization)
          expect(requests.every((request) => request.credentials === "include")).toBe(true);
      }
    }),
);
