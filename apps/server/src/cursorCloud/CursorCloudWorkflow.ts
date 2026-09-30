import {
  CURSOR_CLOUD_CREDENTIAL_REFERENCE,
  emptyCursorCloudBinding,
  isCursorCloudFollowUpReady,
  isCursorCloudRunTerminal,
  mapCursorAgentStatus,
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
import {
  cursorCloudError,
  isCursorCloudError,
  type CursorCloudError,
} from "./CursorCloudErrors.ts";
import {
  cursorCloudIndeterminateError,
  cursorCloudOperationKey,
  cursorCloudRejectedError,
  cursorCloudRequestFingerprint,
  runCursorCloudCommandOnce,
  type CursorCloudOperationIntent,
  type CursorCloudOutbox,
} from "./CursorCloudOutbox.ts";
import type { CursorCloudBetaRun } from "./beta/schemas.ts";

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

const CLAIMED_AT_SKEW_MS = 60_000;

export type FollowUpReconciliation =
  | { readonly outcome: "unique"; readonly run: CursorCloudBetaRun }
  | { readonly outcome: "none" }
  | { readonly outcome: "ambiguous" };

const reconcileFollowUpRun = (
  runs: ReadonlyArray<CursorCloudBetaRun>,
  input: {
    readonly previousRunId?: string;
    readonly claimedAt?: string;
  },
): FollowUpReconciliation => {
  const claimedMs = input.claimedAt === undefined ? Number.NaN : Date.parse(input.claimedAt);
  const candidates = runs.filter((run) => {
    if (input.previousRunId !== undefined && run.id === input.previousRunId) return false;
    if (!Number.isFinite(claimedMs) || run.createdAt === undefined) return true;
    const createdMs = Date.parse(run.createdAt);
    if (!Number.isFinite(createdMs)) return true;
    return createdMs >= claimedMs - CLAIMED_AT_SKEW_MS;
  });
  if (candidates.length === 1) {
    const run = candidates[0];
    if (run !== undefined) return { outcome: "unique", run };
  }
  return candidates.length === 0 ? { outcome: "none" } : { outcome: "ambiguous" };
};

const markIndeterminate = async (
  outbox: CursorCloudOutbox,
  intent: CursorCloudOperationIntent,
): Promise<never> => {
  await outbox.markIndeterminate(intent);
  throw cursorCloudIndeterminateError();
};

const executeCursorCloudOperation = async (input: {
  readonly outbox: CursorCloudOutbox;
  readonly intent: CursorCloudOperationIntent;
  readonly executeAccepted: () => Promise<CursorCloudRunnerBinding>;
  readonly reconcilePending: (
    stored: CursorCloudOperationIntent,
  ) => Promise<CursorCloudRunnerBinding | "retry">;
}): Promise<CursorCloudRunnerBinding> =>
  runCursorCloudCommandOnce(cursorCloudOperationKey(input.intent), async () => {
    const persistAccepted = async () => {
      try {
        const binding = await input.executeAccepted();
        await input.outbox.complete(input.intent, binding);
        return binding;
      } catch (cause) {
        if (isCursorCloudError(cause) && cause.code === "agent_busy" && cause.httpStatus === 409) {
          await input.outbox.markRejected(input.intent, {
            code: cause.code,
            message: cause.message,
          });
        }
        throw cause;
      }
    };
    const claimed = await input.outbox.claim(input.intent);
    if (claimed.state === "completed") return claimed.binding;
    if (claimed.state === "indeterminate") throw cursorCloudIndeterminateError();
    if (claimed.state === "rejected") throw cursorCloudRejectedError(claimed.error);
    if (claimed.state === "pending") {
      const reconciled = await input.reconcilePending(claimed.intent);
      if (reconciled === "retry") return persistAccepted();
      await input.outbox.complete(input.intent, reconciled);
      return reconciled;
    }
    return persistAccepted();
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
  readonly environmentId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly dispatchId: string;
}): Promise<CursorCloudRunnerBinding> => {
  const payload = assertCursorCloudDispatch(input);
  const cursorAgentId = cursorCloudAgentIdFromDispatch({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    dispatchId: input.dispatchId,
  });
  const intent: CursorCloudOperationIntent = {
    commandId: `cursor-create-${input.dispatchId}`,
    kind: "create",
    environmentId: input.environmentId,
    projectId: input.projectId,
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    cursorAgentId,
    requestFingerprint: cursorCloudRequestFingerprint({
      kind: "create",
      cursorAgentId,
      prompt: input.prompt,
    }),
    dispatchId: input.dispatchId,
    claimedAt: input.at,
  };
  const seedBinding = emptyCursorCloudBinding({
    provider: payload.provider,
    model: payload.model,
    target: payload.target,
    at: input.at,
  });
  const executeAccepted = () =>
    input.adapter.createAgent({
      prompt: input.prompt,
      agentId: cursorAgentId,
      target: payload.target,
      provider: payload.provider,
      dispatcherModel: payload.model,
      at: input.at,
    });
  return executeCursorCloudOperation({
    outbox: input.outbox,
    intent,
    executeAccepted,
    reconcilePending: async () => {
      try {
        const agent = await input.adapter.getAgent(cursorAgentId);
        const run =
          agent.latestRunId === undefined
            ? undefined
            : await input.adapter.getRun(cursorAgentId, agent.latestRunId);
        const observed = {
          ...seedBinding,
          cursorAgentId: agent.id,
          cursorAgentStatus: agent.status,
          status: mapCursorAgentStatus(agent.status),
          updatedAt: input.at,
          ...(agent.url === undefined ? {} : { cursorAgentUrl: agent.url }),
        };
        if (run === undefined) return observed;
        return input.adapter.applyObservedRun({
          binding: observed,
          run,
          at: input.at,
        });
      } catch (cause) {
        if (isCursorCloudError(cause) && cause.code === "not_found") return "retry";
        return markIndeterminate(input.outbox, intent);
      }
    },
  });
};

export const followUpCursorCloudStage = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly outbox: CursorCloudOutbox;
  readonly gate: ActionGateResult;
  readonly binding: CursorCloudRunnerBinding;
  readonly prompt: string;
  readonly at: string;
  readonly environmentId: string;
  readonly projectId: string;
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
  if (!isCursorCloudFollowUpReady(input.binding)) {
    throw cursorCloudError("agent_busy", "The Cursor agent is busy with another run.");
  }
  const previousRunId = input.binding.cursorRunId;
  const intent: CursorCloudOperationIntent = {
    commandId: input.commandId,
    kind: "follow-up",
    environmentId: input.environmentId,
    projectId: input.projectId,
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    cursorAgentId,
    requestFingerprint: cursorCloudRequestFingerprint({
      kind: "follow-up",
      cursorAgentId,
      prompt: input.prompt,
      ...(previousRunId === undefined ? {} : { previousRunId }),
    }),
    claimedAt: input.at,
    ...(previousRunId === undefined ? {} : { previousRunId }),
  };
  const executeAccepted = () => {
    if (!isCursorCloudFollowUpReady(input.binding)) {
      throw cursorCloudError("agent_busy", "The Cursor agent is busy with another run.");
    }
    return input.adapter.createFollowUpRun({
      binding: input.binding,
      prompt: input.prompt,
      at: input.at,
    });
  };
  return executeCursorCloudOperation({
    outbox: input.outbox,
    intent,
    executeAccepted,
    reconcilePending: async (stored) => {
      try {
        const listed = await input.adapter.listRunsUntil(cursorAgentId, {
          ...(stored.previousRunId === undefined ? {} : { previousRunId: stored.previousRunId }),
          ...(stored.claimedAt === undefined ? {} : { claimedAt: stored.claimedAt }),
        });
        const match = reconcileFollowUpRun(listed.items, {
          ...(stored.previousRunId === undefined ? {} : { previousRunId: stored.previousRunId }),
          ...(stored.claimedAt === undefined ? {} : { claimedAt: stored.claimedAt }),
        });
        if (match.outcome === "unique" && listed.reachedBoundary) {
          return input.adapter.applyObservedRun({
            binding: input.binding,
            run: match.run,
            at: input.at,
          });
        }
        return markIndeterminate(input.outbox, intent);
      } catch (cause) {
        if (isCursorCloudError(cause) && cause.code === "indeterminate") throw cause;
        return markIndeterminate(input.outbox, intent);
      }
    },
  });
};

export const cancelCursorCloudStage = async (input: {
  readonly adapter: CursorCloudAdapter;
  readonly outbox: CursorCloudOutbox;
  readonly gate: ActionGateResult;
  readonly binding: CursorCloudRunnerBinding;
  readonly at: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly commandId: string;
}): Promise<CursorCloudRunnerBinding> => {
  requireActionGateAllow(input.gate);
  const cursorAgentId = input.binding.cursorAgentId;
  const cursorRunId = input.binding.cursorRunId;
  if (cursorAgentId === undefined || cursorRunId === undefined) {
    throw cursorCloudError("rejected", "A Cursor run is required before cancellation.");
  }
  const intent: CursorCloudOperationIntent = {
    commandId: input.commandId,
    kind: "cancel",
    environmentId: input.environmentId,
    projectId: input.projectId,
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    cursorAgentId,
    requestFingerprint: cursorCloudRequestFingerprint({
      kind: "cancel",
      cursorAgentId,
      previousRunId: cursorRunId,
    }),
    previousRunId: cursorRunId,
    claimedAt: input.at,
  };
  const executeAccepted = () =>
    input.adapter.cancelRun({
      binding: input.binding,
      at: input.at,
    });
  return executeCursorCloudOperation({
    outbox: input.outbox,
    intent,
    executeAccepted,
    reconcilePending: async () => {
      try {
        const run = await input.adapter.getRun(cursorAgentId, cursorRunId);
        if (isCursorCloudRunTerminal(run.status)) {
          return input.adapter.applyObservedRun({
            binding: input.binding,
            run,
            at: input.at,
          });
        }
        return "retry";
      } catch (cause) {
        if (isCursorCloudError(cause) && cause.code === "indeterminate") throw cause;
        return markIndeterminate(input.outbox, intent);
      }
    },
  });
};

export const toWorkflowCursorCloudErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as CursorCloudError;
    if (tagged._tag === "CursorCloudError") return tagged.message;
  }
  return "Cursor Cloud request failed.";
};
