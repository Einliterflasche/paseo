import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { startDictationDaemon, type DictationDaemon } from "../support/helpers/dictation-daemon";
import { installDictationMicrophone } from "../support/helpers/dictation-browser";
import { connectSeedClient, type SeedDaemonClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { createAgentTabFromMenu, openChangesPanel } from "../support/helpers/workspace-tabs";
import {
  buildHostWorkspaceRoute,
  buildProjectSettingsRoute,
  buildSettingsHostSectionRoute,
} from "../../src/utils/host-routes";

interface ScratchWorkspace {
  client: SeedDaemonClient &
    Pick<
      DaemonClient,
      "scheduleList" | "getDaemonConfig" | "patchDaemonConfig" | "readProjectConfig"
    >;
  id: string;
  projectId: string;
  directory: string;
}

const test = base.extend<
  { speech: DictationDaemon["speech"] },
  { host: DictationDaemon; workspace: ScratchWorkspace }
>({
  host: [
    // Playwright requires fixture argument destructuring.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const host = await startDictationDaemon();
      try {
        await provide(host);
      } finally {
        await host.close();
      }
    },
    { scope: "worker" },
  ],
  workspace: [
    async ({ host }, provide) => {
      const repo = await createTempGitRepo("dictation-browser-", {
        files: [{ path: "example.ts", content: "const before = 1;\nconst change = 2;\n" }],
      });
      await writeFile(path.join(repo.path, "example.ts"), "const before = 1;\nconst change = 3;\n");
      const client = (await connectSeedClient({
        port: Number(new URL(host.origin).port),
        projectOwnership: "host",
      })) as ScratchWorkspace["client"];
      try {
        const result = await client.createWorkspace({
          source: { kind: "directory", path: repo.path },
          title: "Dictation browser scratch",
        });
        if (!result.workspace) throw new Error(result.error ?? "Scratch workspace was not created");
        await provide({
          client,
          id: result.workspace.id,
          projectId: result.workspace.projectId,
          directory: repo.path,
        });
      } finally {
        await client.close();
        // Retain the scratch repo and isolated daemon state for reviewing failures.
      }
    },
    { scope: "worker" },
  ],
  speech: async ({ page, host, workspace }, provide, testInfo) => {
    const messages: string[] = [];
    page.on("console", (message) => messages.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => messages.push(error.stack ?? error.message));
    await page.route(/:6767\b/, (route) => route.abort());
    await page.routeWebSocket(/:6767\b/, (socket) =>
      socket.close({ code: 1008, reason: "Live daemon blocked by dictation browser regression" }),
    );
    await installDictationMicrophone(page);
    const speech = host.speech;
    await expect.poll(() => speech.openSessions().length).toBe(0);
    speech.reset();
    await page.goto(host.origin);
    // First-run same-origin onboarding establishes the host before workspace
    // routes can resolve. Enter through the hydrated sidebar like a new user.
    await page.getByRole("button", { name: /^Dictation browser scratch(?:,|$)/ }).click();
    await expect(page).toHaveURL(
      `${host.origin}${buildHostWorkspaceRoute(host.serverId, workspace.id)}`,
    );
    await expect(
      page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first(),
    ).toBeVisible();
    await provide(speech);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("browser-console", {
        body: messages.join("\n"),
        contentType: "text/plain",
      });
      await testInfo.attach("isolated-daemon-home", { body: host.home, contentType: "text/plain" });
    }
  },
});

async function microphoneRequests(page: Page): Promise<number> {
  return page.evaluate(() => window.dictationTestMicrophone.requests);
}

async function expectMicrophoneReleased(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.dictationTestMicrophone.liveTracks)).toBe(0);
}

async function selectDictationTestModel(page: Page, compact = false): Promise<void> {
  await page.getByTestId("combined-model-selector").filter({ visible: true }).click();
  await page.getByTestId("model-search-all-input").fill("Five minute stream");
  await page.getByTestId("model-row-mock-five-minute-stream").click();
  if (compact) {
    await page
      .getByTestId("agent-controls-model-sheet")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  }
  await expect(page.getByTestId("model-search-all-input")).not.toBeVisible();
  await expect(
    page.getByTestId("combined-model-selector").filter({ visible: true }),
  ).toHaveAccessibleName("Select model (Five minute stream)");
}

async function expectDictationControlsInViewport(page: Page, inputId: string, recording: boolean) {
  const controls = [`${inputId}-dictation-toggle`];
  if (recording) controls.push(`${inputId}-dictation-cancel`, `${inputId}-dictation-submit`);
  const field = page.getByTestId(`${inputId}-dictation-field`);
  for (const id of controls) {
    const control = page.getByTestId(id);
    await expect(control).toBeVisible();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  // A compact sheet can still be moving. Measure its field and descendants in
  // one browser frame so a translation cannot look like control overflow.
  const geometry = await field.evaluate(
    (element, { controlIds, overlayId }) => {
      const fieldRect = element.getBoundingClientRect();
      const insets = (id: string) => {
        const node = element.querySelector(`[data-testid="${id}"]`);
        if (!node) throw new Error(`Missing field control ${id}`);
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left - fieldRect.left,
          top: rect.top - fieldRect.top,
          right: fieldRect.right - rect.right,
          bottom: fieldRect.bottom - rect.bottom,
        };
      };
      return {
        controls: controlIds.map((id) => ({ id, ...insets(id) })),
        overlay: overlayId ? insets(overlayId) : null,
      };
    },
    { controlIds: controls, overlayId: recording ? `${inputId}-dictation-overlay` : null },
  );
  for (const { id, left, top, right, bottom } of geometry.controls) {
    expect(left, `${id} left inset`).toBeGreaterThanOrEqual(0);
    expect(top, `${id} top inset`).toBeGreaterThanOrEqual(0);
    expect(right, `${id} right inset`).toBeGreaterThanOrEqual(0);
    expect(bottom, `${id} bottom inset`).toBeGreaterThanOrEqual(0);
  }
  if (recording) {
    expect(geometry.overlay).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  }
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function visibleBounds(locator: Locator): Promise<Bounds> {
  await expect(locator).toBeVisible();
  let previous: Bounds | null = null;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const bounds = await locator.boundingBox();
        const unchanged =
          bounds &&
          previous &&
          Object.entries(bounds).every(([key, value]) => previous![key as keyof Bounds] === value);
        stableSamples = unchanged ? stableSamples + 1 : 0;
        previous = bounds;
        return stableSamples;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(2);
  if (!previous) throw new Error(`Missing visible bounds for ${locator}`);
  return previous;
}

async function expectBounds(locator: Locator, expected: Bounds): Promise<void> {
  await expect
    .poll(async () => {
      const actual = await locator.boundingBox();
      if (!actual) return null;
      return Object.entries(expected).every(
        ([key, value]) => Math.abs(actual[key as keyof Bounds] - value) < 0.5,
      );
    })
    .toBe(true);
}

async function meterHeights(meter: Locator): Promise<number[]> {
  return meter.evaluate((element) =>
    [0, 2, 4].map((index) => element.children[index]!.getBoundingClientRect().height),
  );
}

async function expectMeterRespondsToSound(page: Page, inputId: string): Promise<void> {
  const meter = page.getByTestId(`${inputId}-dictation-meter`);
  await expect(meter).toBeVisible();
  // The existing chat meter alternates three bars with two spacing views.
  await expect(meter.locator(":scope > div")).toHaveCount(5);
  await page.evaluate(() => window.dictationTestMicrophone.setLevel(0));
  await expect.poll(async () => Math.max(...(await meterHeights(meter)))).toBeLessThan(16);
  const silentHeights = await meterHeights(meter);
  await page.evaluate(() => window.dictationTestMicrophone.setLevel(1));
  await expect
    .poll(async () =>
      (await meterHeights(meter)).every((height, index) => height > silentHeights[index]! + 8),
    )
    .toBe(true);
}

async function recordingAppearance(overlay: Locator, buttons: Locator[]) {
  const background = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor);
  const controls = [];
  for (const button of buttons) {
    await expect(button.locator("svg")).toHaveCount(1);
    controls.push(
      await button.evaluate((element) => {
        const icon = element.querySelector("svg")!;
        return {
          background: getComputedStyle(element).backgroundColor,
          iconColor: getComputedStyle(icon).color,
          iconStroke: icon.getAttribute("stroke"),
          iconPaths: Array.from(icon.querySelectorAll("path"), (node) => node.getAttribute("d")),
        };
      }),
    );
  }
  return { background, controls };
}

async function openReview(page: Page, changesAlreadyOpen = false): Promise<Locator> {
  if (!changesAlreadyOpen) await openChangesPanel(page);
  const body = page.getByTestId("diff-file-0-body").filter({ visible: true });
  const canvas = page.getByTestId("git-diff-canvas").filter({ visible: true });
  const bounds = await body.boundingBox();
  if (!bounds) throw new Error("Review diff has no visible bounds");
  const fontSize = await canvas.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  await page.mouse.move(bounds.x + 20, bounds.y + Math.round(fontSize * 1.5) * 1.5, { steps: 12 });
  await page.getByRole("button", { name: "Add review comment" }).click();
  const input = page.getByTestId("inline-review-editor-input");
  await expect(input).toBeFocused();
  return input;
}

async function openSchedule(page: Page, host: DictationDaemon): Promise<Locator> {
  await page.goto(`${host.origin}/schedules`);
  await page.getByTestId("schedules-empty-new").click();
  const prompt = page.getByTestId("schedule-prompt-input");
  await expect(prompt).toBeEditable();
  await expect(page.getByTestId("schedule-prompt-input-dictation-toggle")).toBeEnabled();
  return prompt;
}

async function openMetadata(page: Page, host: DictationDaemon, workspace: ScratchWorkspace) {
  // Keep the connected host client while entering settings; a cold reload can
  // close the bootstrap client during the project's initial config request.
  await page.getByTestId("sidebar-settings").click();
  await page.getByTestId("settings-host-section-projects").click();
  await page
    .getByRole("button", { name: `Edit ${path.basename(workspace.directory)}`, exact: true })
    .click();
  await expect(page).toHaveURL(
    `${host.origin}${buildProjectSettingsRoute(host.serverId, workspace.projectId)}`,
  );
  const first = page.getByTestId("metadata-prompt-branch-name-input");
  const second = page.getByTestId("metadata-prompt-commit-message-input");
  await expect(first).toBeEditable();
  await expect(second).toBeEditable();
  return { first, second };
}

async function visitOtherDraftTabs(page: Page) {
  const drafts: Array<{ tabId: string; text: string }> = [];
  // The panel cache holds three tabs. Three newer tabs must not evict a
  // recording or pending transcript from the original fourth tab.
  for (const text of ["Second chat draft", "Third chat draft", "Fourth chat draft"]) {
    await createAgentTabFromMenu(page);
    const tabId = await page
      .locator('[data-testid^="workspace-tab-draft"]')
      .filter({ visible: true })
      .last()
      .getAttribute("data-testid");
    if (!tabId) throw new Error("Draft tab is missing its identity");
    await page
      .getByTestId("message-input-root")
      .filter({ visible: true })
      .locator("textarea")
      .fill(text);
    drafts.push({ tabId, text });
  }
  return drafts;
}

async function expectOtherDraftsUnchanged(
  page: Page,
  drafts: Array<{ tabId: string; text: string }>,
) {
  for (const { tabId, text } of drafts) {
    await page
      .getByTestId(tabId)
      .filter({ visible: true })
      .click({ position: { x: 12, y: 13 } });
    await expect(
      page.getByTestId("message-input-root").filter({ visible: true }).locator("textarea"),
    ).toHaveValue(text);
  }
}

async function openQuestions(
  page: Page,
  host: DictationDaemon,
  workspace: ScratchWorkspace,
  prompt: string,
) {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.directory,
    workspaceId: workspace.id,
    model: "e2e-fast-stream",
    modeId: "load-test",
    initialPrompt: prompt,
  });
  await page.getByTestId("sidebar-sessions").click();
  await page.getByTestId(`agent-row-${host.serverId}-${agent.id}`).click();
  const card = page.getByTestId("question-form-card").first();
  await expect(card).toBeVisible();
  return card;
}

test("dictating a question answer leaves Next and Submit as explicit actions", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const card = await openQuestions(
    page,
    host,
    workspace,
    "Emit synthetic questions: two free-write questions.",
  );
  const first = card.getByRole("textbox", {
    name: "What is the GitHub private repo URL to push to?",
  });
  await first.fill("First answer");
  await first.press("End");
  await first.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  speech.complete("spoken addition");
  await expect(first).toHaveValue("First answer spoken addition");
  await expect(card.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  expect(speech.permissionResponses).toEqual([]);
  await card.getByRole("button", { name: "Next", exact: true }).click();
  await card
    .getByRole("textbox", { name: "What should the first commit message be?" })
    .fill("Second answer");
  await card.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => speech.permissionResponses.length).toBe(1);
  expect(JSON.stringify(speech.permissionResponses[0])).toContain("First answer spoken addition");
  expect(JSON.stringify(speech.permissionResponses[0])).toContain("Second answer");
});

test("question dictation arrows advance and submit the completed answers exactly once", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const card = await openQuestions(
    page,
    host,
    workspace,
    "Emit synthetic questions: two free-write questions.",
  );
  const firstId = "question-form-answer-1";
  const first = card.getByTestId(firstId);
  await first.fill("First answer");
  await first.press("End");
  const firstBounds = await visibleBounds(card.getByTestId(`${firstId}-dictation-field`));
  await card.getByTestId(`${firstId}-dictation-toggle`).click();
  await speech.waitForAudio(0);
  await expectDictationControlsInViewport(page, firstId, true);
  await expectBounds(card.getByTestId(`${firstId}-dictation-field`), firstBounds);
  await card.getByTestId(`${firstId}-dictation-submit`).click();
  await speech.waitForFinish(0);
  await expectBounds(card.getByTestId(`${firstId}-dictation-overlay`), firstBounds);
  speech.complete("spoken first addition", 0);
  const secondId = "question-form-answer-2";
  const second = card.getByTestId(secondId);
  await expect(second).toBeEditable();
  expect(speech.permissionResponses).toEqual([]);
  await second.fill("Second answer");
  await second.press("End");
  await card.getByTestId(`${secondId}-dictation-toggle`).click();
  await speech.waitForAudio(1);
  await card.getByTestId(`${secondId}-dictation-submit`).click();
  await speech.waitForFinish(1);
  speech.complete("spoken second addition", 1);
  speech.complete("spoken second addition", 1);
  await expect(card).toHaveCount(0);
  await expect.poll(() => speech.permissionResponses.length).toBe(1);
  expect(speech.permissionResponses[0]).toMatchObject({
    behavior: "allow",
    updatedInput: {
      answers: {
        repoUrl: "First answer spoken first addition",
        commitMessage: "Second answer spoken second addition",
      },
    },
  });
  expect(await microphoneRequests(page)).toBe(2);
  await expectMicrophoneReleased(page);
});

test("Tab skips the hidden question input and Enter activates the focused dictation arrow", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const card = await openQuestions(
    page,
    host,
    workspace,
    "Emit synthetic questions: two free-write questions.",
  );
  const firstId = "question-form-answer-1";
  const first = card.getByTestId(firstId);
  await first.fill("Keyboard first answer");
  await first.press("End");
  await card.getByTestId(`${firstId}-dictation-toggle`).click();
  await speech.waitForAudio(0);
  const cancel = card.getByTestId(`${firstId}-dictation-cancel`);
  const pencil = card.getByTestId(`${firstId}-dictation-toggle`);
  const next = card.getByTestId(`${firstId}-dictation-submit`);
  await cancel.focus();
  // Walk backward past the input's DOM position, then forward through every
  // recording control. Reading tabIndex alone would miss a hidden focus trap.
  await page.keyboard.press("Shift+Tab");
  await expect(first).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pencil).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await speech.waitForFinish(0);
  speech.complete("spoken first addition", 0);
  const secondId = "question-form-answer-2";
  const second = card.getByTestId(secondId);
  await expect(second).toBeEditable();
  expect(speech.permissionResponses).toEqual([]);
  await second.fill("Keyboard second answer");
  await second.press("End");
  await card.getByTestId(`${secondId}-dictation-toggle`).click();
  await speech.waitForAudio(1);
  await card.getByTestId(`${secondId}-dictation-submit`).focus();
  await page.keyboard.press("Enter");
  await speech.waitForFinish(1);
  speech.complete("spoken second addition", 1);
  speech.complete("spoken second addition", 1);
  await expect(card).toHaveCount(0);
  await expect.poll(() => speech.permissionResponses.length).toBe(1);
  expect(speech.permissionResponses[0]).toMatchObject({
    behavior: "allow",
    updatedInput: {
      answers: {
        repoUrl: "Keyboard first answer spoken first addition",
        commitMessage: "Keyboard second answer spoken second addition",
      },
    },
  });
  expect(await microphoneRequests(page)).toBe(2);
  await expectMicrophoneReleased(page);
});

for (const shortcut of ["Control+Enter", "Meta+Enter"]) {
  test(`${shortcut} on a focused dictation arrow inserts without advancing or submitting the question`, async ({
    page,
    host,
    workspace,
    speech,
  }) => {
    const card = await openQuestions(
      page,
      host,
      workspace,
      "Emit synthetic questions: two free-write questions.",
    );
    const initialRequests = [...speech.agentRequests];
    const inputId = "question-form-answer-1";
    const input = card.getByTestId(inputId);
    const second = card.getByTestId("question-form-answer-2");
    await input.fill("Keep this question answer");
    await input.press("End");
    await card.getByTestId(`${inputId}-dictation-toggle`).click();
    await speech.waitForAudio(0);
    await card.getByTestId(`${inputId}-dictation-submit`).focus();
    await page.keyboard.press(shortcut);
    await speech.waitForFinish(0);
    await expect(input).toHaveValue("Keep this question answer");
    await expect(second).toHaveCount(0);
    expect(speech.permissionResponses).toEqual([]);
    speech.complete("spoken continuation", 0);
    speech.complete("spoken continuation", 0);
    await expect(input).toBeEditable();
    await expect(input).toHaveValue("Keep this question answer spoken continuation");
    await expect(second).toHaveCount(0);
    await expect(card.getByTestId("question-form-primary-action")).toHaveText("Next");
    expect(speech.permissionResponses).toEqual([]);
    expect(speech.agentRequests).toEqual(initialRequests);
    expect(await microphoneRequests(page)).toBe(1);
    await expectMicrophoneReleased(page);
  });
}

test("option reset and identical question labels never transfer a pending transcript", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const card = await openQuestions(
    page,
    host,
    workspace,
    "Emit synthetic questions: two free-write questions. Duplicate prompt dictation.",
  );
  const answer = card.getByRole("textbox", { name: "Same question", exact: true });
  await answer.fill("Discard this custom answer");
  await answer.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  await card.getByRole("checkbox", { name: "First choice", exact: true }).click();
  await expect(answer).toHaveValue("");
  await expect.poll(() => speech.openSessions().length).toBe(0);
  speech.complete("stale answer for the previous selection", 0);
  await card.getByRole("tab", { name: "Question 2 of 2" }).click();
  await expect(answer).toHaveValue("");
  await answer.fill("Second question");
  await answer.press("End");
  await answer.press("Control+d");
  await speech.waitForAudio(1);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(1);
  speech.complete("spoken second answer", 1);
  await expect(answer).toHaveValue("Second question spoken second answer");
  await card.getByRole("tab", { name: "Question 1 of 2" }).click();
  await expect(answer).toHaveValue("");
  await expect(card.getByRole("checkbox", { name: "First choice", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(speech.permissionResponses).toEqual([]);
  await card.getByRole("tab", { name: "Question 2 of 2" }).click();
  await card.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => speech.permissionResponses.length).toBe(1);
  const submitted = JSON.stringify(speech.permissionResponses[0]);
  expect(submitted).toContain("First choice");
  expect(submitted).toContain("Second question spoken second answer");
  expect(submitted).not.toContain("stale answer");
});

test("review Ctrl+D replaces the selected text without saving the comment", async ({
  page,
  speech,
}, testInfo) => {
  const review = await openReview(page);
  await review.fill("Keep replace suffix");
  const field = page.getByTestId("inline-review-editor-input-dictation-field");
  const idleBounds = await visibleBounds(field);
  await expectDictationControlsInViewport(page, "inline-review-editor-input", false);
  await review.press("Home");
  for (let index = 0; index < 5; index += 1) await review.press("ArrowRight");
  for (let index = 0; index < 7; index += 1) await review.press("Shift+ArrowRight");
  await review.press("Control+d");
  await speech.waitForAudio(0);
  await expect(review).not.toBeEditable();
  await expectDictationControlsInViewport(page, "inline-review-editor-input", true);
  await expectBounds(field, idleBounds);
  await expectMeterRespondsToSound(page, "inline-review-editor-input");
  await page.screenshot({ path: testInfo.outputPath("review-dictation-desktop-recording.png") });
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(0);
  await expectBounds(field, idleBounds);
  await expectBounds(page.getByTestId("inline-review-editor-input-dictation-overlay"), idleBounds);
  speech.complete("spoken comment");
  await expect(review).toHaveValue("Keep spoken comment suffix");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  await expect(review).toBeEditable();
  await expectBounds(field, idleBounds);
  await expectDictationControlsInViewport(page, "inline-review-editor-input", false);
  await expect(page.getByTestId("inline-review-editor-save")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("review-dictation-desktop-inserted.png") });
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
  await page.getByTestId("inline-review-editor-save").click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText("Keep spoken comment suffix", { exact: true })).toBeVisible();
});

test("compact review microphone controls remain visible while recording and after insertion", async ({
  page,
  speech,
}, testInfo) => {
  await openChangesPanel(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const review = await openReview(page, true);
  await review.fill("Compact review draft");
  await review.press("End");
  const field = page.getByTestId("inline-review-editor-input-dictation-field");
  const idleBounds = await visibleBounds(field);
  await expectDictationControlsInViewport(page, "inline-review-editor-input", false);
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await expectDictationControlsInViewport(page, "inline-review-editor-input", true);
  await expectBounds(field, idleBounds);
  await page.screenshot({ path: testInfo.outputPath("review-dictation-compact-recording.png") });
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(0);
  await expectBounds(page.getByTestId("inline-review-editor-input-dictation-overlay"), idleBounds);
  speech.complete("compact spoken comment");
  await expect(review).toHaveValue("Compact review draft compact spoken comment");
  await expectDictationControlsInViewport(page, "inline-review-editor-input", false);
  await expectBounds(field, idleBounds);
  await expect(page.getByTestId("inline-review-editor-save")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("review-dictation-compact-inserted.png") });
  expect(speech.agentRequests).toEqual([]);
});

test("the review dictation arrow saves the complete comment exactly once", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Keep replace suffix");
  await review.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(5, 12));
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("inline-review-editor-input-dictation-submit").click();
  await speech.waitForFinish(0);
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
  speech.complete("spoken and saved", 0);
  speech.complete("spoken and saved", 0);
  await expect(review).toHaveCount(0);
  await expect(page.getByText("Keep spoken and saved suffix", { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-testid^="review-comment-edit-"]')).toHaveCount(1);
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("new fields retain the original chat recording colors and control icons", async ({
  page,
  speech,
}) => {
  await createAgentTabFromMenu(page);
  await selectDictationTestModel(page);
  const composer = page
    .getByTestId("message-input-root")
    .filter({ visible: true })
    .locator("textarea");
  await composer.fill("Original chat draft");
  await composer.press("Control+d");
  await speech.waitForAudio(0);
  const insert = page.getByRole("button", { name: "Insert transcription", exact: true });
  const cancel = page.getByRole("button", { name: "Cancel dictation", exact: true });
  const send = page.getByRole("button", { name: "Insert transcription and send", exact: true });
  const original = await recordingAppearance(insert.locator("../.."), [cancel, insert, send]);
  expect(original.background).not.toBe("rgba(0, 0, 0, 0)");
  await cancel.click();
  await expectMicrophoneReleased(page);
  await expect.poll(() => speech.openSessions().length).toBe(0);
  const review = await openReview(page);
  await review.fill("Review draft");
  await review.press("Control+d");
  await speech.waitForAudio(1);
  const prefix = "inline-review-editor-input-dictation";
  const fieldAppearance = await recordingAppearance(page.getByTestId(`${prefix}-overlay`), [
    page.getByTestId(`${prefix}-cancel`),
    page.getByTestId(`${prefix}-toggle`),
    page.getByTestId(`${prefix}-submit`),
  ]);
  expect(fieldAppearance).toEqual(original);
  await page.getByTestId(`${prefix}-cancel`).click();
  await expect(review).toHaveValue("Review draft");
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("Cancel during an arrow upload discards submission intent before the next pencil insertion", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Keep this draft");
  await review.press("End");
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("inline-review-editor-input-dictation-submit").click();
  await speech.waitForFinish(0);
  await page.getByTestId("inline-review-editor-input-dictation-cancel").click();
  await expect(review).toBeEditable();
  await expect.poll(() => speech.openSessions().length).toBe(0);
  speech.complete("canceled words", 0);
  await expect(review).toHaveValue("Keep this draft");
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(1);
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(1);
  speech.complete("insert these words", 1);
  await expect(review).toHaveValue("Keep this draft insert these words");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  await expect(page.locator('[data-testid^="review-comment-edit-"]')).toHaveCount(0);
  expect(speech.agentRequests).toEqual([]);
  expect(await microphoneRequests(page)).toBe(2);
  await expectMicrophoneReleased(page);
});

test("an empty arrow transcription does not submit or affect the next pencil insertion", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Keep the original review");
  await review.press("End");
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("inline-review-editor-input-dictation-submit").click();
  await speech.waitForFinish(0);
  speech.complete("", 0);
  await expect(review).toBeEditable();
  await expect(review).toHaveValue("Keep the original review");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  await expect(page.locator('[data-testid^="review-comment-edit-"]')).toHaveCount(0);
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(1);
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(1);
  speech.complete("inserted after silence", 1);
  await expect(review).toHaveValue("Keep the original review inserted after silence");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  await expect(page.locator('[data-testid^="review-comment-edit-"]')).toHaveCount(0);
  expect(speech.agentRequests).toEqual([]);
  expect(await microphoneRequests(page)).toBe(2);
  await expectMicrophoneReleased(page);
});

test("schedule microphone inserts only into Prompt and never creates a schedule", async ({
  page,
  host,
  speech,
  workspace,
}, testInfo) => {
  const prompt = await openSchedule(page, host);
  await prompt.fill("Existing prompt");
  await prompt.press("End");
  const field = page.getByTestId("schedule-prompt-input-dictation-field");
  const idleBounds = await visibleBounds(field);
  await expectDictationControlsInViewport(page, "schedule-prompt-input", false);
  await page.getByTestId("schedule-prompt-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await expectDictationControlsInViewport(page, "schedule-prompt-input", true);
  await expectBounds(field, idleBounds);
  await page.screenshot({ path: testInfo.outputPath("schedule-dictation-desktop-recording.png") });
  await page.getByTestId("schedule-prompt-input-dictation-toggle").click();
  await speech.waitForFinish(0);
  await expectBounds(page.getByTestId("schedule-prompt-input-dictation-overlay"), idleBounds);
  speech.complete("spoken continuation");
  await expect(prompt).toHaveValue("Existing prompt spoken continuation");
  await expect(page.getByTestId("schedule-form-sheet")).toBeVisible();
  await expectDictationControlsInViewport(page, "schedule-prompt-input", false);
  await expectBounds(field, idleBounds);
  await page.screenshot({ path: testInfo.outputPath("schedule-dictation-desktop-inserted.png") });
  expect((await workspace.client.scheduleList()).schedules).toEqual([]);
  expect(speech.agentRequests).toEqual([]);
});

test("short fields and an unrelated modal do not activate background dictation", async ({
  page,
  host,
  speech,
}) => {
  await openSchedule(page, host);
  const name = page.getByTestId("schedule-name-input");
  await name.fill("Keep this schedule name");
  await name.press("Control+d");
  await expect(name).toHaveValue("Keep this schedule name");
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Control+d");
  expect(await microphoneRequests(page)).toBe(0);
  expect(speech.requests).toEqual([]);
  await page.getByTestId("schedule-prompt-input").focus();
  await page.keyboard.press("Control+d");
  await speech.waitForAudio(0);
  expect(await microphoneRequests(page)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("schedule-form-sheet")).toBeVisible();
  await expectMicrophoneReleased(page);
});

test("switching between metadata editors preserves ownership and a single capture", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const { first, second } = await openMetadata(page, host, workspace);
  await first.fill("First draft");
  await second.fill("Second draft");
  await first.focus();
  await first.press("End");
  await first.press("Control+d");
  await speech.waitForAudio(0);
  await second.focus();
  await second.press("End");
  await second.press("Enter");
  await second.press("x");
  expect(speech.requests[0]?.finished).toBe(false);
  await expect(second).toHaveValue("Second draft\nx");
  await expect(
    page.getByTestId("metadata-prompt-commit-message-input-dictation-toggle"),
  ).toBeDisabled();
  await second.press("Control+d");
  await speech.waitForFinish(0);
  speech.complete("spoken to first");
  await expect(first).toHaveValue("First draft spoken to first");
  await expect(second).toHaveValue("Second draft\nx");
  expect(await microphoneRequests(page)).toBe(1);
  expect(await page.evaluate(() => window.dictationTestMicrophone.maximumLiveTracks)).toBe(1);
  expect(speech.agentRequests).toEqual([]);
});

test("the microphone reads a live mid-text caret without relying on a selection event", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const { first } = await openMetadata(page, host, workspace);
  await first.fill("Keep suffix");
  await first.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(5, 5));
  await page.getByTestId("metadata-prompt-branch-name-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("metadata-prompt-branch-name-input-dictation-toggle").click();
  await speech.waitForFinish(0);
  speech.complete("spoken");
  await expect(first).toHaveValue("Keep spoken suffix");
  expect(
    await first.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return { start: input.selectionStart, end: input.selectionEnd };
    }),
  ).toEqual({ start: 12, end: 12 });
});

test("a schedule opened at compact width retains its microphone runtime", async ({
  page,
  host,
  speech,
  workspace,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const prompt = await openSchedule(page, host);
  await prompt.fill("Compact schedule");
  await prompt.press("End");
  const field = page.getByTestId("schedule-prompt-input-dictation-field");
  const idleBounds = await visibleBounds(field);
  await expectDictationControlsInViewport(page, "schedule-prompt-input", false);
  const microphone = page.getByTestId("schedule-prompt-input-dictation-toggle");
  await microphone.click();
  await speech.waitForAudio(0);
  await expectDictationControlsInViewport(page, "schedule-prompt-input", true);
  await expectBounds(field, idleBounds);
  await page.screenshot({ path: testInfo.outputPath("schedule-compact-open-recording.png") });
  await microphone.click();
  await speech.waitForFinish(0);
  await expectBounds(page.getByTestId("schedule-prompt-input-dictation-overlay"), idleBounds);
  speech.complete("spoken on compact");
  await expect(prompt).toHaveValue("Compact schedule spoken on compact");
  await expect(page.getByTestId("schedule-form-sheet")).toBeVisible();
  await expectDictationControlsInViewport(page, "schedule-prompt-input", false);
  await expectBounds(field, idleBounds);
  await page.screenshot({ path: testInfo.outputPath("schedule-compact-open-inserted.png") });
  expect((await workspace.client.scheduleList()).schedules).toEqual([]);
});

for (const surface of ["profile", "host-prompt"] as const) {
  test(`a compact ${surface} sheet inserts speech without losing provider context or saving`, async ({
    page,
    host,
    speech,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${host.origin}${buildSettingsHostSectionRoute(host.serverId, "agents")}`);
    if (surface === "profile") {
      await page
        .getByTestId("agent-profiles-card")
        .getByRole("button", { name: "New profile", exact: true })
        .click();
    } else {
      await page.getByTestId("host-page-append-system-prompt-edit").click();
    }
    const inputId =
      surface === "profile" ? "agent-profile-notes-input" : "host-page-append-system-prompt-input";
    const input = page.getByTestId(inputId);
    await input.fill("Retained draft");
    await input.press("End");
    const field = page.getByTestId(`${inputId}-dictation-field`);
    const idleBounds = await visibleBounds(field);
    await expectDictationControlsInViewport(page, inputId, false);
    const microphone = page.getByTestId(`${inputId}-dictation-toggle`);
    await microphone.click();
    await speech.waitForAudio(0);
    await expectDictationControlsInViewport(page, inputId, true);
    await expectBounds(field, idleBounds);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-compact-recording.png`) });
    await microphone.click();
    await speech.waitForFinish(0);
    await expectBounds(page.getByTestId(`${inputId}-dictation-overlay`), idleBounds);
    speech.complete("spoken notes");
    await expect(input).toHaveValue("Retained draft spoken notes");
    await expect(
      page.getByTestId(
        surface === "profile" ? "agent-profile-save-button" : "host-page-append-system-prompt-save",
      ),
    ).toBeVisible();
    await expectDictationControlsInViewport(page, inputId, false);
    await expectBounds(field, idleBounds);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-compact-inserted.png`) });
    expect(speech.agentRequests).toEqual([]);
  });
}

for (const surface of ["schedule", "host-prompt"] as const) {
  test(`Escape from ${surface} recording and arrow upload preserves the modal draft`, async ({
    page,
    host,
    workspace,
    speech,
  }) => {
    const persisted = (await workspace.client.getDaemonConfig()).config;
    if (surface === "schedule") {
      await openSchedule(page, host);
    } else {
      await page.goto(`${host.origin}${buildSettingsHostSectionRoute(host.serverId, "agents")}`);
      await page.getByTestId("host-page-append-system-prompt-edit").click();
    }
    const inputId =
      surface === "schedule" ? "schedule-prompt-input" : "host-page-append-system-prompt-input";
    const modalId =
      surface === "schedule" ? "schedule-form-sheet" : "host-page-append-system-prompt-sheet";
    const input = page.getByTestId(inputId);
    await input.fill("Keep this unsubmitted modal draft");
    await page.getByTestId(`${inputId}-dictation-toggle`).click();
    await speech.waitForAudio(0);
    // Do not focus an input or control between the mouse click and Escape.
    await page.keyboard.press("Escape");
    await expectMicrophoneReleased(page);
    await expect.poll(() => speech.openSessions().length).toBe(0);
    await expect(page.getByTestId(modalId)).toBeVisible();
    await expect(input).toBeEditable();
    await expect(input).toHaveValue("Keep this unsubmitted modal draft");
    await expect(page.getByTestId(`${inputId}-dictation-overlay`)).not.toBeVisible();
    speech.complete("canceled words must not save", 0);
    await expect(input).toHaveValue("Keep this unsubmitted modal draft");
    await page.getByTestId(`${inputId}-dictation-toggle`).click();
    await speech.waitForAudio(1);
    await page.getByTestId(`${inputId}-dictation-submit`).click();
    await speech.waitForFinish(1);
    // The arrow has now been replaced by a spinner. Escape must still find
    // this field without a focus repair from the test or a click on Cancel.
    await page.keyboard.press("Escape");
    await expect.poll(() => speech.openSessions().length).toBe(0);
    speech.complete("late upload must not submit", 1);
    await expect(page.getByTestId(modalId)).toBeVisible();
    await expect(input).toBeEditable();
    await expect(input).toHaveValue("Keep this unsubmitted modal draft");
    await expect(page.getByTestId(`${inputId}-dictation-overlay`)).not.toBeVisible();
    await expectMicrophoneReleased(page);
    expect(await microphoneRequests(page)).toBe(2);
    expect((await workspace.client.getDaemonConfig()).config).toEqual(persisted);
    expect((await workspace.client.scheduleList()).schedules).toEqual([]);
    expect(speech.agentRequests).toEqual([]);
  });
}

test("canceling pending microphone permission releases a late stream without changing the draft", async ({
  page,
  host,
  speech,
}) => {
  const prompt = await openSchedule(page, host);
  await prompt.fill("Permission draft");
  await page.evaluate(() => {
    window.dictationTestMicrophone.holdPermission = true;
  });
  await prompt.press("Control+d");
  await expect.poll(() => microphoneRequests(page)).toBe(1);
  await page.getByTestId("schedule-prompt-input-dictation-cancel").click();
  await page.evaluate(() => window.dictationTestMicrophone.releasePermission());
  await expect
    .poll(() => page.evaluate(() => window.dictationTestMicrophone.maximumLiveTracks))
    .toBe(1);
  await expectMicrophoneReleased(page);
  await expect(prompt).toBeEditable();
  await expect(prompt).toHaveValue("Permission draft");
  expect(speech.requests).toEqual([]);
  await expect(page.getByTestId("schedule-form-sheet")).toBeVisible();
});

test("denied microphone permission keeps the draft and Retry starts a fresh insert-only recording", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Permission denied draft");
  await review.press("End");
  await page.evaluate(() => {
    window.dictationTestMicrophone.holdPermission = true;
    window.dictationTestMicrophone.rejectNextPermission = true;
  });
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await expect.poll(() => microphoneRequests(page)).toBe(1);
  // Choosing the arrow before the permission dialog resolves must not leave a
  // submit intent attached to the next, separately acquired recording.
  await page.getByTestId("inline-review-editor-input-dictation-submit").click();
  await page.evaluate(() => window.dictationTestMicrophone.releasePermission());
  await expect(page.getByTestId("inline-review-editor-input-dictation-error")).toContainText(
    "Microphone access denied",
  );
  await expect(review).toHaveValue("Permission denied draft");
  await expectMicrophoneReleased(page);
  expect(speech.requests).toEqual([]);
  await page.getByTestId("inline-review-editor-input-dictation-retry").click();
  await speech.waitForAudio(0);
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(0);
  speech.complete("retried successfully", 0);
  await expect(review).toHaveValue("Permission denied draft retried successfully");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  await expect(page.locator('[data-testid^="review-comment-edit-"]')).toHaveCount(0);
  expect(await microphoneRequests(page)).toBe(2);
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("closing a dictating review editor ignores its late transcription", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Unsaved review draft");
  await review.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+Enter");
  await speech.waitForFinish(0);
  await page.getByTestId("inline-review-editor-cancel").click();
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
  speech.complete("late result must not appear");
  const reopened = await openReview(page);
  await expect(reopened).toHaveValue("");
  await expect(page.getByText("late result must not appear", { exact: true })).toHaveCount(0);
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("a pending transcription returns to its retained review tab without changing the new chat", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Retained review draft");
  await review.press("End");
  await review.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  const otherDrafts = await visitOtherDraftTabs(page);
  const composer = page
    .getByTestId("message-input-root")
    .filter({ visible: true })
    .locator("textarea");
  await expect(review).not.toBeVisible();
  speech.complete("spoken to retained review");
  await expect.poll(() => speech.openSessions().length).toBe(0);
  await expect(composer).toHaveValue("Fourth chat draft");
  await expect(composer).toBeFocused();
  await page
    .getByTestId("workspace-tab-working_diff")
    .filter({ visible: true })
    .click({ position: { x: 12, y: 13 } });
  await expect(review).toBeVisible();
  await expect(review).toHaveValue("Retained review draft spoken to retained review");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  expect(speech.agentRequests).toEqual([]);
  await expectOtherDraftsUnchanged(page, otherDrafts);
});

test("a failed transcription survives three newer tabs and retries in its original review", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Retained failed draft");
  await review.press("End");
  await review.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  speech.fail("Temporary speech failure");
  const retry = page.getByTestId("inline-review-editor-input-dictation-retry");
  await expect(retry).toBeVisible();
  const otherDrafts = await visitOtherDraftTabs(page);
  await expect(review).not.toBeVisible();
  await page
    .getByTestId("workspace-tab-working_diff")
    .filter({ visible: true })
    .click({ position: { x: 12, y: 13 } });
  await expect(review).toHaveValue("Retained failed draft");
  await retry.click();
  await speech.waitForFinish(1);
  speech.complete("recovered once", 1);
  await expect(review).toHaveValue("Retained failed draft recovered once");
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  expect(speech.agentRequests).toEqual([]);
  expect(await microphoneRequests(page)).toBe(1);
  await expectOtherDraftsUnchanged(page, otherDrafts);
});

test("Reset restores persisted host text and discards a pending arrow submission without saving", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  await workspace.client.patchDaemonConfig({ appendSystemPrompt: "Persisted host instructions" });
  const persisted = (await workspace.client.getDaemonConfig()).config;
  await page.goto(`${host.origin}${buildSettingsHostSectionRoute(host.serverId, "agents")}`);
  await page.getByTestId("host-page-append-system-prompt-edit").click();
  const input = page.getByTestId("host-page-append-system-prompt-input");
  await expect(input).toHaveValue("Persisted host instructions");
  await input.fill("Unsaved replacement instructions");
  await input.press("End");
  await input.press("Control+d");
  await speech.waitForAudio(0);
  await page.getByTestId("host-page-append-system-prompt-input-dictation-submit").click();
  await speech.waitForFinish(0);
  await page.getByTestId("host-page-append-system-prompt-reset").click();
  await expect(input).toHaveValue("Persisted host instructions");
  await expect.poll(() => speech.openSessions().length).toBe(0);
  speech.complete("stale words must not undo Reset");
  await expect(input).toHaveValue("Persisted host instructions");
  await expect(input).toBeEditable();
  await expect(page.getByTestId("host-page-append-system-prompt-save")).toBeDisabled();
  // Compare every config field, including unrelated host settings, through the
  // real RPC before any Save action has been issued.
  expect((await workspace.client.getDaemonConfig()).config).toEqual(persisted);
  await expect(page.getByTestId("host-page-append-system-prompt-sheet")).toBeVisible();
});

test("a failed host-prompt arrow submission retries and saves the exact completed draft", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  await workspace.client.patchDaemonConfig({ appendSystemPrompt: "Original saved instructions" });
  const persisted = (await workspace.client.getDaemonConfig()).config;
  await page.goto(`${host.origin}${buildSettingsHostSectionRoute(host.serverId, "agents")}`);
  await page.getByTestId("host-page-append-system-prompt-edit").click();
  const inputId = "host-page-append-system-prompt-input";
  const input = page.getByTestId(inputId);
  await input.fill("Replacement instructions");
  await input.press("End");
  await page.getByTestId(`${inputId}-dictation-toggle`).click();
  await speech.waitForAudio(0);
  await page.getByTestId(`${inputId}-dictation-submit`).click();
  await speech.waitForFinish(0);
  speech.fail("Speech is temporarily unavailable", 0);
  await expect(page.getByTestId(`${inputId}-dictation-error`)).toContainText(
    "Speech is temporarily unavailable",
  );
  await expect(input).toHaveValue("Replacement instructions");
  expect((await workspace.client.getDaemonConfig()).config).toEqual(persisted);
  await page.getByTestId(`${inputId}-dictation-retry`).click();
  await speech.waitForFinish(1);
  speech.complete("spoken new instructions", 1);
  speech.complete("spoken new instructions", 1);
  await expect(page.getByTestId("host-page-append-system-prompt-sheet")).not.toBeVisible();
  const expected = {
    ...persisted,
    appendSystemPrompt: "Replacement instructions spoken new instructions",
  };
  await expect
    .poll(async () => (await workspace.client.getDaemonConfig()).config)
    .toEqual(expected);
  await page.getByTestId("host-page-append-system-prompt-edit").click();
  await expect(input).toHaveValue(expected.appendSystemPrompt);
  expect(await microphoneRequests(page)).toBe(1);
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("retrying a failed transcription retains the draft and inserts exactly once", async ({
  page,
  host,
  speech,
  workspace,
}) => {
  const prompt = await openSchedule(page, host);
  await prompt.fill("Retry draft");
  await prompt.press("End");
  await prompt.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  speech.fail("Speech temporarily unavailable");
  await expect(page.getByTestId("schedule-prompt-input-dictation-error")).toContainText(
    "Speech temporarily unavailable",
  );
  await expect(prompt).toHaveValue("Retry draft");
  await page.getByTestId("schedule-prompt-input-dictation-retry").click();
  await speech.waitForFinish(1);
  speech.complete("recovered words", 1);
  speech.complete("recovered words", 1);
  await expect(prompt).toHaveValue("Retry draft recovered words");
  expect(await microphoneRequests(page)).toBe(1);
  expect(speech.agentRequests).toEqual([]);
  expect((await workspace.client.scheduleList()).schedules).toEqual([]);
});

test("a disconnected transcription can retry on reconnect without losing the draft", async ({
  page,
  host,
  speech,
}) => {
  const prompt = await openSchedule(page, host);
  await prompt.fill("Disconnected draft");
  await prompt.press("End");
  await prompt.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  const connectionsBeforeDisconnect = speech.connectionCount();
  speech.disconnect();
  await expect(page.getByTestId("schedule-prompt-input-dictation-error")).toBeVisible();
  await expect.poll(speech.connectionCount).toBeGreaterThan(connectionsBeforeDisconnect);
  const retry = page.getByTestId("schedule-prompt-input-dictation-retry");
  await expect(retry).toBeEnabled();
  await retry.click();
  await speech.waitForFinish(1);
  speech.complete("after reconnect", 1);
  await expect(prompt).toHaveValue("Disconnected draft after reconnect");
  expect(await microphoneRequests(page)).toBe(1);
});

test("Ctrl+D stops a hidden chat recording without sending or changing the visible chat", async ({
  page,
  speech,
}) => {
  await createAgentTabFromMenu(page);
  await selectDictationTestModel(page);
  const firstTab = page
    .locator('[data-testid^="workspace-tab-draft"]')
    .filter({ visible: true })
    .last();
  const firstTabId = await firstTab.getAttribute("data-testid");
  if (!firstTabId) throw new Error("First draft tab is missing its identity");
  const visibleComposer = page
    .getByTestId("message-input-root")
    .filter({ visible: true })
    .locator("textarea");
  await visibleComposer.fill("Original hidden chat draft");
  await visibleComposer.press("End");
  await visibleComposer.press("Control+d");
  await speech.waitForAudio(0);
  const otherDrafts = await visitOtherDraftTabs(page);
  await visibleComposer.press("Control+d");
  await speech.waitForFinish(0);
  speech.complete("spoken original continuation");
  await expect.poll(() => speech.openSessions().length).toBe(0);
  await expect(visibleComposer).toHaveValue("Fourth chat draft");
  await page
    .getByTestId(firstTabId)
    .filter({ visible: true })
    .click({ position: { x: 12, y: 13 } });
  await expect(visibleComposer).toHaveValue(
    "Original hidden chat draft spoken original continuation",
  );
  expect(speech.agentRequests).toEqual([]);
  expect(await microphoneRequests(page)).toBe(1);
  await expectOtherDraftsUnchanged(page, otherDrafts);
});

test("main chat keeps bare-page Ctrl+D fallback and its existing automatic send", async ({
  page,
  speech,
}) => {
  await createAgentTabFromMenu(page);
  await selectDictationTestModel(page);
  const composer = page
    .getByTestId("message-input-root")
    .filter({ visible: true })
    .locator("textarea");
  await expect(composer).toBeEditable();
  await composer.fill("Existing chat draft");
  await composer.evaluate((element) => (element as HTMLTextAreaElement).blur());
  await page.keyboard.press("Control+d");
  await speech.waitForAudio(0);
  await page.keyboard.press("Control+d");
  await speech.waitForFinish(0);
  await expect(composer).toBeEditable();
  await composer.fill("Existing chat draft with an upload-time edit");
  speech.complete("spoken chat continuation");
  await expect.poll(() => speech.agentRequests.length).toBe(1);
  expect(speech.agentRequests[0]?.initialPrompt).toBe(
    "Existing chat draft with an upload-time edit spoken chat continuation",
  );
  // The guarded agent adapter records and rejects this launch. The failed send
  // must restore the exact text to the draft, rather than create a chat entry.
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Agent launch intentionally blocked by dictation browser test" }),
  ).toHaveText("Agent launch intentionally blocked by dictation browser test");
  await expect(composer).toHaveValue(
    "Existing chat draft with an upload-time edit spoken chat continuation",
  );
  expect(speech.agentRequests).toHaveLength(1);
});

test("compact dictation survives three newer tabs and returns only to its original draft", async ({
  page,
  speech,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page
    .getByTestId("message-input-root")
    .filter({ visible: true })
    .locator("textarea");
  async function createDraft(text: string) {
    await page.getByTestId("workspace-header-menu-trigger").click();
    await page.getByTestId("workspace-header-new-agent").click();
    await composer.fill(text);
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    const option = page.locator('[data-testid^="workspace-tab-option-draft_"]').last();
    await expect(option).toBeVisible();
    const id = await option.getAttribute("data-testid");
    if (!id) throw new Error("Compact draft option has no identity");
    await option.click();
    await expect(option).not.toBeVisible();
    return { id, text };
  }
  async function selectDraft(id: string) {
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).not.toBeVisible();
  }
  const original = await createDraft("Compact original draft");
  await selectDictationTestModel(page, true);
  await composer.press("End");
  // Compact layouts use touch controls; global desktop shortcuts are disabled.
  await page.getByRole("button", { name: "Start dictation", exact: true }).click();
  await speech.waitForAudio(0);
  const others = [];
  for (const text of ["Compact second draft", "Compact third draft", "Compact fourth draft"]) {
    others.push(await createDraft(text));
  }
  await selectDraft(original.id);
  await page.getByRole("button", { name: "Insert transcription", exact: true }).click();
  await speech.waitForFinish(0);
  await selectDraft(others[2]!.id);
  speech.complete("spoken original words");
  await expect(composer).toHaveValue("Compact fourth draft");
  await selectDraft(original.id);
  await expect(composer).toHaveValue("Compact original draft spoken original words");
  for (const other of others) {
    await selectDraft(other.id);
    await expect(composer).toHaveValue(other.text);
  }
  expect(speech.agentRequests).toEqual([]);
  expect(await microphoneRequests(page)).toBe(1);
  await expectMicrophoneReleased(page);
});

test("terminal Ctrl+D does not start dictation", async ({ page, workspace, speech }) => {
  const before = await workspace.client.listTerminals(workspace.directory, undefined, {
    workspaceId: workspace.id,
  });
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page
    .getByTestId("workspace-new-tab-menu-terminal")
    .filter({ visible: true })
    .first()
    .click();
  const terminal = page.getByTestId("terminal-surface").filter({ visible: true });
  await expect(terminal).toBeVisible();
  const after = await workspace.client.listTerminals(workspace.directory, undefined, {
    workspaceId: workspace.id,
  });
  const created = after.terminals.find(
    (candidate) => !before.terminals.some((existing) => existing.id === candidate.id),
  );
  if (!created) throw new Error("Terminal menu did not create an isolated scratch terminal");
  await terminal.click();
  await page.keyboard.type("cat");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+d");
  await page.keyboard.type("echo DICTATION_TERMINAL_OK");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const capture = await workspace.client.captureTerminal(created.id, { stripAnsi: true });
      return capture.lines.some((line) => line.trim() === "DICTATION_TERMINAL_OK");
    })
    .toBe(true);
  expect(await microphoneRequests(page)).toBe(0);
  expect(speech.requests).toEqual([]);
});

test("Pencil insertion returns focus so the next Ctrl+D stays in the review field", async ({
  page,
  speech,
}) => {
  const review = await openReview(page);
  await review.fill("Review draft");
  await review.press("End");
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(0);
  speech.complete("first continuation", 0);
  await expect(review).toHaveValue("Review draft first continuation");
  await expect(review).toBeFocused();
  // No click or locator.press here: the second shortcut must use the focus
  // left by transcript delivery rather than implicitly refocusing the field.
  await page.keyboard.press("Control+d");
  await speech.waitForAudio(1);
  await expect(page.getByTestId("inline-review-editor-input-dictation-overlay")).toBeVisible();
  await page.getByTestId("inline-review-editor-input-dictation-toggle").click();
  await speech.waitForFinish(1);
  speech.complete("second continuation", 1);
  await expect(review).toHaveValue("Review draft first continuation second continuation");
  await expect(review).toBeFocused();
  await expect(page.getByTestId("inline-review-editor-save")).toBeVisible();
  expect(speech.agentRequests).toEqual([]);
  expect(await microphoneRequests(page)).toBe(2);
  await expectMicrophoneReleased(page);
});

test("the metadata dictation arrow saves its exact prompt and another unsaved field", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const { first, second } = await openMetadata(page, host, workspace);
  await first.fill("Branch instructions");
  await second.fill("Keep these unsaved commit instructions");
  await first.focus();
  await first.press("End");
  const before = await workspace.client.readProjectConfig(workspace.directory);
  if (!before.ok) throw new Error(`Unable to read project config: ${before.error.code}`);
  await page.getByTestId("metadata-prompt-branch-name-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("metadata-prompt-branch-name-input-dictation-submit").click();
  await speech.waitForFinish(0);
  speech.complete("spoken branch guidance", 0);
  speech.complete("spoken branch guidance", 0);
  await expect(first).toHaveValue("Branch instructions spoken branch guidance");
  await expect(second).toHaveValue("Keep these unsaved commit instructions");
  const expected = {
    ...before.config,
    metadataGeneration: {
      ...before.config?.metadataGeneration,
      branchName: { instructions: "Branch instructions spoken branch guidance" },
      commitMessage: { instructions: "Keep these unsaved commit instructions" },
    },
  };
  await expect
    .poll(async () => {
      const result = await workspace.client.readProjectConfig(workspace.directory);
      return result.ok ? result.config : result.error;
    })
    .toEqual(expected);
  // Leave through hydrated Settings and reopen to prove the drafts were
  // persisted, rather than merely left in the still-mounted inputs.
  await page.getByTestId("project-settings-back-link").click();
  await page
    .getByRole("button", { name: `Edit ${path.basename(workspace.directory)}`, exact: true })
    .click();
  await expect(first).toHaveValue("Branch instructions spoken branch guidance");
  await expect(second).toHaveValue("Keep these unsaved commit instructions");
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("the profile dictation arrow honors the required name and saves the complete notes", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const previous = (await workspace.client.getDaemonConfig()).config;
  await page.goto(`${host.origin}${buildSettingsHostSectionRoute(host.serverId, "agents")}`);
  await page
    .getByTestId("agent-profiles-card")
    .getByRole("button", { name: "New profile", exact: true })
    .click();
  await page.getByTestId("agent-profile-provider-trigger").click();
  await page
    .getByTestId("combobox-desktop-container")
    .getByRole("button", { name: "Mock Load Test", exact: true })
    .click();
  const notes = page.getByTestId("agent-profile-notes-input");
  await notes.fill("Use for careful reviews");
  await notes.press("End");
  await page.getByTestId("agent-profile-notes-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("agent-profile-notes-input-dictation-submit").click();
  await speech.waitForFinish(0);
  speech.complete("with test evidence", 0);
  await expect(notes).toHaveValue("Use for careful reviews with test evidence");
  await expect(page.getByTestId("agent-profile-save-button")).toBeDisabled();
  expect((await workspace.client.getDaemonConfig()).config).toEqual(previous);
  await page.getByTestId("agent-profile-name-input").fill("Dictated review profile");
  await notes.focus();
  await notes.press("End");
  await page.getByTestId("agent-profile-notes-input-dictation-toggle").click();
  await speech.waitForAudio(1);
  await page.getByTestId("agent-profile-notes-input-dictation-submit").click();
  await speech.waitForFinish(1);
  speech.complete("and clear findings", 1);
  speech.complete("and clear findings", 1);
  await expect(page.getByTestId("agent-profile-edit-modal")).not.toBeVisible();
  const finalNotes = "Use for careful reviews with test evidence and clear findings";
  await expect
    .poll(async () => {
      const config = (await workspace.client.getDaemonConfig()).config;
      return config.agentProfiles?.filter((profile) => profile.name === "Dictated review profile");
    })
    .toEqual([
      expect.objectContaining({
        name: "Dictated review profile",
        provider: "mock",
        notes: finalNotes,
      }),
    ]);
  const saved = (await workspace.client.getDaemonConfig()).config;
  const created = saved.agentProfiles!.find(
    (profile) => profile.name === "Dictated review profile",
  )!;
  expect(saved).toEqual({
    ...previous,
    agentProfiles: [...(previous.agentProfiles ?? []), created],
  });
  const row = page.getByTestId(`agent-profile-row-${created.id}`);
  await expect(row.getByText(finalNotes, { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Edit profile", exact: true }).click();
  await expect(notes).toHaveValue(finalNotes);
  await expect(page.getByTestId("agent-profile-name-input")).toHaveValue("Dictated review profile");
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});

test("the schedule dictation arrow validates its target before creating a future schedule", async ({
  page,
  host,
  workspace,
  speech,
}) => {
  const prompt = await openSchedule(page, host);
  await page.getByTestId("schedule-name-input").fill("Dictated future schedule");
  await prompt.fill("Inspect this project");
  await prompt.press("End");
  await page.getByTestId("schedule-prompt-input-dictation-toggle").click();
  await speech.waitForAudio(0);
  await page.getByTestId("schedule-prompt-input-dictation-submit").click();
  await speech.waitForFinish(0);
  speech.complete("and summarize the status", 0);
  await expect(prompt).toHaveValue("Inspect this project and summarize the status");
  await expect(page.getByTestId("schedule-form-submit")).toBeDisabled();
  expect((await workspace.client.scheduleList()).schedules).toEqual([]);
  await page.getByTestId("schedule-project-trigger").click();
  await page
    .getByTestId(/^schedule-project-option-/)
    .filter({ hasText: path.basename(workspace.directory) })
    .click();
  await page.getByTestId("schedule-model-trigger").click();
  await page.getByTestId("model-search-all-input").fill("Five minute stream");
  await page.getByTestId("model-row-mock-five-minute-stream").click();
  await expect(page.getByTestId("model-search-all-input")).not.toBeVisible();
  // An annual trigger always resolves to its next future occurrence. Creating
  // this schedule exercises persistence without dispatching a coding agent.
  await page.getByTestId("cadence-cron-expression").fill("0 0 1 1 *");
  await expect(page.getByTestId("schedule-form-submit")).toBeEnabled();
  await prompt.focus();
  await prompt.press("End");
  await page.getByTestId("schedule-prompt-input-dictation-toggle").click();
  await speech.waitForAudio(1);
  await page.getByTestId("schedule-prompt-input-dictation-submit").click();
  await speech.waitForFinish(1);
  const beforeSave = Date.now();
  speech.complete("with clear next steps", 1);
  speech.complete("with clear next steps", 1);
  await expect(page.getByTestId("schedule-form-sheet")).not.toBeVisible();
  const { schedules } = await workspace.client.scheduleList();
  expect(schedules).toHaveLength(1);
  const schedule = schedules[0]!;
  expect(schedule).toMatchObject({
    name: "Dictated future schedule",
    prompt: "Inspect this project and summarize the status with clear next steps",
    cadence: { type: "cron", expression: "0 0 1 1 *" },
    target: {
      type: "new-agent",
      config: { provider: "mock", model: "five-minute-stream", cwd: workspace.directory },
    },
    lastRunAt: null,
  });
  expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(beforeSave);
  await page.getByTestId(`schedule-row-${schedule.id}`).click();
  await expect(prompt).toHaveValue(schedule.prompt);
  await expect(page.getByTestId("schedule-name-input")).toHaveValue(schedule.name!);
  expect(speech.agentRequests).toEqual([]);
  await expectMicrophoneReleased(page);
});
