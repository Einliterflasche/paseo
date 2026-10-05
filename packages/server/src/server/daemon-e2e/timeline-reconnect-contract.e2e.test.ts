import { afterEach, beforeEach, expect, onTestFinished, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createDaemonTestContext,
  type DaemonTestContext,
  DaemonClient,
} from "../test-utils/index.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import type { SessionOutboundMessage } from "../messages.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

async function observeTimeline(
  client: DaemonClient,
  agentId: string,
  messages: SessionOutboundMessage[],
): Promise<void> {
  const subscription = client.observeTimeline([agentId]);
  onTestFinished(
    subscription.subscribe({
      snapshot() {},
      update(message) {
        messages.push(message);
      },
    }),
  );
  await subscription.ready;
}

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function isLiveAssistantTimeline(
  message: SessionOutboundMessage,
  agentId: string,
  text?: string,
): boolean {
  return (
    message.type === "agent_stream" &&
    message.payload.agentId === agentId &&
    message.payload.event.type === "timeline" &&
    message.payload.event.item.type === "assistant_message" &&
    message.payload.seq === undefined &&
    message.payload.epoch === undefined &&
    (text === undefined || message.payload.event.item.text === text)
  );
}

let ctx: DaemonTestContext;
const callerTokens = new Map<string, string>();

beforeEach(async () => {
  callerTokens.clear();
  const clients = createTestAgentClients();
  const createSession = clients.codex.createSession.bind(clients.codex);
  clients.codex.createSession = (config, launch) => {
    if (launch?.env?.PASEO_AGENT_TOKEN)
      callerTokens.set(launch.agentId, launch.env.PASEO_AGENT_TOKEN);
    return createSession(config, launch);
  };
  ctx = await createDaemonTestContext({ agentClients: clients });
});

afterEach(async () => {
  await ctx.cleanup();
}, 60_000);

test("socket sends use actual caller identity and replay one row after the caller is renamed", async () => {
  const cwd = tmpCwd();
  try {
    const caller = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Reviewer",
      modeId: "full-access",
    });
    const receiver = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Recipient",
      modeId: "full-access",
    });
    const callerToken = callerTokens.get(caller.id);
    if (!callerToken) throw new Error("Missing caller token");
    const text = "<paseo-system>\n  A report\n\nFull text  \n</paseo-system>";
    await ctx.client.sendAgentMessage(receiver.id, text, {
      messageId: "agent-report",
      callerToken,
    });
    await ctx.client.waitForFinish(receiver.id, 5000);
    await ctx.daemon.daemon.agentManager.setTitle(caller.id, "Renamed reviewer");
    await ctx.client.sendAgentMessage(receiver.id, text, {
      messageId: "agent-report",
      callerToken,
    });
    await ctx.client.sendAgentMessage(receiver.id, text, { messageId: "human-report" });
    await ctx.client.waitForFinish(receiver.id, 5000);
    const timeline = await ctx.client.fetchAgentTimeline(receiver.id, {
      direction: "tail",
      limit: 0,
    });
    const users = timeline.entries.flatMap((row) =>
      row.item.type === "user_message" ? [row.item] : [],
    );
    expect(users).toEqual([
      {
        type: "user_message",
        text,
        messageId: "agent-report",
        clientMessageId: "agent-report",
        sender: { kind: "agent", agentId: caller.id, title: "Reviewer" },
      },
      {
        type: "user_message",
        text,
        messageId: "human-report",
        clientMessageId: "human-report",
        sender: { kind: "human" },
      },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("CLI sends retain tagged text and distinguish an agent from a human", async () => {
  const cwd = tmpCwd();
  try {
    const caller = await ctx.client.createAgent({ provider: "codex", cwd, title: "CLI sender" });
    const receiver = await ctx.client.createAgent({ provider: "codex", cwd });
    const text = "<paseo-system>\nCLI report\n\n  Full report  \n</paseo-system>";
    const token = callerTokens.get(caller.id);
    if (!token) throw new Error("Missing caller token");
    for (const callerToken of [token, undefined]) {
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
          "--host",
          `127.0.0.1:${ctx.daemon.port}`,
          "send",
          "--no-wait",
          receiver.id,
          text,
        ],
        {
          timeout: 15_000,
          env: {
            ...process.env,
            PASEO_HOME: ctx.daemon.paseoHome,
            PASEO_AGENT_ID: callerToken ? caller.id : undefined,
            PASEO_AGENT_TOKEN: callerToken,
          },
        },
      );
      await ctx.client.waitForFinish(receiver.id, 5_000);
    }
    const users = ctx.daemon.daemon.agentManager
      .getTimeline(receiver.id)
      .filter((item) => item.type === "user_message");
    expect(users.map((item) => item.text)).toEqual([text, text]);
    expect(users.map((item) => item.sender)).toEqual([
      { kind: "agent", agentId: caller.id, title: "CLI sender" },
      { kind: "human" },
    ]);
    expect(new Set(users.map((item) => item.clientMessageId)).size).toBe(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reconnect catches up committed rows without replaying a provisional seed", async () => {
  const cwd = tmpCwd();
  const primaryCollector = createMessageCollector(ctx.client);

  try {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Reconnect Contract Test",
      modeId: "full-access",
    });

    await observeTimeline(ctx.client, agent.id, primaryCollector.messages);

    for (let seq = 1; seq <= 120; seq += 1) {
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: `committed row ${seq}`,
      });
    }
    const baseline = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const epoch = baseline.epoch;
    expect(epoch).not.toBe("");
    expect(baseline.endCursor?.epoch).toBe(epoch);

    primaryCollector.clear();
    await ctx.daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
      type: "assistant_message",
      text: "partial before disconnect",
    });
    await waitFor(() =>
      primaryCollector.messages.some((message) =>
        isLiveAssistantTimeline(message, agent.id, "partial before disconnect"),
      ),
    );

    await ctx.client.close();

    await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: "finalized while disconnected",
    });

    const reconnectClient = new DaemonClient({
      url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    });
    await reconnectClient.connect();
    const reconnectCollector = createMessageCollector(reconnectClient);
    await observeTimeline(reconnectClient, agent.id, reconnectCollector.messages);

    try {
      await reconnectClient.fetchAgents({
        subscribe: {},
      });

      expect(
        reconnectCollector.messages.some((message) => isLiveAssistantTimeline(message, agent.id)),
      ).toBe(false);

      const catchUp = await reconnectClient.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch, seq: 120 },
        limit: 0,
        projection: "canonical",
      });

      expect(catchUp.epoch).toBe(epoch);
      expect(catchUp.reset).toBe(false);
      expect(catchUp.staleCursor).toBe(false);
      expect(catchUp.gap).toBe(false);
      expect(catchUp.entries).toHaveLength(1);
      expect(catchUp.startCursor).toEqual({ epoch, seq: 121 });
      expect(catchUp.endCursor).toEqual({ epoch, seq: 121 });
      expect(catchUp.projection).toBe("projected");
      expect(catchUp.entries[0]?.seqStart).toBe(1);
      expect(catchUp.entries[0]?.seqEnd).toBe(121);
      expect(catchUp.entries[0]?.item).toEqual({
        type: "assistant_message",
        text:
          Array.from({ length: 120 }, (_, index) => `committed row ${index + 1}`).join("") +
          "finalized while disconnected",
      });
    } finally {
      reconnectCollector.unsubscribe();
      await reconnectClient.close();
    }
  } finally {
    primaryCollector.unsubscribe();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("reconnect with no new committed rows resumes from future live provisional updates only", async () => {
  const cwd = tmpCwd();
  const primaryCollector = createMessageCollector(ctx.client);

  try {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Reconnect No Seed Test",
      modeId: "full-access",
    });

    await observeTimeline(ctx.client, agent.id, primaryCollector.messages);

    for (let seq = 1; seq <= 120; seq += 1) {
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: `committed row ${seq}`,
      });
    }
    const baseline = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const epoch = baseline.epoch;
    expect(epoch).not.toBe("");
    expect(baseline.endCursor?.epoch).toBe(epoch);

    primaryCollector.clear();
    await ctx.daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
      type: "assistant_message",
      text: "partial before disconnect",
    });
    await waitFor(() =>
      primaryCollector.messages.some((message) =>
        isLiveAssistantTimeline(message, agent.id, "partial before disconnect"),
      ),
    );

    await ctx.client.close();

    const reconnectClient = new DaemonClient({
      url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    });
    await reconnectClient.connect();
    const reconnectCollector = createMessageCollector(reconnectClient);
    await observeTimeline(reconnectClient, agent.id, reconnectCollector.messages);

    try {
      await reconnectClient.fetchAgents({
        subscribe: {},
      });

      expect(
        reconnectCollector.messages.some((message) => isLiveAssistantTimeline(message, agent.id)),
      ).toBe(false);

      const catchUp = await reconnectClient.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch, seq: 120 },
        limit: 0,
        projection: "canonical",
      });

      expect(catchUp.epoch).toBe(epoch);
      expect(catchUp.reset).toBe(false);
      expect(catchUp.staleCursor).toBe(false);
      expect(catchUp.gap).toBe(false);
      expect(catchUp.entries).toHaveLength(0);
      expect(catchUp.startCursor).toBeNull();
      expect(catchUp.endCursor).toBeNull();

      reconnectCollector.clear();
      await ctx.daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
        type: "assistant_message",
        text: "fresh live after reconnect",
      });
      await waitFor(() =>
        reconnectCollector.messages.some((message) =>
          isLiveAssistantTimeline(message, agent.id, "fresh live after reconnect"),
        ),
      );
    } finally {
      reconnectCollector.unsubscribe();
      await reconnectClient.close();
    }
  } finally {
    primaryCollector.unsubscribe();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
