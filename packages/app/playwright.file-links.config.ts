import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// Scoped run for the file-link click-dispatcher specs (text/image/media/PDF
// links, downloads, unknown-binary handling, and the retained-pane no-auto-
// download invariant). Same Metro/global-setup and isolated-daemon-per-worker
// behavior as the main config; only the browser binary and video capture
// differ, to match this VM's system Chromium and lack of a bundled ffmpeg.
export default defineConfig({
  ...base,
  testMatch: ["file-link-open.spec.ts", "file-link-media.spec.ts", "file-link-state.spec.ts"],
  outputDir: "test-results/file-links",
  projects: [
    {
      name: "browser",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
      },
    },
    {
      name: "compact",
      grep: /an mp4 link|an unknown binary link/,
      use: {
        ...devices["Pixel 7"],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
      },
    },
  ],
  use: {
    ...base.use,
    video: "off",
  },
});
