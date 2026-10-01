#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Host-side UI Lab runner uses Node subprocess and HTTP readiness checks.

import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = NodePath.join(REPO_ROOT, "apps/web");
const REPORT_DIR = NodePath.join(WEB_ROOT, "playwright-report");
const SCREENSHOT_DIR = NodePath.join(REPORT_DIR, "screenshots");
const RESULTS_DIR = NodePath.join(WEB_ROOT, "playwright-results");
const DEFAULT_PORT = 45733;

const serveOnly = NodeProcess.argv.includes("--serve");

function labEnv(port: number): NodeJS.ProcessEnv {
  const env = { ...NodeProcess.env };
  env.T3CODE_UI_LAB = "1";
  env.T3CODE_SINGLE_ORIGIN_DEV = "1";
  env.PORT = String(port);
  env.T3CODE_UI_LAB_PORT = String(port);
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  return env;
}

function listenAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      const server = NodeNet.createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && port < preferred + 20) {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        server.close((closeError) => {
          if (closeError) reject(closeError);
          else resolve(port);
        });
      });
    };
    tryPort(preferred);
  });
}

function waitForLab(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = NodeHttp.get(`${origin}/lab.html`, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 400) {
          resolve();
          return;
        }
        retry(new Error(`UI Lab HTTP ${response.statusCode}`));
      });
      request.on("error", retry);
    };
    const retry = (error: Error) => {
      if (Date.now() >= deadline) {
        reject(error);
        return;
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

function stopChild(child: NodeChildProcess.ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        NodeProcess.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      NodeProcess.kill(pid, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function runPlaywright(origin: string, port: number): number {
  const env = labEnv(port);
  env.T3CODE_UI_LAB_URL = origin;
  const install = NodeChildProcess.spawnSync(
    "vp",
    ["exec", "playwright", "install", "chromium", ...(NodeProcess.env.CI ? ["--with-deps"] : [])],
    { cwd: WEB_ROOT, env, stdio: "inherit" },
  );
  if (install.status !== 0) return install.status ?? 1;
  const test = NodeChildProcess.spawnSync("vp", ["exec", "playwright", "test"], {
    cwd: WEB_ROOT,
    env,
    stdio: "inherit",
  });
  return test.status ?? 1;
}

async function main(): Promise<number> {
  NodeFs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const preferred = Number(NodeProcess.env.T3CODE_UI_LAB_PORT ?? DEFAULT_PORT);
  const port = await listenAvailablePort(Number.isInteger(preferred) ? preferred : DEFAULT_PORT);
  const origin = `http://127.0.0.1:${port}`;
  const env = labEnv(port);
  const child = NodeChildProcess.spawn("vp", ["dev"], {
    cwd: WEB_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capturedPid = child.pid;
  if (capturedPid === undefined) {
    throw new Error("Failed to start the UI Lab Vite process.");
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    NodeProcess.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    NodeProcess.stderr.write(chunk);
  });

  const shutdown = async () => {
    await stopChild(child);
  };

  NodeProcess.once("SIGINT", () => {
    void shutdown().then(() => NodeProcess.exit(130));
  });
  NodeProcess.once("SIGTERM", () => {
    void shutdown().then(() => NodeProcess.exit(143));
  });

  try {
    await waitForLab(origin, 120_000);
    console.log(`Base3Router UI Lab: ${origin}/lab.html`);
    console.log(`Scenarios: ${origin}/lab.html?scenario=empty-thread`);
    if (serveOnly) {
      console.log("Serving until interrupt. Acceptance: vp run ui-lab:accept");
      await new Promise(() => {});
      return 0;
    }
    const status = runPlaywright(origin, port);
    console.log(`Playwright HTML report: ${REPORT_DIR}/index.html`);
    console.log(`Screenshots: ${SCREENSHOT_DIR}`);
    console.log(`Traces (failures only): ${RESULTS_DIR}`);
    return status;
  } finally {
    await shutdown();
  }
}

main()
  .then((status) => {
    NodeProcess.exit(status);
  })
  .catch((error: unknown) => {
    console.error(error);
    NodeProcess.exit(1);
  });
