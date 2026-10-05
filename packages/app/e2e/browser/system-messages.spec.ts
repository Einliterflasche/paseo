import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectComposerVisible } from "../support/helpers/composer";

test.use({ hasTouch: true });

test("tagged messages collapse, expand, and retain human attribution after reload", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "system-messages-",
    title: "System messages",
  });
  const message =
    "<paseo-system>\nReview complete\n\n  Full report with spacing.  \n</paseo-system>";
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await agent.client.sendAgentMessage(agent.agentId, message);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const row = page.getByTestId("system-message");
    const toggle = page.getByTestId("system-message-toggle");
    const content = page.getByTestId("system-message-content");
    await expect(row).toHaveCount(1);
    await expect(toggle).toHaveText("You · Review complete");
    expect(
      await toggle
        .getByText("You · Review complete", { exact: true })
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ).toMatch(/mono|menlo|courier/i);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(content).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("collapsed.png") });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await content.textContent()).toBe(message);
    expect(await content.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
      /mono|menlo|courier/i,
    );
    await page.screenshot({ path: test.info().outputPath("expanded.png") });
    await toggle.click();
    await expect(content).toHaveCount(0);
    await page.reload();
    await expect(toggle).toHaveText("You · Review complete");
    await expect(row).toHaveCount(1);
    await expect(content).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle.tap({ force: true });
    expect(await content.textContent()).toBe(message);
    await page.screenshot({ path: test.info().outputPath("compact-expanded.png") });
  } finally {
    await agent.cleanup();
  }
});
