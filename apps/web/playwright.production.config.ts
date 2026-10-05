import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.T3CODE_PRODUCTION_BROWSER_URL ?? "http://127.0.0.1:5733";

export default defineConfig({
  testDir: "./e2e-production",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-production-report" }]],
  outputDir: "playwright-production-results",
  timeout: 90_000,
  expect: { timeout: 20_000 },
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
