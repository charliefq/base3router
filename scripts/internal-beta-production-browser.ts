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
const journeyLogPath = NodePath.join(artifactDir, "production-browser-journeys.json");

type JourneyStatus = "PASS" | "FAIL" | "BLOCKED";
type JourneyResult = {
  name: "manual" | "auto" | "ask" | "memory";
  status: JourneyStatus;
  detail: string;
  assertions: Record<string, unknown>;
};

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

const fakeLog = NodePath.join(artifactDir, "fake-codex.jsonl");
const fakeBin = NodePath.join(home, "fake-bin");
const fakeCodex = NodePath.join(fakeBin, "codex");
const fakeClaude = NodePath.join(fakeBin, "claude");

function installFakeProviders() {
  NodeFS.mkdirSync(fakeBin, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(root, "scripts/internal-beta-fake-codex.mjs"),
    NodePath.join(fakeBin, "codex.mjs"),
  );
  NodeFS.writeFileSync(
    fakeCodex,
    `#!/bin/sh\nexec ${process.execPath} "${NodePath.join(fakeBin, "codex.mjs")}" "$@"\n`,
  );
  NodeFS.copyFileSync(NodePath.join(root, "scripts/internal-beta-fake-claude.sh"), fakeClaude);
  NodeFS.chmodSync(fakeCodex, 0o755);
  NodeFS.chmodSync(fakeClaude, 0o755);
  NodeFS.mkdirSync(artifactDir, { recursive: true });
  NodeFS.writeFileSync(fakeLog, "");
}

function readSettings(homeDir: string): Record<string, unknown> {
  const path = NodePath.join(homeDir, "userdata", "settings.json");
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(homeDir: string, patch: Record<string, unknown>) {
  const dir = NodePath.join(homeDir, "userdata");
  NodeFS.mkdirSync(dir, { recursive: true });
  const path = NodePath.join(dir, "settings.json");
  const current = readSettings(homeDir);
  NodeFS.writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

function pinFakeDiscovery(
  homeDir: string,
  defaultModelSelection: { instanceId: string; model: string },
) {
  writeSettings(homeDir, {
    defaultModelSelection,
    providers: {
      codex: { enabled: true, binaryPath: fakeCodex },
      claudeAgent: { enabled: true, binaryPath: fakeClaude },
      cursor: { enabled: false },
      grok: { enabled: false },
      opencode: { enabled: false },
      antigravity: { enabled: false },
      pi: { enabled: false },
    },
    providerInstances: {
      codex: {
        driver: "codex",
        enabled: true,
        config: { enabled: true, binaryPath: fakeCodex },
      },
      claudeAgent: {
        driver: "claudeAgent",
        enabled: true,
        config: { enabled: true, binaryPath: fakeClaude },
      },
    },
  });
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

function fakeLogEntries() {
  if (!NodeFS.existsSync(fakeLog)) return [];
  return NodeFS.readFileSync(fakeLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as { method?: string; params?: unknown };
      } catch {
        return {};
      }
    });
}

function fakeMethodCount(method: string) {
  return fakeLogEntries().filter((entry) => entry.method === method).length;
}

function fakeTurnPrompt(text: string) {
  return fakeLogEntries().some((entry) => {
    if (entry.method !== "turn/start") return false;
    return JSON.stringify(entry.params ?? {}).includes(text);
  });
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

async function captureFailure(
  page: import("playwright-core").Page,
  name: string,
  consoleLog: string[],
  error: unknown,
) {
  await page
    .screenshot({ path: NodePath.join(artifactDir, `${name}-failed.png`), fullPage: true })
    .catch(() => undefined);
  NodeFS.writeFileSync(
    NodePath.join(artifactDir, `${name}-page.txt`),
    `${page.url()}\n${await page
      .locator("body")
      .innerText()
      .catch(
        () => "",
      )}\n${consoleLog.join("\n")}\n${error instanceof Error ? error.stack : String(error)}\n`,
  );
}

async function sendComposerTurn(
  page: import("playwright-core").Page,
  mode: "auto" | "manual",
  text: string,
) {
  await dismissOverlays(page);
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
  const send = page.getByRole("button", { name: /Submit message|Send message/ });
  await send.waitFor({ timeout: 30_000 });
  await waitUntil(() => send.isEnabled(), "Composer send stayed disabled.");
  await send.click();
}

async function waitForFakeCatalog() {
  await waitUntil(
    () => fakeMethodCount("model/list") > 0,
    "Fake Codex did not receive model/list; probe never completed discovery.",
    30_000,
  );
}

async function waitForProbedFakeLabel(page: import("playwright-core").Page) {
  const label = page.locator("[data-chat-provider-model-picker-label]").first();
  await page.locator("[data-chat-provider-model-picker]").first().waitFor({ timeout: 60_000 });
  await waitUntil(async () => {
    const text = await label.innerText().catch(() => "");
    return /GPT Fake/i.test(text) && !/gpt-6-astra|No models found/i.test(text);
  }, "Composer picker never showed the probed GPT Fake catalog.");
}

async function dismissOverlays(page: import("playwright-core").Page) {
  for (let i = 0; i < 3; i += 1) {
    const backdrop = page.locator(
      "[data-slot='command-dialog-backdrop'], [data-slot='dialog-backdrop']",
    );
    if ((await backdrop.count()) === 0) break;
    await page.keyboard.press("Escape");
    await sleep(200);
  }
}

async function openFreshThread(page: import("playwright-core").Page, origin: string) {
  await dismissOverlays(page);
  const create = page.getByRole("button", { name: "New thread", exact: true }).last();
  if ((await create.count()) > 0) {
    await create.click();
  } else {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    const startWithout = page.getByRole("button", { name: "Start without a project" });
    if (await startWithout.isVisible().catch(() => false)) {
      await startWithout.click();
    }
  }
  await dismissOverlays(page);
  await page.locator("[data-composer-routing]").first().waitFor({ timeout: 30_000 });
}

async function pairAndOpenComposer(
  page: import("playwright-core").Page,
  pairingUrl: string,
  origin: string,
) {
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
  await page.locator("[data-composer-routing]").first().waitFor({ timeout: 60_000 });
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
    await captureFailure(page, "governance-control-center", consoleLog, error);
    throw error;
  }
  await page.locator("[data-governance-refresh]").click();
  await surface.waitFor({ timeout: 10_000 });
  return surface;
}

async function runManual(
  page: import("playwright-core").Page,
  consoleLog: string[],
): Promise<JourneyResult> {
  const prompt = "manual-route-proof-turn";
  try {
    await waitForFakeCatalog();
    await waitForProbedFakeLabel(page);
    const turnsBefore = fakeMethodCount("turn/start");
    await sendComposerTurn(page, "manual", prompt);
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
      () => fakeTurnPrompt(prompt),
      "Fake Codex did not receive turn/start containing the Manual prompt. thread/start is not sufficient.",
    );
    if (fakeMethodCount("turn/start") <= turnsBefore) {
      throw new Error("Manual send did not increment fake Codex turn/start.");
    }
    return {
      name: "manual",
      status: "PASS",
      detail: "Composer Manual submit bound explicitly and reached fake turn/start.",
      assertions: {
        source: manualBinding.source,
        target: manualBinding.target,
        turnStart: fakeMethodCount("turn/start"),
        prompt,
      },
    };
  } catch (error) {
    await captureFailure(page, "composer-manual", consoleLog, error);
    return {
      name: "manual",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
      assertions: {
        fakeMethods: fakeLogEntries().map((entry) => entry.method),
        picker: await page
          .locator("[data-chat-provider-model-picker-label]")
          .first()
          .innerText()
          .catch(() => ""),
      },
    };
  }
}

async function runAuto(
  page: import("playwright-core").Page,
  origin: string,
  consoleLog: string[],
): Promise<JourneyResult> {
  const prompt = "auto-failover-proof-turn";
  try {
    await openFreshThread(page, origin);
    pinFakeDiscovery(home, { instanceId: "claudeAgent", model: "claude-sonnet-5" });
    await sleep(2_500);
    const turnsBefore = fakeMethodCount("turn/start");
    await sendComposerTurn(page, "auto", prompt);
    await waitUntil(
      () => latestBindings(home).some((binding) => binding.modelRoute?.mode === "auto"),
      "Auto composer send did not persist an auto route binding.",
    );
    const autoBinding = latestBindings(home).find((binding) => binding.modelRoute?.mode === "auto");
    if (autoBinding === undefined) {
      throw new Error("Auto route binding missing after composer send.");
    }
    if (typeof autoBinding.fallbackIndex !== "number" || autoBinding.fallbackIndex < 1) {
      throw new Error(
        `Auto failover provenance missing fallbackIndex: ${JSON.stringify(autoBinding)}`,
      );
    }
    if (autoBinding.source === "explicit" || autoBinding.source === "environment-default") {
      throw new Error(`Auto route did not fail over: ${JSON.stringify(autoBinding)}`);
    }
    await waitUntil(
      () => fakeTurnPrompt(prompt),
      "Fake Codex did not receive turn/start containing the Auto prompt.",
    );
    if (fakeMethodCount("turn/start") <= turnsBefore) {
      throw new Error("Auto send did not increment fake Codex turn/start.");
    }
    return {
      name: "auto",
      status: "PASS",
      detail: "Auto failovers from unavailable environment default onto fake Codex.",
      assertions: {
        fallbackIndex: autoBinding.fallbackIndex,
        source: autoBinding.source,
        target: autoBinding.target,
        preferred: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
        prompt,
      },
    };
  } catch (error) {
    await captureFailure(page, "composer-auto", consoleLog, error);
    return {
      name: "auto",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
      assertions: {
        bindings: latestBindings(home),
        fakeMethods: fakeLogEntries().map((entry) => entry.method),
      },
    };
  }
}

async function runAsk(
  page: import("playwright-core").Page,
  origin: string,
  consoleLog: string[],
): Promise<JourneyResult> {
  try {
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
    await page.reload({ waitUntil: "domcontentloaded" });
    await surface.waitFor({ timeout: 20_000 });
    await page.locator("[data-governance-refresh]").click();
    await waitUntil(
      () =>
        page
          .locator("[data-approval-status='pending']")
          .count()
          .then((count) => count > 0),
      "Pending ASK did not survive refresh.",
    );
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

    return {
      name: "ask",
      status: "PASS",
      detail: "Grant executed once; deny, cancel, and expiry executed zero times.",
      assertions: {
        actionStarted: countAuditKind(home, "action.started"),
        grantDelta: 1,
        denyCancelExpiryDelta: 0,
        refreshPreservedPending: true,
      },
    };
  } catch (error) {
    await captureFailure(page, "ask", consoleLog, error);
    return {
      name: "ask",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
      assertions: { actionStarted: countAuditKind(home, "action.started") },
    };
  }
}

async function runMemory(
  page: import("playwright-core").Page,
  origin: string,
  consoleLog: string[],
  childRef: { child: NodeChildProcess.ChildProcess },
): Promise<JourneyResult> {
  try {
    const surface = page.locator("[data-governance-surface='control-center']");
    if ((await surface.count()) === 0) {
      await openControlCenter(page, origin, consoleLog);
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

    stop(childRef.child, home);
    await sleep(1_000);
    const restarted = await startDev(home);
    childRef.child = restarted.child;
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
    const restartedMemories = memoryRows(home);
    if (restartedMemories.some((row) => row.status !== "deleted")) {
      throw new Error(`Deleted memory returned after reopen: ${JSON.stringify(restartedMemories)}`);
    }
    return {
      name: "memory",
      status: "PASS",
      detail: "Save, capture-off, delete, and restart against the same SQLite file held.",
      assertions: {
        saved: true,
        captureOffCreated: afterEnqueue - afterCaptureOff,
        deletedAfterRestart: restartedMemories,
      },
    };
  } catch (error) {
    await captureFailure(page, "memory", consoleLog, error);
    return {
      name: "memory",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
      assertions: { rows: memoryRows(home) },
    };
  }
}

async function main() {
  NodeFS.mkdirSync(artifactDir, { recursive: true });
  installFakeProviders();
  pinFakeDiscovery(home, { instanceId: "codex", model: "gpt-5.4" });
  const started = await startDev(home);
  const childRef = { child: started.child };
  if (started.pairingUrl.length === 0) {
    stop(childRef.child, home);
    NodeFS.writeFileSync(NodePath.join(artifactDir, "browser-server.log"), started.log());
    throw new Error("Dev server did not print a pairing URL.");
  }
  const origin = new URL(started.pairingUrl).origin;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const results: JourneyResult[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleLog: string[] = [];
    page.on("console", (message) => {
      consoleLog.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      consoleLog.push(`pageerror: ${error.message}`);
    });
    await pairAndOpenComposer(page, started.pairingUrl, origin);
    results.push(await runManual(page, consoleLog));
    results.push(await runAuto(page, origin, consoleLog));
    results.push(await runAsk(page, origin, consoleLog));
    results.push(await runMemory(page, origin, consoleLog, childRef));
    NodeFS.writeFileSync(journeyLogPath, `${JSON.stringify({ origin, results }, null, 2)}\n`);
    for (const result of results) {
      NodeProcess.stdout.write(
        `journey ${result.name}=${result.status} ${result.detail}\n${JSON.stringify(result.assertions)}\n`,
      );
    }
    if (results.some((result) => result.status !== "PASS")) {
      throw new Error(
        `Journeys not all PASS: ${results.map((result) => `${result.name}=${result.status}`).join(" ")}`,
      );
    }
    NodeProcess.stdout.write(`production-browser ok origin=${origin}\n`);
  } finally {
    await browser.close();
    stop(childRef.child, home);
    await sleep(500);
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  NodeProcess.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  NodeProcess.exit(1);
});
