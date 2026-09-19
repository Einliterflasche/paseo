import { expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { AgentSessionConfig, AgentStreamEvent } from "./agent/agent-sdk-types.js";
import {
  MockLoadTestAgentClient,
  MockLoadTestAgentSession,
} from "./agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

class ChildSession extends MockLoadTestAgentSession {
  private readonly observers = new Set<(event: AgentStreamEvent) => void>();
  override subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    const release = super.subscribe(callback);
    this.observers.add(callback);
    return () => {
      release();
      this.observers.delete(callback);
    };
  }
  push(event: Extract<AgentStreamEvent, { type: "provider_subagent" }>["event"]): void {
    for (const callback of this.observers)
      callback({ type: "provider_subagent", provider: "mock", event });
  }
}
class ChildProvider extends MockLoadTestAgentClient {
  session!: ChildSession;
  override async createSession(config: AgentSessionConfig): Promise<ChildSession> {
    this.session = new ChildSession({ config, sessionId: "child-history-provider" });
    return this.session;
  }
}

test("projected children reuse canonical lifecycle projection and only demanded transcripts stream", async () => {
  const provider = new ChildProvider();
  const daemon = await createTestPaseoDaemon({ isDev: true, agentClients: { mock: provider } });
  const clients: DaemonClient[] = [];
  try {
    const connect = async (legacy = false) => {
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        capabilities: { [CLIENT_CAPS.projectedProviderSubagents]: !legacy },
        reconnect: { enabled: false },
      });
      clients.push(client);
      const messages: SessionOutboundMessage[] = [];
      client.subscribeRawMessages((message) => messages.push(message));
      await client.connect();
      return { client, messages };
    };
    const current = await connect();
    const legacy = await connect(true);
    const agent = await current.client.createAgent({
      provider: "mock",
      cwd: "/tmp",
      model: "ten-second-stream",
    });
    const subscription = current.client.subscribeProviderSubagentTimeline(
      { parentAgentId: agent.id, subagentId: "viewed" },
      () => {},
    );
    await subscription.ready;
    for (const id of ["viewed", "unopened"]) {
      provider.session.push({ type: "upsert", id, title: id, status: "running" });
      for (let index = 0; index < 100; index++) {
        provider.session.push({
          type: "timeline",
          id,
          item: {
            type: "tool_call",
            callId: "long-tool",
            name: "shell",
            status: index === 99 ? "completed" : "running",
            error: null,
            detail: { type: "shell", command: "inspect", output: `version-${index}` },
          },
        });
      }
      provider.session.push({
        type: "timeline",
        id,
        item: { type: "assistant_message", text: "finished" },
      });
    }
    await current.client.ping();
    await legacy.client.ping();
    const childUpdates = (messages: SessionOutboundMessage[]) =>
      messages.flatMap((message) =>
        message.type === "agent.provider_subagents.update" ? [message.payload] : [],
      );
    const modernUpdates = childUpdates(current.messages);
    expect(modernUpdates.filter((update) => update.kind === "upsert")).toHaveLength(2);
    expect(modernUpdates.filter((update) => update.kind === "timeline")).toHaveLength(101);
    expect(
      modernUpdates.filter(
        (update) => update.kind === "timeline" && update.subagentId === "unopened",
      ),
    ).toEqual([]);
    expect(
      childUpdates(legacy.messages).filter((update) => update.kind === "timeline"),
    ).toHaveLength(202);

    const projected = await current.client.fetchProviderSubagentTimeline(agent.id, "viewed", {
      projection: "projected",
      direction: "tail",
      limit: 0,
    });
    expect(projected.rows).toEqual([]);
    expect(projected.entries).toHaveLength(2);
    expect(projected.entries?.[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 100,
      item: { detail: { output: "version-99" } },
      collapsed: ["tool_lifecycle"],
    });
    expect(projected.startCursor).toEqual({ epoch: projected.epoch, seq: 1 });
    expect(projected.endCursor).toEqual({ epoch: projected.epoch, seq: 101 });
    const raw = await legacy.client.fetchProviderSubagentTimeline(agent.id, "viewed", {
      direction: "tail",
      limit: 0,
    });
    expect(raw.rows).toHaveLength(101);
    expect(raw.rows[0]!.item).toMatchObject({ detail: { output: "version-0" } });
    expect(raw.entries).toBeUndefined();

    const tail = await current.client.fetchProviderSubagentTimeline(agent.id, "viewed", {
      projection: "projected",
      limit: 1,
    });
    expect(tail.entries).toHaveLength(1);
    expect(tail.startCursor?.seq).toBe(101);
    const older = await current.client.fetchProviderSubagentTimeline(agent.id, "viewed", {
      projection: "projected",
      direction: "before",
      cursor: tail.startCursor!,
      limit: 1,
    });
    expect(older.entries).toHaveLength(1);
    expect(older.entries?.[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 100,
      item: { detail: { output: "version-99" } },
    });
    expect(older.hasOlder).toBe(false);
    subscription();
    await current.client.ping();
    current.messages.length = 0;
    provider.session.push({
      type: "timeline",
      id: "viewed",
      item: { type: "assistant_message", text: "hidden" },
    });
    await current.client.ping();
    expect(childUpdates(current.messages).filter((update) => update.kind === "timeline")).toEqual(
      [],
    );
  } finally {
    for (const client of clients) await client.close();
    await daemon.close();
  }
}, 30_000);
