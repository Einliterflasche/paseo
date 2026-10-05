import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectComposerVisible } from "../support/helpers/composer";
import path from "node:path";
import { killProcessTree, spawnTsx } from "../support/helpers/spawn-node";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { buildAgentRoute } from "../support/helpers/mock-agent";

test.use({ hasTouch: true });

async function startInternalMessageHost() {
  const child = spawnTsx(path.resolve("e2e/support/fixtures/internal-messages-daemon.mts"), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let id = 0;
  const ready = await new Promise<{ port: number; serverId: string }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Internal message host startup timed out")),
      20000,
    );
    child.on("message", (message: unknown) => {
      const value = message as {
        ready?: true;
        port: number;
        serverId: string;
        id: number;
        result?: unknown;
        error?: string;
      };
      if (value.ready) {
        clearTimeout(timeout);
        resolve(value);
        return;
      }
      const request = pending.get(value.id);
      pending.delete(value.id);
      if (value.error) request?.reject(new Error(value.error));
      else request?.resolve(value.result);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) reject(new Error(`Internal message host exited: ${code}`));
    });
  });
  const request = (type: string, agentId?: string, item?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      child.send({ id, type, agentId, item });
    });
  return {
    ...ready,
    manager: {
      clearAgentAttention: (agentId: string) => request("clear", agentId),
      appendTimelineItem: (agentId: string, item: unknown) => request("append", agentId, item),
      runAgent: (agentId: string, item: unknown) => request("run", agentId, item),
      getAgent: async (agentId: string) =>
        (await request("status", agentId)) as { attention: { requiresAttention: boolean } },
    },
    close: async () => {
      await request("close");
      await killProcessTree(child);
    },
  };
}

test("plain attributed reports stay collapsed, quiet, and outside navigation after reload", async ({
  page,
}) => {
  test.setTimeout(90000);
  const host = await startInternalMessageHost();
  const agent = await seedMockAgentWorkspace({
    port: host.port,
    repoPrefix: "internal-reports-",
    title: "Internal reports",
    initialPrompt: "First ordinary prompt.",
    featureValues: {
      mockAssistantResponse:
        "Production remains unchanged while the UI agent inspects the issue. The earlier screenshot showed an intentionally expanded message, so it does not prove that the default display is correct.",
    },
  });
  const manager = host.manager;
  try {
    await agent.client.waitForFinish(agent.agentId, 15000);
    await manager.clearAgentAttention(agent.agentId);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      Object.defineProperty(window, "__internalNotificationCalls", { value: calls });
      class ProtectedNotification {
        static permission = "granted";
        static async requestPermission() {
          return "granted";
        }
        constructor(title: string, options: unknown) {
          calls.push({ title, options });
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", {
        value: ProtectedNotification,
        configurable: true,
      });
    });
    const serverId = host.serverId;
    await page.goto("/");
    await addConnectedHostAndReload(page, {
      serverId,
      port: host.port,
      label: "Internal reports fixture",
    });
    await page.evaluate((fixtureServerId) => {
      const hosts = JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]") as {
        serverId: string;
      }[];
      localStorage.setItem(
        "@paseo:e2e-extra-hosts",
        JSON.stringify(hosts.filter((entry) => entry.serverId === fixtureServerId)),
      );
    }, serverId);
    await page.goto(buildAgentRoute(agent.workspaceId, agent.agentId, serverId));
    await expectComposerVisible(page);
    const reports = [5947, 5953, 5966, 5981, 5999, 6009, 6045];
    for (const seq of reports)
      await manager.appendTimelineItem(agent.agentId, {
        type: "user_message",
        text: `Full original report ${seq}\n\n  Original spacing.  `,
        clientMessageId: `accepted-${seq}`,
        sender: { kind: "agent", agentId: "reviewer", title: "Reviewer" },
      });
    for (const source of ["Completion report", "Restart recovery", "Schedule"])
      await manager.appendTimelineItem(agent.agentId, {
        type: "user_message",
        text: `<paseo-system>\n${source}\n\nOriginal tagged content\n</paseo-system>`,
        sender: { kind: "system", source },
      });
    await expect(page.getByTestId("system-message")).toHaveCount(10);
    expect((await manager.getAgent(agent.agentId))?.attention.requiresAttention).toBe(false);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __internalNotificationCalls: unknown[] })
            .__internalNotificationCalls.length,
      ),
    ).toBe(0);
    await agent.client.sendAgentMessage(agent.agentId, "Second ordinary prompt.");
    await agent.client.waitForFinish(agent.agentId, 15000);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      const row = page.getByTestId("system-message").first();
      const toggle = row.getByTestId("system-message-toggle");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(row.getByTestId("system-message-content")).toHaveCount(0);
      expect(
        await row.evaluate((e) =>
          Boolean(
            e.closest('[data-testid="user-message"],[data-testid="assistant-message-bubble"]'),
          ),
        ),
      ).toBe(false);
      const r = await row.boundingBox(),
        t = await toggle.boundingBox();
      if (!r || !t) throw new Error("Disclosure is not mounted");
      expect(r.height).toBeLessThanOrEqual(40);
      expect(Math.abs(r.x + r.width / 2 - t.x - t.width / 2)).toBeLessThan(1);
      await toggle.click();
      await expect(row.getByTestId("system-message-content")).toHaveText(
        "Full original report 5947\n\n  Original spacing.  ",
      );
      await expect(toggle).toContainText("Reviewer (reviewer)");
      await toggle.click();
      await page.screenshot({ path: test.info().outputPath(`internal-reports-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload();
    const ticks = page.getByTestId("chat-outline-rail").getByRole("tab");
    await expect(ticks).toHaveCount(2);
    await expect(ticks.first()).toHaveAccessibleName("1 of 2: First ordinary prompt.");
    await expect(ticks.last()).toHaveAccessibleName("2 of 2: Second ordinary prompt.");
    await ticks.first().hover();
    await expect(page.getByTestId("chat-outline-preview")).toHaveText("First ordinary prompt.");
    await ticks.first().click();
    await expect(
      page.getByTestId("user-message").getByText("First ordinary prompt.", { exact: true }),
    ).toBeVisible();
    await ticks.last().click();
    await expect(
      page.getByTestId("user-message").getByText("Second ordinary prompt.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("system-message-content")).toHaveCount(0);
    const other = await agent.client.createAgent({
      provider: "mock",
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      title: "Other conversation",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await page.goto(buildAgentRoute(agent.workspaceId, other.id, serverId));
    await expectComposerVisible(page);
    await manager.clearAgentAttention(agent.agentId);
    await manager.appendTimelineItem(agent.agentId, {
      type: "user_message",
      text: "Quiet arrival while reading another conversation.",
      sender: { kind: "agent", agentId: "reviewer" },
    });
    await expect
      .poll(async () => (await manager.getAgent(agent.agentId)).attention.requiresAttention)
      .toBe(false);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __internalNotificationCalls: unknown[] })
            .__internalNotificationCalls.length,
      ),
    ).toBe(0);
    await manager.runAgent(agent.agentId, {
      type: "user_message",
      text: "Complete useful work.",
      clientMessageId: "accepted-background-work",
      sender: { kind: "agent", agentId: "reviewer" },
    });
    await expect
      .poll(async () => (await manager.getAgent(agent.agentId)).attention.requiresAttention)
      .toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __internalNotificationCalls: unknown[] })
              .__internalNotificationCalls.length,
        ),
      )
      .toBe(1);
  } finally {
    await agent.cleanup();
    await host.close();
  }
});

test("tagged messages collapse, expand, and retain human attribution after reload", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "system-messages-",
    title: "System messages",
    featureValues: {
      mockAssistantResponse: "The agent reply stays beside the system message.",
    },
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
    await expect(page.getByTestId("assistant-message-bubble").last()).toBeVisible();
    await expect(page.getByTestId("assistant-message-timestamp").last()).toHaveText(
      /^(\d+[sm] ago|\d{2}:\d{2})$/,
    );
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
    await expect(page.getByTestId("assistant-message-bubble").last()).toBeVisible();
    await expect(page.getByTestId("assistant-message-timestamp").last()).toHaveText(
      /^(\d+[sm] ago|\d{2}:\d{2})$/,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle.tap({ force: true });
    expect(await content.textContent()).toBe(message);
    await page.screenshot({ path: test.info().outputPath("compact-expanded.png") });
  } finally {
    await agent.cleanup();
  }
});
