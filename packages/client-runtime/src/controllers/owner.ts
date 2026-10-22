import {
  ControllerIdentityView,
  ControllerStatus,
  ControllerBridgeFailure,
} from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { createEnvironmentCommand } from "../state/runtime.ts";
import type { ControllerManagement } from "./onboarding.ts";
import { ControllerClientError } from "./client.ts";

type OwnerRequest =
  | { operation: "identities" }
  | { operation: "status" | "revoke"; controllerId: string };
type OwnerResponse = { status: number; body: unknown };
const Identities = Schema.Struct({
  version: Schema.Literal(1),
  identities: Schema.Array(ControllerIdentityView),
});
const Revoked = Schema.Struct({ version: Schema.Literal(1), revoked: Schema.Literal(true) });
const isFailure = Schema.is(ControllerBridgeFailure);
const isRevoked = Schema.is(Revoked);
const decodeIdentities = Schema.decodeUnknownSync(Identities);
const decodeStatus = Schema.decodeUnknownSync(ControllerStatus);
/** Reuses cookie/bearer/DPoP owner-session plumbing; never a controller bearer. */
export const controllerOwnerRequest = (environmentId: EnvironmentId, input: OwnerRequest) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
    if (!prepared || prepared.environmentId !== environmentId)
      return yield* Effect.fail(new ControllerClientError("unavailable"));
    const method = input.operation === "identities" ? "GET" : "POST";
    let requestUrl = "";
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
      method,
      group: "auth",
      timeoutMs: 6000,
      // The bridge routes are not HttpApi groups. Use the existing auth machinery
      // with a raw HTTP request, resolving the URL again after a DPoP refresh.
      url: (base) => {
        requestUrl = environmentEndpointUrl(base, `/api/controller/v1/${input.operation}`);
        return requestUrl;
      },
      request: ({ headers }) =>
        Effect.gen(function* () {
          const request =
            input.operation === "identities"
              ? HttpClientRequest.get(requestUrl)
              : yield* HttpClientRequest.post(requestUrl).pipe(
                  HttpClientRequest.bodyJson({ controllerId: input.controllerId }),
                );
          const response = yield* HttpClient.execute(
            request.pipe(
              HttpClientRequest.setHeaders({
                ...(headers.authorization ? { authorization: headers.authorization } : {}),
                ...(headers.dpop ? { dpop: headers.dpop } : {}),
              }),
            ),
          );
          return { status: response.status, body: yield* response.json };
        }),
      isUnauthorizedResponse: (response) => response.status === 401,
    });
  });

export function createControllerOwnerCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "controllers:owner-session",
    execute: (input: OwnerRequest, _registry, environmentId: EnvironmentId) =>
      controllerOwnerRequest(environmentId, input),
  });
}
/** Bind to one environment/session in the UI; stale responses cannot change that binding. */
export function createControllerManagement(
  environmentId: string,
  request: (input: OwnerRequest) => Promise<OwnerResponse>,
): ControllerManagement {
  const send = async (input: OwnerRequest) => {
    let reply: OwnerResponse;
    try {
      reply = await request(input);
    } catch {
      throw new ControllerClientError("uncertain");
    }
    if (isFailure(reply.body)) throw new ControllerClientError(reply.body.error);
    if (reply.status < 200 || reply.status >= 300)
      throw new ControllerClientError(
        reply.status === 401 ? "unauthorized" : reply.status === 403 ? "denied" : "unavailable",
      );
    return reply.body;
  };
  return {
    async list() {
      const reply = await send({ operation: "identities" });
      try {
        return decodeIdentities(reply).identities;
      } catch {
        throw new ControllerClientError("incompatible_response");
      }
    },
    async read(controllerId) {
      const reply = await send({ operation: "status", controllerId });
      let status: typeof ControllerStatus.Type;
      try {
        status = decodeStatus(reply);
      } catch {
        throw new ControllerClientError("incompatible_response");
      }
      if (
        status.environmentId !== environmentId ||
        (status.identity && status.identity.id !== controllerId) ||
        status.tasks.some((task) => task.controllerId !== controllerId)
      )
        throw new ControllerClientError("incompatible_response");
      return status;
    },
    async revoke(controllerId) {
      const reply = await send({ operation: "revoke", controllerId });
      if (!isRevoked(reply)) throw new ControllerClientError("uncertain");
    },
  };
}
