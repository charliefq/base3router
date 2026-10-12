import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import type { HttpClient } from "effect/unstable/http";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

/** Read the existing collaboration API with the connection's current credentials. */
export function createCollaborationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    snapshot: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:collaboration:snapshot",
      execute: (input: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
          if (!prepared || prepared.environmentId !== input.environmentId)
            return yield* new EnvironmentRpcUnavailableError({
              environmentId: input.environmentId,
              message: "The selected environment connection is unavailable.",
            });
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            prepared,
            signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
            remoteAuthorization: yield* Effect.serviceOption(
              RemoteAuthorization.RemoteEnvironmentAuthorization,
            ),
            method: "GET",
            group: "collaboration",
            url: (base) => environmentEndpointUrl(base, "/api/collaboration"),
            timeoutMs: 6_000,
            request: ({ client, headers }) => client.snapshot({ headers }),
          });
        }),
    }),
  };
}
