import { defineConfig } from "@playwright/test";
import onboarding from "./playwright.onboarding.config";

// Bundled browser UI, isolated real daemon, deterministic speech transport.
export default defineConfig({
  ...onboarding,
  testMatch: "dictation-fields.spec.ts",
  timeout: 90_000,
  outputDir: "test-results/dictation",
});
