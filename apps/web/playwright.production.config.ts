import { defineConfig, devices } from "@playwright/test";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const baseURL = process.env.T3CODE_PRODUCTION_BROWSER_URL ?? "http://localhost:5733";
const artifactRoot =
  process.env.T3CODE_PRODUCTION_PLAYWRIGHT_DIR ??
  NodePath.join(NodeOS.tmpdir(), "t3-internal-beta-playwright");

export default defineConfig({
  testDir: "./e2e-production",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: NodePath.join(artifactRoot, "report") }],
  ],
  outputDir: NodePath.join(artifactRoot, "results"),
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
