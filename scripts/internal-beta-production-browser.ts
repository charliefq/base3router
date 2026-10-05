#!/usr/bin/env node
// Production browser check for the V2 governance surfaces.
// Disposable home directory, fake local transports, no paid providers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { DatabaseSync } from "node:sqlite";

const root = NodePath.resolve(import.meta.dirname, "..");
const chrome = NodeProcess.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "base3-browser-"));
const artifactDir = "/opt/cursor/artifacts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sqlitePath(homeDir: string) {
  return NodePath.join(homeDir, "userdata", "state.sqlite");
}

async function waitForSqlite(homeDir: string) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (NodeFS.existsSync(sqlitePath(homeDir))) return;
    await sleep(250);
  }
  throw new Error("Disposable SQLite file was not created.");
}

function seedPendingHumanGate(homeDir: string) {
  const db = new DatabaseSync(sqlitePath(homeDir));
  try {
    const project = db
      .prepare(
        `SELECT project_id AS projectId FROM projection_projects WHERE deleted_at IS NULL LIMIT 1`,
      )
      .get() as { projectId: string } | undefined;
    if (project === undefined) {
      throw new Error("No project is available to seed a workflow decision.");
    }
    const at = new Date().toISOString();
    const attempt = {
      stageId: "build_gate",
      attempt: 1,
      profileId: null,
      profileVersion: null,
      sourceThreadId: null,
      sourceMessageId: null,
      sourceTurnId: null,
      destinationThreadId: null,
      destinationMessageId: null,
      destinationTurnId: null,
      routeBinding: null,
      status: "pending",
      createdAt: at,
    };
    const run = {
      id: "run-browser-1",
      projectId: project.projectId,
      templateId: "saas-production",
      templateVersion: 1,
      status: "active",
      currentStageId: "build_gate",
      originatingThreadId: null,
      originatingMessageId: null,
      attempts: [attempt],
      artifacts: [],
      decisions: [],
      createdAt: at,
      updatedAt: at,
      endedAt: null,
      pausedAt: null,
    };
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO projection_workflow_runs (run_id, project_id, run_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET run_json = excluded.run_json, updated_at = excluded.updated_at`,
    ).run(run.id, project.projectId, JSON.stringify(run), at, at);
    db.prepare(
      `INSERT INTO projection_workflow_stage_attempts (run_id, stage_id, attempt, attempt_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id, stage_id, attempt) DO UPDATE SET attempt_json = excluded.attempt_json`,
    ).run(run.id, attempt.stageId, attempt.attempt, JSON.stringify(attempt));
    db.prepare(
      `INSERT INTO projection_workflow_cursors (project_id, last_sequence)
       VALUES (?, 1)
       ON CONFLICT (project_id) DO NOTHING`,
    ).run(project.projectId);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

async function startDev(homeDir: string) {
  const child = NodeChildProcess.spawn(
    "node",
    ["scripts/dev-runner.ts", "dev", "--home-dir", homeDir],
    {
      cwd: root,
      env: { ...NodeProcess.env, T3CODE_HOME: homeDir },
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
  return { child, log: () => log, pairingUrl };
}

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
  let { child, log, pairingUrl } = await startDev(home);
  if (pairingUrl.length === 0) {
    stop(child, home);
    NodeFS.writeFileSync(NodePath.join(artifactDir, "browser-server.log"), log());
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
    const startWithout = page.getByRole("button", { name: "Start without a project" });
    if (await startWithout.isVisible().catch(() => false)) {
      await startWithout.click();
      await sleep(3_000);
    } else {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      const retry = page.getByRole("button", { name: "Start without a project" });
      if (
        await retry
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false)
      ) {
        await retry.click();
        await sleep(3_000);
      }
    }
    await waitForSqlite(home);
    seedPendingHumanGate(home);
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
    const decision = page.locator("[data-workflow-decision]");
    try {
      await decision.waitFor({ timeout: 30_000 });
    } catch (error) {
      await page.screenshot({
        path: NodePath.join(artifactDir, "workflow-decision-failed.png"),
        fullPage: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(artifactDir, "workflow-browser-page.txt"),
        `${page.url()}\n${await surface.innerText()}\n${consoleLog.join("\n")}\n`,
      );
      throw error;
    }
    const pendingText = await decision.innerText();
    if (!pendingText.includes("Build Gate")) {
      throw new Error(`Pending workflow decision was not Build Gate: ${pendingText}`);
    }
    await page.locator("[data-workflow-approve]").click();
    await page.waitForFunction(
      () => {
        const stage = document.querySelector("[data-workflow-stage]");
        return stage?.textContent?.includes("Architecture") === true;
      },
      null,
      { timeout: 20_000 },
    );
    const duplicate = page.locator("[data-workflow-approve]");
    if ((await duplicate.count()) > 0) {
      await duplicate.click();
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await surface.waitFor({ timeout: 20_000 });
    const text = await surface.innerText();
    if (!text.includes("Protocol 2")) {
      throw new Error(`Control Center did not report protocol 2: ${text}`);
    }
    if (!text.includes("Architecture")) {
      throw new Error(`Approved workflow stage did not survive refresh: ${text}`);
    }
    await surface.scrollIntoViewIfNeeded();
    await surface.screenshot({
      path: NodePath.join(artifactDir, "governance-control-center.png"),
    });
    const workflowShot = page.locator("[data-workflow-surface]");
    if ((await workflowShot.count()) > 0) {
      await workflowShot.first().screenshot({
        path: NodePath.join(artifactDir, "workflow-human-decision.png"),
      });
    }
    stop(child, home);
    await sleep(1_000);
    const restarted = await startDev(home);
    child = restarted.child;
    if (restarted.pairingUrl.length === 0) {
      NodeFS.writeFileSync(NodePath.join(artifactDir, "browser-server.log"), restarted.log());
      throw new Error("Restarted server did not print a pairing URL.");
    }
    await page.goto(`${origin}/settings/general`, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/pair")) {
      await page.goto(restarted.pairingUrl, { waitUntil: "domcontentloaded" });
      await page
        .waitForFunction(() => !location.pathname.startsWith("/pair"), null, { timeout: 20_000 })
        .catch(async () => {
          const token = decodeURIComponent(
            new URL(restarted.pairingUrl).hash.replace(/^#token=/, ""),
          );
          await page.getByRole("textbox").fill(token);
          await page.getByRole("button", { name: "Continue" }).click();
          await page.waitForFunction(() => !location.pathname.startsWith("/pair"), null, {
            timeout: 20_000,
          });
        });
      await page.goto(`${origin}/settings/general`, { waitUntil: "domcontentloaded" });
    }
    await surface.waitFor({ timeout: 90_000 });
    const restartedText = await surface.innerText();
    if (!restartedText.includes("Architecture")) {
      throw new Error(`Approved workflow stage did not survive restart: ${restartedText}`);
    }
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
