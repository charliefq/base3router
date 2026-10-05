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
  return NodePath.join(homeDir, "userdata", "statev2.sqlite");
}

async function waitForSqlite(homeDir: string) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (NodeFS.existsSync(sqlitePath(homeDir))) return;
    await sleep(250);
  }
  throw new Error("Disposable SQLite file was not created.");
}

async function waitForWorkflowStage(
  page: {
    waitForFunction: (
      pageFunction: (expected: string) => boolean,
      arg: string,
      options: { timeout: number },
    ) => Promise<unknown>;
  },
  label: string,
) {
  await page.waitForFunction(
    (expected) => {
      const surface = document.querySelector("[data-governance-surface='control-center']");
      const text = surface?.textContent ?? "";
      if (text.includes("Loading governance") || text.includes("Loading workflow")) {
        return false;
      }
      const stage = document.querySelector("[data-workflow-stage]");
      return stage?.textContent?.includes(expected) === true;
    },
    label,
    { timeout: 30_000 },
  );
}

const fakeLog = NodePath.join(artifactDir, "fake-codex.jsonl");
const fakeBin = NodePath.join(home, "fake-bin");

function installFakeProviders() {
  NodeFS.mkdirSync(fakeBin, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(root, "scripts/internal-beta-fake-codex.mjs"),
    NodePath.join(fakeBin, "codex.mjs"),
  );
  NodeFS.writeFileSync(
    NodePath.join(fakeBin, "codex"),
    `#!/bin/sh\nexec ${process.execPath} "${NodePath.join(fakeBin, "codex.mjs")}" "$@"\n`,
  );
  NodeFS.copyFileSync(
    NodePath.join(root, "scripts/internal-beta-fake-claude.sh"),
    NodePath.join(fakeBin, "claude"),
  );
  NodeFS.chmodSync(NodePath.join(fakeBin, "codex"), 0o755);
  NodeFS.chmodSync(NodePath.join(fakeBin, "claude"), 0o755);
  NodeFS.mkdirSync(artifactDir, { recursive: true });
  NodeFS.writeFileSync(fakeLog, "");
}

function seedAutoPreferred(homeDir: string) {
  const dir = NodePath.join(homeDir, "userdata");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "settings.json"),
    `${JSON.stringify(
      {
        defaultModelSelection: { instanceId: "claudeAgent", model: "sonnet" },
      },
      null,
      2,
    )}\n`,
  );
}

function latestBindings(homeDir: string) {
  const db = new DatabaseSync(sqlitePath(homeDir));
  try {
    return db
      .prepare(
        `SELECT binding_json AS bindingJson FROM projection_dispatcher_task_routes ORDER BY created_at ASC`,
      )
      .all()
      .map((row) => JSON.parse((row as { bindingJson: string }).bindingJson));
  } finally {
    db.close();
  }
}

function countAuditKind(homeDir: string, kind: string) {
  const db = new DatabaseSync(sqlitePath(homeDir));
  try {
    const rows = db.prepare(`SELECT payload_json AS payloadJson FROM action_gate_audit`).all() as {
      payloadJson: string;
    }[];
    return rows.filter((row) => {
      try {
        return JSON.parse(row.payloadJson).kind === kind;
      } catch {
        return false;
      }
    }).length;
  } finally {
    db.close();
  }
}

function memoryRows(homeDir: string) {
  const db = new DatabaseSync(sqlitePath(homeDir));
  try {
    return db
      .prepare(
        `SELECT memory_id AS memoryId, status, content_present AS contentPresent FROM dream_memories`,
      )
      .all() as { memoryId: string; status: string; contentPresent: number }[];
  } finally {
    db.close();
  }
}

function expirePendingApprovals(homeDir: string) {
  const db = new DatabaseSync(sqlitePath(homeDir));
  try {
    db.prepare(
      `UPDATE action_gate_approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'`,
    ).run();
  } finally {
    db.close();
  }
}

function fakeTurnStarts() {
  if (!NodeFS.existsSync(fakeLog)) return 0;
  return NodeFS.readFileSync(fakeLog, "utf8")
    .split("\n")
    .filter((line) => line.includes('"method":"turn/start"')).length;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 45_000,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(message);
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
      env: {
        ...NodeProcess.env,
        T3CODE_HOME: homeDir,
        PATH: `${fakeBin}:${NodeProcess.env.PATH ?? ""}`,
        T3_FAKE_CODEX_LOG: fakeLog,
      },
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

async function sendComposerTurn(
  page: import("playwright-core").Page,
  mode: "auto" | "manual",
  text: string,
) {
  const routing = page.locator(`[data-composer-routing]`);
  await routing.first().waitFor({ timeout: 60_000 });
  const current = await routing.first().getAttribute("data-composer-routing");
  if (current !== mode) {
    await routing.first().click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector("[data-composer-routing]")?.getAttribute("data-composer-routing") ===
        expected,
      mode,
      { timeout: 10_000 },
    );
  }
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type(text);
  const send = page.getByRole("button", { name: "Send message" });
  await send.waitFor({ timeout: 30_000 });
  await waitUntil(() => send.isEnabled(), "Composer send stayed disabled.");
  await send.click();
}

async function openControlCenter(
  page: import("playwright-core").Page,
  origin: string,
  consoleLog: string[],
) {
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
  return surface;
}

async function main() {
  NodeFS.mkdirSync(artifactDir, { recursive: true });
  installFakeProviders();
  seedAutoPreferred(home);
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
    const turnsBefore = fakeTurnStarts();
    try {
      await sendComposerTurn(page, "manual", "manual route proof");
    } catch (error) {
      await page.screenshot({
        path: NodePath.join(artifactDir, "composer-manual-failed.png"),
        fullPage: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(artifactDir, "composer-manual-page.txt"),
        `${page.url()}\n${await page.locator("body").innerText()}\n${consoleLog.join("\n")}\n`,
      );
      throw error;
    }
    await waitUntil(
      () => latestBindings(home).some((binding) => binding.modelRoute?.mode === "manual"),
      "Manual composer send did not persist a manual route binding.",
    );
    const manualBinding = latestBindings(home).find(
      (binding) => binding.modelRoute?.mode === "manual",
    );
    if (manualBinding?.source !== "explicit") {
      throw new Error(
        `Manual route source was not immutable explicit: ${JSON.stringify(manualBinding)}`,
      );
    }
    await waitUntil(
      () => fakeTurnStarts() > turnsBefore,
      "Fake Codex did not receive the Manual turn/start.",
    );
    const afterManualTurns = fakeTurnStarts();
    await sendComposerTurn(page, "auto", "auto failover proof");
    await waitUntil(
      () => latestBindings(home).some((binding) => binding.modelRoute?.mode === "auto"),
      "Auto composer send did not persist an auto route binding.",
    );
    const autoBinding = latestBindings(home).find((binding) => binding.modelRoute?.mode === "auto");
    if (autoBinding === undefined) {
      throw new Error("Auto route binding missing after composer send.");
    }
    if (typeof autoBinding.fallbackIndex !== "number") {
      throw new Error(
        `Auto failover provenance missing fallbackIndex: ${JSON.stringify(autoBinding)}`,
      );
    }
    if (autoBinding.source === "explicit") {
      throw new Error(`Auto route kept an explicit source: ${JSON.stringify(autoBinding)}`);
    }
    await waitUntil(
      () => fakeTurnStarts() > afterManualTurns,
      "Fake Codex did not receive the Auto turn/start.",
    );
    seedPendingHumanGate(home);
    const surface = await openControlCenter(page, origin, consoleLog);
    const disclosure = await page.locator("[data-provider-disclosure]").innerText();
    if (!disclosure.includes("no executable provider driver")) {
      throw new Error(`Control Center omitted OpenRouter disclosure: ${disclosure}`);
    }
    if (!disclosure.includes("Cursor Cloud REST")) {
      throw new Error(`Control Center omitted Cursor Cloud REST disclosure: ${disclosure}`);
    }

    const requestAsk = async (url: string) => {
      await page.locator("[data-action-gate-url]").fill(url);
      await page.locator("[data-action-gate-authorize]").click();
      await waitUntil(
        () =>
          page
            .locator("[data-approval-status='pending']")
            .count()
            .then((count) => count > 0),
        `ASK pending approval did not appear for ${url}.`,
      );
    };

    await requestAsk("https://example.invalid/ask-grant");
    await page.reload({ waitUntil: "domcontentloaded" });
    await surface.waitFor({ timeout: 20_000 });
    if ((await page.locator("[data-approval-status='pending']").count()) === 0) {
      throw new Error("Pending ASK did not survive refresh.");
    }
    const startedBeforeGrant = countAuditKind(home, "action.started");
    await page.locator("[data-action-gate-grant]").click();
    await waitUntil(
      () => countAuditKind(home, "action.started") === startedBeforeGrant + 1,
      "Grant did not execute the ASK action exactly once.",
    );
    await page.locator("[data-governance-refresh]").click();
    await waitUntil(
      () =>
        page
          .locator("[data-approval-status='consumed']")
          .count()
          .then((count) => count > 0),
      "Granted ASK was not consumed.",
    );
    if (countAuditKind(home, "action.started") !== startedBeforeGrant + 1) {
      throw new Error("Grant executed more than once.");
    }

    await requestAsk("https://example.invalid/ask-deny");
    await page.locator("[data-action-gate-deny]").click();
    await waitUntil(
      () =>
        page
          .locator("[data-approval-status='denied']")
          .count()
          .then((count) => count > 0),
      "Deny did not persist.",
    );
    if (countAuditKind(home, "action.started") !== startedBeforeGrant + 1) {
      throw new Error("Deny executed the ASK action.");
    }

    await requestAsk("https://example.invalid/ask-cancel");
    await page.locator("[data-action-gate-cancel]").click();
    await waitUntil(
      () =>
        page
          .locator("[data-approval-status='cancelled']")
          .count()
          .then((count) => count > 0),
      "Cancel did not persist.",
    );
    if (countAuditKind(home, "action.started") !== startedBeforeGrant + 1) {
      throw new Error("Cancel executed the ASK action.");
    }

    await requestAsk("https://example.invalid/ask-expire");
    expirePendingApprovals(home);
    await page.locator("[data-action-gate-grant]").click();
    await waitUntil(async () => {
      const text = await page
        .locator("[data-governance-mutation-error]")
        .innerText()
        .catch(() => "");
      const expired = await page.locator("[data-approval-status='expired']").count();
      return text.includes("expired") || expired > 0;
    }, "Expiry did not fail-closed on Grant.");
    if (countAuditKind(home, "action.started") !== startedBeforeGrant + 1) {
      throw new Error("Expiry executed the ASK action.");
    }

    const memoriesBeforeSave = memoryRows(home).length;
    await page.locator("[data-memory-save]").click();
    await waitUntil(
      () => memoryRows(home).some((row) => row.status !== "deleted"),
      "Save memory did not persist a Dream Memory row.",
    );
    await page.locator("[data-governance-refresh]").click();
    await waitUntil(
      () =>
        page
          .locator("[data-memory-status]")
          .count()
          .then((count) => count > 0),
      "Saved memory did not appear in Control Center.",
    );
    await page.locator("[data-memory-capture-off]").click();
    await sleep(1_000);
    const afterCaptureOff = memoryRows(home).filter((row) => row.status !== "deleted").length;
    await page.locator("[data-memory-enqueue]").click();
    await sleep(2_000);
    const afterEnqueue = memoryRows(home).filter((row) => row.status !== "deleted").length;
    if (afterEnqueue !== afterCaptureOff) {
      throw new Error(
        `Capture off still created memory (${afterCaptureOff} -> ${afterEnqueue}, before save ${memoriesBeforeSave}).`,
      );
    }
    await page.locator("[data-memory-delete]").click();
    await waitUntil(
      () =>
        memoryRows(home).every((row) => row.status === "deleted") || memoryRows(home).length === 0,
      "Delete memory did not mark rows deleted.",
    );

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
    await waitForWorkflowStage(page, "Architecture");
    const duplicate = page.locator("[data-workflow-approve]");
    if ((await duplicate.count()) > 0) {
      await duplicate.click();
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await surface.waitFor({ timeout: 20_000 });
    await waitForWorkflowStage(page, "Architecture");
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
    const routeShot = page.locator("[data-governance-routes]");
    if ((await routeShot.count()) > 0) {
      await routeShot.first().screenshot({
        path: NodePath.join(artifactDir, "governance-routes.png"),
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
    await waitForWorkflowStage(page, "Architecture");
    const restartedText = await surface.innerText();
    if (!restartedText.includes("Architecture")) {
      throw new Error(`Approved workflow stage did not survive restart: ${restartedText}`);
    }
    const restartedMemories = memoryRows(home);
    if (restartedMemories.some((row) => row.status !== "deleted")) {
      throw new Error(`Deleted memory returned after reopen: ${JSON.stringify(restartedMemories)}`);
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
