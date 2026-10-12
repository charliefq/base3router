// @effect-diagnostics nodeBuiltinImport:off - observe child exit before independently reopening the SQLite database.
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
const childFile = NodeURL.fileURLToPath(
  new URL("./testkit/nativeRecoveryProcess.ts", import.meta.url),
);
const run = (directory: string, phase: string) =>
  new Promise<number | undefined>((resolve, reject) => {
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
    // B cannot open the file until A has actually exited; C likewise waits for B.
    child.on("close", (code, signal) => {
      if (signal || code !== (phase === "crash" ? 77 : 0))
        reject(new Error(`child ${phase}: ${code}/${signal}\n${output}`));
      else resolve(child.pid);
    });
  });
type Report = {
  drained: number;
  hasMoreWork: boolean;
  continueThreadsAfterServerUpdate: boolean;
  providerThreads: Array<{
    id: string;
    appThreadId: string;
    providerInstanceId: string;
    providerSessionId: string;
    nativeThreadRef: { nativeId: string };
    status: string;
  }>;
  providerTurns: Array<{
    id: string;
    providerThreadId: string;
    runAttemptId: string;
    nativeTurnRef: { nativeId: string };
    status: string;
  }>;
  runs: Array<{ id: string; status: string; providerThreadId: string; activeAttemptId: string }>;
  attempts: Array<{ id: string; runId: string; nativeThreadId: string; status: string }>;
  sessions: Array<{ id: string; status: string }>;
  effects: Array<{
    id: string;
    effect_type: string;
    status: string;
    attempt_count: number;
    lease_owner: string | null;
  }>;
};
const readReport = (directory: string, phase: string): Report =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(directory, `${phase}.json`), "utf8"));
const calls = (directory: string) =>
  NodeFS.readFileSync(NodePath.join(directory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; pid: number });
const identities = (report: Pick<Report, "providerThreads" | "providerTurns">) => ({
  threads: report.providerThreads.map(
    ({ id, appThreadId, providerInstanceId, providerSessionId, nativeThreadRef }) => ({
      id,
      appThreadId,
      providerInstanceId,
      providerSessionId,
      nativeThreadRef,
    }),
  ),
  turns: report.providerTurns.map(({ id, providerThreadId, runAttemptId, nativeTurnRef }) => ({
    id,
    providerThreadId,
    runAttemptId,
    nativeTurnRef,
  })),
});
const persistedSend = (directory: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT effect_id AS id, status, attempt_count, lease_owner FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start'",
      )
      .all();
  } finally {
    db.close();
  }
};
const persistedIdentities = (directory: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state.sqlite"), {
    readOnly: true,
  });
  try {
    const providerThreads = db
      .prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads")
      .all()
      .map((row) => JSON.parse(String(row.payload_json))) as Report["providerThreads"];
    const providerTurns = db
      .prepare("SELECT payload_json FROM orchestration_v2_projection_provider_turns")
      .all()
      .map((row) => JSON.parse(String(row.payload_json))) as Report["providerTurns"];
    return identities({ providerThreads, providerTurns });
  } finally {
    db.close();
  }
};

it("retains committed native identity and cancels an unsettled send across three sequential processes without resending", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-recovery-"));
  directories.push(directory);
  const firstPid = await run(directory, "crash");
  const before = readReport(directory, "crash");
  assert.isFalse(before.continueThreadsAfterServerUpdate);
  assert.lengthOf(before.providerThreads, 1);
  assert.lengthOf(before.providerTurns, 1);
  assert.lengthOf(before.runs, 1);
  assert.lengthOf(before.attempts, 1);
  const thread = before.providerThreads[0]!;
  const turn = before.providerTurns[0]!;
  assert.equal(thread.nativeThreadRef.nativeId, "fake-native-thread");
  assert.equal(thread.providerInstanceId, "native-recovery-fake");
  assert.equal(thread.appThreadId, "native-recovery-thread");
  assert.equal(turn.nativeTurnRef.nativeId, "fake-native-turn");
  assert.equal(turn.providerThreadId, thread.id);
  assert.equal(turn.runAttemptId, before.attempts[0]!.id);
  assert.equal(before.attempts[0]!.nativeThreadId, thread.nativeThreadRef.nativeId);
  assert.equal(before.attempts[0]!.runId, before.runs[0]!.id);
  assert.equal(before.runs[0]!.providerThreadId, thread.id);
  assert.equal(before.runs[0]!.activeAttemptId, before.attempts[0]!.id);
  assert.equal(before.runs[0]!.status, "running");
  assert.equal(turn.status, "running");
  // Independent read after A exited proves the native bindings survived process loss.
  assert.deepEqual(persistedIdentities(directory), identities(before));
  const originalSend = persistedSend(directory);
  assert.lengthOf(originalSend, 1);
  assert.equal(originalSend[0]!.status, "running");
  assert.equal(originalSend[0]!.attempt_count, 1);
  assert.isString(originalSend[0]!.lease_owner);
  assert.deepEqual(
    calls(directory).map(({ event }) => event),
    ["openSession", "startTurn"],
  );

  const secondPid = await run(directory, "recover");
  assert.notEqual(secondPid, firstPid);
  const recovered = readReport(directory, "recover");
  assert.lengthOf(recovered.runs, 1);
  assert.lengthOf(recovered.attempts, 1);
  assert.lengthOf(recovered.sessions, 1);
  assert.equal(recovered.runs[0]!.id, before.runs[0]!.id);
  assert.equal(recovered.attempts[0]!.id, before.attempts[0]!.id);
  assert.equal(recovered.sessions[0]!.id, thread.providerSessionId);
  assert.isFalse(recovered.continueThreadsAfterServerUpdate);
  assert.isFalse(recovered.hasMoreWork);
  assert.isBelow(recovered.drained, 20);
  assert.isFalse(
    recovered.effects.some((effect) => effect.effect_type === "provider-runtime.continue"),
  );
  // Local cancellation is not evidence of remote provider termination.
  assert.equal(recovered.runs[0]!.status, "cancelled");
  assert.equal(recovered.attempts[0]!.status, "cancelled");
  assert.equal(recovered.providerTurns[0]!.status, "cancelled");
  assert.equal(recovered.sessions[0]!.status, "stopped");
  assert.deepEqual(identities(recovered), identities(before));
  assert.deepEqual(persistedIdentities(directory), identities(before));
  assert.deepEqual(persistedSend(directory), [
    { ...originalSend[0], status: "cancelled", lease_owner: null },
  ]);
  assert.deepEqual(
    calls(directory).map(({ event }) => event),
    ["openSession", "startTurn", "recovered", "drained"],
  );

  const thirdPid = await run(directory, "repeat");
  assert.notEqual(thirdPid, firstPid);
  assert.notEqual(thirdPid, secondPid);
  const repeated = readReport(directory, "repeat");
  assert.deepEqual({ ...repeated, drained: 0 }, { ...recovered, drained: 0 });
  assert.equal(repeated.drained, 0);
  assert.deepEqual(persistedIdentities(directory), identities(before));
  assert.deepEqual(persistedSend(directory), [
    { ...originalSend[0], status: "cancelled", lease_owner: null },
  ]);
  const trace = calls(directory);
  assert.deepEqual(
    trace.map(({ event }) => event),
    ["openSession", "startTurn", "recovered", "drained", "recovered", "drained"],
  );
  assert.deepEqual(
    trace.filter(({ event }) => event === "startTurn").map(({ pid }) => pid),
    [firstPid],
  );
}, 80_000);
