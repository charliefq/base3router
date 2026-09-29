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
import { cursorCloudAgentIdFromDispatch } from "./CursorCloudAgentId.ts";
import { cursorCloudError, type CursorCloudError } from "./CursorCloudErrors.ts";
import { runCursorCloudCommandOnce, type CursorCloudOutbox } from "./CursorCloudOutbox.ts";

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

const runRemoteOnce = async (
  outbox: CursorCloudOutbox,
  commandId: string,
  intent: Parameters<CursorCloudOutbox["claim"]>[0],
  remote: () => Promise<CursorCloudRunnerBinding>,
): Promise<CursorCloudRunnerBinding> =>
  runCursorCloudCommandOnce(commandId, async () => {
    const claimed = await outbox.claim(intent);
    if (claimed.state === "completed") return claimed.binding;
    const binding = await remote();
    await outbox.complete(commandId, binding);
    return binding;
  });

export const createCursorCloudStageBinding = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly outbox: CursorCloudOutbox;
  readonly configured: boolean;
  readonly gate: ActionGateResult;
  readonly routeBinding: DispatcherTaskRouteBinding | null;
  readonly target: CursorCloudExecutionTarget | undefined;
  readonly prompt: string;
  readonly at: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly dispatchId: string;
}): Promise<CursorCloudRunnerBinding> => {
  const payload = assertCursorCloudDispatch(input);
  const commandId = `cursor-create-${input.dispatchId}`;
  const cursorAgentId = cursorCloudAgentIdFromDispatch({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    dispatchId: input.dispatchId,
  });
  return runRemoteOnce(
    input.outbox,
    commandId,
    {
      commandId,
      kind: "create",
      cursorAgentId,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      dispatchId: input.dispatchId,
    },
    () =>
      input.adapter.createAgent({
        prompt: input.prompt,
        agentId: cursorAgentId,
        target: payload.target,
        provider: payload.provider,
        dispatcherModel: payload.model,
        at: input.at,
      }),
  );
};

export const followUpCursorCloudStage = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly outbox: CursorCloudOutbox;
  readonly gate: ActionGateResult;
  readonly binding: CursorCloudRunnerBinding;
  readonly prompt: string;
  readonly at: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly commandId: string;
}): Promise<CursorCloudRunnerBinding> => {
  requireActionGateAllow(input.gate);
  const cursorAgentId = input.binding.cursorAgentId;
  if (cursorAgentId === undefined) {
    throw cursorCloudError("rejected", "A durable Cursor agent is required before a follow-up.");
  }
  return runRemoteOnce(
    input.outbox,
    input.commandId,
    {
      commandId: input.commandId,
      kind: "follow-up",
      cursorAgentId,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
    },
    () =>
      input.adapter.createFollowUpRun({
        binding: input.binding,
        prompt: input.prompt,
        at: input.at,
      }),
  );
};

export const cancelCursorCloudStage = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly outbox: CursorCloudOutbox;
  readonly gate: ActionGateResult;
  readonly binding: CursorCloudRunnerBinding;
  readonly at: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly commandId: string;
}): Promise<CursorCloudRunnerBinding> => {
  requireActionGateAllow(input.gate);
  const cursorAgentId = input.binding.cursorAgentId;
  if (cursorAgentId === undefined) {
    throw cursorCloudError("rejected", "A Cursor run is required before cancellation.");
  }
  return runRemoteOnce(
    input.outbox,
    input.commandId,
    {
      commandId: input.commandId,
      kind: "cancel",
      cursorAgentId,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
    },
    () =>
      input.adapter.cancelRun({
        binding: input.binding,
        at: input.at,
      }),
  );
};

export const toWorkflowCursorCloudErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as CursorCloudError;
    if (tagged._tag === "CursorCloudError") return tagged.message;
  }
  return "Cursor Cloud request failed.";
};
