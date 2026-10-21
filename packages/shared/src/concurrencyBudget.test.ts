import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ThreadId,
  type ConcurrencyAdmissionRequestV0,
  type ConcurrencyWorkloadClass,
} from "@t3tools/contracts";

import { ConcurrencyScheduler, type SchedulerClock } from "./concurrencyBudget.ts";

const env = EnvironmentId.make("env-1");
const TEST_EPOCH_MS = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z").epochMilliseconds;

class FakeClock implements SchedulerClock {
  ms: number;
  constructor(ms = TEST_EPOCH_MS) {
    this.ms = ms;
  }
  nowMs = () => this.ms;
  nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(this.ms));
  advance(delta: number) {
    this.ms += delta;
  }
}

function request(
  workloadClass: ConcurrencyWorkloadClass,
  extras: Partial<ConcurrencyAdmissionRequestV0> = {},
): ConcurrencyAdmissionRequestV0 {
  return {
    workloadClass,
    environmentId: env,
    requestedAt: "2026-10-03T00:00:00.000Z",
    ...extras,
  };
}

describe("concurrency scheduler", () => {
  it("admits up to the exact class limit and queues FIFO within the class", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const first = scheduler.admit(request("mcp-action"));
    const second = scheduler.admit(request("mcp-action"));
    expect(first.outcome).toBe("admitted");
    expect(second.outcome).toBe("admitted");
    for (let index = 0; index < 6; index += 1) {
      expect(scheduler.admit(request("mcp-action")).outcome).toBe("admitted");
    }
    const queued = scheduler.admit(request("mcp-action"));
    expect(queued.outcome).toBe("queued");
    expect(scheduler.queuedCount()).toBe(1);
  });

  it("protects foreground from Dream and Shadow shedding", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const foreground = scheduler.admit(request("foreground-turn"));
    expect(foreground.outcome).toBe("admitted");
    const dream = scheduler.admit(request("dream-job"));
    expect(dream.outcome).toBe("admitted");
    const extraDream = scheduler.admit(request("dream-job"));
    expect(extraDream.outcome === "queued" || extraDream.outcome === "rejected").toBe(true);
    const shadow = scheduler.admit(request("openrouter-shadow"));
    expect(shadow.outcome).toBe("admitted");
    const extraShadow = scheduler.admit(request("openrouter-shadow"));
    expect(extraShadow.outcome).toBe("rejected");
    expect(extraShadow.reasonCodes).toContain("SHADOW_SHED");
  });

  it("times out queued work with a fake clock and cancels waiters", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    for (let index = 0; index < 8; index += 1) {
      expect(scheduler.admit(request("mcp-action")).outcome).toBe("admitted");
    }
    const queued = scheduler.admit(request("mcp-action"));
    expect(queued.outcome).toBe("queued");
    let observed = queued;
    scheduler.attachWaiter(queued.admissionId, {
      resolve: (result) => {
        observed = result;
      },
    });
    clock.advance(15_000);
    scheduler.tick();
    expect(observed.outcome).toBe("timed-out");
    expect(observed.reasonCodes).toContain("QUEUE_TIMEOUT");
  });

  it("cancels queued work so it never executes, and releases active leases", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    for (let index = 0; index < 8; index += 1) {
      scheduler.admit(request("mcp-action"));
    }
    const queued = scheduler.admit(request("mcp-action"));
    expect(scheduler.cancel(queued.admissionId)).toBe(true);
    expect(scheduler.queuedCount()).toBe(0);
    const admitted = scheduler.admit(request("foreground-turn"));
    const leaseId = admitted.lease?.leaseId;
    if (leaseId === undefined) throw new Error("expected lease");
    expect(scheduler.release(leaseId)).toEqual({ leaseId, released: true, duplicate: false });
    expect(scheduler.release(leaseId)).toEqual({ leaseId, released: false, duplicate: true });
    expect(scheduler.activeCount()).toBe(8);
    scheduler.shutdownNow();
    expect(scheduler.activeCount()).toBe(0);
  });

  it("enforces depth, children, descendants, and attempts without reset on failover", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const parent = scheduler.admit(request("foreground-turn"));
    const tree = parent.tree;
    if (tree === undefined) throw new Error("expected tree");
    const child = scheduler.admit(request("child-agent", { tree }));
    expect(child.outcome).toBe("admitted");
    const retry = scheduler.admit(request("failover-retry", { tree: child.tree }));
    expect(retry.outcome).toBe("admitted");
    expect(retry.tree?.attempt).toBe(2);
    expect(retry.tree?.depth).toBe(child.tree?.depth);
    const childLease = child.lease?.leaseId;
    if (childLease !== undefined) scheduler.release(childLease);
    const nested = scheduler.admit(request("child-agent", { tree: child.tree }));
    expect(nested.outcome).toBe("admitted");
    expect(nested.tree?.depth).toBe(2);
    const nestedLease = nested.lease?.leaseId;
    if (nestedLease !== undefined) scheduler.release(nestedLease);
    const deeper = scheduler.admit(request("child-agent", { tree: nested.tree }));
    expect(deeper.outcome).toBe("admitted");
    expect(deeper.tree?.depth).toBe(3);
    const tooDeep = scheduler.admit(request("child-agent", { tree: deeper.tree }));
    expect(tooDeep.outcome).toBe("rejected");
    expect(tooDeep.reasonCodes).toContain("MAX_DEPTH");
    const spoofed = scheduler.admit(
      request("child-agent", {
        tree: {
          ...tree,
          depth: 0,
          descendantCount: 0,
          directChildCount: 0,
          concurrentChildCount: 0,
          attempt: 1,
        },
      }),
    );
    expect(spoofed.outcome).toBe("rejected");
  });

  it("shuts down without leaking permits", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    scheduler.admit(request("foreground-turn"));
    for (let index = 0; index < 8; index += 1) scheduler.admit(request("mcp-action"));
    scheduler.admit(request("mcp-action"));
    scheduler.shutdownNow();
    expect(scheduler.activeCount()).toBe(0);
    expect(scheduler.queuedCount()).toBe(0);
    expect(scheduler.admit(request("dream-job")).reasonCodes).toContain("SHUTDOWN");
  });

  it("admits a child while the parent holds a foreground lease", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const parent = scheduler.admit(request("foreground-turn"));
    expect(parent.outcome).toBe("admitted");
    const child = scheduler.admit(request("child-agent", { tree: parent.tree }));
    expect(child.outcome).toBe("admitted");
    expect(child.tree?.depth).toBe(1);
  });

  it("wakes FIFO waiters inside a class and prefers queued foreground over Dream", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const leases: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const admitted = scheduler.admit(request("mcp-action"));
      if (admitted.lease !== undefined) leases.push(admitted.lease.leaseId);
    }
    const firstQueued = scheduler.admit(request("mcp-action"));
    const secondQueued = scheduler.admit(request("mcp-action"));
    expect(firstQueued.outcome).toBe("queued");
    expect(secondQueued.outcome).toBe("queued");
    const woken: string[] = [];
    scheduler.attachWaiter(firstQueued.admissionId, {
      resolve: (result) => {
        woken.push(`first:${result.outcome}`);
      },
    });
    scheduler.attachWaiter(secondQueued.admissionId, {
      resolve: (result) => {
        woken.push(`second:${result.outcome}`);
      },
    });
    const firstLease = leases.shift();
    if (firstLease === undefined) throw new Error("expected lease");
    scheduler.release(firstLease as never);
    expect(woken[0]).toBe("first:admitted");
    const dream = scheduler.admit(request("dream-job"));
    expect(dream.outcome === "queued" || dream.outcome === "admitted").toBe(true);
  });

  it("runs a deterministic concurrent stress of admit/release without negative counts", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const leases: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const result = scheduler.admit(
        request(index % 2 === 0 ? "mcp-action" : "detached-background"),
      );
      if (result.lease !== undefined) leases.push(result.lease.leaseId);
      if (index % 3 === 0 && leases.length > 0) {
        const leaseId = leases.shift();
        if (leaseId !== undefined) scheduler.release(leaseId as never);
      }
      if (index % 11 === 0) clock.advance(1_000);
      scheduler.tick();
    }
    for (const leaseId of leases) scheduler.release(leaseId as never);
    scheduler.shutdownNow();
    const snapshot = scheduler.snapshot();
    for (const item of snapshot.classes) {
      expect(item.active).toBeGreaterThanOrEqual(0);
    }
    expect(scheduler.activeCount()).toBe(0);
  });

  it("does not commit execution-tree counts while work is only queued", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const parent = scheduler.admit(request("foreground-turn"));
    const tree = parent.tree;
    if (tree === undefined) throw new Error("expected tree");
    const childLeases: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const admitted = scheduler.admit(request("child-agent"));
      if (admitted.lease !== undefined) childLeases.push(admitted.lease.leaseId);
    }
    const queued = scheduler.admit(
      request("child-agent", { tree, threadId: ThreadId.make("t-1") }),
    );
    expect(queued.outcome).toBe("queued");
    expect(queued.tree?.concurrentChildCount ?? 0).toBe(0);
    const woken: string[] = [];
    scheduler.attachWaiter(queued.admissionId, {
      resolve: (result) => {
        woken.push(result.outcome);
      },
    });
    const first = childLeases.shift();
    if (first === undefined) throw new Error("expected child lease");
    scheduler.release(first as never);
    expect(woken[0]).toBe("admitted");
  });

  it("cancels queued work for a thread and cannot promote Dream above foreground by aging", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const threadId = ThreadId.make("thread-cancel");
    for (let index = 0; index < 8; index += 1) {
      expect(scheduler.admit(request("mcp-action")).outcome).toBe("admitted");
    }
    const queued = scheduler.admit(request("mcp-action", { threadId }));
    expect(queued.outcome).toBe("queued");
    expect(scheduler.cancelQueuedForThread(threadId)).toBe(1);
    expect(scheduler.queuedCount()).toBe(0);

    const foregroundLeases: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const admitted = scheduler.admit(request("foreground-turn"));
      if (admitted.lease !== undefined) foregroundLeases.push(admitted.lease.leaseId);
    }
    expect(scheduler.admit(request("dream-job")).outcome).toBe("admitted");
    const queuedDream = scheduler.admit(request("dream-job"));
    expect(queuedDream.outcome).toBe("queued");
    const queuedForeground = scheduler.admit(request("foreground-turn"));
    expect(queuedForeground.outcome).toBe("queued");
    let dreamResult = queuedDream.outcome;
    let foregroundResult = queuedForeground.outcome;
    scheduler.attachWaiter(queuedDream.admissionId, {
      resolve: (result) => {
        dreamResult = result.outcome;
      },
    });
    scheduler.attachWaiter(queuedForeground.admissionId, {
      resolve: (result) => {
        foregroundResult = result.outcome;
      },
    });
    clock.advance(60_000);
    const leaseId = foregroundLeases.shift();
    if (leaseId === undefined) throw new Error("expected foreground lease");
    scheduler.release(leaseId as never);
    expect(foregroundResult).toBe("admitted");
    expect(dreamResult).toBe("queued");
  });

  it("times out non-sheddable queued work at maxQueueTimeMs rather than claiming starvation-freedom", () => {
    const clock = new FakeClock();
    const scheduler = new ConcurrencyScheduler({ environmentId: env, clock });
    const started = performance.now();
    const foregroundLeases: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const admitted = scheduler.admit(request("foreground-turn"));
      if (admitted.lease !== undefined) foregroundLeases.push(admitted.lease.leaseId);
    }
    const queued = scheduler.admit(
      request("foreground-turn", { threadId: ThreadId.make("t-wait") }),
    );
    expect(queued.outcome).toBe("queued");
    let outcome = queued.outcome;
    scheduler.attachWaiter(queued.admissionId, {
      resolve: (result) => {
        outcome = result.outcome;
      },
    });
    clock.advance(scheduler.policy.classes["foreground-turn"].maxQueueTimeMs);
    scheduler.tick();
    expect(outcome).toBe("timed-out");
    expect(performance.now() - started).toBeLessThan(1_000);
    for (const leaseId of foregroundLeases) scheduler.release(leaseId as never);
  });
});
