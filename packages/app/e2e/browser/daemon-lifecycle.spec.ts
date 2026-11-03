import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  openDaemonOverview,
  restartDaemonInSettings,
  expectDaemonRestartComplete,
  readWorkerPid,
} from "../support/helpers/daemon-lifecycle";

test("settings restart waits for a replacement worker while retaining the supervisor", async ({
  page,
}, testInfo) => {
  const daemon = await startIsolatedHostDaemon(randomUUID());
  try {
    const supervisor = daemon.getPid();
    const previousWorker = await readWorkerPid(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(daemon.getPid()).toBe(supervisor);
    await page.screenshot({ path: testInfo.outputPath("restart-confirmed.png"), fullPage: true });
  } finally {
    await daemon.close();
  }
});

test("settings restart replaces the worker when a provider CLI answers --version slowly", async ({
  page,
}) => {
  test.skip(process.platform === "win32", "The slow provider stub is a POSIX script");
  const daemon = await startIsolatedHostDaemon(randomUUID(), {
    paseoHome: await createHomeWithSlowProvider(1_800),
  });
  try {
    const previousWorker = await readWorkerPid(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
  } finally {
    await daemon.close();
  }
});

async function createHomeWithSlowProvider(versionDelayMs: number): Promise<string> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-e2e-slow-provider-"));
  const provider = path.join(paseoHome, "slow-provider");
  await writeFile(
    provider,
    `#!${process.execPath}\nsetTimeout(() => console.log("provider 1.0.0"), ${versionDelayMs});\n`,
    { mode: 0o700 },
  );
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({
      version: 1,
      agents: { providers: { claude: { command: { mode: "replace", argv: [provider] } } } },
    })}\n`,
  );
  return paseoHome;
}

test("Restart anyway escapes failed recovery from the host banner without reloading the app", async ({
  page,
}, testInfo) => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-e2e-restart-anyway-"));
  await mkdir(path.join(home, "restart-checkpoints"));
  const pointer = path.join(home, "restart-checkpoints", "ready.json");
  const corrupt = "{incomplete checkpoint";
  await writeFile(pointer, corrupt);
  const daemon = await startIsolatedHostDaemon(randomUUID(), { paseoHome: home });
  try {
    await openDaemonOverview(page, daemon);
    const previousWorker = await readWorkerPid(daemon);
    const button = page.getByTestId("host-restart-anyway");
    await expect(button).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("restart-anyway-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(button).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("restart-anyway-compact.png"),
      fullPage: true,
    });
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Saved tasks will not resume automatically");
      await dialog.dismiss();
    });
    await button.click();
    await expect(button).toBeEnabled();
    expect(await readWorkerPid(daemon)).toBe(previousWorker);
    await page.evaluate(() => {
      (globalThis as { emergencyRestartPageMarker?: string }).emergencyRestartPageMarker =
        "same-page";
    });
    page.once("dialog", (dialog) => dialog.accept());
    await button.click();
    await expect(button).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(
      await page.evaluate(
        () => (globalThis as { emergencyRestartPageMarker?: string }).emergencyRestartPageMarker,
      ),
    ).toBe("same-page");
    expect(await readFile(pointer, "utf8")).toBe(corrupt);
    await page.screenshot({
      path: testInfo.outputPath("restart-anyway-recovered.png"),
      fullPage: true,
    });
  } finally {
    await daemon.close();
  }
});
