import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "vite-plus/test";

import {
  SLOT_PATH,
  SLOT_REF,
  acquireSlot,
  acknowledgeSlot,
  checkSlot,
  confirmAck,
  finishSlot,
  formatResultPacket,
  initSharedRemote,
  readSlot,
  startProvider,
} from "./ops-slot.mjs";

const script = NodeURL.fileURLToPath(new URL("./ops-slot.mjs", import.meta.url));

const cli = (args) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${args[0]} exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });

const git = (cwd, args, input) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ops-slot-test",
      GIT_AUTHOR_EMAIL: "ops-slot-test@localhost",
      GIT_COMMITTER_NAME: "ops-slot-test",
      GIT_COMMITTER_EMAIL: "ops-slot-test@localhost",
    },
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });

const temp = (name) => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `ops-slot-${name}-`));

const pair = () => {
  const remotePath = temp("remote");
  initSharedRemote(remotePath);
  const workA = temp("a");
  const workB = temp("b");
  return { remotePath, workA, workB };
};

const remove = (...paths) => {
  for (const path of paths) NodeFS.rmSync(path, { recursive: true, force: true });
};

const remoteSha = (remotePath) => git(remotePath, ["rev-parse", SLOT_REF]).trim();

describe("shared execution slot", () => {
  it("admits one of two working copies", async () => {
    const { remotePath, workA, workB } = pair();
    const [left, right] = await Promise.all([
      cli([
        "acquire",
        "--remote",
        remotePath,
        "--work",
        workA,
        "--task",
        "queue-item",
        "--worker",
        "worker-a",
      ]),
      cli([
        "acquire",
        "--remote",
        remotePath,
        "--work",
        workB,
        "--task",
        "queue-item",
        "--worker",
        "worker-b",
      ]),
    ]);
    const acquired = [left, right].filter((result) => result.ok && result.acquired);
    const blocked = [left, right].filter(
      (result) => result.ok === false && result.reason === "held",
    );
    assert.equal(acquired.length, 1);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].holder, acquired[0].record.workerId);
    assert.notEqual(
      git(workA, ["rev-parse", "--absolute-git-dir"]).trim(),
      git(workB, ["rev-parse", "--absolute-git-dir"]).trim(),
    );
    assert.equal(remoteSha(remotePath), acquired[0].sha);
    remove(remotePath, workA, workB);
  });

  it("ignores a local ref that was never pushed", () => {
    const { remotePath, workA, workB } = pair();
    acquireSlot({ remotePath, workDir: workA, taskId: "queue-item", workerId: "worker-a" });
    const localOnly = temp("local");
    git(localOnly, ["init", "--quiet", "--initial-branch=work"]);
    git(localOnly, ["commit", "--allow-empty", "-m", "local claim"]);
    git(localOnly, ["update-ref", SLOT_REF, "HEAD"]);
    const remoteBefore = remoteSha(remotePath);
    const claimed = acquireSlot({
      remotePath,
      workDir: workB,
      taskId: "other-item",
      workerId: "worker-b",
    });
    assert.equal(claimed.reason, "held");
    assert.equal(claimed.holder, "worker-a");
    assert.equal(remoteSha(remotePath), remoteBefore);
    assert.notEqual(git(localOnly, ["rev-parse", SLOT_REF]).trim(), remoteBefore);
    const sameWorkerOtherTask = acquireSlot({
      remotePath,
      workDir: workA,
      taskId: "other-item",
      workerId: "worker-a",
    });
    assert.equal(sameWorkerOtherTask.reason, "held");
    remove(remotePath, workA, workB, localOnly);
  });

  it("does not send again after restart or a second start", async () => {
    const { remotePath, workA, workB } = pair();
    const effect = NodePath.join(NodeOS.tmpdir(), `ops-slot-effect-${process.pid}.txt`);
    NodeFS.rmSync(effect, { force: true });
    const claimed = await cli([
      "acquire",
      "--remote",
      remotePath,
      "--work",
      workA,
      "--task",
      "queue-item",
      "--worker",
      "worker-a",
    ]);
    assert.equal(claimed.acquired, true);
    await cli([
      "acknowledge",
      "--remote",
      remotePath,
      "--work",
      workA,
      "--worker",
      "worker-a",
      "--effect",
      effect,
    ]);
    const startArgs = (workDir) => [
      "start",
      "--remote",
      remotePath,
      "--work",
      workDir,
      "--worker",
      "worker-a",
      "--effect",
      effect,
    ];
    const [left, right] = await Promise.all([cli(startArgs(workA)), cli(startArgs(workB))]);
    assert.equal(left.ok && right.ok, true);
    assert.equal(left.dispatchId, right.dispatchId);
    const restart = await cli([
      "acquire",
      "--remote",
      remotePath,
      "--work",
      workA,
      "--task",
      "queue-item",
      "--worker",
      "worker-a",
    ]);
    const again = await cli(startArgs(workA));
    const lines = NodeFS.readFileSync(effect, "utf8").trim().split("\n");
    assert.equal(restart.restart, true);
    assert.equal(again.sent, false);
    assert.equal(again.record.dispatchCount, 1);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("worker-a:")),
      [left.dispatchId],
    );
    const other = await cli([
      "acquire",
      "--remote",
      remotePath,
      "--work",
      workB,
      "--task",
      "queue-item",
      "--worker",
      "worker-b",
    ]);
    assert.equal(other.reason, "held");
    NodeFS.rmSync(effect, { force: true });
    remove(remotePath, workA, workB);
  });

  it("keeps an uncertain send pinned and will not expire it", () => {
    const { remotePath, workA, workB } = pair();
    acquireSlot({ remotePath, workDir: workA, taskId: "queue-item", workerId: "worker-a" });
    let comments = 0;
    acknowledgeSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      postComment: () => {
        comments += 1;
        const seen = readSlot({ remotePath, workDir: workA });
        assert.equal(seen.record.state, "ACK_STARTED");
        return "https://example.invalid/comment/1";
      },
    });
    let sends = 0;
    const first = startProvider({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      send: () => {
        sends += 1;
        throw Object.assign(new Error("timeout"), { uncertain: true });
      },
    });
    const second = startProvider({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      send: () => {
        sends += 1;
      },
    });
    const before = remoteSha(remotePath);
    const checked = checkSlot({ remotePath, workDir: workB });
    const refused = finishSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      termination: null,
    });
    const aged = finishSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      termination: { established: true, evidence: "runner exited 0", workerState: "STOPPED" },
      maxAgeMs: 1,
    });
    const stillHeld = acquireSlot({
      remotePath,
      workDir: workB,
      taskId: "queue-item",
      workerId: "worker-b",
    });
    assert.equal(comments, 1);
    assert.equal(first.uncertain, true);
    assert.equal(first.sent, false);
    assert.equal(second.sent, false);
    assert.equal(second.record.state, "UNCERTAIN");
    assert.equal(checked.pinned, true);
    assert.equal(checked.releasable, false);
    assert.equal(checked.expired, false);
    assert.equal(checked.sha, before);
    assert.equal(refused.reason, "termination-not-established");
    assert.equal(refused.redispatched, false);
    assert.equal(aged.reason, "expiry-not-supported");
    assert.equal(aged.redispatched, false);
    assert.equal(stillHeld.reason, "held");
    assert.equal(sends, 1);
    assert.equal(remoteSha(remotePath), before);
    remove(remotePath, workA, workB);
  });

  it("does not post or start again when comment delivery is unknown", () => {
    const { remotePath, workA } = pair();
    acquireSlot({ remotePath, workDir: workA, taskId: "queue-item", workerId: "worker-a" });
    let comments = 0;
    const first = acknowledgeSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      postComment: () => {
        comments += 1;
        throw Object.assign(new Error("timeout"), { uncertain: true });
      },
    });
    const second = acknowledgeSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      postComment: () => {
        comments += 1;
        return "https://example.invalid/comment/2";
      },
    });
    const blocked = startProvider({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      send: () => {
        throw new Error("provider must not start");
      },
    });
    const confirmed = confirmAck({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      commentUrl: "https://example.invalid/comment/1",
    });
    let sends = 0;
    const started = startProvider({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      send: () => {
        sends += 1;
      },
    });
    assert.equal(first.uncertain, true);
    assert.equal(first.posted, false);
    assert.equal(second.posted, false);
    assert.equal(comments, 1);
    assert.equal(blocked.reason, "ack-not-confirmed");
    assert.equal(confirmed.posted, false);
    assert.equal(confirmed.record.state, "ACKED");
    assert.equal(started.sent, true);
    assert.equal(sends, 1);
    remove(remotePath, workA);
  });

  it("releases only the holder and only with termination, leaving the ref", () => {
    const { remotePath, workA, workB } = pair();
    let sends = 0;
    acquireSlot({ remotePath, workDir: workA, taskId: "queue-item", workerId: "worker-a" });
    acknowledgeSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      postComment: () => "https://example.invalid/comment/1",
    });
    startProvider({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      send: () => {
        sends += 1;
      },
    });
    const stranger = finishSlot({
      remotePath,
      workDir: workB,
      workerId: "worker-b",
      termination: { established: true, evidence: "not the holder", workerState: "STOPPED" },
    });
    const released = finishSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      termination: {
        established: true,
        evidence: "https://example.invalid/comment/result",
        workerState: "COMPLETED",
      },
    });
    const listed = git(remotePath, ["ls-remote", "--heads", ".", SLOT_REF]).trim();
    const next = acquireSlot({
      remotePath,
      workDir: workB,
      taskId: "next-item",
      workerId: "worker-b",
    });
    assert.equal(stranger.reason, "not-holder");
    assert.equal(stranger.redispatched, false);
    assert.equal(released.ok, true);
    assert.equal(released.redispatched, false);
    assert.equal(released.record.state, "TERMINAL");
    assert.match(listed, /refs\/heads\/ops\/base3-execution-slot$/);
    assert.equal(next.acquired, true);
    assert.equal(next.record.state, "CLAIMED");
    assert.equal(next.record.dispatchCount, 0);
    assert.equal(next.record.dispatchId, null);
    assert.equal(sends, 1);
    remove(remotePath, workA, workB);
  });

  it("shows a fast-forward push can move a held slot when the lease is omitted", () => {
    const { remotePath, workA, workB } = pair();
    const claimed = acquireSlot({
      remotePath,
      workDir: workA,
      taskId: "queue-item",
      workerId: "worker-a",
    });
    git(workB, ["init", "--quiet", "--initial-branch=work"]);
    git(workB, ["remote", "add", "origin", remotePath]);
    git(workB, ["fetch", "--no-tags", "origin", `${SLOT_REF}:refs/ops-slot/observed`]);
    const parent = git(workB, ["rev-parse", "refs/ops-slot/observed"]).trim();
    const record = {
      schema: 1,
      state: "CLAIMED",
      taskId: "queue-item",
      workerId: "worker-b",
      dispatchId: null,
      dispatchCount: 0,
      ack: null,
      provider: null,
      termination: null,
      claimedAt: "2026-10-11T00:00:00.000Z",
    };
    const blob = git(workB, ["hash-object", "-w", "--stdin"], `${JSON.stringify(record)}\n`).trim();
    const opsTree = git(workB, ["mktree"], `100644 blob ${blob}\texecution-slot.json\n`).trim();
    const root = git(workB, ["mktree"], `040000 tree ${opsTree}\tops\n`).trim();
    const stolen = git(workB, [
      "commit-tree",
      root,
      "-p",
      parent,
      "-m",
      "unsafe fast-forward",
    ]).trim();
    git(workB, ["push", "origin", `${stolen}:${SLOT_REF}`]);
    const after = readSlot({ remotePath, workDir: workA });
    const release = finishSlot({
      remotePath,
      workDir: workA,
      workerId: "worker-a",
      termination: { established: true, evidence: "original holder", workerState: "STOPPED" },
    });
    const workC = temp("c");
    const protocol = acquireSlot({
      remotePath,
      workDir: workC,
      taskId: "queue-item",
      workerId: "worker-c",
    });
    assert.equal(after.record.workerId, "worker-b");
    assert.equal(release.reason, "not-holder");
    assert.equal(protocol.reason, "held");
    assert.equal(protocol.holder, "worker-b");
    assert.equal(claimed.record.workerId, "worker-a");
    remove(remotePath, workA, workB, workC);
  });

  it("requires the result fields event review reads", () => {
    assert.throws(
      () =>
        formatResultPacket({
          dispatch_id: "base3-closed-loop-20261011-01",
          worker_state: "REVIEW_READY",
        }),
      /worker_state must be COMPLETED or STOPPED/,
    );
    const text = formatResultPacket({
      dispatch_id: "base3-closed-loop-20261011-01",
      worker_state: "COMPLETED",
      starting_sha: "abc",
      final_sha: "def",
      branch: "cursor/closed-loop-slot-abd5",
      pr: "https://github.com/charliefq/base3router/pull/23",
      evidence_links: ["https://example.invalid/run"],
      ci_workflow: "Check",
      ci_run: "https://example.invalid/actions/runs/1",
      checkout_sha: "def",
      unresolved_blockers: ["spend limit UNKNOWN"],
      suggested_next_task: "CL-1 evidence paragraph",
    });
    assert.match(text, /dispatch_id: base3-closed-loop-20261011-01/);
    assert.match(text, /worker_state: COMPLETED/);
    assert.match(text, /suggested_next_task: CL-1 evidence paragraph/);
    assert.equal(SLOT_PATH, "ops/execution-slot.json");
  });
});
