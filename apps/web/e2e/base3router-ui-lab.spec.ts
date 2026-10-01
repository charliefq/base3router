import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import * as NodePath from "node:path";

import { UI_LAB_SCENARIO_IDS, type UiLabScenarioId } from "../src/lab/scenarios";
import { UI_LAB_BEARER_PROBE, UI_LAB_SECRET_PROBE } from "../src/lab/fakeProvider";

const SCREENSHOT_DIR = NodePath.join(import.meta.dirname, "../playwright-report/screenshots");

async function openScenario(page: Page, id: UiLabScenarioId) {
  await page.goto(`/lab.html?scenario=${id}`);
  await expect(page.locator('[data-ui-lab="root"]')).toHaveAttribute("data-ui-lab-scenario", id);
}

async function capture(page: Page, name: string) {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: NodePath.join(SCREENSHOT_DIR, `${name}.png`),
    animations: "disabled",
  });
}

async function assertNoSecrets(page: Page) {
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(UI_LAB_SECRET_PROBE);
  expect(body).not.toContain(UI_LAB_BEARER_PROBE);
  expect(body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
}

test.describe("Base3Router UI Lab", () => {
  for (const id of UI_LAB_SCENARIO_IDS) {
    test(`opens ${id}`, async ({ page }) => {
      await openScenario(page, id);
      await expect(page.locator('[data-ui-lab="composer"]')).toBeVisible();
      await expect(page.locator('[data-control-plane="rail"]')).toBeVisible();
      await expect(page.getByLabel("Model routing mode")).toBeVisible();
      await assertNoSecrets(page);
      await capture(page, id);
    });
  }

  test("toggles Auto Route and Manual, then submits a successful Auto prompt", async ({ page }) => {
    await openScenario(page, "empty-thread");
    const mode = page.locator("[data-model-router-mode]");
    await expect(mode).toHaveAttribute("data-model-router-mode", "auto");
    await mode.click();
    await page.getByRole("option", { name: "Manual" }).click();
    await expect(mode).toHaveAttribute("data-model-router-mode", "manual");
    await mode.click();
    await page.getByRole("option", { name: "Auto Route" }).click();
    await expect(mode).toHaveAttribute("data-model-router-mode", "auto");
    await page.locator("[data-ui-lab-prompt]").fill("Route this harmless lab prompt.");
    await page.locator("[data-ui-lab-submit]").click();
    await expect(page.locator("[data-ui-lab-thread-status]")).toHaveAttribute(
      "data-ui-lab-thread-status",
      "completed",
    );
    await expect(page.locator("[data-ui-lab-executed-model]")).toHaveText("gpt-5.5");
    await expect(page.locator("[data-model-router-selected]")).toContainText("gpt-5.5");
    await capture(page, "auto-submit-success");
  });

  test("records Codex failure then Claude fallback in the Inspector", async ({ page }) => {
    await openScenario(page, "failover-success");
    await expect(page.locator("[data-model-router-rerouted]")).toHaveAttribute(
      "data-model-router-rerouted",
      "true",
    );
    await expect(page.locator("[data-ui-lab-selected-model]")).toHaveText("gpt-5.5");
    await expect(page.locator("[data-ui-lab-executed-model]")).toHaveText("claude-sonnet-4-6");
    await expect(page.locator("[data-model-router-attempts]")).toBeVisible();
    await expect(page.locator("[data-model-router-attempt='1']")).toContainText(
      "usage_quota_exhausted",
    );
    await expect(page.locator("[data-model-router-attempt-outcome='succeeded']")).toContainText(
      "claude-sonnet-4-6",
    );
    await page.locator("[data-ui-lab-prompt]").fill("Replay failover from the composer.");
    await page.locator("[data-ui-lab-submit]").click();
    await expect(page.locator("[data-ui-lab-executed-model]")).toHaveText("claude-sonnet-4-6");
    await assertNoSecrets(page);
    await capture(page, "failover-inspector");
  });

  test("shows no-alternate copy and Provider settings", async ({ page }) => {
    await openScenario(page, "no-alternate");
    await expect(page.getByRole("alert")).toContainText("No eligible alternate provider");
    await expect(page.getByRole("button", { name: "Provider settings" })).toBeVisible();
    await capture(page, "no-alternate-banner");
  });

  test("caps Auto Route at three Inspector attempts", async ({ page }) => {
    await openScenario(page, "bounded-attempts");
    await expect(page.locator("[data-model-router-attempt]")).toHaveCount(3);
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("scrolls conversation independently of sidebar and Inspector", async ({ page }) => {
    await openScenario(page, "long-thread");
    const conversation = page.locator('[data-workspace-scroll-surface="conversation"]');
    const sidebar = page.locator('[data-workspace-scroll-surface="sidebar"]');
    const inspector = page.locator('[data-workspace-scroll-surface="inspector"]');
    await expect(conversation).toBeVisible();
    const before = await conversation.evaluate((element) => element.scrollTop);
    await conversation.hover();
    await page.mouse.wheel(0, 800);
    await expect
      .poll(async () => conversation.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before);
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await inspector.evaluate((element) => element.scrollTop)).toBe(0);
    const inspectorBefore = await inspector.evaluate((element) => element.scrollTop);
    await inspector.hover();
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => inspector.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(inspectorBefore);
    expect(await conversation.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
  });

  test("keeps the composer visible after shrinking the viewport", async ({ page }) => {
    await openScenario(page, "reduced-height");
    await page.setViewportSize({ width: 1280, height: 520 });
    await expect(page.locator('[data-ui-lab="composer"]')).toBeVisible();
    await expect(page.locator('[data-slot="composer-shell"]')).toBeVisible();
    await expect(page.getByLabel("Model routing mode")).toBeVisible();
    await capture(page, "reduced-height-composer");
  });

  test("narrow and standard desktop widths keep independent panes", async ({ page }) => {
    await openScenario(page, "standard-width");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('[data-control-plane="inspector"]')).toBeVisible();
    await expect(page.locator('[data-ui-lab="composer"]')).toBeVisible();
    await capture(page, "standard-width");

    await openScenario(page, "narrow-width");
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('[data-ui-lab="composer"]')).toBeVisible();
    await expect(page.locator('[data-control-plane="rail"]')).toBeVisible();
    await capture(page, "narrow-width");
  });
});
