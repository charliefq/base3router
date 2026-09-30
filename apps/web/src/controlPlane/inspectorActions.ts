import {
  cursorCloudCancelDisabled,
  cursorCloudFollowUpDisabled,
} from "@t3tools/client-runtime/cursor-cloud";
import type { CursorCloudRunnerBinding } from "@t3tools/contracts";

export type InspectorActionState = {
  readonly available: boolean;
  readonly enabled: boolean;
};

export type CursorCloudInspectorActions = {
  readonly readOnly: boolean;
  readonly followUp: InspectorActionState;
  readonly cancel: InspectorActionState;
  readonly refresh: InspectorActionState;
  readonly followUpEditable: boolean;
};

export type CursorCloudInspectorActionHandlers = {
  readonly onFollowUp?: () => void;
  readonly onCancel?: () => void;
  readonly onRefresh?: () => void;
  readonly onFollowUpChange?: (value: string) => void;
};

/**
 * Mutation controls are available only when a real handler exists. Missing
 * handlers produce a read-only inspector; they never become enabled no-ops.
 */
export function resolveCursorCloudInspectorActions(input: {
  readonly binding: CursorCloudRunnerBinding | null | undefined;
  readonly busy: boolean;
  readonly followUp: string;
  readonly handlers: CursorCloudInspectorActionHandlers;
}): CursorCloudInspectorActions {
  const binding = input.binding ?? undefined;
  const followUpAvailable = binding !== undefined && input.handlers.onFollowUp !== undefined;
  const cancelAvailable = binding !== undefined && input.handlers.onCancel !== undefined;
  const refreshAvailable = binding !== undefined && input.handlers.onRefresh !== undefined;
  const followUpEditable = binding !== undefined && input.handlers.onFollowUpChange !== undefined;
  const anyMutation = followUpAvailable || cancelAvailable || refreshAvailable || followUpEditable;

  return {
    readOnly: binding !== undefined && !anyMutation,
    followUp: {
      available: followUpAvailable,
      enabled:
        followUpAvailable &&
        !input.busy &&
        !cursorCloudFollowUpDisabled(binding) &&
        input.followUp.trim().length > 0,
    },
    cancel: {
      available: cancelAvailable,
      enabled: cancelAvailable && !input.busy && !cursorCloudCancelDisabled(binding),
    },
    refresh: {
      available: refreshAvailable,
      enabled: refreshAvailable && !input.busy,
    },
    followUpEditable,
  };
}
