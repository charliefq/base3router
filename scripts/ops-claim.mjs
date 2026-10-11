/**
 * Atomic claim for one operational task, outside the product runtime.
 *
 * A git ref is created only when it is absent. Restarting the same worker
 * reads that ref and does not dispatch again. The ref is deleted only when
 * the caller supplies established termination evidence. This script does not
 * detect a dead worker and does not dispatch a replacement.
 *
 * The repository may be a local bare repo. Tests use that. Nothing here
 * contacts a provider.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "ops-claim",
  GIT_AUTHOR_EMAIL: "ops-claim@localhost",
  GIT_COMMITTER_NAME: "ops-claim",
  GIT_COMMITTER_EMAIL: "ops-claim@localhost",
};

const git = (repo, args, input) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });

const tryGit = (repo, args, input) => {
  try {
    return { ok: true, stdout: git(repo, args, input) };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    return { ok: false, stdout: "", stderr: String(stderr) };
  }
};

export const initClaimRepo = (repo) => {
  NodeFS.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--bare", "--initial-branch=claims"]);
};

const refFor = (taskId) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) {
    throw new Error("Task id must be one ref path segment.");
  }
  return `refs/ops/claims/${taskId}`;
};

const readSha = (repo, ref) => {
  const result = tryGit(repo, ["rev-parse", "--verify", "--quiet", ref]);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length === 0 ? null : sha;
};

const writeCommit = (repo, record) => {
  const json = `${JSON.stringify(record)}\n`;
  const blob = git(repo, ["hash-object", "-w", "--stdin"], json).trim();
  const tree = git(repo, ["mktree"], `100644 blob ${blob}\tclaim.json\n`).trim();
  return git(repo, ["commit-tree", tree, "-m", `claim ${record.taskId} ${record.state}`]).trim();
};

const readRecord = (repo, sha) => JSON.parse(git(repo, ["show", `${sha}:claim.json`]));

const claimedRecord = (taskId, workerId) => ({
  taskId,
  workerId,
  state: "CLAIMED",
  dispatchCount: 0,
  dispatchId: null,
  termination: null,
});

export const claimTask = ({ repo, taskId, workerId }) => {
  const ref = refFor(taskId);
  const existingSha = readSha(repo, ref);
  if (existingSha) {
    const record = readRecord(repo, existingSha);
    if (record.workerId === workerId) {
      return { ok: true, acquired: false, restart: true, record };
    }
    return { ok: false, reason: "held", holder: record.workerId, record };
  }
  const record = claimedRecord(taskId, workerId);
  const sha = writeCommit(repo, record);
  const created = tryGit(repo, ["update-ref", ref, sha, ""]);
  if (created.ok) {
    return { ok: true, acquired: true, restart: false, record };
  }
  const racedSha = readSha(repo, ref);
  const raced = racedSha ? readRecord(repo, racedSha) : null;
  if (raced && raced.workerId === workerId) {
    return { ok: true, acquired: false, restart: true, record: raced };
  }
  return { ok: false, reason: "held", holder: raced?.workerId ?? "unknown", record: raced };
};

export const dispatchTask = ({ repo, taskId, workerId, dispatch }) => {
  const ref = refFor(taskId);
  const sha = readSha(repo, ref);
  if (!sha) return { ok: false, reason: "missing" };
  const record = readRecord(repo, sha);
  if (record.workerId !== workerId) {
    return { ok: false, reason: "not-holder", holder: record.workerId };
  }
  if (record.state === "DISPATCHED") {
    return { ok: true, duplicated: false, dispatchId: record.dispatchId, record };
  }
  const dispatchId = `${workerId}:${taskId}:1`;
  const next = {
    ...record,
    state: "DISPATCHED",
    dispatchCount: 1,
    dispatchId,
  };
  const nextSha = writeCommit(repo, next);
  const swapped = tryGit(repo, ["update-ref", ref, nextSha, sha]);
  if (!swapped.ok) {
    const currentSha = readSha(repo, ref);
    const current = currentSha ? readRecord(repo, currentSha) : null;
    if (current?.state === "DISPATCHED") {
      return { ok: true, duplicated: false, dispatchId: current.dispatchId, record: current };
    }
    return { ok: false, reason: "lost-race", record: current };
  }
  dispatch(dispatchId);
  return { ok: true, duplicated: false, dispatchId, record: next };
};

const terminationEstablished = (termination) =>
  termination !== null &&
  termination !== undefined &&
  termination.established === true &&
  typeof termination.evidence === "string" &&
  termination.evidence.trim().length > 0;

export const releaseTask = ({ repo, taskId, workerId, termination }) => {
  if (!terminationEstablished(termination)) {
    return { ok: false, reason: "termination-not-established", redispatched: false };
  }
  const ref = refFor(taskId);
  const sha = readSha(repo, ref);
  if (!sha) return { ok: false, reason: "missing", redispatched: false };
  const record = readRecord(repo, sha);
  if (record.workerId !== workerId) {
    return { ok: false, reason: "not-holder", redispatched: false };
  }
  const deleted = tryGit(repo, ["update-ref", "-d", ref, sha]);
  if (!deleted.ok) return { ok: false, reason: "lost-race", redispatched: false };
  return { ok: true, redispatched: false };
};

const arg = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const main = () => {
  const command = process.argv[2];
  const repo = arg("--repo");
  const taskId = arg("--task");
  const workerId = arg("--worker");
  if (!repo || !taskId || !workerId || !command) {
    process.stderr.write(
      "Usage: ops-claim.mjs <claim|dispatch|release> --repo <path> --task <id> --worker <id>\n",
    );
    process.exit(1);
  }
  if (command === "claim") {
    process.stdout.write(`${JSON.stringify(claimTask({ repo, taskId, workerId }))}\n`);
    return;
  }
  if (command === "dispatch") {
    const effect = arg("--effect");
    const result = dispatchTask({
      repo,
      taskId,
      workerId,
      dispatch: (dispatchId) => {
        if (effect) NodeFS.appendFileSync(effect, `${dispatchId}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "release") {
    const evidence = arg("--termination-evidence");
    const result = releaseTask({
      repo,
      taskId,
      workerId,
      termination: evidence === undefined ? null : { established: true, evidence },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stderr.write(`Unknown command ${command}\n`);
  process.exit(1);
};

const entry = process.argv[1] ? NodePath.resolve(process.argv[1]) : "";
if (entry === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  main();
}
