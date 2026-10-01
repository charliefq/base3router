import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.T3CODE_UI_LAB_PORT ?? 45733);
const baseURL = process.env.T3CODE_UI_LAB_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "playwright-results",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  ...(process.env.T3CODE_UI_LAB_URL
    ? {}
    : {
        webServer: {
          command: "vp dev",
          cwd: import.meta.dirname,
          url: `${baseURL}/lab.html`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            ...process.env,
            T3CODE_UI_LAB: "1",
            T3CODE_SINGLE_ORIGIN_DEV: "1",
            PORT: String(port),
            VITE_HTTP_URL: "",
            VITE_WS_URL: "",
          },
        },
      }),
});
