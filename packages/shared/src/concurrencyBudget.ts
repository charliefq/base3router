/**
 * Process-local concurrency scheduler (Phase 13 V0).
 *
 * Counter mutations are synchronous. Queue waits are async via callbacks
 * driven by an injected clock. This does not claim distributed locking.
 */
import {
  CONCURRENCY_BUDGET_POLICY_VERSION,
  SHEDDABLE_CLASSES,
  WORKLOAD_PRIORITY,
  defaultConcurrencyBudgetPolicy,
  type AdmissionId,
  type ConcurrencyAdmissionOutcome,
  type ConcurrencyAdmissionRequestV0,
  type ConcurrencyAdmissionResultV0,
  type ConcurrencyAuditEventV0,
  type ConcurrencyBudgetPolicyV0,
  type ConcurrencyClassSnapshotV0,
  type ConcurrencyGovernanceSnapshotV0,
  type ConcurrencyLeaseV0,
  type ConcurrencyRejectionReason,
  type ConcurrencyReleaseOutcomeV0,
  type ConcurrencyWorkloadClass,
  type EnvironmentId,
  type ExecutionTreeContextV0,
  type ExecutionTreeId,
  type LeaseId,
} from "@t3tools/contracts";
import { MODEL_ROUTER_UNKNOWN_METRIC } from "@t3tools/contracts";

import { digestCanonical } from "./actionCanonical.ts";

export type SchedulerClock = {
  nowMs: () => number;
  nowIso: () => string;
};

export type QueueWaiter = {
  readonly resolve: (result: ConcurrencyAdmissionResultV0) => void;
};

type InternalLease = ConcurrencyLeaseV0 & {
  released: boolean;
};

type QueueEntry = {
  readonly admissionId: AdmissionId;
  readonly request: ConcurrencyAdmissionRequestV0;
  readonly enqueuedAtMs: number;
  readonly priority: number;
  readonly sequence: number;
  cancelled: boolean;
  waiter?: QueueWaiter;
};

const BACKGROUND_CLASSES = new Set<ConcurrencyWorkloadClass>([
  "detached-background",
  "openrouter-shadow",
  "dream-job",
]);

const makeId = (prefix: string, material: unknown): string =>
  `${prefix}-${digestCanonical(material).slice(0, 24)}`;

const emptyTree = (treeId: ExecutionTreeId): ExecutionTreeContextV0 => ({
  treeId,
  depth: 0,
  descendantCount: 0,
  directChildCount: 0,
  concurrentChildCount: 0,
  attempt: 1,
});

export class ConcurrencyScheduler {
  readonly policy: ConcurrencyBudgetPolicyV0;
  private readonly clock: SchedulerClock;
  private readonly environmentId: EnvironmentId;
  private sequence = 0;
  private readonly classActive = new Map<ConcurrencyWorkloadClass, number>();
  private readonly classRejected = new Map<ConcurrencyWorkloadClass, number>();
  private readonly classCancelled = new Map<ConcurrencyWorkloadClass, number>();
  private readonly classTimedOut = new Map<ConcurrencyWorkloadClass, number>();
  private readonly projectForeground = new Map<string, number>();
  private readonly threadForeground = new Map<string, number>();
  private readonly leases = new Map<string, InternalLease>();
  private readonly trees = new Map<string, ExecutionTreeContextV0>();
  private readonly queue: QueueEntry[] = [];
  private shutdown = false;
  readonly audit: ConcurrencyAuditEventV0[] = [];

  constructor(input: {
    readonly environmentId: EnvironmentId;
    readonly clock: SchedulerClock;
    readonly policy?: ConcurrencyBudgetPolicyV0;
  }) {
    this.environmentId = input.environmentId;
    this.clock = input.clock;
    this.policy = input.policy ?? defaultConcurrencyBudgetPolicy();
    for (const workloadClass of Object.keys(WORKLOAD_PRIORITY) as ConcurrencyWorkloadClass[]) {
      this.classActive.set(workloadClass, 0);
      this.classRejected.set(workloadClass, 0);
      this.classCancelled.set(workloadClass, 0);
      this.classTimedOut.set(workloadClass, 0);
    }
  }

  private bump(map: Map<string, number>, key: string, delta: number): number {
    const next = Math.max(0, (map.get(key) ?? 0) + delta);
    map.set(key, next);
    return next;
  }

  private classCount(workloadClass: ConcurrencyWorkloadClass): number {
    return this.classActive.get(workloadClass) ?? 0;
  }

  private foregroundActive(): number {
    return this.classCount("foreground-turn");
  }

  private reservedForegroundFree(): number {
    return Math.max(0, this.policy.foregroundReserved - this.foregroundActive());
  }

  private wouldStarveForeground(workloadClass: ConcurrencyWorkloadClass): boolean {
    // Separate class pools reserve foreground capacity. Dream/Shadow still
    // yield to any queued foreground waiter during drain.
    return (
      workloadClass === "dream-job" &&
      this.queue.some(
        (entry) => entry.request.workloadClass === "foreground-turn" && !entry.cancelled,
      )
    );
  }

  private treeFor(
    request: ConcurrencyAdmissionRequestV0,
  ): ExecutionTreeContextV0 | { reason: ConcurrencyRejectionReason } {
    if (request.tree === undefined) {
      const treeId = makeId("tree", {
        at: request.requestedAt,
        seq: this.sequence,
        class: request.workloadClass,
      }) as ExecutionTreeId;
      const tree = emptyTree(treeId);
      this.trees.set(treeId, tree);
      return tree;
    }
    const current = this.trees.get(request.tree.treeId) ?? request.tree;
    const nextDepth =
      request.workloadClass === "failover-retry" ? current.depth : current.depth + 1;
    const nextAttempt =
      request.workloadClass === "failover-retry" ? current.attempt + 1 : current.attempt;
    if (nextDepth > this.policy.tree.maxDepth) return { reason: "MAX_DEPTH" };
    if (current.directChildCount + 1 > this.policy.tree.maxDirectChildren) {
      return { reason: "MAX_CHILDREN" };
    }
    if (current.descendantCount + 1 > this.policy.tree.maxTotalDescendants) {
      return { reason: "MAX_DESCENDANTS" };
    }
    if (current.concurrentChildCount + 1 > this.policy.tree.maxConcurrentChildren) {
      return { reason: "MAX_CONCURRENT_CHILDREN" };
    }
    if (nextAttempt > this.policy.tree.maxAttempts) return { reason: "MAX_ATTEMPTS" };
    const next: ExecutionTreeContextV0 = {
      ...current,
      parentAdmissionId: undefined,
      depth: nextDepth,
      descendantCount:
        current.descendantCount + (request.workloadClass === "failover-retry" ? 0 : 1),
      directChildCount:
        current.directChildCount + (request.workloadClass === "failover-retry" ? 0 : 1),
      concurrentChildCount:
        current.concurrentChildCount + (request.workloadClass === "failover-retry" ? 0 : 1),
      attempt: nextAttempt,
    };
    this.trees.set(current.treeId, next);
    return next;
  }

  private hasCapacity(request: ConcurrencyAdmissionRequestV0): boolean {
    const limits = this.policy.classes[request.workloadClass];
    if (this.classCount(request.workloadClass) >= limits.maxConcurrent) return false;
    if (request.workloadClass === "foreground-turn") {
      if (request.projectId !== undefined) {
        const used = this.projectForeground.get(request.projectId) ?? 0;
        if (used >= this.policy.projectForegroundConcurrent) return false;
      }
      if (request.threadId !== undefined) {
        const used = this.threadForeground.get(request.threadId) ?? 0;
        if (used >= this.policy.threadForegroundConcurrent) return false;
      }
    } else if (
      this.reservedForegroundFree() === 0 &&
      BACKGROUND_CLASSES.has(request.workloadClass)
    ) {
      return false;
    }
    return true;
  }

  private acquireLease(
    request: ConcurrencyAdmissionRequestV0,
    tree: ExecutionTreeContextV0,
    queuedMs: number,
  ): ConcurrencyAdmissionResultV0 {
    const admissionId = makeId("adm", {
      seq: ++this.sequence,
      class: request.workloadClass,
      at: this.clock.nowIso(),
    }) as AdmissionId;
    const leaseId = makeId("lease", { admissionId }) as LeaseId;
    const lease: InternalLease = {
      leaseId,
      admissionId,
      workloadClass: request.workloadClass,
      environmentId: request.environmentId,
      acquiredAt: this.clock.nowIso(),
      tree,
      released: false,
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
    };
    this.leases.set(leaseId, lease);
    this.bump(this.classActive, request.workloadClass, 1);
    if (request.workloadClass === "foreground-turn") {
      if (request.projectId !== undefined) this.bump(this.projectForeground, request.projectId, 1);
      if (request.threadId !== undefined) this.bump(this.threadForeground, request.threadId, 1);
    }
    this.record("concurrency.acquired", admissionId, leaseId, request.workloadClass, "admitted");
    return {
      outcome: "admitted",
      admissionId,
      workloadClass: request.workloadClass,
      queuedMs,
      reasonCodes: [],
      lease,
      tree,
      explanation: "Admitted under process-local concurrency budget.",
    };
  }

  private reject(
    request: ConcurrencyAdmissionRequestV0,
    reason: ConcurrencyRejectionReason,
    outcome: ConcurrencyAdmissionOutcome = "rejected",
  ): ConcurrencyAdmissionResultV0 {
    if (outcome === "rejected") this.bump(this.classRejected, request.workloadClass, 1);
    if (outcome === "timed-out") this.bump(this.classTimedOut, request.workloadClass, 1);
    if (outcome === "cancelled") this.bump(this.classCancelled, request.workloadClass, 1);
    const admissionId = makeId("adm", {
      seq: ++this.sequence,
      class: request.workloadClass,
      reason,
    }) as AdmissionId;
    this.record(
      outcome === "cancelled" ? "concurrency.cancelled" : "concurrency.rejected",
      admissionId,
      undefined,
      request.workloadClass,
      outcome,
      [reason],
    );
    return {
      outcome,
      admissionId,
      workloadClass: request.workloadClass,
      queuedMs: 0,
      reasonCodes: [reason],
      explanation: `Concurrency ${outcome}: ${reason}`,
    };
  }

  admit(request: ConcurrencyAdmissionRequestV0): ConcurrencyAdmissionResultV0 {
    if (this.shutdown) return this.reject(request, "SHUTDOWN");
    const treeOrReason = this.treeFor(request);
    if ("reason" in treeOrReason) return this.reject(request, treeOrReason.reason);
    if (this.hasCapacity(request) && !this.wouldStarveForeground(request.workloadClass)) {
      return this.acquireLease(request, treeOrReason, 0);
    }
    const limits = this.policy.classes[request.workloadClass];
    const sheddable = SHEDDABLE_CLASSES.includes(request.workloadClass);
    if (sheddable && limits.maxQueue === 0) {
      const reason: ConcurrencyRejectionReason =
        request.workloadClass === "dream-job"
          ? "DREAM_SHED"
          : request.workloadClass === "openrouter-shadow"
            ? "SHADOW_SHED"
            : "CAPACITY_EXHAUSTED";
      return this.reject(request, reason);
    }
    const queuedForClass = this.queue.filter(
      (entry) => entry.request.workloadClass === request.workloadClass && !entry.cancelled,
    ).length;
    if (queuedForClass >= limits.maxQueue) {
      const reason: ConcurrencyRejectionReason = sheddable
        ? request.workloadClass === "dream-job"
          ? "DREAM_SHED"
          : request.workloadClass === "openrouter-shadow"
            ? "SHADOW_SHED"
            : "QUEUE_FULL"
        : "QUEUE_FULL";
      return this.reject(request, reason);
    }
    const admissionId = makeId("adm", {
      seq: ++this.sequence,
      queued: true,
      class: request.workloadClass,
    }) as AdmissionId;
    const entry: QueueEntry = {
      admissionId,
      request,
      enqueuedAtMs: this.clock.nowMs(),
      priority: WORKLOAD_PRIORITY[request.workloadClass],
      sequence: this.sequence,
      cancelled: false,
    };
    this.queue.push(entry);
    this.record("concurrency.queued", admissionId, undefined, request.workloadClass, "queued");
    return {
      outcome: "queued",
      admissionId,
      workloadClass: request.workloadClass,
      queuedMs: 0,
      reasonCodes: [],
      tree: treeOrReason,
      explanation: "Queued under process-local concurrency budget.",
    };
  }

  attachWaiter(admissionId: AdmissionId, waiter: QueueWaiter): boolean {
    const entry = this.queue.find((item) => item.admissionId === admissionId);
    if (entry === undefined || entry.cancelled) return false;
    entry.waiter = waiter;
    return true;
  }

  cancel(admissionId: AdmissionId): boolean {
    const index = this.queue.findIndex((entry) => entry.admissionId === admissionId);
    if (index === -1) return false;
    const entry = this.queue[index];
    if (entry === undefined || entry.cancelled) return false;
    entry.cancelled = true;
    this.queue.splice(index, 1);
    this.bump(this.classCancelled, entry.request.workloadClass, 1);
    const result: ConcurrencyAdmissionResultV0 = {
      outcome: "cancelled",
      admissionId,
      workloadClass: entry.request.workloadClass,
      queuedMs: Math.max(0, this.clock.nowMs() - entry.enqueuedAtMs),
      reasonCodes: ["CANCELLED"],
      explanation: "Queued work was cancelled before execution.",
    };
    entry.waiter?.resolve(result);
    this.record(
      "concurrency.cancelled",
      admissionId,
      undefined,
      entry.request.workloadClass,
      "cancelled",
      ["CANCELLED"],
    );
    return true;
  }

  release(leaseId: LeaseId): ConcurrencyReleaseOutcomeV0 {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) {
      return { leaseId, released: false, duplicate: false };
    }
    if (lease.released) {
      return { leaseId, released: false, duplicate: true };
    }
    lease.released = true;
    this.bump(this.classActive, lease.workloadClass, -1);
    if (lease.workloadClass === "foreground-turn") {
      if (lease.projectId !== undefined) this.bump(this.projectForeground, lease.projectId, -1);
      if (lease.threadId !== undefined) this.bump(this.threadForeground, lease.threadId, -1);
    }
    const tree = this.trees.get(lease.tree.treeId);
    if (tree !== undefined && lease.workloadClass !== "failover-retry" && lease.tree.depth > 0) {
      this.trees.set(lease.tree.treeId, {
        ...tree,
        concurrentChildCount: Math.max(0, tree.concurrentChildCount - 1),
      });
    }
    this.record(
      "concurrency.released",
      lease.admissionId,
      leaseId,
      lease.workloadClass,
      "admitted",
    );
    this.drain();
    return { leaseId, released: true, duplicate: false };
  }

  tick(): void {
    const now = this.clock.nowMs();
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (entry === undefined || entry.cancelled) continue;
      const limit = this.policy.classes[entry.request.workloadClass].maxQueueTimeMs;
      if (limit > 0 && now - entry.enqueuedAtMs >= limit) {
        this.queue.splice(index, 1);
        this.bump(this.classTimedOut, entry.request.workloadClass, 1);
        const result: ConcurrencyAdmissionResultV0 = {
          outcome: "timed-out",
          admissionId: entry.admissionId,
          workloadClass: entry.request.workloadClass,
          queuedMs: now - entry.enqueuedAtMs,
          reasonCodes: ["QUEUE_TIMEOUT"],
          explanation: "Queued work exceeded the wait timeout.",
        };
        entry.waiter?.resolve(result);
        this.record(
          "concurrency.timeout",
          entry.admissionId,
          undefined,
          entry.request.workloadClass,
          "timed-out",
          ["QUEUE_TIMEOUT"],
        );
      }
    }
    this.drain();
  }

  drain(): void {
    const now = this.clock.nowMs();
    this.queue.sort((left, right) => {
      const leftRank = left.priority + Math.min(25, Math.floor((now - left.enqueuedAtMs) / 2_000));
      const rightRank =
        right.priority + Math.min(25, Math.floor((now - right.enqueuedAtMs) / 2_000));
      if (leftRank !== rightRank) return rightRank - leftRank;
      return left.sequence - right.sequence;
    });
    const remaining: QueueEntry[] = [];
    for (const entry of this.queue) {
      if (entry.cancelled) continue;
      if (
        this.hasCapacity(entry.request) &&
        !this.wouldStarveForeground(entry.request.workloadClass)
      ) {
        const treeOrReason = this.treeFor(entry.request);
        if ("reason" in treeOrReason) {
          const rejected = this.reject(entry.request, treeOrReason.reason);
          entry.waiter?.resolve(rejected);
          continue;
        }
        const admitted = this.acquireLease(
          entry.request,
          treeOrReason,
          Math.max(0, this.clock.nowMs() - entry.enqueuedAtMs),
        );
        entry.waiter?.resolve(admitted);
        continue;
      }
      remaining.push(entry);
    }
    this.queue.length = 0;
    this.queue.push(...remaining);
  }

  shutdownNow(): void {
    this.shutdown = true;
    while (this.queue.length > 0) {
      const entry = this.queue.pop();
      if (entry === undefined || entry.cancelled) continue;
      const result: ConcurrencyAdmissionResultV0 = {
        outcome: "cancelled",
        admissionId: entry.admissionId,
        workloadClass: entry.request.workloadClass,
        queuedMs: Math.max(0, this.clock.nowMs() - entry.enqueuedAtMs),
        reasonCodes: ["SHUTDOWN"],
        explanation: "Server shutdown cancelled queued work.",
      };
      this.bump(this.classCancelled, entry.request.workloadClass, 1);
      entry.waiter?.resolve(result);
    }
    for (const lease of this.leases.values()) {
      if (!lease.released) this.release(lease.leaseId);
    }
  }

  snapshot(): ConcurrencyGovernanceSnapshotV0 {
    const classes: ConcurrencyClassSnapshotV0[] = (
      Object.keys(WORKLOAD_PRIORITY) as ConcurrencyWorkloadClass[]
    ).map((workloadClass) => ({
      workloadClass,
      active: this.classCount(workloadClass),
      queued: this.queue.filter(
        (entry) => entry.request.workloadClass === workloadClass && !entry.cancelled,
      ).length,
      limit: this.policy.classes[workloadClass].maxConcurrent,
      rejected: this.classRejected.get(workloadClass) ?? 0,
      cancelled: this.classCancelled.get(workloadClass) ?? 0,
      timedOut: this.classTimedOut.get(workloadClass) ?? 0,
    }));
    const queued = classes.reduce((sum, item) => sum + item.queued, 0);
    const backgroundActive = classes
      .filter((item) => item.workloadClass !== "foreground-turn")
      .reduce((sum, item) => sum + item.active, 0);
    const rejectedCount = classes.reduce((sum, item) => sum + item.rejected, 0);
    const cancelledCount = classes.reduce((sum, item) => sum + item.cancelled, 0);
    const saturation =
      queued === 0 && this.foregroundActive() === 0 && backgroundActive === 0
        ? "idle"
        : rejectedCount > 0 && this.reservedForegroundFree() === 0
          ? "shedding"
          : queued > 0
            ? "saturated"
            : "busy";
    return {
      environmentId: this.environmentId,
      policyVersion: CONCURRENCY_BUDGET_POLICY_VERSION,
      topology: "process-local",
      saturation,
      foregroundActive: this.foregroundActive(),
      backgroundActive,
      queued,
      reservedForegroundFree: this.reservedForegroundFree(),
      classes,
      knownCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
      cancelledCount,
      rejectedCount,
    };
  }

  activeCount(): number {
    return [...this.leases.values()].filter((lease) => !lease.released).length;
  }

  queuedCount(): number {
    return this.queue.filter((entry) => !entry.cancelled).length;
  }

  private record(
    kind: ConcurrencyAuditEventV0["kind"],
    admissionId: AdmissionId | undefined,
    leaseId: LeaseId | undefined,
    workloadClass: ConcurrencyWorkloadClass | undefined,
    outcome: ConcurrencyAdmissionOutcome | undefined,
    reasonCodes: ReadonlyArray<ConcurrencyRejectionReason> = [],
  ): void {
    this.audit.push({
      eventId: makeId("cau", { kind, admissionId, at: this.clock.nowIso(), seq: this.sequence }),
      kind,
      at: this.clock.nowIso(),
      environmentId: this.environmentId,
      ...(admissionId !== undefined ? { admissionId } : {}),
      ...(leaseId !== undefined ? { leaseId } : {}),
      ...(workloadClass !== undefined ? { workloadClass } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      reasonCodes: [...reasonCodes],
      policyVersion: CONCURRENCY_BUDGET_POLICY_VERSION,
    });
  }
}
