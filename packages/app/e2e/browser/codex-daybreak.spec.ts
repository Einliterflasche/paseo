import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

// The fixture catalog has GPT-6 Sol, which is on Paseo's Daybreak list, and GPT-6.1 Sol, which is not.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: {
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/catalog-codex.mjs")],
        },
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});

// Rendered light-theme colors: palette blue 400 while Daybreak is on, muted foreground otherwise.
const ACTIVE_DAYBREAK_COLOR = "rgb(96, 165, 250)";
const INACTIVE_DAYBREAK_COLOR = "rgb(113, 113, 122)";
const ON_NOTICE = "Daybreak is on for new turns.";
const OFF_NOTICE = "Daybreak is off.";
const UNAVAILABLE = "Daybreak is not available for GPT-6.1 Sol";

async function switchAgentModel(agentId: string, modelId: string): Promise<void> {
  const client = await connectDaemonClient<
    Pick<DaemonClient, "setAgentModel" | "close" | "connect">
  >({
    clientIdPrefix: "codex-daybreak-model",
  });
  try {
    await client.setAgentModel(agentId, modelId);
  } finally {
    await client.close();
  }
}

async function expectIconColor(page: Page, name: string, color: string): Promise<void> {
  const trigger = page.getByRole("button", { name, exact: true }).filter({ visible: true });
  await expect(trigger.locator("svg").first()).toHaveCSS("stroke", color);
}

async function openAgentSettingsSheet(page: Page): Promise<void> {
  const daybreak = page.getByTestId("agent-feature-daybreak").filter({ visible: true });
  if (await daybreak.isVisible()) return;
  const features = page.getByRole("button", { name: "Open agent features", exact: true });
  const modelSettings = page.getByRole("button", { name: /^Select model \(/ });
  const trigger = features.or(modelSettings).filter({ visible: true }).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(daybreak).toBeVisible({ timeout: 30_000 });
}

async function seedDaybreakAgent(page: Page) {
  const workspace = await seedWorkspace({ repoPrefix: "codex-daybreak-" });
  const agent = await workspace.client.createAgent({
    provider: "codex",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Daybreak settings",
    model: "gpt-6-sol",
    modeId: "full-access",
    initialPrompt: "Get ready to work on this project.",
  });
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
  return { workspace, agentId: agent.id };
}

test("Codex Daybreak toggles from the desktop toolbar and stays off the incompatible model", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 850 });
  const { workspace, agentId } = await seedDaybreakAgent(page);
  try {
    const toggle = page.getByRole("button", { name: "Toggle Daybreak", exact: true });
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveText("");
    await expectIconColor(page, "Toggle Daybreak", INACTIVE_DAYBREAK_COLOR);

    await toggle.click();
    await expect(page.getByText(ON_NOTICE, { exact: true })).toBeVisible();
    await expectIconColor(page, "Toggle Daybreak", ACTIVE_DAYBREAK_COLOR);
    await page.screenshot({ path: testInfo.outputPath("desktop-daybreak-on.png") });

    await toggle.click();
    await expect(page.getByText(OFF_NOTICE, { exact: true })).toBeVisible();
    await expectIconColor(page, "Toggle Daybreak", INACTIVE_DAYBREAK_COLOR);

    await toggle.click();
    await expect(page.getByText(ON_NOTICE, { exact: true })).toHaveCount(2);

    await switchAgentModel(agentId, "gpt-6.1-sol");
    const unavailable = page.getByRole("button", { name: UNAVAILABLE, exact: true });
    await expect(unavailable).toBeDisabled({ timeout: 30_000 });
    await expectIconColor(page, UNAVAILABLE, INACTIVE_DAYBREAK_COLOR);
    await unavailable.hover({ force: true });
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("desktop-daybreak-unavailable.png") });

    await switchAgentModel(agentId, "gpt-6-sol");
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    await expectIconColor(page, "Toggle Daybreak", ACTIVE_DAYBREAK_COLOR);
    await expect(page.getByText(ON_NOTICE, { exact: true })).toHaveCount(2);
    await expect(page.getByText(OFF_NOTICE, { exact: true })).toHaveCount(1);
  } finally {
    await workspace.cleanup();
  }
});

test("Codex Daybreak shows its state in the compact settings sheet", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { workspace, agentId } = await seedDaybreakAgent(page);
  try {
    await openAgentSettingsSheet(page);
    const row = page.getByTestId("agent-feature-daybreak").filter({ visible: true });
    await expect(row).toContainText("Off");
    await row.click();
    await page.getByRole("button", { name: "On", exact: true }).last().click();
    await expect(page.getByText(ON_NOTICE, { exact: true })).toHaveCount(1);

    await switchAgentModel(agentId, "gpt-6.1-sol");
    await openAgentSettingsSheet(page);
    await expect(row).toContainText("Unavailable", { timeout: 30_000 });
    await expect(row).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("compact-daybreak-unavailable.png") });
  } finally {
    await workspace.cleanup();
  }
});
