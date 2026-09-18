import { expect, test } from "../support/fixtures";
import { readFile } from "node:fs/promises";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  copyFixtureIntoRepo,
  seedFileLinkAgentWorkspace,
  SAMPLE_MP4_FIXTURE,
  SAMPLE_PDF_FIXTURE,
  unknownBinaryFixtureBytes,
  writeBinaryFixture,
} from "../support/helpers/file-link-fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

// Real daemon, real browser, and a deterministic mock-provider agent driving
// the real click dispatcher (packages/app/src/files/use-open-linked-file.tsx)
// and its decision table (packages/app/src/files/open-decision.ts).

// Extracted so these run as plain top-level functions inside page.evaluate,
// not arrows nested inside the test body (keeps max-nested-callbacks happy).
function waitForVideoMetadata(element: HTMLVideoElement): Promise<number> {
  return new Promise((resolve) => {
    if (element.readyState >= 1 && element.duration > 0) {
      resolve(element.duration);
      return;
    }
    element.addEventListener("loadedmetadata", () => resolve(element.duration), { once: true });
  });
}

function seekVideoAndWaitForSeeked(element: HTMLVideoElement, seekTo: number): Promise<number> {
  return new Promise((resolve) => {
    element.addEventListener("seeked", () => resolve(element.currentTime), { once: true });
    element.currentTime = seekTo;
  });
}

function videoIsPaused(element: HTMLVideoElement): boolean {
  return element.paused;
}

test.describe("Agent markdown file links: playable media and PDF", () => {
  test("an mp4 link opens a real, seekable <video> in the pane", async ({ page }, testInfo) => {
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-mp4-",
      title: "File link mp4",
      placeFixture: async (repoPath) => {
        const absolutePath = await copyFixtureIntoRepo(
          repoPath,
          "media/sample.mp4",
          SAMPLE_MP4_FIXTURE,
        );
        return { label: "Open clip", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open clip" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();

      await expect(page.getByTestId("workspace-file-pane")).toBeVisible({ timeout: 30_000 });
      const video = page.getByTestId("file-video-preview");
      await expect(video).toBeVisible({ timeout: 30_000 });
      await expect(video).toHaveAttribute("controls", "");
      await expect(video).toHaveAttribute("src", /\/api\/files\/preview\?token=/);

      // Real bytes served over the real HTTP preview route: metadata actually loads.
      const duration = await video.evaluate(waitForVideoMetadata);
      expect(duration).toBeGreaterThan(0);
      expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("file-download-button").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("sample.mp4");
      expect(await readFile((await download.path())!)).toEqual(await readFile(SAMPLE_MP4_FIXTURE));

      // Seeking exercises the server's real byte-Range handling for the preview route.
      const target = duration / 2;
      const seekedTime = await video.evaluate(seekVideoAndWaitForSeeked, target);
      expect(seekedTime).toBeGreaterThan(target - 1);
      expect(seekedTime).toBeLessThan(target + 1);
      await page.screenshot({ path: testInfo.outputPath("video-preview.png") });
      await video.evaluate((element: HTMLVideoElement) => {
        element.muted = true;
        element.loop = true;
        return element.play();
      });
      await expect.poll(() => video.evaluate(videoIsPaused)).toBe(false);
      if (testInfo.project.name === "compact") {
        await page.getByTestId("workspace-tab-switcher-trigger").click();
        await page.getByTestId(`workspace-tab-option-agent_${workspace.agentId}`).click();
      } else {
        await page
          .getByTestId(`workspace-tab-agent_${workspace.agentId}`)
          .filter({ visible: true })
          .first()
          .click();
      }
      await expect.poll(() => video.evaluate(videoIsPaused)).toBe(true);

      await test.info().attach("mp4-pane-after-seek", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("a failed media request keeps Download and Retry recovers with the same file grant", async ({
    page,
  }) => {
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-media-retry-",
      title: "File media retry",
      placeFixture: async (repoPath) => ({
        label: "Retry clip",
        absolutePath: await copyFixtureIntoRepo(repoPath, "clip.mp4", SAMPLE_MP4_FIXTURE),
      }),
    });
    try {
      await page.route("**/api/files/preview?*", (route) => route.abort("failed"));
      await openAgentRoute(page, workspace);
      await page.locator("a").filter({ hasText: "Retry clip" }).click();
      const error = page.getByTestId("file-media-preview-error");
      await expect(error).toBeVisible();
      await expect(error.getByRole("button", { name: "Download", exact: true })).toBeVisible();
      await page.unroute("**/api/files/preview?*");
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      const video = page.getByTestId("file-video-preview");
      await expect(video).toBeVisible();
      expect(await video.evaluate(waitForVideoMetadata)).toBeGreaterThan(0);
      await expect(error).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("a PDF link opens a new browser tab without also triggering a download", async ({
    page,
  }) => {
    // Force the deterministic branch: real headless Chromium's built-in PDF
    // viewer availability is an environment detail, not test-worthy on its own.
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "pdfViewerEnabled", {
        configurable: true,
        get: () => true,
      });
    });

    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-pdf-",
      title: "File link pdf",
      placeFixture: async (repoPath) => {
        const absolutePath = await copyFixtureIntoRepo(
          repoPath,
          "docs/manual.pdf",
          SAMPLE_PDF_FIXTURE,
        );
        return { label: "Open manual", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open manual" });
      await expect(link).toBeVisible({ timeout: 30_000 });

      let downloadFired = false;
      page.on("download", () => {
        downloadFired = true;
      });
      const popupPromise = page.context().waitForEvent("page");
      await link.click();

      const popup = await popupPromise;
      // The click reserves about:blank before the file-access RPC completes.
      await popup.waitForURL(/\/api\/files\/preview\?token=/);
      expect(downloadFired).toBe(false);
      await expect(page.getByTestId("workspace-file-pane")).toHaveCount(0);

      await test.info().attach("pdf-preview-tab", {
        body: await popup.screenshot(),
        contentType: "image/png",
      });
      await popup.close();
    } finally {
      await workspace.cleanup();
    }
  });

  test("a retained/restored unsupported-binary pane never auto-downloads on reactivation", async ({
    page,
  }) => {
    const binaryBytes = unknownBinaryFixtureBytes();
    let workspace: SeededWorkspace | null = null;
    try {
      workspace = await seedWorkspace({
        repoPrefix: "file-link-retained-",
        repo: { files: [{ path: "other.txt", content: "Some other file.\n" }] },
      });
      await writeBinaryFixture(workspace.repoPath, "payload.customext", binaryBytes);

      await gotoWorkspace(page, workspace.workspaceId);
      await openFileExplorer(page);

      let downloadFired = false;
      page.on("download", () => {
        downloadFired = true;
      });

      await openFileFromExplorer(page, "payload.customext");
      await expect(page.getByTestId("file-binary-preview")).toBeVisible({ timeout: 30_000 });
      // Explorer files use a replaceable preview slot. Switching to the existing
      // chat draft hides the file without intentionally replacing that slot.
      await page
        .locator('[data-testid^="workspace-tab-draft_"]')
        .filter({ visible: true })
        .first()
        .click();
      await expect(page.getByTestId("message-input-root").filter({ visible: true })).toBeVisible();
      expect(downloadFired).toBe(false);

      // ...then restore it. Reactivation must never auto-trigger a download.
      await page.getByTestId("workspace-tab-file_payload.customext").first().click();
      await expect(page.getByTestId("file-binary-preview")).toBeVisible({ timeout: 30_000 });
      expect(downloadFired).toBe(false);

      // The Download button still works as an explicit user action.
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByTestId("file-binary-preview")
        .getByRole("button", { name: /download/i })
        .click();
      await downloadPromise;
      expect(downloadFired).toBe(true);
    } finally {
      await workspace?.cleanup();
    }
  });
});
