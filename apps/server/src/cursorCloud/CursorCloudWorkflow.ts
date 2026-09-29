import {
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  type ActionGateResult,
  type CursorCloudDispatchPreview,
  type CursorCloudExecutionTarget,
  type CursorCloudImmutableDispatchPayload,
  type CursorCloudRunnerBinding,
  type DispatcherTaskRouteBinding,
  type ProviderDriverKind,
} from "@t3tools/contracts";

import type { CursorCloudAdapter } from "./CursorCloudAdapter.ts";
import { cursorCloudError, type CursorCloudError } from "./CursorCloudErrors.ts";

export const requireActionGateAllow = (gate: ActionGateResult): void => {
  if (gate.decision !== "ALLOW") {
    throw cursorCloudError("rejected", "ActionGate denied this Cursor Cloud operation.");
  }
};

export const cursorCloudDispatchPreview = (input: {
  readonly available: boolean;
  readonly configured: boolean;
  readonly gate: ActionGateResult;
  readonly provider: ProviderDriverKind | null;
  readonly model: string | null;
  readonly target: CursorCloudExecutionTarget | null;
}): CursorCloudDispatchPreview => {
  const ready =
    input.available &&
    input.configured &&
    input.gate.decision === "ALLOW" &&
    input.provider !== null &&
    input.model !== null &&
    input.target !== null;
  const payload: CursorCloudImmutableDispatchPayload | null = ready
    ? {
        runnerKind: "cursor-cloud",
        provider: input.provider,
        model: input.model,
        target: input.target,
        workOnCurrentBranch: false,
        autoCreatePR: false,
        credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
      }
    : null;
  return {
    available: input.available,
    configured: input.configured,
    target: input.target,
    payload,
    gate: input.gate,
  };
};

export const assertCursorCloudDispatch = (input: {
  readonly configured: boolean;
  readonly gate: ActionGateResult;
  readonly routeBinding: DispatcherTaskRouteBinding | null;
  readonly target: CursorCloudExecutionTarget | undefined;
}): CursorCloudImmutableDispatchPayload => {
  if (!input.configured) {
    throw cursorCloudError("unconfigured", "Cursor Cloud is not configured on this server.");
  }
  requireActionGateAllow(input.gate);
  if (input.routeBinding === null || input.target === undefined) {
    throw cursorCloudError(
      "rejected",
      "Repository, starting ref, runner target, or credential reference is missing.",
    );
  }
  return {
    runnerKind: "cursor-cloud",
    provider: input.routeBinding.driver,
    model: input.routeBinding.target.model,
    target: input.target,
    workOnCurrentBranch: false,
    autoCreatePR: false,
    credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  };
};

export const createCursorCloudStageBinding = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly configured: boolean;
  readonly gate: ActionGateResult;
  readonly routeBinding: DispatcherTaskRouteBinding | null;
  readonly target: CursorCloudExecutionTarget | undefined;
  readonly prompt: string;
  readonly at: string;
}): Promise<CursorCloudRunnerBinding> => {
  const payload = assertCursorCloudDispatch(input);
  return input.adapter.createAgent({
    prompt: input.prompt,
    model: payload.model,
    target: payload.target,
    provider: payload.provider,
    at: input.at,
  });
};

export const followUpCursorCloudStage = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly gate: ActionGateResult;
  readonly binding: CursorCloudRunnerBinding;
  readonly prompt: string;
  readonly at: string;
}): Promise<CursorCloudRunnerBinding> => {
  requireActionGateAllow(input.gate);
  return input.adapter.createFollowUpRun({
    binding: input.binding,
    prompt: input.prompt,
    at: input.at,
  });
};

export const cancelCursorCloudStage = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly gate: ActionGateResult;
  readonly binding: CursorCloudRunnerBinding;
  readonly at: string;
}): Promise<CursorCloudRunnerBinding> => {
  requireActionGateAllow(input.gate);
  return input.adapter.cancelRun({
    binding: input.binding,
    at: input.at,
  });
};

export const toWorkflowCursorCloudErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as CursorCloudError;
    if (tagged._tag === "CursorCloudError") return tagged.message;
  }
  return "Cursor Cloud request failed.";
};
