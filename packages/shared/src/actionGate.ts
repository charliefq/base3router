import {
  ACTION_GATE_POLICY_VERSION,
  ActionFingerprint,
  ActionIdempotencyKey,
  type ActionApprovalId,
  type ActionApprovalRecord,
  type ActionApprovalReusePolicy,
  type ActionApprovalStatus,
  type ActionGateDecision,
  type ActionGateDecisionKind,
  type ActionGateReasonCode,
  type ActionIdempotencyKey as ActionIdempotencyKeyType,
  type ActionRiskClass,
  type EnvironmentId,
  type ExecutionPlanV0,
  type PlannedActionV0,
  type ProjectId,
  type SideEffectClass,
  type ThreadId,
} from "@t3tools/contracts";

import { digestCanonical } from "./actionCanonical.ts";

export const HIGH_RISK_CLASSES: ReadonlySet<ActionRiskClass> = new Set([
  "destructive",
  "financial",
  "credential",
  "administrative",
]);

export const TERMINAL_APPROVAL_STATUSES: ReadonlySet<ActionApprovalStatus> = new Set([
  "denied",
  "expired",
  "cancelled",
  "consumed",
  "invalidated",
]);

export const askIdempotencyKey = (fingerprint: ActionFingerprint): ActionIdempotencyKeyType =>
  ActionIdempotencyKey.make(`ask:${fingerprint}`);

export const defaultDecisionForRisk = (input: {
  readonly riskClass: ActionRiskClass;
  readonly sideEffectClass: SideEffectClass;
  readonly mayExposeSecrets?: boolean;
}): {
  readonly decision: ActionGateDecisionKind;
  readonly reasonCodes: ReadonlyArray<ActionGateReasonCode>;
} => {
  if (input.riskClass === "unclassified" || input.sideEffectClass === "unknown") {
    return { decision: "ASK", reasonCodes: ["APPROVAL_REQUIRED", "UNCLASSIFIED_SIDE_EFFECT"] };
  }
  if (HIGH_RISK_CLASSES.has(input.riskClass)) {
    return {
      decision: "ASK",
      reasonCodes: ["APPROVAL_REQUIRED", "HIGH_RISK_DEFAULT", "BASELINE_SAFETY"],
    };
  }
  if (input.mayExposeSecrets === true) {
    return { decision: "ASK", reasonCodes: ["APPROVAL_REQUIRED", "SECRET_EXPOSURE_RISK"] };
  }
  if (input.riskClass === "read-only-local" && input.sideEffectClass === "read") {
    return { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] };
  }
  return { decision: "ASK", reasonCodes: ["APPROVAL_REQUIRED", "BASELINE_SAFETY"] };
};

export const SECRET_EXPOSURE_TOOLS: ReadonlySet<string> = new Set([
  "preview_snapshot",
  "device_screenshot",
]);

export const actionFingerprintOf = (input: {
  readonly planId: string;
  readonly actionId: string;
  readonly serverId: string;
  readonly toolId: string;
  readonly argumentDigest: string;
  readonly schemaDigest: string;
  readonly policyVersion: string;
  readonly environmentId: string;
}): ActionFingerprint =>
  ActionFingerprint.make(
    digestCanonical({
      planId: input.planId,
      actionId: input.actionId,
      serverId: input.serverId,
      toolId: input.toolId,
      argumentDigest: input.argumentDigest,
      schemaDigest: input.schemaDigest,
      policyVersion: input.policyVersion,
      environmentId: input.environmentId,
    }),
  );

export const evaluateSideEffectActionGate = (input: {
  readonly plan: ExecutionPlanV0;
  readonly action: PlannedActionV0;
  readonly nowMs: number;
  readonly granted?: ActionApprovalRecord | null;
}): ActionGateDecision => {
  const reasons: ActionGateReasonCode[] = [];
  const planExpiry =
    input.plan.expiresAt !== undefined ? Date.parse(input.plan.expiresAt) : Number.NaN;
  if (Number.isFinite(planExpiry) && input.nowMs >= planExpiry) {
    return decision(input.action, "DENY", ["ACTION_DENIED", "PLAN_EXPIRED"]);
  }

  const expected = actionFingerprintOf({
    planId: input.plan.planId,
    actionId: input.action.actionId,
    serverId: input.action.serverId,
    toolId: input.action.toolId,
    argumentDigest: input.action.argumentDigest,
    schemaDigest: input.action.schemaDigest,
    policyVersion: ACTION_GATE_POLICY_VERSION,
    environmentId: input.plan.environmentId,
  });
  if (expected !== input.action.fingerprint) {
    return decision(input.action, "DENY", [
      "ACTION_DENIED",
      "FINGERPRINT_MISMATCH",
      "PLAN_MUTATED",
    ]);
  }

  const toolName = input.action.toolId.includes("/")
    ? input.action.toolId.slice(input.action.toolId.lastIndexOf("/") + 1)
    : input.action.toolId;
  const defaults = defaultDecisionForRisk({
    riskClass: input.action.riskClass,
    sideEffectClass: input.action.sideEffectClass,
    mayExposeSecrets: SECRET_EXPOSURE_TOOLS.has(toolName),
  });

  if (defaults.decision === "ALLOW") {
    return decision(input.action, "ALLOW", ["ACTION_ALLOWED", "PAID_TIER_CANNOT_DISABLE_SAFETY"]);
  }

  const granted = input.granted;
  if (granted) {
    if (granted.fingerprint !== expected) {
      return decision(input.action, "DENY", [
        "ACTION_DENIED",
        "FINGERPRINT_MISMATCH",
        "PLAN_MUTATED",
      ]);
    }
    if (granted.status === "denied") {
      return decision(
        input.action,
        "DENY",
        ["ACTION_DENIED", "APPROVAL_DENIED"],
        granted.approvalId,
      );
    }
    if (granted.status === "cancelled") {
      return decision(
        input.action,
        "DENY",
        ["ACTION_DENIED", "APPROVAL_CANCELLED"],
        granted.approvalId,
      );
    }
    if (granted.status === "expired" || Date.parse(granted.expiresAt) <= input.nowMs) {
      return decision(
        input.action,
        "DENY",
        ["ACTION_DENIED", "APPROVAL_EXPIRED"],
        granted.approvalId,
      );
    }
    if (granted.status === "consumed") {
      return decision(
        input.action,
        "DENY",
        ["ACTION_DENIED", "REPLAY_REJECTED", "APPROVAL_CONSUMED"],
        granted.approvalId,
      );
    }
    if (granted.status === "invalidated") {
      return decision(input.action, "DENY", ["ACTION_DENIED", "PLAN_MUTATED"], granted.approvalId);
    }
    if (granted.status === "granted") {
      return decision(input.action, "ALLOW", ["ACTION_ALLOWED"], granted.approvalId);
    }
  }

  reasons.push(...defaults.reasonCodes);
  return decision(input.action, "ASK", uniqueReasons(["APPROVAL_REQUIRED", ...reasons]));
};

const uniqueReasons = (
  codes: ReadonlyArray<ActionGateReasonCode>,
): ReadonlyArray<ActionGateReasonCode> => [...new Set(codes)].slice(0, 16);

const decision = (
  action: PlannedActionV0,
  kind: ActionGateDecisionKind,
  reasonCodes: ReadonlyArray<ActionGateReasonCode>,
  approvalId?: ActionApprovalRecord["approvalId"],
): ActionGateDecision => ({
  policyVersion: ACTION_GATE_POLICY_VERSION,
  actionId: action.actionId,
  decision: kind,
  riskClass: action.riskClass,
  sideEffectClass: action.sideEffectClass,
  fingerprint: action.fingerprint,
  reasonCodes: uniqueReasons(reasonCodes),
  explanation:
    kind === "ALLOW"
      ? "ActionGate allowed the bound action."
      : kind === "DENY"
        ? "ActionGate denied the bound action."
        : "ActionGate requires an exact-action approval before execution.",
  requiresApproval: kind === "ASK",
  ...(approvalId !== undefined ? { approvalId } : {}),
});

export const createPendingApproval = (input: {
  readonly approvalId: ActionApprovalId;
  readonly plan: ExecutionPlanV0;
  readonly action: PlannedActionV0;
  readonly nowIso: string;
  readonly expiresAt: string;
  readonly reusePolicy?: ActionApprovalReusePolicy;
  readonly idempotencyKey?: ActionIdempotencyKeyType;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  readonly argumentSummary?: string;
  readonly askExplanation?: string;
}): ActionApprovalRecord => ({
  approvalId: input.approvalId,
  actionId: input.action.actionId,
  fingerprint: input.action.fingerprint,
  planId: input.plan.planId,
  environmentId: input.plan.environmentId,
  serverId: input.action.serverId,
  toolId: input.action.toolId,
  argumentDigest: input.action.argumentDigest,
  policyVersion: ACTION_GATE_POLICY_VERSION,
  reusePolicy: input.reusePolicy ?? "one-time",
  status: "pending",
  scope: "exact-action",
  createdAt: input.nowIso,
  expiresAt: input.expiresAt,
  reasonCodes: ["APPROVAL_REQUIRED"],
  riskClass: input.action.riskClass,
  sideEffectClass: input.action.sideEffectClass,
  argumentSummary: (input.argumentSummary ?? "none").slice(0, 512),
  askExplanation:
    input.askExplanation ??
    "ActionGate requires a one-time exact-action approval before execution.",
  ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
});

export class InMemoryActionApprovalStore {
  readonly #records = new Map<string, ActionApprovalRecord>();
  readonly #chain = new Map<string, Promise<unknown>>();

  get(id: ActionApprovalId): ActionApprovalRecord | undefined {
    return this.#records.get(id);
  }

  list(environmentId: EnvironmentId): ReadonlyArray<ActionApprovalRecord> {
    return [...this.#records.values()].filter((record) => record.environmentId === environmentId);
  }

  put(record: ActionApprovalRecord): ActionApprovalRecord {
    const existing = [...this.#records.values()].find(
      (row) =>
        row.idempotencyKey !== undefined &&
        record.idempotencyKey !== undefined &&
        row.idempotencyKey === record.idempotencyKey &&
        row.environmentId === record.environmentId,
    );
    if (existing) {
      if (existing.fingerprint !== record.fingerprint) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      if (TERMINAL_APPROVAL_STATUSES.has(existing.status)) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }
    const live = [...this.#records.values()].find(
      (row) =>
        row.environmentId === record.environmentId &&
        row.fingerprint === record.fingerprint &&
        (row.status === "pending" || row.status === "granted"),
    );
    if (live) return live;
    this.#records.set(record.approvalId, record);
    return record;
  }

  setStatus(
    id: ActionApprovalId,
    status: ActionApprovalStatus,
    nowIso: string,
    extra?: { readonly consumedAt?: string },
  ): ActionApprovalRecord | undefined {
    const current = this.#records.get(id);
    if (current === undefined) return undefined;
    const next: ActionApprovalRecord = {
      ...current,
      status,
      decidedAt: nowIso,
      ...(extra?.consumedAt !== undefined ? { consumedAt: extra.consumedAt } : {}),
      reasonCodes:
        status === "granted"
          ? ["ACTION_ALLOWED"]
          : status === "denied"
            ? ["APPROVAL_DENIED"]
            : status === "cancelled"
              ? ["APPROVAL_CANCELLED"]
              : status === "expired"
                ? ["APPROVAL_EXPIRED"]
                : status === "consumed"
                  ? ["APPROVAL_CONSUMED"]
                  : status === "invalidated"
                    ? ["PLAN_MUTATED"]
                    : current.reasonCodes,
    };
    this.#records.set(id, next);
    return next;
  }

  invalidateFingerprint(fingerprint: ActionFingerprint, nowIso: string): void {
    for (const record of this.#records.values()) {
      if (
        record.fingerprint === fingerprint &&
        (record.status === "pending" || record.status === "granted")
      ) {
        this.setStatus(record.approvalId, "invalidated", nowIso);
      }
    }
  }

  expireDue(nowMs: number, nowIso: string): void {
    for (const record of this.#records.values()) {
      if (
        (record.status === "pending" || record.status === "granted") &&
        Date.parse(record.expiresAt) <= nowMs
      ) {
        this.setStatus(record.approvalId, "expired", nowIso);
      }
    }
  }

  consumeOneTime(
    id: ActionApprovalId,
    fingerprint: ActionFingerprint,
    nowIso: string,
  ): Promise<ActionApprovalRecord> {
    const run = (): ActionApprovalRecord => {
      const current = this.#records.get(id);
      if (current === undefined) throw new Error("not_found");
      if (current.fingerprint !== fingerprint) throw new Error("FINGERPRINT_MISMATCH");
      if (current.status === "consumed") throw new Error("REPLAY_REJECTED");
      if (current.status !== "granted") throw new Error(current.status);
      if (current.reusePolicy === "explicit-reuse") return current;
      const consumed: ActionApprovalRecord = {
        ...current,
        status: "consumed",
        consumedAt: nowIso,
        decidedAt: current.decidedAt ?? nowIso,
        reasonCodes: ["APPROVAL_CONSUMED"],
      };
      this.#records.set(id, consumed);
      return consumed;
    };
    const previous = this.#chain.get(id) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#chain.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
