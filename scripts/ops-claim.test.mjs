import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claimTask, dispatchTask, initClaimRepo, releaseTask } from "./ops-claim.mjs";

const script = NodeURL.fileURLToPath(new URL("./ops-claim.mjs", import.meta.url));

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

const tempRepo = () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ops-claim-"));
  initClaimRepo(repo);
  return repo;
};

describe("ops claim", () => {
  it("gives one of two concurrent workers the claim", async () => {
    const repo = tempRepo();
    const [left, right] = await Promise.all([
      cli(["claim", "--repo", repo, "--task", "queue-item", "--worker", "worker-a"]),
      cli(["claim", "--repo", repo, "--task", "queue-item", "--worker", "worker-b"]),
    ]);
    const acquired = [left, right].filter((result) => result.ok && result.acquired);
    const held = [left, right].filter((result) => result.ok === false && result.reason === "held");
    assert.equal(acquired.length, 1);
    assert.equal(held.length, 1);
    assert.equal(held[0].holder, acquired[0].record.workerId);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("does not dispatch again when the holding worker restarts", () => {
    const repo = tempRepo();
    const effect = NodePath.join(repo, "dispatches.txt");
    const claimed = claimTask({ repo, taskId: "queue-item", workerId: "worker-a" });
    assert.equal(claimed.acquired, true);
    let sends = 0;
    const first = dispatchTask({
      repo,
      taskId: "queue-item",
      workerId: "worker-a",
      dispatch: () => {
        sends += 1;
      },
    });
    const restart = claimTask({ repo, taskId: "queue-item", workerId: "worker-a" });
    const second = dispatchTask({
      repo,
      taskId: "queue-item",
      workerId: "worker-a",
      dispatch: () => {
        sends += 1;
      },
    });
    assert.equal(restart.restart, true);
    assert.equal(first.dispatchId, second.dispatchId);
    assert.equal(second.record.dispatchCount, 1);
    assert.equal(sends, 1);
    assert.equal(NodeFS.existsSync(effect), false);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("lets only one of two concurrent dispatch calls send", async () => {
    const repo = tempRepo();
    const effect = NodePath.join(NodeOS.tmpdir(), `ops-claim-effect-${process.pid}.txt`);
    NodeFS.rmSync(effect, { force: true });
    const claimed = claimTask({ repo, taskId: "queue-item", workerId: "worker-a" });
    assert.equal(claimed.acquired, true);
    const args = [
      "dispatch",
      "--repo",
      repo,
      "--task",
      "queue-item",
      "--worker",
      "worker-a",
      "--effect",
      effect,
    ];
    const [left, right] = await Promise.all([cli(args), cli(args)]);
    assert.equal(left.ok && right.ok, true);
    assert.equal(left.dispatchId, right.dispatchId);
    const lines = NodeFS.readFileSync(effect, "utf8").trim().split("\n");
    assert.deepEqual(lines, [left.dispatchId]);
    NodeFS.rmSync(effect, { force: true });
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("keeps an active claim until termination evidence is supplied", () => {
    const repo = tempRepo();
    let sends = 0;
    claimTask({ repo, taskId: "queue-item", workerId: "worker-a" });
    dispatchTask({
      repo,
      taskId: "queue-item",
      workerId: "worker-a",
      dispatch: () => {
        sends += 1;
      },
    });
    const refused = releaseTask({
      repo,
      taskId: "queue-item",
      workerId: "worker-a",
      termination: null,
    });
    const stillHeld = claimTask({ repo, taskId: "queue-item", workerId: "worker-b" });
    const released = releaseTask({
      repo,
      taskId: "queue-item",
      workerId: "worker-a",
      termination: { established: true, evidence: "runner process exited 0 and was reaped" },
    });
    const next = claimTask({ repo, taskId: "queue-item", workerId: "worker-b" });
    assert.equal(refused.reason, "termination-not-established");
    assert.equal(refused.redispatched, false);
    assert.equal(stillHeld.reason, "held");
    assert.equal(released.ok, true);
    assert.equal(released.redispatched, false);
    assert.equal(next.acquired, true);
    assert.equal(next.record.state, "CLAIMED");
    assert.equal(next.record.dispatchCount, 0);
    assert.equal(sends, 1);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });
});
