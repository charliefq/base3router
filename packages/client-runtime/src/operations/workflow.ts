import {
  WS_METHODS,
  type WorkflowActionInput,
  type WorkflowCursorCloudCancelInput,
  type WorkflowCursorCloudFollowUpInput,
  type WorkflowCursorCloudRefreshInput,
  type WorkflowDispatchStageInput,
  type WorkflowProposeArtifactInput,
  type WorkflowReadInput,
  type WorkflowReadRunInput,
  type WorkflowStagePreviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

export const catalog = Effect.fn("EnvironmentWorkflow.catalog")(function* (
  input: typeof WorkflowReadInput.Type,
) {
  return yield* request(WS_METHODS.workflowCatalog, input);
});

export const readRun = Effect.fn("EnvironmentWorkflow.readRun")(function* (
  input: typeof WorkflowReadRunInput.Type,
) {
  return yield* request(WS_METHODS.workflowReadRun, input);
});

export const action = Effect.fn("EnvironmentWorkflow.action")(function* (
  input: WorkflowActionInput,
) {
  return yield* request(WS_METHODS.workflowAction, input);
});

export const previewStage = Effect.fn("EnvironmentWorkflow.previewStage")(function* (
  input: typeof WorkflowStagePreviewInput.Type,
) {
  return yield* request(WS_METHODS.workflowStagePreview, input);
});

export const dispatchStage = Effect.fn("EnvironmentWorkflow.dispatchStage")(function* (
  input: typeof WorkflowDispatchStageInput.Type,
) {
  return yield* request(WS_METHODS.workflowDispatchStage, input);
});

export const proposeArtifact = Effect.fn("EnvironmentWorkflow.proposeArtifact")(function* (
  input: typeof WorkflowProposeArtifactInput.Type,
) {
  return yield* request(WS_METHODS.workflowProposeArtifact, input);
});

export const cursorCloudFollowUp = Effect.fn("EnvironmentWorkflow.cursorCloudFollowUp")(function* (
  input: WorkflowCursorCloudFollowUpInput,
) {
  return yield* request(WS_METHODS.workflowCursorCloudFollowUp, input);
});

export const cursorCloudCancel = Effect.fn("EnvironmentWorkflow.cursorCloudCancel")(function* (
  input: WorkflowCursorCloudCancelInput,
) {
  return yield* request(WS_METHODS.workflowCursorCloudCancel, input);
});

export const cursorCloudRefresh = Effect.fn("EnvironmentWorkflow.cursorCloudRefresh")(function* (
  input: WorkflowCursorCloudRefreshInput,
) {
  return yield* request(WS_METHODS.workflowCursorCloudRefresh, input);
});
