// @effect-diagnostics nodeBuiltinImport:off
/** Disposable production bootstrap. Does not read the user's home, settings or provider credentials. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { inspectInstalledNodePackage } from "./lib/node-package.ts";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const Runtime = Schema.Struct({
  root: Schema.String,
  port: Schema.Number,
  serverPid: Schema.Number,
  launcherPid: Schema.Number,
  project: Schema.String,
  entrypoint: Schema.String,
  providerBinary: Schema.String,
  entrypointSha256: Schema.String,
  controlFile: Schema.optionalKey(Schema.String),
  pairingUrl: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
});
const decodeRuntime = Schema.decodeUnknownSync(Runtime);
const decodeControl = Schema.decodeUnknownSync(
  Schema.Struct({ serverPid: Schema.Number, signal: Schema.Literals(["SIGTERM", "SIGKILL"]) }),
);
export type LocalProductRuntime = typeof Runtime.Type;
export function readLocalProductRuntime(root: string): LocalProductRuntime {
  NodeAssert.ok(
    root === NodePath.resolve(root) &&
      NodePath.dirname(root) === NodePath.resolve(NodeOS.tmpdir()) &&
      /^b3r-local-product-[A-Za-z0-9]+$/.test(NodePath.basename(root)) &&
      NodeFS.realpathSync(root) === root &&
      !NodeFS.lstatSync(root).isSymbolicLink(),
    "Only a direct, nonsymlink disposable root is allowed",
  );
  const runtime = decodeRuntime(
    JSON.parse(NodeFS.readFileSync(NodePath.join(root, "runtime-private.json"), "utf8")),
  );
  NodeAssert.equal(runtime.root, root);
  NodeAssert.equal(runtime.project, NodePath.join(root, "project"));
  NodeAssert.equal(runtime.providerBinary, NodePath.join(root, "bin", "fake-codex"));
  if (runtime.controlFile)
    NodeAssert.equal(
      runtime.controlFile,
      NodePath.join(root, `server-control-${runtime.serverPid}.json`),
    );
  return runtime;
}
const exitFile = (root: string, pid: number) => NodePath.join(root, `server-exit-${pid}.json`);
export async function stopLocalProductRuntime(runtime: LocalProductRuntime, crash = false) {
  if (NodeFS.existsSync(exitFile(runtime.root, runtime.serverPid))) return;
  const controlFile = runtime.controlFile;
  NodeAssert.ok(
    controlFile,
    "This launcher has no child-handle control channel; use its original task session",
  );
  await new Promise<void>((done, fail) => {
    const watcher = NodeFS.watch(runtime.root, () => {
      if (NodeFS.existsSync(exitFile(runtime.root, runtime.serverPid))) {
        deadline.removeEventListener("abort", onTimeout);
        watcher.close();
        done();
      }
    });
    const deadline = AbortSignal.timeout(20_000);
    const onTimeout = () => {
      watcher.close();
      fail(new Error("Captured server exit was not confirmed; do not assume it stopped"));
    };
    deadline.addEventListener("abort", onTimeout, { once: true });
    if (!NodeFS.existsSync(controlFile)) {
      NodeFS.writeFileSync(
        controlFile + ".pending",
        JSON.stringify({ serverPid: runtime.serverPid, signal: crash ? "SIGKILL" : "SIGTERM" }),
        { mode: 0o600, flag: "wx" },
      );
      NodeFS.renameSync(controlFile + ".pending", controlFile);
    }
  });
}
export async function launchLocalProductRuntime(input: {
  output: string;
  existingRoot?: string;
  entrypoint?: string;
}) {
  const root =
    input.existingRoot ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b3r-local-product-"));
  const prior = input.existingRoot ? readLocalProductRuntime(root) : null;
  if (prior)
    NodeAssert.ok(
      NodeFS.existsSync(exitFile(root, prior.serverPid)),
      "Previous captured server exit must be confirmed before restart",
    );
  const entrypoint = NodePath.resolve(
    input.entrypoint ?? prior?.entrypoint ?? NodePath.join(repo, "apps/server/dist/bin.mjs"),
  );
  const portableRoot = NodePath.resolve(NodePath.dirname(entrypoint), "..");
  const portableInstall =
    NodePath.dirname(NodePath.dirname(portableRoot)) === NodePath.resolve(NodeOS.tmpdir()) &&
    /^b3r-portable-node-install-[A-Za-z0-9_-]+$/.test(
      NodePath.basename(NodePath.dirname(portableRoot)),
    ) &&
    NodePath.basename(portableRoot) === "package" &&
    entrypoint === NodePath.join(portableRoot, "dist/bin.mjs");
  if (portableInstall) inspectInstalledNodePackage(portableRoot);
  NodeAssert.ok(
    portableInstall ||
      entrypoint.startsWith(NodePath.join(repo, "apps/server/dist/")) ||
      entrypoint.startsWith(NodePath.join(NodeOS.tmpdir(), "b3r-local-product-package-")),
    "Only local built or disposable package entrypoints are allowed",
  );
  NodeAssert.ok(
    NodeFS.existsSync(NodePath.join(NodePath.dirname(entrypoint), "client/index.html")),
    "Build and bundle the client before verification",
  );
  for (const relative of [
    "home",
    "app/userdata",
    "codex",
    "project",
    "tmp",
    "config",
    "cache",
    "data",
    "bin",
  ])
    NodeFS.mkdirSync(NodePath.join(root, relative), { recursive: true, mode: 0o700 });
  const project = NodePath.join(root, "project");
  const providerBinary = NodePath.join(root, "bin/fake-codex");
  NodeFS.copyFileSync(
    NodePath.join(repo, "scripts/fixtures/local-product-codex.mjs"),
    providerBinary,
  );
  NodeFS.chmodSync(providerBinary, 0o755);
  NodeFS.copyFileSync(
    NodePath.join(repo, "scripts/fixtures/local-product-network-guard.mjs"),
    NodePath.join(root, "bin/network-guard.mjs"),
  );
  const env: Record<string, string> = {
    PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: NodePath.join(root, "home"),
    USERPROFILE: NodePath.join(root, "home"),
    XDG_CONFIG_HOME: NodePath.join(root, "config"),
    XDG_CACHE_HOME: NodePath.join(root, "cache"),
    XDG_DATA_HOME: NodePath.join(root, "data"),
    TMPDIR: NodePath.join(root, "tmp"),
    CODEX_HOME: NodePath.join(root, "codex"),
    T3CODE_HOME: NodePath.join(root, "app"),
    B3R_LOCAL_PRODUCT_ROOT: root,
    T3CODE_TELEMETRY_ENABLED: "false",
    LANG: "C.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    NODE_OPTIONS: `--import=${NodePath.join(root, "bin/network-guard.mjs")}`,
  };
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  if (!prior) {
    const drivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
    const settings = {
      providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
      providerInstances: {
        codex: {
          driver: "codex",
          displayName: "Local verification fixture",
          enabled: false,
          config: {
            setupMode: "existing",
            binaryPath: providerBinary,
            homePath: NodePath.join(root, "codex"),
          },
        },
      },
      openRouter: { enabled: false },
    };
    NodeFS.writeFileSync(
      NodePath.join(root, "app/userdata/settings.json"),
      JSON.stringify(settings, null, 2),
      {
        mode: 0o600,
      },
    );
    NodeFS.writeFileSync(
      NodePath.join(project, "README.md"),
      "# Disposable local product verification\nNo live data or external providers.\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.name", "Local fixture"],
      ["config", "user.email", "fixture@example.invalid"],
      ["add", "README.md"],
      ["commit", "-m", "Initialize disposable fixture"],
    ]) {
      const result = NodeChildProcess.spawnSync("git", args, {
        cwd: project,
        env,
        encoding: "utf8",
      });
      NodeAssert.equal(result.status, 0, result.stderr);
    }
  }
  const port =
    prior?.port ??
    (await new Promise<number>((done, fail) => {
      const listener = NodeNet.createServer();
      listener.once("error", fail);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        NodeAssert.ok(address && typeof address !== "string");
        listener.close(() => done(address.port));
      });
    }));
  NodeFS.mkdirSync(input.output, { recursive: true });
  const log = NodeFS.createWriteStream(NodePath.join(root, "server-private.log"), {
    flags: "a",
    mode: 0o600,
  });
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      NodePath.join(root, "app"),
      "--no-browser",
    ],
    { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  NodeAssert.ok(child.pid);
  const serverPid = child.pid;
  const controlFile = NodePath.join(root, `server-control-${serverPid}.json`);
  const control = NodeFS.watch(root, (_event, name) => {
    if (name !== `server-control-${serverPid}.json` || !NodeFS.existsSync(controlFile)) return;
    const request = decodeControl(JSON.parse(NodeFS.readFileSync(controlFile, "utf8")));
    if (request.serverPid === child.pid && child.exitCode === null && child.signalCode === null)
      child.kill(request.signal);
  });
  const publicState = {
    root,
    port,
    serverPid,
    launcherPid: process.pid,
    project,
    entrypoint,
    providerBinary,
    controlFile,
    entrypointSha256: NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(entrypoint))
      .digest("hex"),
  };
  NodeFS.writeFileSync(NodePath.join(root, "spawn.json"), JSON.stringify(publicState, null, 2), {
    mode: 0o600,
  });
  NodeFS.writeFileSync(NodePath.join(input.output, "current-runtime-path.txt"), root + "\n");
  child.on("exit", (code, signal) => {
    control.close();
    NodeFS.writeFileSync(exitFile(root, serverPid), JSON.stringify({ serverPid, code, signal }));
    log.end();
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  return await new Promise<LocalProductRuntime>((done, fail) => {
    let output = "";
    let ready = false;
    const deadline = AbortSignal.timeout(45_000);
    const onTimeout = () => {
      child.kill("SIGTERM");
      fail(new Error(`Production startup timed out; private log retained under ${root}`));
    };
    deadline.addEventListener("abort", onTimeout, { once: true });
    const consume = (chunk: Buffer) => {
      log.write(chunk);
      output += chunk.toString();
      const match = output.match(/Pairing URL: (http[^\s]+)/);
      if (match && !ready) {
        ready = true;
        deadline.removeEventListener("abort", onTimeout);
        const runtime = { ...publicState, pairingUrl: match[1]!, env };
        NodeFS.writeFileSync(
          NodePath.join(root, "runtime-private.json"),
          JSON.stringify(runtime, null, 2),
          {
            mode: 0o600,
          },
        );
        done(runtime);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", fail);
    child.once("exit", (code) => {
      deadline.removeEventListener("abort", onTimeout);
      if (!ready)
        fail(new Error(`Production startup exited ${code}; private log retained under ${root}`));
    });
  });
}
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
if (NodePath.resolve(process.argv[1] ?? "") === NodeURL.fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const output = NodePath.resolve(
    option("--output") ?? NodePath.join(NodeOS.tmpdir(), "b3r-local-product-evidence"),
  );
  const root = option("--runtime");
  if (action === "start" || action === "restart") {
    if (action === "restart") {
      NodeAssert.ok(root);
      const prior = readLocalProductRuntime(root);
      NodeAssert.ok(
        !NodeFS.existsSync(exitFile(root, prior.serverPid)),
        "Restart requires a live process for its pre-restart checkpoint; use start --runtime for a previously stopped fixture",
      );
      const checkpoint = NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodePath.join(repo, "scripts/local-product-check.ts"),
          "--checkpoint",
          "--runtime",
          root,
          "--output",
          output,
          "--recovery-kind",
          process.argv.includes("--crash") ? "crash" : "graceful",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "checkpoint-client-private.log"),
        (checkpoint.stdout ?? "") + (checkpoint.stderr ?? ""),
        { mode: 0o600 },
      );
      NodeAssert.equal(
        checkpoint.status,
        0,
        "Pre-restart checkpoint failed; server left running, private diagnostic retained",
      );
      await stopLocalProductRuntime(prior, process.argv.includes("--crash"));
    }
    const entrypoint = option("--entrypoint");
    const runtime = await launchLocalProductRuntime({
      output,
      ...(root ? { existingRoot: root } : {}),
      ...(entrypoint ? { entrypoint } : {}),
    });
    process.stdout.write(
      JSON.stringify({
        root: runtime.root,
        origin: `http://127.0.0.1:${runtime.port}`,
        serverPid: runtime.serverPid,
        entrypointSha256: runtime.entrypointSha256,
        auth: "Production one-time pairing retained in private disposable log",
      }) + "\n",
    );
  } else if (action === "stop" || action === "cleanup") {
    NodeAssert.ok(root);
    await stopLocalProductRuntime(readLocalProductRuntime(root));
    if (action === "cleanup") NodeFS.rmSync(root, { recursive: true });
    process.stdout.write(JSON.stringify({ action, root, confirmed: true }) + "\n");
  } else
    throw new Error(
      "Use start|restart|stop|cleanup --output <evidence-dir> [--runtime <disposable-root>] [--entrypoint <local-package-bin.mjs>] [--crash]",
    );
}
