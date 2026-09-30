import type {
  WorkflowActionInput,
  WorkflowDispatchStageInput,
  WorkflowProposeArtifactInput,
  WorkflowReadInput,
  WorkflowReadRunInput,
  WorkflowStagePreviewInput,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Workflow from "../operations/workflow.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export function createWorkflowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    catalog: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:catalog",
      execute: (input: typeof WorkflowReadInput.Type) => Workflow.catalog(input),
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.projectId}`,
      },
    }),
    readRun: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:read-run",
      execute: (input: typeof WorkflowReadRunInput.Type) => Workflow.readRun(input),
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.runId}`,
      },
    }),
    action: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:action",
      execute: (input: WorkflowActionInput) => Workflow.action(input),
      scheduler,
    }),
    previewStage: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:preview-stage",
      execute: (input: typeof WorkflowStagePreviewInput.Type) => Workflow.previewStage(input),
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.runId}`,
      },
    }),
    dispatchStage: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:dispatch-stage",
      execute: (input: typeof WorkflowDispatchStageInput.Type) => Workflow.dispatchStage(input),
      scheduler,
    }),
    proposeArtifact: createEnvironmentCommand(runtime, {
      label: "environment-data:workflow:propose-artifact",
      execute: (input: typeof WorkflowProposeArtifactInput.Type) => Workflow.proposeArtifact(input),
      scheduler,
    }),
  };
}
