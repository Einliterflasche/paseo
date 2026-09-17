import { defineConfig, devices } from "@playwright/test";

// Uses the production browser export and real daemons; no Metro or seeded E2E startup.
export default defineConfig({
  testDir: "./e2e/browser",
  testMatch: "daemon-web-onboarding.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    ignoreHTTPSErrors: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
