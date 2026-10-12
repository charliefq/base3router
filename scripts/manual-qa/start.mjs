import * as NodeProcess from "node:process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { qaPaths, qaEnvironment, validateFixture, hasLiveOwnership } from "./safety.mjs";
const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith("--") && arg !== "--stop")) throw Error("Unknown QA option.");
const positional = args.filter((arg) => arg !== "--stop");
if (positional.length > 2) throw Error("Use start.mjs [repo] [base] [--stop].");
const { repo, base } = qaPaths(positional[0], positional[1]);
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
const stopPid = async (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) throw Error("Invalid QA ownership record.");
  let command;
  try {
    command = NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
    });
  } catch {
    if (hasLiveOwnership(pid))
      throw Error(
        "Recorded launcher absent but group live; manual ownership verification required.",
      );
    console.log("Recorded launcher is no longer present; no process stopped.");
    return;
  }
  if (
    !command.includes("scripts/dev-runner.ts dev --home-dir") ||
    !command.includes("--home-dir " + base + " --auto-bootstrap-project-from-cwd=false")
  )
    throw Error("PID ownership mismatch; no process stopped.");
  if (NodeProcess.platform === "win32")
    throw Error("Use the captured PID with the local Windows process supervisor; no broad kill.");
  process.kill(-pid, "SIGTERM");
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!hasLiveOwnership(pid)) {
      console.log("Recorded QA-only process group stopped.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw Error("QA group has not fully stopped; do not restart or restore yet.");
};
if (process.argv.includes("--stop")) {
  await stopPid(
    JSON.parse(NodeFS.readFileSync(NodePath.join(base, "qa-owned-process.json"), "utf8")).pid,
  );
  process.exit(0);
}
const ownership = NodePath.join(base, "qa-owned-process.json");
if (NodeFS.existsSync(ownership)) {
  const { pid } = JSON.parse(NodeFS.readFileSync(ownership, "utf8"));
  if (hasLiveOwnership(pid))
    throw Error(
      "Recorded process/group is still live; refusing duplicate startup without changing ownership/log.",
    );
}
const env = qaEnvironment(repo, base);
validateFixture(
  base,
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "qa-provider.mjs"),
);
const log = NodePath.join(base, "private-startup.log");
const fd = NodeFS.openSync(log, "w", 0o600);
NodeFS.chmodSync(log, 0o600);
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    "scripts/dev-runner.ts",
    "dev",
    "--home-dir",
    base,
    "--auto-bootstrap-project-from-cwd=false",
    "--host",
    "127.0.0.1",
    "--share=false",
  ],
  {
    detached: NodeProcess.platform !== "win32",
    cwd: repo,
    stdio: ["inherit", fd, fd],
    env,
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
  process.on(signal, async () => {
    try {
      await stopPid(child.pid);
    } catch (error) {
      console.error(
        "QA shutdown failed; use --stop and verify the recorded PID locally:",
        error.message,
      );
    }
  });
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
