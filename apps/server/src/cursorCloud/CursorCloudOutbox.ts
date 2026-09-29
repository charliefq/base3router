import type { CursorCloudRunnerBinding } from "@t3tools/contracts";

export type CursorCloudOperationKind = "create" | "follow-up" | "cancel";

export type CursorCloudOperationIntent = {
  readonly commandId: string;
  readonly kind: CursorCloudOperationKind;
  readonly cursorAgentId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly dispatchId?: string;
};

export type CursorCloudOutboxRecord =
  | { readonly state: "pending"; readonly intent: CursorCloudOperationIntent }
  | {
      readonly state: "completed";
      readonly intent: CursorCloudOperationIntent;
      readonly binding: CursorCloudRunnerBinding;
    };

export type CursorCloudOutbox = {
  claim(intent: CursorCloudOperationIntent): Promise<CursorCloudOutboxRecord>;
  complete(commandId: string, binding: CursorCloudRunnerBinding): Promise<void>;
};

const cloneIntent = (intent: CursorCloudOperationIntent): CursorCloudOperationIntent => ({
  ...intent,
});

export const makeMemoryCursorCloudOutbox = (): CursorCloudOutbox => {
  const records = new Map<string, CursorCloudOutboxRecord>();
  return {
    async claim(intent) {
      const existing = records.get(intent.commandId);
      if (existing) return existing;
      const pending: CursorCloudOutboxRecord = { state: "pending", intent: cloneIntent(intent) };
      records.set(intent.commandId, pending);
      return pending;
    },
    async complete(commandId, binding) {
      const existing = records.get(commandId);
      if (existing === undefined) {
        throw new Error(`Cursor Cloud outbox is missing command ${commandId}.`);
      }
      records.set(commandId, {
        state: "completed",
        intent: existing.intent,
        binding,
      });
    },
  };
};

const inflight = new Map<string, Promise<CursorCloudRunnerBinding>>();

export const runCursorCloudCommandOnce = (
  commandId: string,
  run: () => Promise<CursorCloudRunnerBinding>,
): Promise<CursorCloudRunnerBinding> => {
  const existing = inflight.get(commandId);
  if (existing) return existing;
  const promise = run().finally(() => {
    inflight.delete(commandId);
  });
  inflight.set(commandId, promise);
  return promise;
};
