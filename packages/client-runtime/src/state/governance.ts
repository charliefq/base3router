import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createGovernanceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const snapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:governance:snapshot",
    tag: WS_METHODS.governanceSnapshot,
  });
  return {
    snapshot,
    authorizeTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:governance:authorize-tool",
      tag: WS_METHODS.actionGateAuthorizeTool,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(snapshot({ environmentId: target.environmentId, input: {} }));
        }),
    }),
    respondApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:governance:respond-approval",
      tag: WS_METHODS.actionGateRespondApproval,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(snapshot({ environmentId: target.environmentId, input: {} }));
        }),
    }),
    saveMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:governance:save-memory",
      tag: WS_METHODS.memorySave,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(snapshot({ environmentId: target.environmentId, input: {} }));
        }),
    }),
    deleteMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:governance:delete-memory",
      tag: WS_METHODS.memoryDelete,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(snapshot({ environmentId: target.environmentId, input: {} }));
        }),
    }),
    enqueueEligible: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:governance:enqueue-eligible",
      tag: WS_METHODS.memoryEnqueueEligible,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(snapshot({ environmentId: target.environmentId, input: {} }));
        }),
    }),
  };
}
