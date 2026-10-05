import { createHash, randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";

const ARTIFACT_DIR = "/opt/cursor/artifacts";
async function capture(page: Page, name: string) {
  await NodeFS.promises.mkdir(ARTIFACT_DIR, { recursive: true });
  await page.screenshot({
    path: NodePath.join(ARTIFACT_DIR, `${name}.png`),
    animations: "disabled",
  });
}

async function finishFirstRunIfPresent(page: Page) {
  const setup = page.getByRole("dialog", { name: "Set up Base3Router" });
  const appeared = await setup.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!appeared) return;
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Do not import projects" }).click();
  await expect(setup).toBeHidden();
}

async function ensureInspectorOpen(page: Page) {
  const open = page.locator('[data-control-plane="inspector"]');
  if (await open.isVisible().catch(() => false)) return;
  const collapsed = page.getByLabel("Open operational inspector");
  if (await collapsed.isVisible().catch(() => false)) {
    await collapsed.click();
  }
  await expect(open).toBeVisible();
}

const seedPendingApproval = (input: {
  readonly environmentId: string;
  readonly approvalId: string;
  readonly toolId: string;
}) => {
  const home = process.env.T3CODE_PRODUCTION_HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("T3CODE_PRODUCTION_HOME is required to seed ActionGate rows.");
  }
  const dbPath = NodePath.join(home, "userdata", "state.sqlite");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  const digest = createHash("sha256")
    .update(`${input.approvalId}:${input.toolId}`)
    .digest("hex")
    .slice(0, 64);
  const record = {
    approvalId: input.approvalId,
    actionId: `act-${input.approvalId}`,
    fingerprint: digest,
    planId: `plan-${input.approvalId}`,
    environmentId: input.environmentId,
    serverId: "fake-mcp",
    toolId: input.toolId,
    argumentDigest: digest,
    policyVersion: "action-gate.v0",
    reusePolicy: "one-time",
    status: "pending",
    scope: "exact-action",
    createdAt: now,
    expiresAt: expires,
    reasonCodes: ["APPROVAL_REQUIRED"],
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    argumentSummary: "path=internal-beta.txt",
    askExplanation: "ActionGate requires a one-time exact-action approval before execution.",
  };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO action_gate_approvals (
        approval_id, environment_id, fingerprint, status, idempotency_key,
        created_at, expires_at, consumed_at, payload_json
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, ?)`,
    ).run(
      input.approvalId,
      input.environmentId,
      digest,
      `ask:${digest}`,
      now,
      expires,
      JSON.stringify(record),
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};

test("Internal Beta: production web UI talks to real RPC for memory, approvals, and reconnect", async ({
  page,
}) => {
  const pairingUrl = process.env.T3CODE_PRODUCTION_PAIRING_URL;
  if (pairingUrl === undefined || pairingUrl.length === 0) {
    throw new Error("T3CODE_PRODUCTION_PAIRING_URL is required.");
  }

  await page.addInitScript(() => {
    const key = "t3code:client-settings:v1";
    const current = window.localStorage.getItem(key);
    const parsed =
      current === null || current.length === 0
        ? {}
        : (JSON.parse(current) as Record<string, unknown>);
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...parsed, onboardingCompletedAt: "2026-10-05T00:00:00.000Z" }),
    );
  });

  await page.goto(pairingUrl);
  await expect(page).not.toHaveURL(/\/pair/, { timeout: 60_000 });
  await finishFirstRunIfPresent(page);

  await page.goto("/control-center");
  await expect(page).toHaveURL(/\/control-center/);
  await expect(page.locator('[data-control-plane="control-center"]')).toBeVisible();
  await expect(page.locator('[data-control-center-surface="ready"]')).toBeVisible({
    timeout: 60_000,
  });
  await ensureInspectorOpen(page);
  await capture(page, "production-control-center-ready");

  const environmentId = await page
    .locator("[data-control-center-environment]")
    .getAttribute("data-control-center-environment");
  expect(environmentId !== null && environmentId.length > 0).toBe(true);
  if (environmentId === null) return;

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings/);
  await page.getByRole("heading", { name: "Dream Memory" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "Dream Memory" })).toBeVisible();
  await page.getByLabel("Memory to save").fill("Prefer focused Internal Beta tests.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.locator("[data-memory-item]")).toContainText(
    "Prefer focused Internal Beta tests.",
  );
  const memorySwitch = page.getByLabel("Enable Dream Memory");
  if (await memorySwitch.isChecked()) {
    await memorySwitch.click();
  }
  await expect(memorySwitch).not.toBeChecked();
  await expect(page.locator("[data-dream-memory-mode]")).toBeVisible();
  await capture(page, "production-memory-controls");

  await page.goto("/control-center");
  await expect(page).toHaveURL(/\/control-center/);
  await expect(page.locator("[data-concurrency-gov]")).toBeVisible();
  await ensureInspectorOpen(page);
  await expect(page.locator("[data-control-plane='inspector']")).toBeVisible();

  const grantId = `apr-${randomUUID()}`;
  const denyId = `apr-${randomUUID()}`;
  seedPendingApproval({
    environmentId,
    approvalId: grantId,
    toolId: "workspace/write_file",
  });
  seedPendingApproval({
    environmentId,
    approvalId: denyId,
    toolId: "workspace/delete_file",
  });
  await page.reload();
  await expect(page.locator('[data-control-center-surface="ready"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-action-approval]")).toHaveCount(2, { timeout: 30_000 });
  await page.locator("[data-action-approval-grant]").first().click();
  await expect(page.locator("[data-action-approval]")).toHaveCount(1);
  await page.locator("[data-action-approval-deny]").click();
  await expect(page.locator("[data-action-approval]")).toHaveCount(0);
  await expect(page.locator("[data-action-governance]")).toContainText("0 pending");
  await ensureInspectorOpen(page);
  await capture(page, "production-approvals-decided");

  await page.reload();
  await expect(page.locator('[data-control-center-surface="ready"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-dream-memory-gov]")).toBeVisible();
  await expect(page.locator("[data-action-governance]")).toContainText("0 pending");
  await ensureInspectorOpen(page);
  await capture(page, "production-refresh-reconnect");
});
