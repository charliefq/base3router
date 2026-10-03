import {
  ACTION_GATE_POLICY_VERSION,
  MODEL_ROUTER_UNKNOWN_METRIC,
  type ActionApprovalId,
  type ActionAuditEventKind,
  type ActionAuditEventV0,
  type ActionFingerprint,
  type ActionGateDecisionKind,
  type ActionGateReasonCode,
  type ActionId,
  type ActionOutcomeClass,
  type EnvironmentId,
} from "@t3tools/contracts";

import { digestCanonical } from "./actionCanonical.ts";

const SECRET_SHAPED =
  /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|OPENROUTER_API_KEY\s*=|CURSOR_API_KEY\s*=|api[_-]?key\s*[=:]|Authorization\s*:/i;

export const ACTION_AUDIT_REDACTION = "[redacted]";

export const redactSecretShapedText = (value: string): string =>
  SECRET_SHAPED.test(value) ? ACTION_AUDIT_REDACTION : value;

export const serializedOmitsSecrets = (value: unknown): boolean => {
  if (typeof value === "string") return !SECRET_SHAPED.test(value);
  if (Array.isArray(value)) return value.every(serializedOmitsSecrets);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) =>
        !/authorization|api[_-]?key|secret|token|password|credential/i.test(key) &&
        serializedOmitsSecrets(entry),
    );
  }
  return true;
};

export const argumentSummary = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return redactSecretShapedText(String(value));
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, 8);
  return keys
    .map((key) => {
      const entry = record[key];
      if (typeof entry === "string") return `${key}=${redactSecretShapedText(entry).slice(0, 48)}`;
      if (typeof entry === "number" || typeof entry === "boolean") return `${key}=${String(entry)}`;
      return `${key}=[complex]`;
    })
    .join(", ");
};

export const makeActionAuditEvent = (input: {
  readonly kind: ActionAuditEventKind;
  readonly at: string;
  readonly environmentId: EnvironmentId;
  readonly planId: string;
  readonly actionId?: ActionId;
  readonly decision?: ActionGateDecisionKind;
  readonly outcome?: ActionOutcomeClass;
  readonly reasonCodes?: ReadonlyArray<ActionGateReasonCode>;
  readonly fingerprint?: ActionFingerprint;
  readonly approvalId?: ActionApprovalId;
}): ActionAuditEventV0 => ({
  eventId: digestCanonical({
    kind: input.kind,
    at: input.approvalId === undefined ? input.at : "stable",
    planId: input.planId,
    actionId: input.actionId ?? null,
    approvalId: input.approvalId ?? null,
  }).slice(0, 32),
  kind: input.kind,
  at: input.at,
  environmentId: input.environmentId,
  planId: input.planId,
  reasonCodes: [...(input.reasonCodes ?? [])].slice(0, 16),
  policyVersion: ACTION_GATE_POLICY_VERSION,
  cost: MODEL_ROUTER_UNKNOWN_METRIC,
  ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
  ...(input.decision !== undefined ? { decision: input.decision } : {}),
  ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
  ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
});
