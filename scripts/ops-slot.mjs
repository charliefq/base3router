/**
 * One repository execution slot on a shared remote.
 *
 * Distinct working copies talk only to that remote. A local ref is not the
 * slot. The remote ref `refs/heads/ops/base3-execution-slot` moves only when
 * `git push --force-with-lease` names the SHA the caller just read. An absent
 * ref uses the all-zero SHA. A failed lease leaves the slot where it was.
 *
 * The script never deletes the ref, never expires a claim, and never sends
 * twice. Tests pass a local bare repo and a fake sender. They do not call
 * GitHub or a provider, and they are not an operational claim.
 *
 * The GitHub @cursor handoff does not use this lease. It updates
 * ops/execution-slot.json through the Contents API. That path is
 * scripts/ops-contents-slot.mjs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const SLOT_REF = "refs/heads/ops/base3-execution-slot";
export const SLOT_PATH = "ops/execution-slot.json";
export const ABSENT_SHA = "0000000000000000000000000000000000000000";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "ops-slot",
  GIT_AUTHOR_EMAIL: "ops-slot@localhost",
  GIT_COMMITTER_NAME: "ops-slot",
  GIT_COMMITTER_EMAIL: "ops-slot@localhost",
  GIT_TERMINAL_PROMPT: "0",
};

const git = (cwd, args, input) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });

const tryGit = (cwd, args, input) => {
  try {
    return { ok: true, stdout: git(cwd, args, input) };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    return { ok: false, stdout: "", stderr: String(stderr) };
  }
};

const assertId = (value, label) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${label} must be one path segment.`);
  }
};

export const initSharedRemote = (remotePath) => {
  NodeFS.mkdirSync(remotePath, { recursive: true });
  git(remotePath, ["init", "--bare", "--initial-branch=slot"]);
};

const ensureWorkCopy = (remotePath, workDir) => {
  if (!NodeFS.existsSync(NodePath.join(workDir, ".git"))) {
    NodeFS.mkdirSync(workDir, { recursive: true });
    git(workDir, ["init", "--quiet", "--initial-branch=work"]);
    git(workDir, ["remote", "add", "origin", remotePath]);
  }
};

const readRecord = (workDir, sha) => {
  const shown = tryGit(workDir, ["show", `${sha}:${SLOT_PATH}`]);
  if (!shown.ok) return { sha, record: null, unreadable: true };
  try {
    return { sha, record: JSON.parse(shown.stdout), unreadable: false };
  } catch {
    return { sha, record: null, unreadable: true };
  }
};

export const readSlot = ({ remotePath, workDir }) => {
  ensureWorkCopy(remotePath, workDir);
  const listed = tryGit(workDir, ["ls-remote", "origin", SLOT_REF]);
  if (!listed.ok) return { ok: false, reason: "remote-unreadable", sha: null, record: null };
  const line = listed.stdout.trim();
  if (line.length === 0) return { ok: true, sha: null, record: null, unreadable: false };
  const fetched = tryGit(workDir, [
    "fetch",
    "--no-tags",
    "origin",
    `${SLOT_REF}:refs/ops-slot/observed`,
  ]);
  if (!fetched.ok) return { ok: false, reason: "remote-unreadable", sha: null, record: null };
  const sha = git(workDir, ["rev-parse", "refs/ops-slot/observed"]).trim();
  return { ok: true, ...readRecord(workDir, sha) };
};

const writeCommit = (workDir, record, parentSha) => {
  const json = `${JSON.stringify(record)}\n`;
  const blob = git(workDir, ["hash-object", "-w", "--stdin"], json).trim();
  const opsTree = git(workDir, ["mktree"], `100644 blob ${blob}\texecution-slot.json\n`).trim();
  const root = git(workDir, ["mktree"], `040000 tree ${opsTree}\tops\n`).trim();
  const token = NodeCrypto.randomBytes(8).toString("hex");
  const args = ["commit-tree", root, "-m", `slot ${record.state} ${record.taskId} ${token}`];
  if (parentSha) args.push("-p", parentSha);
  return git(workDir, args).trim();
};

const remoteTip = (workDir) => {
  const listed = tryGit(workDir, ["ls-remote", "origin", SLOT_REF]);
  if (!listed.ok) return null;
  const line = listed.stdout.trim();
  if (line.length === 0) return null;
  return line.split(/\s+/)[0];
};

const compareAndSwap = (workDir, { expectedSha, record }) => {
  if (expectedSha) {
    const hasParent = tryGit(workDir, ["cat-file", "-e", `${expectedSha}^{commit}`]);
    if (!hasParent.ok) return { ok: false, reason: "missing-parent" };
  }
  const sha = writeCommit(workDir, record, expectedSha);
  const expected = expectedSha ?? ABSENT_SHA;
  const pushed = tryGit(workDir, [
    "push",
    `--force-with-lease=${SLOT_REF}:${expected}`,
    "origin",
    `${sha}:${SLOT_REF}`,
  ]);
  // A second copy that built the same commit sees "up to date" and exit 0.
  // The tip check is what makes that copy lose before it can send.
  if (!pushed.ok || remoteTip(workDir) !== sha) return { ok: false, reason: "conflict" };
  return { ok: true, sha, record };
};

const occupied = (record) => record !== null && record !== undefined && record.state !== "TERMINAL";

const claimedRecord = (taskId, workerId) => ({
  schema: 1,
  state: "CLAIMED",
  taskId,
  workerId,
  dispatchId: null,
  dispatchCount: 0,
  ack: null,
  provider: null,
  termination: null,
  claimedAt: new Date().toISOString(),
});

const held = (current) => ({
  ok: false,
  reason: "held",
  holder: current.record?.workerId ?? "unknown",
  record: current.record,
  sha: current.sha,
});

export const acquireSlot = ({ remotePath, workDir, taskId, workerId }) => {
  assertId(taskId, "Task id");
  assertId(workerId, "Worker id");
  ensureWorkCopy(remotePath, workDir);
  const current = readSlot({ remotePath, workDir });
  if (!current.ok || current.unreadable) {
    return {
      ok: false,
      reason: current.unreadable ? "unreadable" : current.reason,
      redispatched: false,
    };
  }
  if (occupied(current.record)) {
    if (current.record.workerId === workerId && current.record.taskId === taskId) {
      return { ok: true, acquired: false, restart: true, record: current.record, sha: current.sha };
    }
    return held(current);
  }
  const next = claimedRecord(taskId, workerId);
  const swapped = compareAndSwap(workDir, { expectedSha: current.sha, record: next });
  if (!swapped.ok) {
    const raced = readSlot({ remotePath, workDir });
    if (
      raced.record &&
      raced.record.workerId === workerId &&
      raced.record.taskId === taskId &&
      occupied(raced.record)
    ) {
      return { ok: true, acquired: false, restart: true, record: raced.record, sha: raced.sha };
    }
    return held(raced);
  }
  return { ok: true, acquired: true, restart: false, record: next, sha: swapped.sha };
};

const holderRecord = ({ remotePath, workDir, workerId }) => {
  const current = readSlot({ remotePath, workDir });
  if (!current.ok || current.unreadable || !current.record) {
    return { ok: false, reason: current.unreadable ? "unreadable" : "missing", current };
  }
  if (current.record.workerId !== workerId) {
    return { ok: false, reason: "not-holder", holder: current.record.workerId, current };
  }
  return { ok: true, current };
};

const ackClosed = (record) =>
  record.state === "ACK_STARTED" ||
  record.state === "ACKED" ||
  record.state === "DISPATCHED" ||
  record.state === "UNCERTAIN" ||
  record.state === "TERMINAL" ||
  record.ack?.delivery === "confirmed" ||
  record.ack?.delivery === "uncertain" ||
  record.ack?.delivery === "started";

export const acknowledgeSlot = ({ remotePath, workDir, workerId, postComment }) => {
  assertId(workerId, "Worker id");
  const heldBy = holderRecord({ remotePath, workDir, workerId });
  if (!heldBy.ok) return { ok: false, reason: heldBy.reason, posted: false };
  const { current } = heldBy;
  if (ackClosed(current.record)) {
    return { ok: true, posted: false, record: current.record, sha: current.sha };
  }
  if (current.record.state !== "CLAIMED") {
    return { ok: false, reason: "not-ready", posted: false, record: current.record };
  }
  const started = {
    ...current.record,
    state: "ACK_STARTED",
    ack: { delivery: "started", commentUrl: null },
  };
  const swapped = compareAndSwap(workDir, { expectedSha: current.sha, record: started });
  if (!swapped.ok) {
    const raced = readSlot({ remotePath, workDir });
    return { ok: true, posted: false, record: raced.record, sha: raced.sha };
  }
  let commentUrl;
  try {
    commentUrl = postComment();
  } catch (error) {
    if (!error || error.uncertain !== true) throw error;
    const uncertain = {
      ...started,
      ack: { delivery: "uncertain", commentUrl: null },
    };
    compareAndSwap(workDir, { expectedSha: swapped.sha, record: uncertain });
    return { ok: true, posted: false, uncertain: true, record: uncertain, sha: swapped.sha };
  }
  const acked = {
    ...started,
    state: "ACKED",
    ack: { delivery: "confirmed", commentUrl },
  };
  const confirmed = compareAndSwap(workDir, { expectedSha: swapped.sha, record: acked });
  if (!confirmed.ok) {
    return { ok: true, posted: true, recordConfirmed: false, record: started, sha: swapped.sha };
  }
  return { ok: true, posted: true, record: acked, sha: confirmed.sha };
};

export const confirmAck = ({ remotePath, workDir, workerId, commentUrl }) => {
  assertId(workerId, "Worker id");
  if (typeof commentUrl !== "string" || commentUrl.trim().length === 0) {
    return { ok: false, reason: "comment-url-required", posted: false };
  }
  const heldBy = holderRecord({ remotePath, workDir, workerId });
  if (!heldBy.ok) return { ok: false, reason: heldBy.reason, posted: false };
  const { current } = heldBy;
  if (current.record.state === "ACKED") {
    return { ok: true, changed: false, posted: false, record: current.record, sha: current.sha };
  }
  if (current.record.state !== "ACK_STARTED" && current.record.ack?.delivery !== "uncertain") {
    return { ok: false, reason: "not-started", posted: false, record: current.record };
  }
  const acked = {
    ...current.record,
    state: "ACKED",
    ack: { delivery: "confirmed", commentUrl },
  };
  const swapped = compareAndSwap(workDir, { expectedSha: current.sha, record: acked });
  if (!swapped.ok) return { ok: false, reason: "conflict", posted: false };
  return { ok: true, changed: true, posted: false, record: acked, sha: swapped.sha };
};

const dispatchIdFor = (record) => `${record.workerId}:${record.taskId}:1`;

export const startProvider = ({ remotePath, workDir, workerId, send }) => {
  assertId(workerId, "Worker id");
  const heldBy = holderRecord({ remotePath, workDir, workerId });
  if (!heldBy.ok) return { ok: false, reason: heldBy.reason, sent: false };
  const { current } = heldBy;
  if (current.record.state === "DISPATCHED" || current.record.state === "UNCERTAIN") {
    return {
      ok: true,
      sent: false,
      uncertain: current.record.state === "UNCERTAIN",
      dispatchId: current.record.dispatchId,
      record: current.record,
    };
  }
  if (current.record.state !== "ACKED") {
    return { ok: false, reason: "ack-not-confirmed", sent: false, record: current.record };
  }
  const dispatchId = dispatchIdFor(current.record);
  const started = {
    ...current.record,
    state: "DISPATCHED",
    dispatchId,
    dispatchCount: 1,
    provider: { delivery: "started" },
  };
  const swapped = compareAndSwap(workDir, { expectedSha: current.sha, record: started });
  if (!swapped.ok) {
    const raced = readSlot({ remotePath, workDir });
    if (raced.record?.state === "DISPATCHED" || raced.record?.state === "UNCERTAIN") {
      return { ok: true, sent: false, dispatchId: raced.record.dispatchId, record: raced.record };
    }
    return { ok: false, reason: "lost-race", sent: false, record: raced.record };
  }
  try {
    send(dispatchId);
  } catch (error) {
    if (!error || error.uncertain !== true) throw error;
    const uncertain = {
      ...started,
      state: "UNCERTAIN",
      provider: { delivery: "uncertain" },
    };
    compareAndSwap(workDir, { expectedSha: swapped.sha, record: uncertain });
    return { ok: true, sent: false, uncertain: true, dispatchId, record: uncertain };
  }
  const confirmed = { ...started, provider: { delivery: "confirmed" } };
  const written = compareAndSwap(workDir, { expectedSha: swapped.sha, record: confirmed });
  return {
    ok: true,
    sent: true,
    dispatchId,
    record: written.ok ? confirmed : started,
    sha: written.ok ? written.sha : swapped.sha,
  };
};

const terminationEstablished = (termination) =>
  termination !== null &&
  termination !== undefined &&
  termination.established === true &&
  typeof termination.evidence === "string" &&
  termination.evidence.trim().length > 0 &&
  (termination.workerState === "COMPLETED" || termination.workerState === "STOPPED");

export const finishSlot = ({ remotePath, workDir, workerId, termination, maxAgeMs }) => {
  if (maxAgeMs !== undefined) {
    return { ok: false, reason: "expiry-not-supported", redispatched: false };
  }
  if (!terminationEstablished(termination)) {
    return { ok: false, reason: "termination-not-established", redispatched: false };
  }
  assertId(workerId, "Worker id");
  const heldBy = holderRecord({ remotePath, workDir, workerId });
  if (!heldBy.ok) return { ok: false, reason: heldBy.reason, redispatched: false };
  const { current } = heldBy;
  if (current.record.state === "TERMINAL") {
    return { ok: true, redispatched: false, record: current.record, sha: current.sha };
  }
  const next = {
    ...current.record,
    state: "TERMINAL",
    termination: {
      established: true,
      evidence: termination.evidence,
      workerState: termination.workerState,
    },
  };
  const swapped = compareAndSwap(workDir, { expectedSha: current.sha, record: next });
  if (!swapped.ok) return { ok: false, reason: "conflict", redispatched: false };
  return { ok: true, redispatched: false, record: next, sha: swapped.sha };
};

export const checkSlot = ({ remotePath, workDir }) => {
  const current = readSlot({ remotePath, workDir });
  if (!current.ok) return { ok: false, reason: current.reason, pinned: true, releasable: false };
  return {
    ok: true,
    sha: current.sha,
    record: current.record,
    pinned: occupied(current.record) || current.unreadable === true,
    releasable: false,
    expired: false,
  };
};

const RESULT_FIELDS = [
  "dispatch_id",
  "worker_state",
  "starting_sha",
  "final_sha",
  "branch",
  "pr",
  "evidence_links",
  "ci_workflow",
  "ci_run",
  "checkout_sha",
  "unresolved_blockers",
  "suggested_next_task",
];

export const formatResultPacket = (input) => {
  if (input.worker_state !== "COMPLETED" && input.worker_state !== "STOPPED") {
    throw new Error("worker_state must be COMPLETED or STOPPED");
  }
  const missing = RESULT_FIELDS.filter((field) => {
    const value = input[field];
    return value === undefined || value === null || value === "";
  });
  if (missing.length > 0) {
    throw new Error(`Missing result fields: ${missing.join(", ")}`);
  }
  if (!Array.isArray(input.evidence_links) || input.evidence_links.length === 0) {
    throw new Error("evidence_links must list at least one link");
  }
  if (!Array.isArray(input.unresolved_blockers)) {
    throw new Error("unresolved_blockers must be a list");
  }
  const blockers =
    input.unresolved_blockers.length === 0
      ? "(none)"
      : input.unresolved_blockers.map((item) => `- ${item}`).join("\n");
  return [
    `dispatch_id: ${input.dispatch_id}`,
    `worker_state: ${input.worker_state}`,
    `starting_sha: ${input.starting_sha}`,
    `final_sha: ${input.final_sha}`,
    `branch: ${input.branch}`,
    `pr: ${input.pr}`,
    `evidence_links: ${input.evidence_links.join(", ")}`,
    `ci_workflow: ${input.ci_workflow}`,
    `ci_run: ${input.ci_run}`,
    `checkout_sha: ${input.checkout_sha}`,
    "unresolved_blockers:",
    blockers,
    `suggested_next_task: ${input.suggested_next_task}`,
  ].join("\n");
};

const arg = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const flagged = (name) => process.argv.includes(name);

const uncertainError = () => Object.assign(new Error("uncertain"), { uncertain: true });

const main = () => {
  const command = process.argv[2];
  const remotePath = arg("--remote");
  const workDir = arg("--work");
  const taskId = arg("--task");
  const workerId = arg("--worker");
  if (!command || (command !== "init" && (!remotePath || !workDir))) {
    process.stderr.write(
      "Usage: ops-slot.mjs <init|acquire|check|acknowledge|confirm-ack|start|finish> --remote <bare> --work <dir> --task <id> --worker <id>\n",
    );
    process.exit(1);
  }
  if (command === "init") {
    if (!remotePath) process.exit(1);
    initSharedRemote(remotePath);
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  if (command === "acquire") {
    process.stdout.write(
      `${JSON.stringify(acquireSlot({ remotePath, workDir, taskId, workerId }))}\n`,
    );
    return;
  }
  if (command === "check") {
    process.stdout.write(`${JSON.stringify(checkSlot({ remotePath, workDir }))}\n`);
    return;
  }
  if (command === "acknowledge") {
    const effect = arg("--effect");
    const result = acknowledgeSlot({
      remotePath,
      workDir,
      workerId,
      postComment: () => {
        if (flagged("--uncertain")) throw uncertainError();
        const commentUrl = `local://comment/${workerId}`;
        if (effect) NodeFS.appendFileSync(effect, `${commentUrl}\n`);
        return commentUrl;
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "confirm-ack") {
    process.stdout.write(
      `${JSON.stringify(confirmAck({ remotePath, workDir, workerId, commentUrl: arg("--comment-url") }))}\n`,
    );
    return;
  }
  if (command === "start") {
    const effect = arg("--effect");
    const result = startProvider({
      remotePath,
      workDir,
      workerId,
      send: (dispatchId) => {
        if (flagged("--uncertain")) throw uncertainError();
        if (effect) NodeFS.appendFileSync(effect, `${dispatchId}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "finish") {
    const evidence = arg("--termination-evidence");
    const workerState = arg("--worker-state");
    const result = finishSlot({
      remotePath,
      workDir,
      workerId,
      termination:
        evidence === undefined && workerState === undefined
          ? null
          : { established: true, evidence, workerState },
      ...(arg("--max-age-ms") === undefined ? {} : { maxAgeMs: Number(arg("--max-age-ms")) }),
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
