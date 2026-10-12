import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "vite-plus/test";
import { createReceiptStore, openReceiptStore } from "./ops-receipt-store.mjs";
import { createReadOnlyAdapters, lookupReceipt } from "./ops-evidence-adapters.mjs";

const entry = (kind = "start", state = "pending") => {
  const binding =
    kind === "start"
      ? { taskId: "isolated-task", workerId: "fake-worker", startingSha: "a".repeat(40) }
      : { ownerId: "fake-reviewer", key: "result:1", headSha: "a".repeat(40) };
  const receipt =
    kind === "start"
      ? { ...binding, dispatchId: "intent-1", url: "https://example.invalid/start" }
      : { ...binding, requestId: "intent-1", decision: "ACCEPTED", evidence: "fixture-only" };
  return { kind, id: "intent-1", binding, state, receipt: state === "confirmed" ? receipt : null };
};
function fixture(options = {}) {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "receipt-store-test-"));
  const store = createReceiptStore({ parentDirectory: parent, ...options });
  return {
    parent,
    store,
    reopen: (extra = {}) =>
      openReceiptStore({ directory: store.directory, storeId: store.storeId, ...extra }),
    clean: () => NodeFS.rmSync(parent, { recursive: true, force: true }),
  };
}

describe("isolated local receipt persistence", () => {
  it("rejects a FIFO journal without blocking the writer lock", () => {
    const f = fixture();
    try {
      const file = NodePath.join(f.store.directory, "journal.json");
      NodeFS.unlinkSync(file);
      const fifo = NodeChildProcess.spawnSync("mkfifo", [file], { timeout: 2000 });
      assert.equal(fifo.status, 0);
      const moduleUrl = new URL("./ops-receipt-store.mjs", import.meta.url).href;
      const script = `import { openReceiptStore } from ${JSON.stringify(moduleUrl)};
        try { openReceiptStore({directory: process.argv[1], storeId: process.argv[2]}).read(); process.exit(2); }
        catch (error) { if (error.message !== 'receipt-store-unreadable') process.exit(3); }`;
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script, f.store.directory, f.store.storeId],
        { timeout: 1500, killSignal: "SIGKILL", encoding: "utf8" },
      );
      assert.equal(
        child.error?.code,
        undefined,
        "FIFO read must finish before the bounded child timeout",
      );
      assert.equal(child.status, 0);
      assert.equal(NodeFS.existsSync(NodePath.join(f.store.directory, "writer.lock")), false);
      assert.equal(NodeFS.lstatSync(file).isFIFO(), true);
    } finally {
      f.clean();
    }
  });

  it.each(["start", "review"])("recovers one confirmed %s record without sending", async (kind) => {
    const f = fixture();
    try {
      let token = f.store.snapshot().token;
      token = f.store.record({ expected: token, entry: entry(kind) }).token;
      token = f.reopen().record({ expected: token, entry: entry(kind, "uncertain") }).token;
      assert.equal(
        lookupReceipt(f.reopen().read(), kind, "intent-1", entry(kind).binding).status,
        "unknown",
      );
      const confirmed = entry(kind, "confirmed");
      token = f.reopen().record({ expected: token, entry: confirmed }).token;
      const replay = f.reopen().record({ expected: token, entry: confirmed });
      assert.equal(replay.changed, false);
      assert.deepEqual(replay.token, token);
      assert.equal(f.reopen().read().entries.length, 1);
      const adapters = createReadOnlyAdapters({
        repository: "fixture/repo",
        receiptStore: f.reopen(),
        receiptBindings: { [`${kind}:intent-1`]: confirmed.binding },
      });
      const result =
        kind === "start"
          ? await adapters.worker.findStart("intent-1")
          : await adapters.reviewer.findReview("intent-1");
      assert.deepEqual(result, confirmed.receipt);
      assert.throws(() => adapters.worker.start({}), /offline-write-disabled/);
      assert.throws(() => adapters.reviewer.review({}), /offline-write-disabled/);
    } finally {
      f.clean();
    }
  });

  it("rejects stale generation/digest/store identity before appending a successor", () => {
    const f = fixture();
    try {
      const old = f.store.snapshot().token;
      const current = f.store.record({ expected: old, entry: entry() }).token;
      const next = {
        ...entry(),
        id: "intent-2",
        binding: { ...entry().binding, taskId: "new-task" },
      };
      for (const expected of [old, { ...current, digest: "bad" }, { ...current, storeId: "other" }])
        assert.throws(() => f.reopen().record({ expected, entry: next }), /receipt-cas-conflict/);
      assert.equal(f.store.read().entries.length, 1);
      assert.deepEqual(f.store.snapshot().token, current);
    } finally {
      f.clean();
    }
  });

  it.each(["binding", "receipt", "regression"])(
    "cannot overwrite a confirmed receipt with %s changes",
    (change) => {
      const f = fixture();
      try {
        const good = entry("start", "confirmed");
        const token = f.store.record({ expected: f.store.snapshot().token, entry: good }).token;
        const bad = structuredClone(good);
        if (change === "binding") {
          bad.binding.workerId = "other";
          bad.receipt.workerId = "other";
        }
        if (change === "receipt") bad.receipt.url = "https://example.invalid/conflict";
        if (change === "regression") {
          bad.state = "pending";
          bad.receipt = null;
        }
        assert.throws(() => f.reopen().record({ expected: token, entry: bad }));
        assert.deepEqual(f.reopen().read().entries, [good]);
      } finally {
        f.clean();
      }
    },
  );

  it.each([
    "missing",
    "truncated",
    "digest",
    "duplicate",
    "invalid-state",
    "wrong-store",
    "symlink",
  ])("fails closed for %s journal without repairing it", (change) => {
    const f = fixture();
    try {
      const file = NodePath.join(f.store.directory, "journal.json");
      const saved = NodeFS.readFileSync(file, "utf8");
      if (change === "missing") NodeFS.unlinkSync(file);
      else if (change === "truncated") NodeFS.writeFileSync(file, saved.slice(0, -10));
      else if (change === "symlink") {
        const other = NodePath.join(f.parent, "other.json");
        NodeFS.writeFileSync(other, saved);
        NodeFS.unlinkSync(file);
        NodeFS.symlinkSync(other, file);
      } else {
        const envelope = JSON.parse(saved);
        if (change === "digest") envelope.digest = "wrong";
        else {
          if (change === "duplicate") envelope.payload.journal.entries = [entry(), entry()];
          if (change === "invalid-state")
            envelope.payload.journal.entries = [{ ...entry(), state: "made-up" }];
          if (change === "wrong-store") envelope.payload.storeId = NodeCrypto.randomUUID();
          envelope.digest = NodeCrypto.createHash("sha256")
            .update(JSON.stringify(envelope.payload))
            .digest("hex");
        }
        NodeFS.writeFileSync(file, JSON.stringify(envelope));
      }
      assert.throws(() => f.reopen().read(), /receipt-store-unreadable/);
      assert.equal(NodeFS.existsSync(file), change !== "missing");
    } finally {
      f.clean();
    }
  });

  it.each(["pending", "uncertain"])(
    "missing confirmation remains unknown after %s reopen",
    (state) => {
      const f = fixture();
      try {
        f.store.record({ expected: f.store.snapshot().token, entry: entry("start", state) });
        const found = lookupReceipt(f.reopen().read(), "start", "intent-1", entry().binding);
        assert.equal(found.status, "unknown");
        assert.equal(found.reason, `receipt-${state}`);
      } finally {
        f.clean();
      }
    },
  );

  it.each(["after-write", "after-file-sync", "after-rename", "after-directory-sync"])(
    "retains the recovery lock after injected failure at %s",
    (stage) => {
      const f = fixture();
      try {
        let token = f.store.record({ expected: f.store.snapshot().token, entry: entry() }).token;
        const broken = f.reopen({
          fault: (point) => {
            if (point === stage) throw new Error("injected-io-failure");
          },
        });
        assert.throws(
          () => broken.record({ expected: token, entry: entry("start", "confirmed") }),
          /injected-io-failure/,
        );
        assert.throws(() => f.reopen().read(), /receipt-store-locked-or-inaccessible/);
        // Test-only recovery: the synchronous writer has exited its call, all FDs are closed.
        // The production API deliberately cannot steal/remove stale locks.
        NodeFS.unlinkSync(NodePath.join(f.store.directory, "writer.lock"));
        const recovered = f.reopen().snapshot();
        const renamed = stage === "after-rename" || stage === "after-directory-sync";
        assert.equal(recovered.journal.entries[0].state, renamed ? "confirmed" : "pending");
        assert.equal(recovered.journal.entries.length, 1);
        if (renamed)
          assert.throws(
            () => f.store.record({ expected: token, entry: entry("start", "confirmed") }),
            /receipt-cas-conflict/,
          );
        token = recovered.token;
        f.store.record({ expected: token, entry: entry("start", "confirmed") });
        assert.equal(f.store.read().entries.length, 1);
      } finally {
        f.clean();
      }
    },
  );

  it("recovers a committed receipt after its caller loses the return value", () => {
    const f = fixture();
    try {
      const old = f.store.snapshot().token;
      f.store.record({ expected: old, entry: entry("start", "confirmed") });
      assert.throws(
        () => f.reopen().record({ expected: old, entry: entry("start", "confirmed") }),
        /receipt-cas-conflict/,
      );
      const current = f.reopen().snapshot();
      assert.equal(
        f.reopen().record({ expected: current.token, entry: entry("start", "confirmed") }).changed,
        false,
      );
      assert.equal(current.journal.entries.length, 1);
    } finally {
      f.clean();
    }
  });

  it.each(["none", "locked", "after-file-sync", "after-rename"])(
    "rejects another process while the writer holds a lock (crash=%s)",
    async (crash) => {
      const f = fixture();
      let child;
      try {
        const expected = f.store.snapshot().token;
        const moduleUrl = new URL("./ops-receipt-store.mjs", import.meta.url).href;
        const ready = NodePath.join(f.parent, "ready");
        const release = NodePath.join(f.parent, "release");
        const script = `import * as fs from 'node:fs'; import { openReceiptStore } from ${JSON.stringify(moduleUrl)};
        const [directory, storeId, expected, entry, ready, release, crash] = process.argv.slice(1);
        const store = openReceiptStore({directory, storeId, fault(stage) {
          if (stage === 'locked') {
            fs.writeFileSync(ready, 'ready');
            while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          if (stage === crash) process.exit(23);
        }});
        store.record({expected: JSON.parse(expected), entry: JSON.parse(entry)});`;
        child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            script,
            f.store.directory,
            f.store.storeId,
            JSON.stringify(expected),
            JSON.stringify(entry("start", "confirmed")),
            ready,
            release,
            String(crash),
          ],
          { stdio: "ignore" },
        );
        const exited = new Promise((resolve, reject) => {
          child.once("exit", resolve);
          child.once("error", reject);
        });
        const deadline = Date.now() + 5000;
        while (!NodeFS.existsSync(ready) && Date.now() < deadline && child.exitCode === null)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(NodeFS.existsSync(ready), true);
        assert.throws(
          () => f.store.record({ expected, entry: entry("start", "confirmed") }),
          /receipt-store-locked-or-inaccessible/,
        );
        assert.throws(() => f.store.read(), /receipt-store-locked-or-inaccessible/);
        NodeFS.writeFileSync(release, "release");
        assert.equal(await exited, crash === "none" ? 0 : 23);
        if (crash !== "none") {
          assert.throws(() => f.reopen().read(), /receipt-store-locked-or-inaccessible/);
          // Independent child exit is established. Removal is an isolated test action only.
          NodeFS.unlinkSync(NodePath.join(f.store.directory, "writer.lock"));
          const entries = f.reopen().read().entries;
          assert.equal(entries.length, crash === "after-rename" ? 1 : 0);
          if (entries.length) assert.equal(entries[0].state, "confirmed");
        } else assert.equal(f.reopen().read().entries.length, 1);
      } finally {
        if (child && child.exitCode === null) child.kill();
        f.clean();
      }
    },
  );

  it("rejects paths outside the temporary root", () => {
    NodeAssert.throws(
      () => createReceiptStore({ parentDirectory: NodePath.parse(NodeOS.tmpdir()).root }),
      /store-outside-temporary-root/,
    );
  });
});
