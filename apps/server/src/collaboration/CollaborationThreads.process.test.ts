// @effect-diagnostics nodeBuiltinImport:off - verify closed child processes and inspect only disposable SQLite files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { CollaborationCommandResult, CollaborationSnapshot } from "@t3tools/contracts";
import { afterEach, expect, it } from "vite-plus/test";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "collaboration-recovery-"));
  directories.push(dir);
  return dir;
};
const childFile = NodeURL.fileURLToPath(
  new URL("./testkit/openRecoveryProcess.ts", import.meta.url),
);
const run = (directory: string, phase: string) =>
  new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [childFile, directory, phase], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
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
    child.on("close", (code, signal) =>
      signal || (code !== 0 && code !== 77)
        ? reject(new Error(`${phase}: ${code}/${signal}\n${output}`))
        : resolve(),
    );
  });
interface Report {
  http: { denied: number; statuses: number[]; otherSnapshot: CollaborationSnapshot };
  pid: number;
  starts: number;
  providerStartEffects: number;
  results: CollaborationCommandResult[];
  replays: CollaborationCommandResult[];
  principalA: CollaborationSnapshot;
  principalB: CollaborationSnapshot;
  counts: { threads: number; runs: number; messages: number; bindings: number };
}
const report = (dir: string, phase: string): Report =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(dir, `${phase}.json`), "utf8"));
const noExecution = (r: Report) => {
  expect(r.starts).toBe(0);
  expect(r.providerStartEffects).toBe(0);
  expect(r.counts.runs).toBe(0);
  expect(r.counts.messages).toBe(0);
};

it("concurrent requests, lost response and a fresh process converge on one durable thread/binding", async () => {
  const dir = fixture();
  await run(dir, "concurrent");
  const first = report(dir, "concurrent");
  expect(first.results.every((r) => r.outcome === "applied")).toBe(true);
  expect(first.counts).toEqual({ threads: 1, bindings: 1, runs: 0, messages: 0 });
  await run(dir, "lost");
  await run(dir, "recover");
  const recovered = report(dir, "recover");
  expect(recovered.pid).not.toBe(first.pid);
  expect(recovered.results[0]?.idempotent).toBe(true);
  expect(recovered.principalA).toEqual(first.principalA);
  expect(recovered.principalB.tasks).toEqual([]);
  expect(recovered.principalB.messages).toEqual([]);
  expect(recovered.counts).toEqual(first.counts);
  noExecution(first);
  noExecution(recovered);
});
it("recovers an actual committed create after a failed bind and process death", async () => {
  const dir = fixture();
  await run(dir, "partial");
  const partial = report(dir, "partial");
  expect(partial.counts.threads).toBe(1);
  expect(partial.counts.bindings).toBe(0);
  await run(dir, "recover");
  const r = report(dir, "recover");
  expect(r.results[0]?.outcome).toBe("applied");
  expect(r.counts.threads).toBe(1);
  expect(r.counts.bindings).toBe(1);
  noExecution(r);
});
it("partitions principal, project, provider and server environment without cross-principal reads", async () => {
  const dir = fixture();
  await run(dir, "concurrent");
  await run(dir, "partitions");
  const r = report(dir, "partitions");
  expect(r.results.every((result) => result.outcome === "applied")).toBe(true);
  expect(r.counts.threads).toBe(4);
  expect(r.counts.bindings).toBe(4);
  expect(r.principalA.tasks).toHaveLength(3);
  expect(r.principalB.tasks).toHaveLength(1);
  const bId = r.principalB.tasks[0]?.threadId;
  expect(r.principalA.tasks.some((task) => task.threadId === bId)).toBe(false);
  noExecution(r);
  // A separate environment uses a separate database, as production does.
  const other = fixture();
  await run(other, "environment");
  const env = report(other, "environment");
  expect(env.principalA.tasks[0]?.threadId).not.toBe(r.principalA.tasks[0]?.threadId);
  noExecution(env);
});
it("checks command ownership and changed semantics before replay and returns no other principal data", async () => {
  const dir = fixture();
  await run(dir, "concurrent");
  await run(dir, "replay");
  const r = report(dir, "replay");
  expect(r.replays.every((result) => result.outcome === "rejected")).toBe(true);
  expect(r.replays[0]?.snapshot.tasks).toEqual([]);
  expect(r.replays[0]?.snapshot.messages).toEqual([]);
  expect(r.replays[2]?.snapshot.tasks).toEqual([]);
  expect(r.counts.bindings).toBe(1);
  noExecution(r);
});
it.each(["archive", "delete"])(
  "invalidates %s links in authoritative reads and never recreates them",
  async (phase) => {
    const dir = fixture();
    await run(dir, "concurrent");
    await run(dir, phase);
    await run(dir, "recover");
    const r = report(dir, "recover");
    expect(r.results[0]?.outcome).toBe("rejected");
    expect(r.counts.threads).toBe(1);
    expect(
      r.principalA.agents.filter((a) => a.origin === "internal").every((a) => a.threadId === null),
    ).toBe(true);
    expect(r.principalA.tasks[0]?.threadId).toBe(null);
    noExecution(r);
  },
);

it("runs independent HTTP requests through production scope checks and ignores payload identity spoofing", async () => {
  const dir = fixture();
  await run(dir, "http");
  const r = report(dir, "http");
  expect(r.http.denied).toBe(403);
  expect(r.http.statuses).toEqual([200, 200]);
  expect(r.results.every((result) => result.outcome === "applied")).toBe(true);
  expect(r.principalA.tasks[0]?.ownerAgentId).toBe("principal-a");
  expect(r.http.otherSnapshot.tasks).toEqual([]);
  expect(r.http.otherSnapshot.messages).toEqual([]);
  expect(r.counts).toEqual({ threads: 1, bindings: 1, runs: 0, messages: 0 });
  noExecution(r);
});
