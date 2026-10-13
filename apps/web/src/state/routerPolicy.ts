import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@t3tools/client-runtime/state/session";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, EnvironmentRouterPolicyCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { connectionAtomRuntime } from "../connection/runtime";

const selectedAuthorization = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
    if (!prepared || prepared.environmentId !== environmentId)
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message: "The selected environment connection is unavailable.",
      });
    return {
      prepared,
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    };
  });

export const routerPolicyRequests = {
  status: (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...(yield* selectedAuthorization(environmentId)),
        group: "routerPolicy",
        method: "GET",
        timeoutMs: 6_000,
        url: (base) => environmentEndpointUrl(base, "/api/router-policy"),
        request: ({ client, headers }) => client.status({ headers }),
      });
    }),
  control: (environmentId: EnvironmentId, payload: EnvironmentRouterPolicyCommand) =>
    Effect.gen(function* () {
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...(yield* selectedAuthorization(environmentId)),
        group: "routerPolicy",
        method: "POST",
        timeoutMs: 6_000,
        url: (base) => environmentEndpointUrl(base, "/api/router-policy/command"),
        request: ({ client, headers }) => {
          switch (payload.action) {
            case "shadow":
              return client.command({ headers, payload });
            case "activate":
              return client.command({ headers, payload });
            case "rollback":
              return client.command({ headers, payload });
          }
        },
      });
    }),
};
export const routerPolicyStatusCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "router-policy:status",
  execute: (_: undefined, _registry, environmentId) => routerPolicyRequests.status(environmentId),
});
export const routerPolicyControlCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "router-policy:control",
  execute: (input: EnvironmentRouterPolicyCommand, _registry, environmentId) =>
    routerPolicyRequests.control(environmentId, input),
  concurrency: { mode: "serial", key: (target) => target.environmentId },
});
