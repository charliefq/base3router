import type { ActionApprovalRecord } from "@t3tools/contracts";

import { sanitizeDisplayText } from "./sanitizeDisplayText";

export type InspectorApprovalModel = {
  readonly approvalId: string;
  readonly status: string;
  readonly reuse: string;
  readonly expiresAt: string | null;
  readonly oneTime: boolean;
  readonly actionType: string;
  readonly destination: string;
  readonly argumentSummary: string;
  readonly riskClass: string;
  readonly sideEffectClass: string;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly scope: string;
  readonly fingerprint: string;
  readonly askReason: string;
};

export function presentActionApproval(record: ActionApprovalRecord): InspectorApprovalModel {
  const toolName = record.toolId.includes("/")
    ? record.toolId.slice(record.toolId.lastIndexOf("/") + 1)
    : record.toolId;
  return {
    approvalId: record.approvalId,
    status: record.status,
    reuse: record.reusePolicy,
    expiresAt: record.expiresAt,
    oneTime: record.reusePolicy === "one-time",
    actionType: toolName,
    destination: `${record.serverId} / ${toolName}`,
    argumentSummary: sanitizeDisplayText(record.argumentSummary ?? "none") ?? "none",
    riskClass: record.riskClass ?? "unclassified",
    sideEffectClass: record.sideEffectClass ?? "unknown",
    environmentId: record.environmentId,
    projectId: record.projectId ?? null,
    threadId: record.threadId ?? null,
    scope: record.scope,
    fingerprint: record.fingerprint.slice(0, 12),
    askReason: record.askExplanation ?? record.reasonCodes.join(", "),
  };
}
