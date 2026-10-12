import * as NodeProcess from "node:process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
const repo = NodePath.resolve(process.argv[2] ?? process.cwd());
const base = NodePath.resolve(process.argv[3] ?? NodePath.join(repo, ".t3/qa-ac0-local"));
if (
  NodeFS.existsSync(NodePath.join(repo, ".t3")) &&
  NodeFS.lstatSync(NodePath.join(repo, ".t3")).isSymbolicLink()
)
  throw Error("Do not use a symlinked state directory.");
if (!base.startsWith(NodePath.join(repo, ".t3/qa-")))
  throw Error("Use a disposable repo/.t3/qa-* base.");
if (
  NodeChildProcess.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== "ac0c3ace530744960abb9deeb7ca350a7e7c71cb"
)
  throw Error("Wrong checkout.");
if (!NodeFS.existsSync(NodePath.join(base, "qa-public.json")))
  throw Error("Run prepare.mjs first.");
for (const name of ["", "userdata", "fake-codex-home"])
  if (NodeFS.lstatSync(NodePath.join(base, name)).isSymbolicLink())
    throw Error("Do not use symlinked QA state.");
const stopPid = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) throw Error("Invalid QA ownership record.");
  let command;
  try { command = NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "args="], {encoding:"utf8"}); }
  catch { console.log("Recorded launcher is no longer present; no process stopped."); return; }
  if (!command.includes("scripts/dev-runner.ts dev --home-dir") || !command.includes(base))
    throw Error("PID ownership mismatch; no process stopped.");
  if (NodeProcess.platform === "win32") throw Error("Use the captured PID with the local Windows process supervisor; no broad kill.");
  process.kill(-pid, "SIGTERM");
  console.log("Sent SIGTERM to the recorded QA-only process group.");
};
if (process.argv.includes("--stop")) {
  stopPid(JSON.parse(NodeFS.readFileSync(NodePath.join(base,"qa-owned-process.json"),"utf8")).pid);
  process.exit(0);
}
const settings = JSON.parse(
  NodeFS.readFileSync(NodePath.join(base, "userdata/settings.json"), "utf8"),
);
if (
  Object.values(settings.providers ?? {}).some((p) => p.enabled !== false) ||
  Object.keys(settings.providerInstances ?? {}).some((k) => k !== "qa-fixture")
)
  throw Error("QA permits only its metadata fixture; restore isolated settings.");
const log = NodePath.join(base, "private-startup.log");
const fd = NodeFS.openSync(log, "w", 0o600);
NodeFS.chmodSync(log, 0o600);
const child = NodeChildProcess.spawn(
  process.execPath,
  ["scripts/dev-runner.ts", "dev", "--home-dir", base, "--auto-bootstrap-project-from-cwd=false"],
  {
    detached: NodeProcess.platform !== "win32",
    cwd: repo,
    stdio: ["inherit", fd, fd],
    env: {
      ...process.env,
      PATH: NodePath.join(repo, "node_modules/.bin") + NodePath.delimiter + process.env.PATH,
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_PORT_OFFSET: "700",
      T3_FAKE_CODEX_LOG: NodePath.join(base, "fake-peer.jsonl"),
    },
  },
);
NodeFS.closeSync(fd);
NodeFS.writeFileSync(
  NodePath.join(base, "qa-owned-process.json"),
  JSON.stringify({ pid: child.pid, log }, null, 2),
);
console.log("Candidate starting. Private pairing output stays on this machine: " + log);
console.log(
  "Run health.mjs locally; read the complete fresh pairing URL locally. Never send that URL or log to chat/GitHub.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    try { stopPid(child.pid); }
    catch (error) { console.error("QA shutdown failed; use --stop and verify the recorded PID locally:", error.message); }
  });
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
