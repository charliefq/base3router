import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { writeConfiguration } from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createWorkflowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const catalog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workflow:catalog",
    tag: WS_METHODS.workflowCatalog,
  });
  return {
    catalog,
    configurationAction: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:configuration-action",
      execute: writeConfiguration,
    }),
    configurationStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:configuration-status",
      tag: WS_METHODS.workflowConfigurationStatus,
    }),
    readCatalog: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:read-catalog",
      tag: WS_METHODS.workflowCatalog,
    }),
    readRun: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:read-run",
      tag: WS_METHODS.workflowReadRun,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:action",
      tag: WS_METHODS.workflowAction,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(
            catalog({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          );
        }),
    }),
    stagePreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:stage-preview",
      tag: WS_METHODS.workflowStagePreview,
    }),
    dispatchStage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:dispatch-stage",
      tag: WS_METHODS.workflowDispatchStage,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(
            catalog({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          );
        }),
    }),
    proposeArtifact: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:propose-artifact",
      tag: WS_METHODS.workflowProposeArtifact,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(
            catalog({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          );
        }),
    }),
  };
}
