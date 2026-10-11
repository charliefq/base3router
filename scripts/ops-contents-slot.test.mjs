import { assert, describe, it } from "vite-plus/test";

import {
  acquireSlot,
  checkSlot,
  createMockContentsRemote,
  finishSlot,
  reserveDispatch,
} from "./ops-contents-slot.mjs";

const uncertain = () => Object.assign(new Error("timeout"), { uncertain: true });

describe("contents slot", () => {
  it("gives one of two readers the blob and returns 409 to the other", () => {
    const remote = createMockContentsRemote({ branchExists: false });
    const first = remote.read();
    const second = remote.read();
    assert.equal(first.status, "absent-branch");
    assert.equal(second.blobSha, first.blobSha);
    const winner = acquireSlot({ remote, taskId: "queue-item", workerId: "worker-a" });
    const loser = remote.compareAndSwap({
      expectedBlobSha: second.blobSha,
      record: { state: "CLAIMED", workerId: "worker-b", generation: 1, nonce: "stale" },
    });
    assert.equal(winner.acquired, true);
    assert.equal(loser.ok, false);
    assert.equal(loser.status, 409);
    assert.equal(remote.read().record.workerId, "worker-a");
  });

  it("does not post again on restart or after an uncertain comment", () => {
    const remote = createMockContentsRemote();
    acquireSlot({ remote, taskId: "queue-item", workerId: "worker-a" });
    let posts = 0;
    const first = reserveDispatch({
      remote,
      workerId: "worker-a",
      postComment: () => {
        posts += 1;
        const seen = remote.read();
        assert.equal(seen.record.state, "DISPATCHED");
        assert.equal(seen.record.dispatchCount, 1);
        throw uncertain();
      },
    });
    const restart = acquireSlot({ remote, taskId: "queue-item", workerId: "worker-a" });
    const second = reserveDispatch({
      remote,
      workerId: "worker-a",
      postComment: () => {
        posts += 1;
        return "https://example.invalid/comment/2";
      },
    });
    const other = acquireSlot({ remote, taskId: "queue-item", workerId: "worker-b" });
    assert.equal(first.uncertain, true);
    assert.equal(first.posted, false);
    assert.equal(restart.restart, true);
    assert.equal(second.posted, false);
    assert.equal(second.record.state, "UNCERTAIN");
    assert.equal(other.reason, "held");
    assert.equal(posts, 1);
  });

  it("blocks a missing or unreadable file on an existing branch", () => {
    const missing = createMockContentsRemote({ branchExists: true, bytes: null });
    const missingCheck = checkSlot(missing);
    const missingAcquire = acquireSlot({
      remote: missing,
      taskId: "queue-item",
      workerId: "worker-a",
    });
    assert.equal(missingCheck.reason, "blocked");
    assert.equal(missingCheck.occupied, true);
    assert.equal(missingAcquire.reason, "blocked");
    assert.equal(missing.read().status, "missing-file");

    const broken = createMockContentsRemote({ branchExists: true, bytes: "{not json" });
    assert.equal(checkSlot(broken).reason, "blocked");
    assert.equal(
      acquireSlot({ remote: broken, taskId: "queue-item", workerId: "worker-a" }).reason,
      "blocked",
    );
    assert.equal(broken.read().status, "unreadable");
  });

  it("releases only for observed termination and keeps generations moving forward", () => {
    const remote = createMockContentsRemote();
    const claimed = acquireSlot({ remote, taskId: "queue-item", workerId: "worker-a" });
    let posts = 0;
    const sent = reserveDispatch({
      remote,
      workerId: "worker-a",
      postComment: (dispatchId) => {
        posts += 1;
        return `https://example.invalid/comment/${dispatchId}`;
      },
    });
    const reserved = remote.read().record;
    const refused = finishSlot({ remote, workerId: "worker-a", termination: null });
    const aged = finishSlot({
      remote,
      workerId: "worker-a",
      termination: { established: true, evidence: "seen", workerState: "STOPPED" },
      maxAgeMs: 1,
    });
    const stranger = finishSlot({
      remote,
      workerId: "worker-b",
      termination: { established: true, evidence: "seen", workerState: "STOPPED" },
    });
    const released = finishSlot({
      remote,
      workerId: "worker-a",
      termination: {
        established: true,
        evidence: "https://example.invalid/comment/result",
        workerState: "COMPLETED",
      },
    });
    const after = remote.read();
    const next = acquireSlot({ remote, taskId: "next-item", workerId: "worker-b" });
    assert.equal(sent.posted, true);
    assert.equal(sent.record.commentUrl, "https://example.invalid/comment/worker-a:queue-item:1");
    assert.equal(refused.reason, "termination-not-established");
    assert.equal(refused.redispatched, false);
    assert.equal(aged.reason, "expiry-not-supported");
    assert.equal(stranger.reason, "not-holder");
    assert.equal(released.ok, true);
    assert.equal(released.redispatched, false);
    assert.equal(after.status, "ok");
    assert.equal(after.record.state, "TERMINAL");
    assert.equal(next.acquired, true);
    assert.equal(next.record.dispatchCount, 0);
    assert.ok(reserved.generation > claimed.record.generation);
    assert.ok(released.record.generation > reserved.generation);
    assert.ok(next.record.generation > released.record.generation);
    assert.equal(
      new Set([claimed.record.nonce, reserved.nonce, released.record.nonce, next.record.nonce])
        .size,
      4,
    );
    assert.notEqual(claimed.blobSha, sent.blobSha);
    assert.equal(posts, 1);
    assert.equal(checkSlot(remote).expired, false);
  });
});
