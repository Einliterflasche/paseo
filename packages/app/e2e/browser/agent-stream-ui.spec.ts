import { test, expect } from "../support/fixtures";
import {
  awaitAssistantMessage,
  expectAgentIdle,
  expectInlineWorkingIndicator,
  expectRunningAgentChrome,
  expectTurnCopyButton,
  expectScrollFollowsNewContent,
} from "../support/helpers/agent-stream";
import {
  expectScrollStaysFixed,
  clickToolCallBesideScrollToBottomButton,
  readScrollMetrics,
  scrollAgentChatToBottom,
  scrollChatAwayFromBottom,
  waitForScrollableChat,
} from "../support/helpers/agent-bottom-anchor";
import { delayCreatedAgentInitialTailResponse } from "../support/helpers/agent-timeline-gate";
import { selectModel } from "../support/helpers/app";
import { clickNewChat } from "../support/helpers/launcher";
import { expectComposerVisible, startRunningMockAgent } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  seedRunningMockAgentWorkspace,
} from "../support/helpers/mock-agent";

const SCROLL_AWAY_MIN_SCROLLABLE_DISTANCE = 360;

test.describe("Agent stream UI", () => {
  for (const width of [1440, 390]) {
    test(`keeps a grouped agent bubble and one live timestamp at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "agent-bubble-",
        title: "Agent bubble",
        initialPrompt: "Show the message fixture.",
        featureValues: {
          mockAssistantResponse:
            "The message keeps its paragraphs together.\n\n```ts\nconst message = { text: 'Ready', timestamp: '15:04' };\n```\n\n[Read the details](https://example.com/details).",
        },
      });
      try {
        await agent.client.waitForFinish(agent.agentId, 30000);
        await openAgentRoute(page, agent);
        const bubbles = page.getByTestId("assistant-message-bubble");
        const timestamp = page.getByTestId("assistant-message-timestamp");
        await expect(bubbles).toHaveCount(3);
        await expect(timestamp).toHaveCount(1);
        await expect(timestamp).toHaveText(/^(\d+[sm] ago|\d{2}:\d{2})$/);
        const first = await bubbles.nth(0).boundingBox();
        const second = await bubbles.nth(1).boundingBox();
        if (!first || !second) throw new Error("Agent bubble is not visible");
        expect(first.width).toBeGreaterThan(width === 1440 ? 600 : 250);
        expect(second.y - first.y - first.height).toBeLessThan(1);
        await expect(
          page.getByRole("link", { name: "Read the details" }).and(page.locator("a")),
        ).toBeVisible();
        const markdown = page.getByTestId("assistant-message").first();
        const body = await markdown.locator(":scope > *").first().elementHandle();
        const initialTime = await timestamp.textContent();
        await expect(timestamp).not.toHaveText(initialTime ?? "");
        expect(await body?.evaluate((element) => element.isConnected)).toBe(true);
        await expectTurnCopyButton(page);
        await page.reload();
        await expect(bubbles).toHaveCount(3);
        await expect(timestamp).toHaveCount(1);
      } finally {
        await agent.cleanup();
      }
    });
  }

  test("keeps running agent chrome after page refresh", async ({ page }) => {
    const title = "Running agent refresh";
    const agent = await seedRunningMockAgentWorkspace({
      repoPrefix: "stream-running-refresh-",
      title,
      model: "five-minute-stream",
      initialPrompt: "Stay running while the page refreshes.",
    });
    try {
      await openAgentRoute(page, agent);
      await expectRunningAgentChrome(page, title);

      await page.reload();

      await expectRunningAgentChrome(page, title);
    } finally {
      await agent.cleanup();
    }
  });

  test("auto-scroll sticks to bottom across token bursts", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-scroll-",
      model: "one-minute-stream",
      prompt: "Stream for auto-scroll test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectScrollFollowsNewContent(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps the active Markdown root mounted across streamed text updates", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-markdown-root-",
      model: "one-minute-stream",
      prompt: "Stream for Markdown root stability test.",
    });
    try {
      const assistantMessage = page.getByTestId("assistant-message").last();
      await expect(assistantMessage).toContainText("walking through", { timeout: 30_000 });

      const activeBlock = assistantMessage.locator(":scope > *").last();
      const initialText = (await activeBlock.textContent()) ?? "";
      const activeBlockHandle = await activeBlock.elementHandle();
      if (!activeBlockHandle) {
        throw new Error("Expected the active assistant message to contain a block");
      }
      const markdownRoot = await activeBlock.locator(":scope > *").first().elementHandle();
      if (!markdownRoot) {
        throw new Error("Expected the active assistant block to contain a Markdown root");
      }

      await page.evaluate((block) => {
        const evidence = { addedNodes: 0, characterDataMutations: 0, removedNodes: 0 };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            evidence.addedNodes += record.addedNodes.length;
            evidence.removedNodes += record.removedNodes.length;
            if (record.type === "characterData") evidence.characterDataMutations += 1;
          }
        });
        observer.observe(block, { characterData: true, childList: true, subtree: true });
        Object.assign(window, {
          __markdownRootEvidence: evidence,
          __markdownRootObserver: observer,
        });
      }, activeBlockHandle);

      await expect
        .poll(async () => ((await activeBlock.textContent()) ?? "").length)
        .toBeGreaterThan(initialText.length + 80);

      const evidence = await page.evaluate((root) => {
        const state = window as typeof window & {
          __markdownRootEvidence?: {
            addedNodes: number;
            characterDataMutations: number;
            removedNodes: number;
          };
          __markdownRootObserver?: MutationObserver;
        };
        state.__markdownRootObserver?.disconnect();
        const messages = document.querySelectorAll('[data-testid="assistant-message"]');
        const message = messages.item(messages.length - 1);
        const block = message?.lastElementChild;
        return {
          ...state.__markdownRootEvidence,
          connected: root.isConnected,
          sameRoot: block?.firstElementChild === root,
        };
      }, markdownRoot);

      await testInfo.attach("markdown-root-stability", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      expect(evidence.connected).toBe(true);
      expect(evidence.sameRoot).toBe(true);
      expect(
        evidence.removedNodes,
        `Streaming Markdown replaced mounted descendants: ${JSON.stringify(evidence)}`,
      ).toBe(0);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps the viewport fixed after the user scrolls away during a stream", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "stream-scroll-away-",
      title: "Scroll-away anchor",
      model: "five-minute-stream",
      initialPrompt: "emit 120 agent stream updates for scroll-away setup.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
      });
      await expectComposerVisible(page);
      await agent.client.sendAgentMessage(agent.agentId, "Stream for scroll-away anchor test.");
      await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
        timeout: 30_000,
      });
      await awaitAssistantMessage(page);
      await waitForScrollableChat(page, {
        minScrollableDistance: SCROLL_AWAY_MIN_SCROLLABLE_DISTANCE,
        timeout: 30_000,
      });
      const baseline = await scrollChatAwayFromBottom(page, {
        deltaY: -900,
        minDistanceFromBottom: 300,
      });
      await expectScrollStaysFixed(page, baseline, { durationMs: 30_000 });

      const finalMetrics = await readScrollMetrics(page);
      expect(finalMetrics.contentHeight).toBeGreaterThan(baseline.contentHeight);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps the viewport fixed when delayed authoritative history arrives after scroll-away", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(180_000);
    const timelineGate = await delayCreatedAgentInitialTailResponse(page);
    const workspace = await withWorkspace({
      prefix: "stream-scroll-away-delayed-history-",
    });
    await workspace.navigateTo();
    await clickNewChat(page);
    await page.getByText("Model defaults are still loading").waitFor({
      state: "hidden",
      timeout: 30_000,
    });
    await expectComposerVisible(page);
    await selectModel(page, "Five minute stream");

    const prompt = "Stream for delayed authoritative history scroll-away test.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText(prompt, { exact: true }).first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await timelineGate.waitForCreatedAgent();
    await timelineGate.waitForDelayedResponse();
    await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Reasoning rows collapse when the mock starts its next assistant response. Wait past
    // that transition so their temporary height cannot satisfy the scroll-away setup.
    await awaitAssistantMessage(page, "Now I have a clearer picture.");
    await waitForScrollableChat(page, {
      minScrollableDistance: SCROLL_AWAY_MIN_SCROLLABLE_DISTANCE,
      timeout: 45_000,
    });
    const baseline = await scrollChatAwayFromBottom(page, {
      deltaY: -900,
      minDistanceFromBottom: 300,
    });

    timelineGate.release();
    await timelineGate.waitForForwardedResponse();
    await expectScrollStaysFixed(page, baseline);
  });

  test("keeps tool calls clickable beside the scroll-to-bottom button", async ({ page }) => {
    test.setTimeout(60_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "stream-scroll-button-hit-area-",
      title: "Scroll button hit area",
      model: "ten-second-stream",
      initialPrompt: "Stream enough content to exercise the scroll button hit area.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
      });
      await waitForScrollableChat(page, {
        minScrollableDistance: SCROLL_AWAY_MIN_SCROLLABLE_DISTANCE,
        timeout: 30_000,
      });

      const hitArea = await clickToolCallBesideScrollToBottomButton(page);

      expect(hitArea).toEqual({
        outsideButton: true,
        toolCallReceivesPointer: true,
        withinButtonBand: true,
      });
    } finally {
      await agent.cleanup();
    }
  });

  test("working-indicator transitions to copy-button when stream ends", async ({ page }) => {
    test.setTimeout(60_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-indicator-",
      model: "ten-second-stream",
      prompt: "Stream briefly for indicator transition test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectInlineWorkingIndicator(page);
      await expectAgentIdle(page, 30_000);
      await scrollAgentChatToBottom(page);
      await expect(page.getByTestId("tool-call-badge").first()).toBeVisible();
      await expect(
        page.locator('[data-testid="assistant-message-bubble"] [data-testid="tool-call-badge"]'),
      ).toHaveCount(0);
      await expectTurnCopyButton(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("shows elapsed timer on first app-created running turn", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "stream-first-app-turn-timer-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await page.getByText("Model defaults are still loading").waitFor({
      state: "hidden",
      timeout: 30_000,
    });
    const prompt = "Stream briefly for first app-created turn timer test.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText(prompt, { exact: true }).first().waitFor({ state: "visible" });
    await awaitAssistantMessage(page);
    await expectInlineWorkingIndicator(page);
    await page.getByTestId("turn-working-elapsed").waitFor({ state: "visible", timeout: 5_000 });
  });
});
