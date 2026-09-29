import * as NodeCrypto from "node:crypto";
import type { CursorCloudRunnerBinding } from "@t3tools/contracts";

import { cursorCloudError } from "./CursorCloudErrors.ts";

export type CursorCloudOperationKind = "create" | "follow-up" | "cancel";
export type CursorCloudOperationState = "pending" | "completed" | "indeterminate";

export type CursorCloudOperationIntent = {
  readonly commandId: string;
  readonly kind: CursorCloudOperationKind;
  readonly environmentId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly cursorAgentId: string;
  readonly requestFingerprint: string;
  readonly dispatchId?: string;
  readonly previousRunId?: string;
  readonly claimedAt?: string;
};

export type CursorCloudOutboxRecord =
  | { readonly state: "accepted"; readonly intent: CursorCloudOperationIntent }
  | { readonly state: "pending"; readonly intent: CursorCloudOperationIntent }
  | {
      readonly state: "completed";
      readonly intent: CursorCloudOperationIntent;
      readonly binding: CursorCloudRunnerBinding;
    }
  | { readonly state: "indeterminate"; readonly intent: CursorCloudOperationIntent };

export type CursorCloudOutbox = {
  claim(intent: CursorCloudOperationIntent): Promise<CursorCloudOutboxRecord>;
  complete(intent: CursorCloudOperationIntent, binding: CursorCloudRunnerBinding): Promise<void>;
  markIndeterminate(intent: CursorCloudOperationIntent): Promise<void>;
};

const SEPARATOR = "\u001f";

export const cursorCloudIdempotencyToken = (intent: CursorCloudOperationIntent): string =>
  intent.kind === "create" ? (intent.dispatchId ?? intent.commandId) : intent.commandId;

export const cursorCloudOperationKey = (intent: CursorCloudOperationIntent): string =>
  [
    intent.kind,
    intent.environmentId,
    intent.projectId,
    intent.runId,
    intent.stageId,
    String(intent.attempt),
    cursorCloudIdempotencyToken(intent),
  ].join(SEPARATOR);

export const cursorCloudRequestFingerprint = (input: {
  readonly kind: CursorCloudOperationKind;
  readonly cursorAgentId: string;
  readonly prompt?: string;
  readonly previousRunId?: string;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(
      [input.kind, input.cursorAgentId, input.previousRunId ?? "", input.prompt ?? ""].join(
        SEPARATOR,
      ),
    )
    .digest("hex");

export const cloneCursorCloudIntent = (
  intent: CursorCloudOperationIntent,
): CursorCloudOperationIntent => ({
  ...intent,
});

const optionalValue = (value: string | undefined): string => value ?? "";

export const cursorCloudIntentConflicts = (
  stored: CursorCloudOperationIntent,
  incoming: CursorCloudOperationIntent,
): boolean =>
  stored.kind !== incoming.kind ||
  stored.environmentId !== incoming.environmentId ||
  stored.projectId !== incoming.projectId ||
  stored.runId !== incoming.runId ||
  stored.stageId !== incoming.stageId ||
  stored.attempt !== incoming.attempt ||
  stored.commandId !== incoming.commandId ||
  optionalValue(stored.dispatchId) !== optionalValue(incoming.dispatchId) ||
  stored.cursorAgentId !== incoming.cursorAgentId ||
  optionalValue(stored.previousRunId) !== optionalValue(incoming.previousRunId) ||
  stored.requestFingerprint !== incoming.requestFingerprint;

export const cursorCloudCommandConflict = () =>
  cursorCloudError("command_conflict", "Cursor Cloud command conflicts with a stored operation.");

export const cursorCloudIndeterminateError = () =>
  cursorCloudError("indeterminate", "Cursor Cloud operation needs a refresh before retry.");

export const makeMemoryCursorCloudOutbox = (): CursorCloudOutbox => {
  const records = new Map<string, CursorCloudOutboxRecord>();
  return {
    async claim(intent) {
      const key = cursorCloudOperationKey(intent);
      const existing = records.get(key);
      if (existing) {
        if (cursorCloudIntentConflicts(existing.intent, intent)) {
          throw cursorCloudCommandConflict();
        }
        return existing;
      }
      const pending: CursorCloudOutboxRecord = {
        state: "accepted",
        intent: cloneCursorCloudIntent(intent),
      };
      records.set(key, { ...pending, state: "pending" });
      return pending;
    },
    async complete(intent, binding) {
      const key = cursorCloudOperationKey(intent);
      const existing = records.get(key);
      if (existing === undefined) {
        throw new Error(`Cursor Cloud outbox is missing operation ${key}.`);
      }
      records.set(key, {
        state: "completed",
        intent: existing.intent,
        binding,
      });
    },
    async markIndeterminate(intent) {
      const key = cursorCloudOperationKey(intent);
      const existing = records.get(key);
      if (existing === undefined) {
        throw new Error(`Cursor Cloud outbox is missing operation ${key}.`);
      }
      records.set(key, { state: "indeterminate", intent: existing.intent });
    },
  };
};

const inflight = new Map<string, Promise<CursorCloudRunnerBinding>>();

export const runCursorCloudCommandOnce = (
  operationKey: string,
  run: () => Promise<CursorCloudRunnerBinding>,
): Promise<CursorCloudRunnerBinding> => {
  const existing = inflight.get(operationKey);
  if (existing) return existing;
  const promise = run().finally(() => {
    inflight.delete(operationKey);
  });
  inflight.set(operationKey, promise);
  return promise;
};
