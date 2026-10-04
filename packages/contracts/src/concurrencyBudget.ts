/**
 * Concurrency Budget V0 contracts (Phase 13).
 *
 * Enforcement is process-local. Policy may be persisted; runtime leases
 * are in-memory. This module does not claim distributed locking.
 *
 * Admission never substitutes for ActionGate authorization.
 *
 * @module concurrencyBudget
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelRouterMetricValue } from "./modelRouter.ts";
import { MemoryActorId } from "./dreamMemory.ts";

export const CONCURRENCY_BUDGET_POLICY_VERSION = "concurrency-budget.v0" as const;
export const ConcurrencyBudgetPolicyVersion = Schema.Literal(CONCURRENCY_BUDGET_POLICY_VERSION);
export type ConcurrencyBudgetPolicyVersion = typeof ConcurrencyBudgetPolicyVersion.Type;

const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const AdmissionId = BoundedId.pipe(Schema.brand("AdmissionId"));
export type AdmissionId = typeof AdmissionId.Type;

export const LeaseId = BoundedId.pipe(Schema.brand("LeaseId"));
export type LeaseId = typeof LeaseId.Type;

export const ExecutionTreeId = BoundedId.pipe(Schema.brand("ExecutionTreeId"));
export type ExecutionTreeId = typeof ExecutionTreeId.Type;

export const CONCURRENCY_WORKLOAD_CLASSES = [
  "foreground-turn",
  "child-agent",
  "mcp-action",
  "failover-retry",
  "detached-background",
  "openrouter-shadow",
  "dream-job",
] as const;
export const ConcurrencyWorkloadClass = Schema.Literals(CONCURRENCY_WORKLOAD_CLASSES);
export type ConcurrencyWorkloadClass = typeof ConcurrencyWorkloadClass.Type;

export const CONCURRENCY_ADMISSION_OUTCOMES = [
  "admitted",
  "queued",
  "rejected",
  "cancelled",
  "timed-out",
] as const;
export const ConcurrencyAdmissionOutcome = Schema.Literals(CONCURRENCY_ADMISSION_OUTCOMES);
export type ConcurrencyAdmissionOutcome = typeof ConcurrencyAdmissionOutcome.Type;

export const CONCURRENCY_REJECTION_REASONS = [
  "CAPACITY_EXHAUSTED",
  "QUEUE_FULL",
  "QUEUE_TIMEOUT",
  "CANCELLED",
  "SHUTDOWN",
  "MAX_DEPTH",
  "MAX_CHILDREN",
  "MAX_DESCENDANTS",
  "MAX_CONCURRENT_CHILDREN",
  "MAX_ATTEMPTS",
  "FOREGROUND_PROTECTED",
  "SHADOW_SHED",
  "DREAM_SHED",
  "DEADLOCK_PREVENTION",
] as const;
export const ConcurrencyRejectionReason = Schema.Literals(CONCURRENCY_REJECTION_REASONS);
export type ConcurrencyRejectionReason = typeof ConcurrencyRejectionReason.Type;

export const CONCURRENCY_AUDIT_EVENT_KINDS = [
  "concurrency.admitted",
  "concurrency.queued",
  "concurrency.acquired",
  "concurrency.released",
  "concurrency.timeout",
  "concurrency.cancelled",
  "concurrency.rejected",
  "concurrency.exhausted",
] as const;
export const ConcurrencyAuditEventKind = Schema.Literals(CONCURRENCY_AUDIT_EVENT_KINDS);
export type ConcurrencyAuditEventKind = typeof ConcurrencyAuditEventKind.Type;

export const WORKLOAD_PRIORITY: Record<ConcurrencyWorkloadClass, number> = {
  "foreground-turn": 100,
  "child-agent": 80,
  "mcp-action": 70,
  "failover-retry": 60,
  "detached-background": 40,
  "openrouter-shadow": 20,
  "dream-job": 10,
};

export const SHEDDABLE_CLASSES: ReadonlyArray<ConcurrencyWorkloadClass> = [
  "detached-background",
  "openrouter-shadow",
  "dream-job",
];

export const ConcurrencyClassLimits = Schema.Struct({
  maxConcurrent: NonNegativeInt,
  maxQueue: NonNegativeInt,
  maxQueueTimeMs: NonNegativeInt,
});
export type ConcurrencyClassLimits = typeof ConcurrencyClassLimits.Type;

export const ExecutionTreeLimits = Schema.Struct({
  maxDepth: NonNegativeInt,
  maxDirectChildren: NonNegativeInt,
  maxTotalDescendants: NonNegativeInt,
  maxConcurrentChildren: NonNegativeInt,
  maxAttempts: NonNegativeInt,
});
export type ExecutionTreeLimits = typeof ExecutionTreeLimits.Type;

export const defaultClassLimits = (
  workloadClass: ConcurrencyWorkloadClass,
): ConcurrencyClassLimits => {
  switch (workloadClass) {
    case "foreground-turn":
      return { maxConcurrent: 4, maxQueue: 8, maxQueueTimeMs: 30_000 };
    case "child-agent":
      return { maxConcurrent: 4, maxQueue: 4, maxQueueTimeMs: 30_000 };
    case "mcp-action":
      return { maxConcurrent: 8, maxQueue: 8, maxQueueTimeMs: 15_000 };
    case "failover-retry":
      return { maxConcurrent: 2, maxQueue: 2, maxQueueTimeMs: 15_000 };
    case "detached-background":
      return { maxConcurrent: 2, maxQueue: 4, maxQueueTimeMs: 15_000 };
    case "openrouter-shadow":
      return { maxConcurrent: 1, maxQueue: 0, maxQueueTimeMs: 0 };
    case "dream-job":
      return { maxConcurrent: 1, maxQueue: 2, maxQueueTimeMs: 30_000 };
  }
};

export const DEFAULT_EXECUTION_TREE_LIMITS: ExecutionTreeLimits = {
  maxDepth: 3,
  maxDirectChildren: 4,
  maxTotalDescendants: 8,
  maxConcurrentChildren: 2,
  maxAttempts: 3,
};

export const DEFAULT_FOREGROUND_RESERVED = 1;
export const DEFAULT_PROJECT_FOREGROUND_CONCURRENT = 2;
export const DEFAULT_THREAD_FOREGROUND_CONCURRENT = 1;

export const ConcurrencyBudgetPolicyV0 = Schema.Struct({
  policyVersion: ConcurrencyBudgetPolicyVersion,
  topology: Schema.Literal("process-local"),
  foregroundReserved: NonNegativeInt,
  projectForegroundConcurrent: NonNegativeInt,
  threadForegroundConcurrent: NonNegativeInt,
  tree: ExecutionTreeLimits,
  classes: Schema.Struct({
    "foreground-turn": ConcurrencyClassLimits,
    "child-agent": ConcurrencyClassLimits,
    "mcp-action": ConcurrencyClassLimits,
    "failover-retry": ConcurrencyClassLimits,
    "detached-background": ConcurrencyClassLimits,
    "openrouter-shadow": ConcurrencyClassLimits,
    "dream-job": ConcurrencyClassLimits,
  }),
});
export type ConcurrencyBudgetPolicyV0 = typeof ConcurrencyBudgetPolicyV0.Type;

export const defaultConcurrencyBudgetPolicy = (): ConcurrencyBudgetPolicyV0 => ({
  policyVersion: CONCURRENCY_BUDGET_POLICY_VERSION,
  topology: "process-local",
  foregroundReserved: DEFAULT_FOREGROUND_RESERVED,
  projectForegroundConcurrent: DEFAULT_PROJECT_FOREGROUND_CONCURRENT,
  threadForegroundConcurrent: DEFAULT_THREAD_FOREGROUND_CONCURRENT,
  tree: DEFAULT_EXECUTION_TREE_LIMITS,
  classes: {
    "foreground-turn": defaultClassLimits("foreground-turn"),
    "child-agent": defaultClassLimits("child-agent"),
    "mcp-action": defaultClassLimits("mcp-action"),
    "failover-retry": defaultClassLimits("failover-retry"),
    "detached-background": defaultClassLimits("detached-background"),
    "openrouter-shadow": defaultClassLimits("openrouter-shadow"),
    "dream-job": defaultClassLimits("dream-job"),
  },
});

export const ConcurrencyBudgetSettings = Schema.Struct({
  policyVersion: ConcurrencyBudgetPolicyVersion.pipe(
    Schema.withDecodingDefault(Effect.succeed(CONCURRENCY_BUDGET_POLICY_VERSION)),
  ),
  foregroundReserved: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_FOREGROUND_RESERVED)),
  ),
});
export type ConcurrencyBudgetSettings = typeof ConcurrencyBudgetSettings.Type;

export const DEFAULT_CONCURRENCY_BUDGET_SETTINGS: ConcurrencyBudgetSettings = {
  policyVersion: CONCURRENCY_BUDGET_POLICY_VERSION,
  foregroundReserved: DEFAULT_FOREGROUND_RESERVED,
};

export const ExecutionTreeContextV0 = Schema.Struct({
  treeId: ExecutionTreeId,
  parentAdmissionId: Schema.optional(AdmissionId),
  depth: NonNegativeInt,
  descendantCount: NonNegativeInt,
  directChildCount: NonNegativeInt,
  concurrentChildCount: NonNegativeInt,
  attempt: NonNegativeInt,
});
export type ExecutionTreeContextV0 = typeof ExecutionTreeContextV0.Type;

export const ConcurrencyAdmissionRequestV0 = Schema.Struct({
  workloadClass: ConcurrencyWorkloadClass,
  environmentId: EnvironmentId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  actorId: Schema.optional(MemoryActorId),
  tree: Schema.optional(ExecutionTreeContextV0),
  requestedAt: BoundedIso,
});
export type ConcurrencyAdmissionRequestV0 = typeof ConcurrencyAdmissionRequestV0.Type;

export const ConcurrencyLeaseV0 = Schema.Struct({
  leaseId: LeaseId,
  admissionId: AdmissionId,
  workloadClass: ConcurrencyWorkloadClass,
  environmentId: EnvironmentId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  acquiredAt: BoundedIso,
  tree: ExecutionTreeContextV0,
});
export type ConcurrencyLeaseV0 = typeof ConcurrencyLeaseV0.Type;

export const ConcurrencyAdmissionResultV0 = Schema.Struct({
  outcome: ConcurrencyAdmissionOutcome,
  admissionId: AdmissionId,
  workloadClass: ConcurrencyWorkloadClass,
  queuedMs: NonNegativeInt,
  reasonCodes: Schema.Array(ConcurrencyRejectionReason).check(Schema.isMaxLength(8)),
  lease: Schema.optional(ConcurrencyLeaseV0),
  tree: Schema.optional(ExecutionTreeContextV0),
  explanation: BoundedExplanation,
});
export type ConcurrencyAdmissionResultV0 = typeof ConcurrencyAdmissionResultV0.Type;

export const ConcurrencyReleaseOutcomeV0 = Schema.Struct({
  leaseId: LeaseId,
  released: Schema.Boolean,
  duplicate: Schema.Boolean,
});
export type ConcurrencyReleaseOutcomeV0 = typeof ConcurrencyReleaseOutcomeV0.Type;

export const ConcurrencyAdmissionTraceV0 = Schema.Struct({
  policyVersion: ConcurrencyBudgetPolicyVersion,
  workloadClass: ConcurrencyWorkloadClass,
  outcome: ConcurrencyAdmissionOutcome,
  queuedMs: NonNegativeInt,
  depth: NonNegativeInt,
  attempt: NonNegativeInt,
  reasonCodes: Schema.Array(ConcurrencyRejectionReason).check(Schema.isMaxLength(8)),
  cost: ModelRouterMetricValue,
});
export type ConcurrencyAdmissionTraceV0 = typeof ConcurrencyAdmissionTraceV0.Type;

export const ConcurrencyClassSnapshotV0 = Schema.Struct({
  workloadClass: ConcurrencyWorkloadClass,
  active: NonNegativeInt,
  queued: NonNegativeInt,
  limit: NonNegativeInt,
  rejected: NonNegativeInt,
  cancelled: NonNegativeInt,
  timedOut: NonNegativeInt,
});
export type ConcurrencyClassSnapshotV0 = typeof ConcurrencyClassSnapshotV0.Type;

export const ConcurrencyGovernanceSnapshotV0 = Schema.Struct({
  environmentId: EnvironmentId,
  policyVersion: ConcurrencyBudgetPolicyVersion,
  topology: Schema.Literal("process-local"),
  saturation: Schema.Literals(["idle", "busy", "saturated", "shedding"]),
  foregroundActive: NonNegativeInt,
  backgroundActive: NonNegativeInt,
  queued: NonNegativeInt,
  reservedForegroundFree: NonNegativeInt,
  classes: Schema.Array(ConcurrencyClassSnapshotV0).check(Schema.isMaxLength(16)),
  knownCostUsd: ModelRouterMetricValue,
  cancelledCount: NonNegativeInt,
  rejectedCount: NonNegativeInt,
});
export type ConcurrencyGovernanceSnapshotV0 = typeof ConcurrencyGovernanceSnapshotV0.Type;

export const ConcurrencyAuditEventV0 = Schema.Struct({
  eventId: BoundedId,
  kind: ConcurrencyAuditEventKind,
  at: BoundedIso,
  environmentId: EnvironmentId,
  admissionId: Schema.optional(AdmissionId),
  leaseId: Schema.optional(LeaseId),
  workloadClass: Schema.optional(ConcurrencyWorkloadClass),
  outcome: Schema.optional(ConcurrencyAdmissionOutcome),
  reasonCodes: Schema.Array(ConcurrencyRejectionReason).check(Schema.isMaxLength(8)),
  policyVersion: ConcurrencyBudgetPolicyVersion,
});
export type ConcurrencyAuditEventV0 = typeof ConcurrencyAuditEventV0.Type;

export class ConcurrencyBudgetError extends Schema.TaggedError<ConcurrencyBudgetError>()(
  "ConcurrencyBudgetError",
  {
    reason: Schema.Literals(["rejected", "cancelled", "timed-out", "shutdown", "invalid"]),
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
    reasonCodes: Schema.Array(ConcurrencyRejectionReason).check(Schema.isMaxLength(8)),
  },
) {
  override get message(): string {
    return `Concurrency budget failed (${this.reason}): ${this.detail}`;
  }
}
