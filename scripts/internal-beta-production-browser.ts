#!/usr/bin/env node
// Production browser check for the V2 governance surfaces.
// Disposable home directory, fake local transports, no paid providers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const root = NodePath.resolve(import.meta.dirname, "..");
const chrome = NodeProcess.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "base3-browser-"));
const artifactDir = "/opt/cursor/artifacts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stop(child: NodeChildProcess.ChildProcess, homeDir: string) {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      NodeProcess.kill(-pid, "SIGTERM");
    } catch {
      try {
        NodeProcess.kill(pid, "SIGTERM");
      } catch {
        // The runner may already have exited.
      }
    }
  }
  for (const entry of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const proc = `/proc/${entry}`;
    let marked = false;
    try {
      marked =
        NodeFS.readFileSync(`${proc}/cmdline`).includes(homeDir) ||
        NodeFS.readFileSync(`${proc}/environ`).includes(homeDir);
    } catch {
      continue;
    }
    if (!marked) continue;
    try {
      NodeProcess.kill(Number(entry), "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function main() {
  NodeFS.mkdirSync(artifactDir, { recursive: true });
  const child = NodeChildProcess.spawn(
    "node",
    ["scripts/dev-runner.ts", "dev", "--home-dir", home],
    {
      cwd: root,
      env: { ...NodeProcess.env, T3CODE_HOME: home },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  const append = (chunk: Buffer) => {
    log += chunk.toString("utf8");
    if (log.length > 200_000) log = log.slice(-100_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const started = Date.now();
  let pairingUrl = "";
  while (Date.now() - started < 90_000) {
    const match = log.match(/pairingUrl[:=]\s*(http\S+)/i);
    if (match?.[1] !== undefined) {
      pairingUrl = match[1];
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  if (pairingUrl.length === 0) {
    stop(child, home);
    NodeFS.writeFileSync(NodePath.join(artifactDir, "browser-server.log"), log);
    throw new Error("Dev server did not print a pairing URL.");
  }
  const origin = new URL(pairingUrl).origin;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleLog: string[] = [];
    page.on("console", (message) => {
      consoleLog.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      consoleLog.push(`pageerror: ${error.message}`);
    });
    await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    const paired = await page
      .waitForFunction(() => !location.pathname.startsWith("/pair"), null, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!paired) {
      const token = decodeURIComponent(new URL(pairingUrl).hash.replace(/^#token=/, ""));
      await page.getByRole("textbox").fill(token);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForFunction(() => !location.pathname.startsWith("/pair"), null, {
        timeout: 20_000,
      });
    }
    await page.goto(`${origin}/settings/general`, { waitUntil: "domcontentloaded" });
    const surface = page.locator("[data-governance-surface='control-center']");
    try {
      await surface.waitFor({ timeout: 90_000 });
    } catch (error) {
      await page.screenshot({
        path: NodePath.join(artifactDir, "governance-control-center-failed.png"),
        fullPage: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(artifactDir, "governance-browser-page.txt"),
        `${page.url()}\n${await page.locator("body").innerText()}\n${consoleLog.join("\n")}\n`,
      );
      throw error;
    }
    await page.locator("[data-governance-refresh]").click();
    await surface.waitFor({ timeout: 10_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await surface.waitFor({ timeout: 20_000 });
    const text = await surface.innerText();
    if (!text.includes("Protocol 2")) {
      throw new Error(`Control Center did not report protocol 2: ${text}`);
    }
    await surface.scrollIntoViewIfNeeded();
    await surface.screenshot({
      path: NodePath.join(artifactDir, "governance-control-center.png"),
    });
    NodeProcess.stdout.write(`production-browser ok origin=${origin}\n`);
  } finally {
    await browser.close();
    stop(child, home);
    await sleep(500);
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  NodeProcess.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  NodeProcess.exit(1);
});
