import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "vite-plus/test";
import { createMockContentsRemote, acquireSlot, recordValid } from "./ops-contents-slot.mjs";
import { reconcile } from "./ops-reconciler.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const MERGE = "d".repeat(40);
const time = (minute) => `2026-10-11T10:${String(minute).padStart(2, "0")}:00Z`;
const task = (id, startingSha, predecessor = null, dependencies = []) => ({
  id,
  workerId: `worker-${id}`,
  resultAuthorId: "owner",
  branch: `offline/${id}`,
  baseBranch: "accepted-base",
  scope: `scope for ${id}`,
  startingSha,
  requiredCI: { workflow: "CI", check: "Check" },
  predecessor,
  dependencies,
});
const first = task("one", A);
const second = task("two", B, "one", [{ taskId: "one", sha: B }]);
const third = task("three", C, "two", [{ taskId: "two", sha: C }]);

// File-backed test remote only. Each facade independently reads the file; rename
// commits a complete JSON document, and an exclusive directory protects CAS.
function openRemote(directory) {
  const file = NodePath.join(directory, "slot.json");
  const hash = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return {
    read() {
      try {
        const bytes = NodeFS.readFileSync(file, "utf8");
        const record = JSON.parse(bytes);
        return { status: recordValid(record) ? "ok" : "invalid", blobSha: hash(bytes), record };
      } catch {
        return { status: "unreadable", record: null, blobSha: null };
      }
    },
    compareAndSwap({ expectedBlobSha, record }) {
      const lock = NodePath.join(directory, "cas-lock");
      try {
        NodeFS.mkdirSync(lock);
      } catch {
        return { ok: false, status: 409 };
      }
      try {
        const current = this.read();
        if (current.blobSha !== expectedBlobSha) return { ok: false, status: 409 };
        if (!recordValid(record)) return { ok: false, status: 422 };
        const bytes = JSON.stringify(record);
        const temporary = NodePath.join(directory, `${NodeCrypto.randomUUID()}.json`);
        NodeFS.writeFileSync(temporary, bytes);
        NodeFS.renameSync(temporary, file);
        return { ok: true, blobSha: hash(bytes), record };
      } finally {
        NodeFS.rmSync(lock, { recursive: true });
      }
    },
  };
}

function heldRecord() {
  const remote = createMockContentsRemote();
  acquireSlot({ remote, taskId: first.id, workerId: first.workerId });
  return {
    ...remote.read().record,
    state: "DISPATCHED",
    dispatchId: "initial-start",
    dispatchCount: 1,
    commentDelivery: "confirmed",
    commentUrl: "https://example.invalid/start",
    startingSha: A,
    branch: first.branch,
    scope: first.scope,
    ci: { id: "old-ci" },
    resultCheckpoint: "old-result",
    extension: { retain: true },
  };
}

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ops-reconcile-"));
  NodeFS.writeFileSync(NodePath.join(directory, "slot.json"), JSON.stringify(heldRecord()));
  const prs = new Map();
  const comments = new Map();
  const publications = new Map();
  const runs = new Map();
  const starts = new Map();
  const reviews = new Map();
  const calls = { start: 0, review: 0, prPages: [], commentPages: [] };
  let nextNumber = 101;
  let loseStartReceipt = false;
  let loseReviewReceipt = false;
  let decision = "ACCEPTED";
  const paginate = (items, cursor) => {
    const offset = cursor === null ? 0 : Number(cursor);
    return {
      items: items.slice(offset, offset + 1),
      nextCursor: offset + 1 < items.length ? String(offset + 1) : null,
    };
  };
  const github = {
    async listPullRequests({ cursor }) {
      calls.prPages.push(cursor);
      return paginate([...prs.values()], cursor);
    },
    async listComments({ prNumber, cursor }) {
      calls.commentPages.push({ prNumber, cursor });
      return paginate(comments.get(prNumber) ?? [], cursor);
    },
    async getPullRequest(number) {
      return structuredClone(prs.get(number));
    },
    async getPublication({ branch, sha: commit }) {
      return publications.get(`${branch}:${commit}`) ?? null;
    },
    async getCI({ prNumber }) {
      return runs.get(prNumber) ?? null;
    },
  };
  const worker = {
    async start(intent) {
      calls.start += 1;
      const onDisk = openRemote(directory).read().record;
      assert.equal(onDisk.dispatchId, intent.id);
      assert.equal(onDisk.dispatchCount, 1);
      assert.equal(onDisk.coordination.intent.delivery, "started");
      const receipt = {
        dispatchId: intent.id,
        taskId: intent.task.id,
        workerId: intent.task.workerId,
        startingSha: intent.task.startingSha,
        url: `https://example.invalid/start/${intent.id}`,
      };
      starts.set(intent.id, receipt);
      if (loseStartReceipt) throw new Error("receipt lost after send");
      return receipt;
    },
    async findStart(id) {
      return starts.get(id) ?? null;
    },
  };
  const reviewer = {
    async review(request) {
      calls.review += 1;
      const receipt = {
        requestId: request.requestId,
        ownerId: request.ownerId,
        key: request.key,
        headSha: request.packet.finalSha,
        decision,
        evidence: "https://example.invalid/technical-review",
      };
      reviews.set(request.requestId, receipt);
      if (loseReviewReceipt) throw new Error("review receipt lost");
      return receipt;
    },
    async findReview(id) {
      return reviews.get(id) ?? null;
    },
  };
  function report(binding, finalSha, options = {}) {
    const number = nextNumber++;
    const packet = {
      kind: "implementation_result",
      taskId: binding.id,
      workerId: binding.workerId,
      branch: binding.branch,
      startingSha: binding.startingSha,
      finalSha,
      prNumber: number,
      workerState: "COMPLETED",
      classification: options.classification ?? "code",
      predecessor: binding.predecessor,
      dependencies: binding.dependencies,
    };
    const comment = {
      id: `result-${number}`,
      url: `https://example.invalid/comments/${number}`,
      authorId: binding.resultAuthorId,
      authorType: "Bot",
      createdAt: time(1),
      body: JSON.stringify(packet),
    };
    prs.set(number, {
      number,
      branch: binding.branch,
      baseBranch: binding.baseBranch,
      baseSha: binding.startingSha,
      headSha: binding.startingSha,
      mergeSha: MERGE,
    });
    comments.set(number, [{ id: "ack", body: "Taking a look!" }, comment]);
    return { number, packet, comment, binding };
  }
  function publish(delivery, options = {}) {
    prs.get(delivery.number).headSha = delivery.packet.finalSha;
    publications.set(`${delivery.binding.branch}:${delivery.packet.finalSha}`, {
      branch: delivery.binding.branch,
      sha: delivery.packet.finalSha,
      firstPublishedAt: options.at ?? time(2),
    });
    runs.set(delivery.number, {
      workflow: "CI",
      check: "Check",
      id: `ci-${delivery.number}`,
      url: `https://example.invalid/runs/${delivery.number}`,
      headSha: delivery.packet.finalSha,
      checkoutSha: MERGE,
      baseSha: delivery.binding.startingSha,
      mergeParents: [delivery.binding.startingSha, delivery.packet.finalSha],
      status: options.status ?? "completed",
      conclusion: options.conclusion ?? "success",
    });
  }
  const run = (options = {}) =>
    reconcile({
      source: "periodic",
      ownerId: "reviewer-a",
      remote: openRemote(directory),
      github,
      reviewer,
      worker,
      tasks: [first, second, third],
      ...options,
    });
  return {
    directory,
    github,
    worker,
    reviewer,
    calls,
    prs,
    comments,
    publications,
    runs,
    starts,
    reviews,
    report,
    publish,
    run,
    read: () => openRemote(directory).read().record,
    loseStart: () => {
      loseStartReceipt = true;
    },
    loseReview: () => {
      loseReviewReceipt = true;
    },
    rejectReview: () => {
      decision = "CHANGES_REQUIRED";
    },
    dispose: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
  };
}

describe("offline closed-loop reconciler", () => {
  it("reopens durable checkpoints through two result-before-push, delayed-CI cycles", async () => {
    const f = fixture();
    try {
      for (const [binding, finalSha, successor] of [
        [first, B, second],
        [second, C, third],
      ]) {
        const delivery = f.report(binding, finalSha);
        assert.equal((await f.run({ source: "event" })).status, "PUBLICATION_WAIT");
        f.publish(delivery, { status: "in_progress", conclusion: null });
        assert.equal((await f.run()).status, "CI_WAIT");
        assert.equal(f.read().coordination.results.at(-1).phase, "CI_WAIT");
        const waiting = f.read();
        assert.equal((await f.run()).status, "CI_WAIT");
        assert.deepEqual(f.read(), waiting, "an unchanged checkpoint must not churn the ledger");
        f.runs.get(delivery.number).status = "completed";
        f.runs.get(delivery.number).conclusion = "success";
        assert.equal((await f.run()).status, "DISPATCH_CONFIRMED");
        const saved = f.read();
        assert.equal(saved.taskId, successor.id);
        assert.equal(saved.scope, successor.scope);
        assert.equal(saved.startingSha, finalSha);
        assert.isNull(saved.ci);
        assert.isNull(saved.resultCheckpoint);
        assert.deepEqual(saved.extension, { retain: true });
        assert.equal(saved.coordination.results.at(-1).phase, "ACCEPTED");
        assert.equal(saved.coordination.intent.task.id, successor.id);
        assert.isUndefined(saved.coordination.intent.task.ci);
        assert.equal((await f.run()).status, "NO_RESULT");
      }
      assert.equal(f.calls.start, 2);
      assert.equal(f.calls.review, 2);
      assert.equal(f.read().coordination.results.length, 2);
      const confirmed = f
        .read()
        .coordination.history.filter((event) => event.action === "dispatch-confirmed");
      assert.deepEqual(
        confirmed.map((event) => event.intent.task.id),
        [second.id, third.id],
      );
      assert.isTrue(
        confirmed.every((event) => event.intent.receipt.dispatchId === event.dispatchId),
      );
      assert.deepEqual(
        confirmed.map((event) => event.intent.predecessorResultKey),
        f.read().coordination.results.map((result) => result.key),
      );
      const generations = f.read().coordination.history.map((event) => event.generation);
      assert.deepEqual(
        generations,
        [...new Set(generations)].sort((a, b) => a - b),
      );
      assert.include(f.calls.prPages, "1");
      assert.isTrue(f.calls.commentPages.some((page) => page.cursor === "1"));
    } finally {
      f.dispose();
    }
  });

  it("races event and periodic readers into one review owner and one send", async () => {
    const f = fixture();
    try {
      const delivery = f.report(first, B);
      await f.run();
      f.publish(delivery);
      await Promise.all([
        f.run({ source: "event", ownerId: "event-reviewer" }),
        f.run({ source: "periodic", ownerId: "periodic-reviewer" }),
      ]);
      await f.run();
      assert.equal(f.calls.review, 1);
      assert.equal(f.calls.start, 1);
      assert.equal(f.read().coordination.results[0].phase, "ACCEPTED");
      assert.include(
        ["event-reviewer", "periodic-reviewer"],
        f.read().coordination.results[0].review.ownerId,
      );
    } finally {
      f.dispose();
    }
  });

  it("recovers a lost start receipt after reopening without sending again", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      f.loseStart();
      assert.equal((await f.run()).reason, "unconfirmed-dispatch");
      assert.equal(f.read().state, "UNCERTAIN");
      assert.equal((await f.run()).status, "DISPATCH_CONFIRMED");
      await f.run();
      assert.equal(f.calls.start, 1);
    } finally {
      f.dispose();
    }
  });

  it("pins a crash after intent commit but before start; absence is not permission to retry", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      const remote = openRemote(f.directory);
      const crashing = {
        read: () => remote.read(),
        compareAndSwap(input) {
          const result = remote.compareAndSwap(input);
          if (input.record.coordination.history.at(-1).action === "successor-reserved")
            throw new Error("crash");
          return result;
        },
      };
      await f.run({ remote: crashing });
      assert.equal((await f.run()).reason, "unconfirmed-dispatch");
      assert.equal(f.read().state, "DISPATCHED");
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("recovers a technical review receipt without re-reviewing", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      f.loseReview();
      await f.run();
      assert.equal(f.read().coordination.results[0].phase, "REVIEWING");
      assert.equal((await f.run({ ownerId: "restart-reader" })).status, "DISPATCH_CONFIRMED");
      assert.equal(f.calls.review, 1);
      assert.equal(f.calls.start, 1);
    } finally {
      f.dispose();
    }
  });

  it("does not equate a green CI with technical acceptance", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      f.rejectReview();
      assert.equal((await f.run()).status, "CHANGES_REQUIRED");
      await f.run();
      assert.equal(f.calls.start, 0);
      assert.equal(f.calls.review, 1);
      assert.notEqual(f.read().state, "TERMINAL");
    } finally {
      f.dispose();
    }
  });

  it("reconciles bot-only no-code results and duplicate or harmlessly edited comments once", async () => {
    const f = fixture();
    try {
      const delivery = f.report(first, A, { classification: "no_code" });
      f.publish(delivery, { at: time(0) });
      f.runs.get(delivery.number).checkoutSha = A;
      f.comments
        .get(delivery.number)
        .push({ ...delivery.comment, id: "duplicate", createdAt: time(3) });
      assert.equal((await f.run({ tasks: [first] })).status, "ACCEPTED");
      delivery.comment.body = JSON.stringify(
        { ...delivery.packet, note: "clarified wording" },
        null,
        2,
      );
      assert.equal((await f.run({ tasks: [first], source: "event" })).status, "ACCEPTED");
      assert.equal(f.calls.review, 1);
      assert.equal(f.read().coordination.results.length, 1);
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it.each([
    [
      "unrelated green check",
      "ci-check-mismatch",
      (f, d) => {
        f.runs.get(d.number).check = "Lint";
      },
    ],
    [
      "wrong published head",
      "published-sha-mismatch",
      (f, d) => {
        f.prs.get(d.number).headSha = C;
      },
    ],
    [
      "wrong CI head",
      "ci-head-mismatch",
      (f, d) => {
        f.runs.get(d.number).headSha = C;
      },
    ],
    [
      "unproven test merge",
      "ci-checkout-mismatch",
      (f, d) => {
        f.runs.get(d.number).mergeParents = [A, C];
      },
    ],
    [
      "wrong CI base",
      "ci-checkout-mismatch",
      (f, d) => {
        f.runs.get(d.number).baseSha = C;
      },
    ],
    [
      "failed CI",
      "ci-not-successful",
      (f, d) => {
        f.runs.get(d.number).conclusion = "failure";
      },
    ],
    [
      "result after push",
      "result-not-before-publication",
      (f, d) => {
        f.publish(d, { at: time(0) });
      },
    ],
    [
      "spoofed author",
      "invalid-result-binding",
      (_f, d) => {
        d.comment.authorId = "stranger";
      },
    ],
    [
      "stopped worker",
      "worker-stopped",
      (_f, d) => {
        d.comment.body = JSON.stringify({ ...d.packet, workerState: "STOPPED" });
      },
    ],
  ])("fails closed for %s", async (_name, reason, alter) => {
    const f = fixture();
    try {
      const delivery = f.report(first, B);
      f.publish(delivery);
      alter(f, delivery);
      assert.equal((await f.run()).reason, reason);
      assert.equal(f.calls.start, 0);
      assert.equal(f.calls.review, 0);
    } finally {
      f.dispose();
    }
  });

  it("rejects result identity edits after a durable CI_WAIT", async () => {
    const f = fixture();
    try {
      const delivery = f.report(first, B);
      f.publish(delivery, { status: "in_progress" });
      await f.run();
      delivery.comment.body = JSON.stringify({ ...delivery.packet, finalSha: C });
      assert.equal((await f.run()).reason, "changed-result-binding");
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("refuses unaccepted dependencies and does not use a stale active label as termination", async () => {
    const f = fixture();
    try {
      const original = f.read();
      assert.equal((await f.run()).status, "NO_RESULT");
      assert.deepEqual(f.read(), original);
      const bound = { ...first, dependencies: [{ taskId: "unreviewed", sha: C }] };
      f.publish(f.report(bound, B));
      assert.equal((await f.run({ tasks: [bound] })).reason, "dependency-not-accepted");
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("blocks malformed slots without replacing them", async () => {
    const f = fixture();
    try {
      for (const bytes of [
        "{",
        "null",
        "{}",
        JSON.stringify({ ...heldRecord(), coordination: {} }),
      ]) {
        NodeFS.writeFileSync(NodePath.join(f.directory, "slot.json"), bytes);
        assert.equal((await f.run()).status, "BLOCKED");
        assert.equal(NodeFS.readFileSync(NodePath.join(f.directory, "slot.json"), "utf8"), bytes);
      }
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("rechecks head changes made during technical review before reserving a successor", async () => {
    const f = fixture();
    try {
      const delivery = f.report(first, B);
      f.publish(delivery);
      const reviewer = {
        ...f.reviewer,
        async review(request) {
          const receipt = await f.reviewer.review(request);
          f.prs.get(delivery.number).headSha = C;
          return receipt;
        },
      };
      assert.equal((await f.run({ reviewer })).reason, "published-sha-mismatch");
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("waits for an explicit technical receipt when green CI has no review result", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      let reviews = 0;
      const reviewer = {
        async review() {
          reviews += 1;
          return null;
        },
        async findReview() {
          return null;
        },
      };
      assert.equal((await f.run({ reviewer })).status, "REVIEW_WAIT");
      assert.equal((await f.run({ reviewer, ownerId: "other-reader" })).status, "REVIEW_WAIT");
      assert.equal(reviews, 1);
      assert.equal(f.calls.start, 0);
      assert.equal(f.read().coordination.results[0].phase, "REVIEWING");
    } finally {
      f.dispose();
    }
  });

  it("rejects a review receipt for another SHA", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      const reviewer = {
        ...f.reviewer,
        async review(request) {
          return { ...(await f.reviewer.review(request)), headSha: C };
        },
      };
      assert.equal((await f.run({ reviewer })).reason, "invalid-review-receipt");
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("pins a nonmatching worker receipt and never treats it as a confirmed start", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      const worker = {
        async start(intent) {
          return { ...(await f.worker.start(intent)), workerId: "someone-else" };
        },
        async findStart() {
          return null;
        },
      };
      assert.equal((await f.run({ worker })).reason, "unconfirmed-dispatch");
      assert.equal((await f.run({ worker })).reason, "unconfirmed-dispatch");
      assert.equal(f.calls.start, 1);
      assert.equal(f.read().commentDelivery, "started");
    } finally {
      f.dispose();
    }
  });

  it("blocks a successor with stale scope binding after restart", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      await f.run();
      const before = f.read();
      const changed = { ...second, scope: "silently replaced scope" };
      assert.equal((await f.run({ tasks: [first, changed, third] })).reason, "slot-task-mismatch");
      assert.deepEqual(f.read(), before);
      assert.equal(f.calls.start, 1);
    } finally {
      f.dispose();
    }
  });

  it("rejects an ACCEPTED checkpoint without its technical receipt", async () => {
    const f = fixture();
    try {
      const delivery = f.report(first, B);
      f.publish(delivery, { status: "in_progress" });
      await f.run();
      const corrupted = f.read();
      corrupted.coordination.results[0].phase = "ACCEPTED";
      NodeFS.writeFileSync(NodePath.join(f.directory, "slot.json"), JSON.stringify(corrupted));
      assert.equal((await f.run()).reason, "invalid-coordination-state");
      assert.deepEqual(f.read(), corrupted);
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("rejects a contradictory terminal packet even when its fingerprint is recomputed", async () => {
    const f = fixture();
    try {
      const delivery = f.report(first, B);
      f.publish(delivery);
      await f.run({ tasks: [first] });
      const corrupted = f.read();
      const result = corrupted.coordination.results[0];
      result.packet.workerState = "STOPPED";
      delivery.comment.body = JSON.stringify({ ...delivery.packet, workerState: "STOPPED" });
      result.fingerprint = NodeCrypto.createHash("sha256")
        .update(JSON.stringify(result.packet))
        .digest("hex");
      NodeFS.writeFileSync(NodePath.join(f.directory, "slot.json"), JSON.stringify(corrupted));
      assert.equal((await f.run({ tasks: [first] })).reason, "invalid-coordination-state");
      assert.deepEqual(f.read(), corrupted);
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("fails closed on discovery errors and repeated cursors without changing the slot", async () => {
    const f = fixture();
    try {
      const before = f.read();
      const github = {
        ...f.github,
        async listPullRequests() {
          return { items: [], nextCursor: "again" };
        },
      };
      assert.equal((await f.run({ github })).reason, "pagination-cycle");
      assert.deepEqual(f.read(), before);
      github.listPullRequests = async () => {
        throw new Error("read unavailable");
      };
      assert.equal((await f.run({ github })).reason, "read unavailable");
      assert.deepEqual(f.read(), before);
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });

  it("records a terminal accepted task without dispatching an unaccepted dependency", async () => {
    const f = fixture();
    try {
      f.publish(f.report(first, B));
      const dependent = {
        ...second,
        dependencies: [...second.dependencies, { taskId: "missing", sha: C }],
      };
      assert.equal(
        (await f.run({ tasks: [first, dependent] })).reason,
        "successor-dependency-mismatch",
      );
      assert.equal(f.read().state, "TERMINAL");
      assert.equal(f.read().coordination.results[0].phase, "ACCEPTED");
      assert.equal(f.calls.start, 0);
    } finally {
      f.dispose();
    }
  });
});
