import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentClient, AgentSessionConfig } from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { CheckpointStore } from "../../restart/checkpoint-store.js";
import { DaemonCheckpointSchema } from "../../restart/daemon-checkpoint.js";
import { createCheckpointAgentClient } from "../../test-utils/checkpoint-agent-client.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

async function createManager(home: string, client: AgentClient): Promise<AgentManager> {
  const logger = createTestLogger();
  const registry = new AgentStorage(join(home, "agents"), logger);
  await registry.initialize();
  return new AgentManager({ clients: { codex: client }, registry, logger });
}

function nativeClient(): { client: AgentClient; servers: FakeCodexAppServer[] } {
  const client = createCheckpointAgentClient();
  const servers: FakeCodexAppServer[] = [];
  let sequence = 0;
  const open = async (config: AgentSessionConfig, handle: { sessionId: string } | null) => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({
        data: [
          {
            id: "gpt-6.1-sol",
            isDefault: true,
            defaultServiceTier: "priority",
            serviceTiers: [{ id: "priority", name: "Fast", description: "Account priority" }],
          },
        ],
      }),
      "thread/resume": (params) => ({
        thread: { id: (params as { threadId: string }).threadId },
        serviceTier: "priority",
      }),
      "turn/start": (params) => {
        const threadId = (params as { threadId: string }).threadId;
        const turnId = `native-turn-${++sequence}`;
        setImmediate(() => {
          appServer.startsTurn({ threadId, turnId });
          appServer.says({ threadId, itemId: turnId, text: "completed" });
          appServer.completeTurn({ threadId, turnId });
        });
        return {};
      },
    });
    servers.push(appServer);
    const session = new CodexAppServerAgentSession(
      config,
      handle,
      createTestLogger(),
      async () => appServer.child,
    );
    await session.connect();
    return session;
  };
  client.createSession = (config) => open(config, null);
  client.resumeSession = (handle, overrides) =>
    open(
      { ...handle.metadata, ...overrides, provider: "codex", cwd: overrides?.cwd ?? process.cwd() },
      handle,
    );
  return { client, servers };
}

test.each([
  { saved: { fast_mode: true }, expected: "priority" },
  { saved: { fast_mode: false }, expected: "default" },
  { saved: {}, expected: "default" },
  { saved: { fast_mode: true, service_tier: "default" }, expected: "default" },
])(
  "format4 saved Speed $saved restores as $expected on every native turn",
  async ({ saved, expected }) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-codex-checkpoint-speeds-"));
    const before = await createManager(home, createCheckpointAgentClient());
    const actual = nativeClient();
    let after: AgentManager | undefined;
    try {
      const agent = await before.createAgent(
        { provider: "codex", cwd: home, model: "gpt-6.1-sol", modeId: "auto" },
        undefined,
        { workspaceId: "workspace" },
      );
      await before
        .streamAgent(agent.id, "accepted unfinished input", { clientMessageId: "saved-input" })
        .next();
      const agents = await before.quiesceForRestart();
      agents.agents[0]!.record.config.featureValues = saved;
      const snapshot = DaemonCheckpointSchema.parse({
        version: 4,
        agents,
        notifications: [],
        schedules: { runs: [] },
        services: [],
      });
      const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
      await store.commit(snapshot);
      const claimed = await store.loadAndClaim();
      expect(claimed?.snapshot.version).toBe(4);
      expect(claimed?.snapshot.agents.agents[0]?.record.config.featureValues).toEqual(saved);
      after = await createManager(home, actual.client);
      await after.installRestartCheckpoint(claimed!.snapshot.agents);
      await after.resumeRestartCheckpoint(claimed!.snapshot.agents);
      await expect(after.waitForRunOutcome(agent.id, "saved-input")).resolves.toMatchObject({
        type: "completed",
      });
      await after.runAgent(agent.id, "next ordinary turn");
      expect(
        actual.servers[0]!.requests()
          .filter((request) => request.method === "turn/start")
          .map((request) => (request.params as Record<string, unknown>).serviceTier),
      ).toEqual([expected, expected]);
      await after.setAgentFeature(agent.id, "service_tier", "default");
      await after.runAgent(agent.id, "explicit Normal overrides native priority");
      expect(
        actual.servers[0]!.requests()
          .filter((request) => request.method === "turn/start")
          .map((request) => (request.params as Record<string, unknown>).serviceTier),
      ).toEqual([expected, expected, "default"]);
      const successor = await after.quiesceForRestart();
      expect(successor.agents[0]?.record.config.featureValues?.service_tier).toBe("default");
      for (const server of actual.servers) server.assertNoErrors();
    } finally {
      await after?.quiesceForRestart();
      await before.quiesceForRestart();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("new agents send Normal on every turn despite native account priority defaults", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-new-speeds-"));
  const actual = nativeClient();
  const manager = await createManager(home, actual.client);
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: home, model: "gpt-6.1-sol", modeId: "auto" },
      undefined,
      { workspaceId: "workspace" },
    );
    await manager.runAgent(agent.id, "first new turn");
    await manager.runAgent(agent.id, "second new turn");
    expect(
      actual.servers[0]!.requests()
        .filter((request) => request.method === "turn/start")
        .map((request) => (request.params as Record<string, unknown>).serviceTier),
    ).toEqual(["default", "default"]);
    actual.servers[0]!.assertNoErrors();
  } finally {
    await manager.quiesceForRestart();
    await rm(home, { recursive: true, force: true });
  }
});
