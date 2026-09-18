import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  copyFixtureIntoRepo,
  seedFileLinkAgentWorkspace,
  SAMPLE_PDF_FIXTURE,
} from "../support/helpers/file-link-fixtures";

test("PDF without a browser viewer downloads once without opening a tab", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => false });
  });
  const workspace = await seedFileLinkAgentWorkspace({
    repoPrefix: "file-link-pdf-download-",
    title: "PDF download",
    placeFixture: async (repoPath) => ({
      label: "Open manual",
      absolutePath: await copyFixtureIntoRepo(repoPath, "manual.pdf", SAMPLE_PDF_FIXTURE),
    }),
  });
  try {
    await openAgentRoute(page, workspace);
    const pagesBefore = page.context().pages().length;
    const downloads: string[] = [];
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    const pendingDownload = page.waitForEvent("download");
    await page.locator("a").filter({ hasText: "Open manual" }).click();
    const download = await pendingDownload;
    expect(await readFile((await download.path())!)).toEqual(await readFile(SAMPLE_PDF_FIXTURE));
    expect(downloads).toEqual(["manual.pdf"]);
    expect(page.context().pages()).toHaveLength(pagesBefore);
    await expect(page.getByTestId("workspace-file-pane")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("metadata failure on return preserves an unsaved editor and downloads only the saved bytes", async ({
  page,
}) => {
  const saved = "const saved = true;";
  const draft = "const draft = true;";
  const workspace = await seedFileLinkAgentWorkspace({
    repoPrefix: "file-link-editor-retention-",
    title: "Retained editor",
    placeFixture: async (repoPath) => {
      const absolutePath = path.join(repoPath, "draft.ts");
      await writeFile(absolutePath, saved);
      return { label: "Open source", absolutePath };
    },
  });
  const gate = await installDaemonWebSocketGate(page);
  try {
    await openAgentRoute(page, workspace);
    await page.locator("a").filter({ hasText: "Open source" }).click();
    const editor = page.getByTestId("file-source-editor").locator(".cm-content");
    await expect(editor).toBeVisible();
    const originalEditor = await editor.elementHandle();
    gate.holdNextClientRequest("fs.file.write.request");
    await editor.fill(draft);
    await gate.waitForHeldClientRequest();

    const pendingDownload = page.waitForEvent("download");
    await page.getByTestId("file-download-button").click();
    const download = await pendingDownload;
    expect(await readFile((await download.path())!, "utf8")).toBe(saved);
    await expect(editor).toHaveText(draft);

    await page
      .getByTestId(`workspace-tab-agent_${workspace.agentId}`)
      .filter({ visible: true })
      .first()
      .click();
    // A real filesystem failure in the metadata refresh must not discard the
    // draft owned by the existing editor or replace its conflict UI.
    await unlink(path.join(workspace.cwd, "draft.ts"));
    gate.holdNextServerMessage("files.get_access.response");
    await page.getByTestId("workspace-tab-file_draft.ts").filter({ visible: true }).first().click();
    await gate.waitForHeldServerMessage("files.get_access.response");
    gate.releaseHeldServerMessage("files.get_access.response");
    // Complete the outstanding save; conflict notices wait while a save is pending.
    gate.releaseHeldClientRequest();
    await expect(page.getByTestId("workspace-file-pane").getByRole("alert")).toContainText(
      "File deleted on disk",
    );
    await expect(editor).toHaveText(draft);
    expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(
      true,
    );
  } finally {
    await workspace.cleanup();
  }
});
