// @effect-diagnostics nodeBuiltinImport:off - observe real child exit and reopen its SQLite file outside Effect scope cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import { afterEach, assert, it } from "vite-plus/test";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-recovery-"));
  directories.push(directory);
  return directory;
};
const childFile = NodeURL.fileURLToPath(
  new URL("./testkit/dispatchRecoveryProcess.ts", import.meta.url),
);
const run = (directory: string, phase: string) =>
  new Promise<{ code: number | null; pid: number | undefined }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [childFile, directory, phase], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
      killSignal: "SIGKILL",
      env: { ...process.env, TMPDIR: directory },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    // close is observed before the caller opens the DB or starts the next process.
    child.on("close", (code, signal) => {
      if (signal || (code !== 0 && code !== 77))
        reject(new Error(`child ${phase}: ${code}/${signal}\n${output}`));
      else resolve({ code, pid: child.pid });
    });
  });
const report = (directory: string, phase: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(directory, `${phase}.json`), "utf8")) as {
    result: string;
    error: { tag: string; message: string } | null;
    latestAttempt: number;
    receipt: { commandId: string; threadId: string; status: string };
    stage: { destinationThreadId: string | null };
    nativeThreadRefs: Array<unknown>;
  };
function inspect(directory: string) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state.sqlite"), {
    readOnly: true,
  });
  try {
    const count = (table: string) =>
      Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
    return {
      threads: count("orchestration_v2_projection_threads"),
      messages: count("orchestration_v2_projection_messages"),
      runs: count("orchestration_v2_projection_runs"),
      receipts: db
        .prepare("SELECT command_id FROM orchestration_command_receipts ORDER BY command_id")
        .all(),
      stageReceipts: Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM base3_workflow_commands WHERE command_id = 'workflow-dispatch-recovery-dispatch'",
          )
          .get()?.count,
      ),
      attempts: db
        .prepare(
          "SELECT attempt, attempt_json FROM projection_workflow_stage_attempts WHERE stage_id = 'discovery' ORDER BY attempt",
        )
        .all(),
      stage: JSON.parse(
        String(
          db
            .prepare(
              "SELECT attempt_json FROM projection_workflow_stage_attempts WHERE stage_id = 'discovery'",
            )
            .get()?.attempt_json,
        ),
      ) as { destinationThreadId: string | null },
    };
  } finally {
    db.close();
  }
}
const calls = (directory: string) =>
  NodeFS.readFileSync(NodePath.join(directory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; pid: number });

it("recovers real command receipts after process death before stage persistence, without duplicate work", async () => {
  const directory = fixture();
  const first = await run(directory, "crash");
  assert.equal(first.code, 77);
  const before = inspect(directory);
  assert.equal(before.threads, 1);
  assert.equal(before.messages, 1);
  assert.equal(before.runs, 1);
  assert.equal(before.stageReceipts, 0);
  assert.equal(before.stage.destinationThreadId, null);
  const second = await run(directory, "recover");
  assert.notEqual(first.pid, second.pid);
  const recovered = report(directory, "recover");
  assert.equal(recovered.result, "Success");
  assert.equal(recovered.receipt.status, "accepted");
  assert.equal(recovered.receipt.commandId, "workflow-create-recovery-dispatch");
  assert.equal(recovered.stage.destinationThreadId, recovered.receipt.threadId);
  assert.equal(
    recovered.nativeThreadRefs.some((ref) => ref !== null),
    false,
  );
  const after = inspect(directory);
  assert.equal(after.stageReceipts, 1);
  assert.equal(after.threads, before.threads);
  assert.equal(after.messages, before.messages);
  assert.equal(after.runs, before.runs);
  assert.deepEqual(after.receipts, before.receipts);
  await run(directory, "recover");
  assert.deepEqual(inspect(directory), after);
  assert.equal(calls(directory).filter((call) => call.event === "launch.enter").length, 2);
  assert.equal(calls(directory).filter((call) => call.event === "provider.openSession").length, 0);
});

it("recovers after a real stage-ledger failure with no partial projection or extra thread/message/run", async () => {
  const directory = fixture();
  await run(directory, "ledger-failure");
  assert.equal(report(directory, "ledger-failure").result, "Failure");
  const before = inspect(directory);
  assert.equal(before.stage.destinationThreadId, null);
  assert.equal(before.stageReceipts, 0);
  await run(directory, "recover");
  const after = inspect(directory);
  assert.equal(report(directory, "recover").result, "Success");
  assert.equal(after.threads, 1);
  assert.equal(after.messages, 1);
  assert.equal(after.runs, 1);
  assert.equal(after.stageReceipts, 1);
  assert.deepEqual(after.receipts, before.receipts);
});

it("rejects conflicting route, dispatch identity and future attempt after recovery", async () => {
  const directory = fixture();
  await run(directory, "crash");
  await run(directory, "recover");
  const before = inspect(directory);
  for (const phase of ["wrong-route", "wrong-dispatch", "future-attempt"]) {
    await run(directory, phase);
    assert.equal(report(directory, phase).result, "Failure");
    assert.deepEqual(inspect(directory), before);
  }
  assert.equal(calls(directory).filter((call) => call.event === "launch.enter").length, 2);
  assert.equal(calls(directory).filter((call) => call.event === "provider.openSession").length, 0);
});

it("rejects a changed provider route while the launch receipt exists but the stage is not recorded", async () => {
  const directory = fixture();
  await run(directory, "crash");
  const before = inspect(directory);
  await run(directory, "wrong-route");
  assert.equal(report(directory, "wrong-route").result, "Failure");
  assert.deepEqual(inspect(directory), before);
});

it("rejects a superseded attempt after a revision is persisted by another process, without entering launch", async () => {
  const directory = fixture();
  await run(directory, "crash");
  await run(directory, "recover");
  const revision = await run(directory, "revise");
  assert.equal(report(directory, "revise").latestAttempt, 2);
  const before = inspect(directory);
  assert.deepEqual(
    before.attempts.map((row) => row.attempt),
    [1, 2],
  );
  const launchesBefore = calls(directory).filter((call) => call.event === "launch.enter").length;
  const stale = await run(directory, "superseded-attempt");
  assert.notEqual(stale.pid, revision.pid);
  const rejected = report(directory, "superseded-attempt");
  assert.equal(rejected.latestAttempt, 2);
  assert.equal(rejected.result, "Failure");
  assert.deepEqual(rejected.error, {
    tag: "WorkflowOperationError",
    message: "Stage preview is stale.",
  });
  assert.equal(
    calls(directory).filter((call) => call.event === "launch.enter").length - launchesBefore,
    0,
  );
  assert.equal(calls(directory).filter((call) => call.event === "provider.openSession").length, 0);
  assert.deepEqual(inspect(directory), before);
});
