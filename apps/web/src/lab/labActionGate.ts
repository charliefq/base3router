import type { InspectorApprovalModel } from "~/controlPlane/presentActionApproval";

import type { ActionApprovalDecision } from "~/components/controlPlane/ActionApprovalControls";

export type LabApprovalResult = {
  readonly approval: InspectorApprovalModel;
  readonly error: string | null;
  readonly toolExecutions: number;
};

export function applyLabApprovalDecision(
  approval: InspectorApprovalModel,
  decision: ActionApprovalDecision,
): LabApprovalResult {
  if (approval.status !== "pending") {
    return {
      approval,
      error:
        approval.status === "consumed"
          ? "One-time approval already consumed."
          : `Approval is already ${approval.status}.`,
      toolExecutions: 0,
    };
  }
  if (decision === "grant") {
    return {
      approval: { ...approval, status: "consumed" },
      error: null,
      toolExecutions: 1,
    };
  }
  return {
    approval: {
      ...approval,
      status: decision === "deny" ? "denied" : "cancelled",
    },
    error: null,
    toolExecutions: 0,
  };
}
