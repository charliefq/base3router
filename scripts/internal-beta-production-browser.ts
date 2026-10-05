#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Host-side production browser runner uses Node subprocess and HTTP readiness checks.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const runtimeProcess: NodeJS.Process =
  typeof NodeProcess.once === "function"
    ? NodeProcess
    : (NodeProcess as unknown as { readonly default: NodeJS.Process }).default;

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = NodePath.join(REPO_ROOT, "apps/web");
const DEV_TOKEN = "internal-beta-production-browser-token-32chars";

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    runtimeProcess.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function stopChild(child: NodeChildProcess.ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      signalProcess(-pid, "SIGKILL");
      signalProcess(pid, "SIGKILL");
      setTimeout(finish, 250);
    }, 8_000);
    child.once("exit", finish);
    if (!signalProcess(-pid, "SIGTERM")) {
      signalProcess(pid, "SIGTERM");
    }
  });
}

function probeOrigin(origin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(`${origin}/pair`, (response) => {
      response.resume();
      if ((response.statusCode ?? 500) < 500) {
        resolve();
        return;
      }
      reject(new Error(`Production web HTTP ${String(response.statusCode)}`));
    });
    request.on("error", reject);
  });
}

function waitForReadyOrigin(candidates: ReadonlyArray<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let lastError: Error = new Error("Production web origin was not reachable.");
    const attempt = (index: number) => {
      const origin = candidates[index];
      if (origin === undefined) {
        if (Date.now() >= deadline) {
          reject(lastError);
          return;
        }
        setTimeout(() => attempt(0), 400);
        return;
      }
      probeOrigin(origin).then(
        () => resolve(origin),
        (error: unknown) => {
          lastError = error instanceof Error ? error : new Error(String(error));
          attempt(index + 1);
        },
      );
    };
    attempt(0);
  });
}

function rewritePairingUrl(pairingUrl: string, origin: string): string {
  const parsed = new URL(pairingUrl);
  const target = new URL(origin);
  parsed.protocol = target.protocol;
  parsed.hostname = target.hostname;
  parsed.port = target.port;
  return parsed.toString();
}

function runPlaywright(input: {
  readonly origin: string;
  readonly pairingUrl: string;
  readonly home: string;
}): number {
  const env = {
    ...NodeProcess.env,
    T3CODE_PRODUCTION_BROWSER_URL: input.origin,
    T3CODE_PRODUCTION_PAIRING_URL: input.pairingUrl,
    T3CODE_PRODUCTION_HOME: input.home,
  };
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  delete env.T3CODE_UI_LAB;
  const install = NodeChildProcess.spawnSync(
    "vp",
    ["exec", "playwright", "install", "chromium", ...(NodeProcess.env.CI ? ["--with-deps"] : [])],
    { cwd: WEB_ROOT, env, stdio: "inherit" },
  );
  if (install.status !== 0) return install.status ?? 1;
  const test = NodeChildProcess.spawnSync(
    "vp",
    ["exec", "playwright", "test", "--config", "playwright.production.config.ts"],
    { cwd: WEB_ROOT, env, stdio: "inherit" },
  );
  return test.status ?? 1;
}

async function main(): Promise<number> {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-internal-beta-browser-"));
  const env: NodeJS.ProcessEnv = {
    ...NodeProcess.env,
    T3CODE_HOME: home,
    T3CODE_DEV_AUTH_TOKEN: DEV_TOKEN,
    T3CODE_NO_BROWSER: "1",
    T3CODE_SINGLE_ORIGIN_DEV: "1",
    T3CODE_HOST: "127.0.0.1",
    HOST: "127.0.0.1",
  };
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  delete env.T3CODE_UI_LAB;
  delete env.T3CODE_UI_LAB_URL;

  // `--home-dir` outranks worktree `.t3`. Ambient T3CODE_HOME alone does not.
  const child = NodeChildProcess.spawn(
    runtimeProcess.execPath,
    [
      NodePath.join(REPO_ROOT, "scripts/dev-runner.ts"),
      "dev",
      "--home-dir",
      home,
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const capturedPid = child.pid;
  if (capturedPid === undefined) {
    throw new Error("Failed to start the production vp run dev process.");
  }

  let combined = "";
  const append = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    combined += text;
    runtimeProcess.stdout.write(chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopChild(child);
    NodeFS.rmSync(home, { recursive: true, force: true });
  };

  runtimeProcess.once("SIGINT", () => {
    void shutdown().then(() => runtimeProcess.exit(130));
  });
  runtimeProcess.once("SIGTERM", () => {
    void shutdown().then(() => runtimeProcess.exit(143));
  });

  try {
    const deadline = Date.now() + 180_000;
    let webPort: number | undefined;
    let pairingUrl: string | undefined;
    let observedHome = home;
    while (Date.now() < deadline) {
      const runnerMatch = combined.match(/\[dev-runner\][^\n]*webPort=(\d+)[^\n]*baseDir=(\S+)/);
      if (runnerMatch?.[1] !== undefined) {
        webPort = Number(runnerMatch[1]);
        if (runnerMatch[2] !== undefined && runnerMatch[2].length > 0) {
          observedHome = runnerMatch[2];
        }
      }
      const pairingMatch = combined.match(/(?:Pairing URL|pairingUrl): (https?:\/\/\S+)/);
      if (pairingMatch?.[1] !== undefined) {
        pairingUrl = pairingMatch[1];
      }
      if (
        webPort !== undefined &&
        (pairingUrl !== undefined || combined.includes("Listening on "))
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (webPort === undefined) {
      throw new Error("Production browser runner did not observe [dev-runner] webPort.");
    }
    const origin = await waitForReadyOrigin(
      [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`],
      120_000,
    );
    if (pairingUrl === undefined) {
      pairingUrl = `${origin}/pair#token=${DEV_TOKEN}`;
    } else {
      pairingUrl = rewritePairingUrl(pairingUrl, origin);
    }
    console.log(`Production browser origin: ${origin}`);
    console.log(`Production browser home: ${observedHome}`);
    const status = runPlaywright({ origin, pairingUrl, home: observedHome });
    const evidenceDir = NodeProcess.env.INTERNAL_BETA_EVIDENCE_DIR;
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      NodeFS.mkdirSync(evidenceDir, { recursive: true });
      const screenshotDir = NodePath.join(WEB_ROOT, "playwright-production-results", "screenshots");
      if (NodeFS.existsSync(screenshotDir)) {
        NodeFS.cpSync(screenshotDir, NodePath.join(evidenceDir, "production-browser-screenshots"), {
          recursive: true,
        });
      }
    }
    return status;
  } finally {
    await shutdown();
  }
}

main()
  .then((status) => {
    runtimeProcess.exit(status);
  })
  .catch((error: unknown) => {
    console.error(error);
    runtimeProcess.exit(1);
  });
