import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  copyFixtureIntoRepo,
  seedFileLinkAgentWorkspace,
  SAMPLE_PNG_FIXTURE,
  unknownBinaryFixtureBytes,
  writeBinaryFixture,
} from "../support/helpers/file-link-fixtures";

// Real daemon, real browser, and a deterministic mock-provider agent (the
// "emit settled assistant link markdown:" trigger added to
// mock-load-test-agent.ts) standing in for a paid real agent. Every scenario
// clicks a real absolute-path markdown link rendered inside a real assistant
// message and drives the real click dispatcher
// (packages/app/src/files/use-open-linked-file.tsx).

test.describe("Agent markdown file links: text, image, unicode paths, unknown binaries, failure", () => {
  test("absolute link to a text file opens it in the pane with a working Download button", async ({
    page,
  }) => {
    const textContent = "Absolute link text fixture 12345\n";
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-text-",
      title: "File link text",
      placeFixture: async (repoPath) => {
        const absolutePath = path.join(repoPath, "docs/notes.txt");
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, textContent);
        return { label: "Open notes", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open notes" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();

      await expect(page.getByTestId("workspace-file-pane")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(textContent.trim())).toBeVisible({ timeout: 30_000 });

      const downloadButton = page.getByTestId("file-download-button");
      await expect(downloadButton).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await downloadButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("notes.txt");
      const downloadedPath = await download.path();
      expect(downloadedPath).not.toBeNull();
      const downloadedContent = await readFile(downloadedPath as string, "utf8");
      expect(downloadedContent).toBe(textContent);
    } finally {
      await workspace.cleanup();
    }
  });

  test("absolute link to an image opens it in the pane with a working Download button", async ({
    page,
  }) => {
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-image-",
      title: "File link image",
      placeFixture: async (repoPath) => {
        const absolutePath = await copyFixtureIntoRepo(
          repoPath,
          "assets/logo.png",
          SAMPLE_PNG_FIXTURE,
        );
        return { label: "Open logo", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open logo" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();

      await expect(page.getByTestId("workspace-file-pane")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("image-file-preview")).toBeVisible({ timeout: 30_000 });

      const downloadButton = page.getByTestId("file-download-button");
      await expect(downloadButton).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await downloadButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("logo.png");
      const downloadedPath = await download.path();
      const [downloadedBytes, sourceBytes] = await Promise.all([
        readFile(downloadedPath as string),
        readFile(SAMPLE_PNG_FIXTURE),
      ]);
      expect(downloadedBytes.equals(sourceBytes)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });

  test("a path with encoded spaces and unicode characters opens the right file", async ({
    page,
  }) => {
    const textContent = "Unicode fixture content ✅\n";
    const fileName = "My Report é ✅.txt";
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-unicode-",
      title: "File link unicode",
      placeFixture: async (repoPath) => {
        const absolutePath = path.join(repoPath, "docs", fileName);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, textContent);
        return { label: "Open unicode report", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open unicode report" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();

      await expect(page.getByTestId("workspace-file-pane")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(textContent.trim())).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId(`workspace-tab-file_docs/${fileName}`).filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("file-download-button").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(fileName);
      expect(await readFile((await download.path())!, "utf8")).toBe(textContent);
    } finally {
      await workspace.cleanup();
    }
  });

  test("an unknown binary link downloads the exact bytes under the real filename, with no pane or tab", async ({
    page,
  }) => {
    const bytes = unknownBinaryFixtureBytes();
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-binary-",
      title: "File link unknown binary",
      placeFixture: async (repoPath) => {
        const absolutePath = await writeBinaryFixture(repoPath, "payload.customext", bytes);
        return { label: "Open payload", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open payload" });
      await expect(link).toBeVisible({ timeout: 30_000 });

      const pagesBefore = page.context().pages().length;
      const downloadPromise = page.waitForEvent("download");
      await link.click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe("payload.customext");
      const downloadedPath = await download.path();
      const downloadedBytes = await readFile(downloadedPath as string);
      expect(downloadedBytes.equals(bytes)).toBe(true);

      // No pane and no new tab: the unknown binary never gets a preview surface.
      await expect(page.getByTestId("workspace-file-pane")).toHaveCount(0);
      await expect(page.getByTestId(/workspace-tab-file_/)).toHaveCount(0);
      expect(page.context().pages().length).toBe(pagesBefore);
    } finally {
      await workspace.cleanup();
    }
  });

  test("a broken link shows a visible error with Retry, and Retry succeeds once the file exists", async ({
    page,
  }) => {
    const textContent = "Now it exists.\n";
    let absolutePathHolder = "";
    const workspace = await seedFileLinkAgentWorkspace({
      repoPrefix: "file-link-retry-",
      title: "File link retry",
      placeFixture: async (repoPath) => {
        const absolutePath = path.join(repoPath, "docs", "arrives-later.txt");
        absolutePathHolder = absolutePath;
        // Intentionally do not create the file yet: the first click must fail.
        return { label: "Open later file", absolutePath };
      },
    });
    try {
      await openAgentRoute(page, workspace);
      const link = page.locator("a").filter({ hasText: "Open later file" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();

      const errorToast = page.getByTestId("file-open-error");
      await expect(errorToast).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("workspace-file-pane")).toHaveCount(0);

      await mkdir(path.dirname(absolutePathHolder), { recursive: true });
      await writeFile(absolutePathHolder, textContent);

      await page.getByTestId("file-open-retry").click();

      await expect(page.getByTestId("workspace-file-pane")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(textContent.trim())).toBeVisible({ timeout: 30_000 });
      await expect(errorToast).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
