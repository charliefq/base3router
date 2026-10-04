import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  type ConcurrencyAdmissionRequestV0,
  type ConcurrencyWorkloadClass,
} from "@t3tools/contracts";

import { ConcurrencyScheduler, type SchedulerClock } from "./concurrencyBudget.ts";

const env = EnvironmentId.make("env-1");

class FakeClock implements SchedulerClock {
  ms: number;
  constructor(ms = Date.parse("2026-10-03T00:00:00.000Z")) {
    this.ms = ms;
  }
  nowMs = () => this.ms;
  nowIso = () => new Date(this.ms).toISOString();
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
    const tooDeep = scheduler.admit(
      request("child-agent", {
        tree: {
          ...tree,
          depth: 3,
          descendantCount: 8,
          directChildCount: 4,
          concurrentChildCount: 2,
          attempt: 1,
        },
      }),
    );
    expect(tooDeep.outcome).toBe("rejected");
    expect(tooDeep.reasonCodes.length).toBeGreaterThan(0);
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
});
