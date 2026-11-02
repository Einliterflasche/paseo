import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentClient, AgentSessionConfig } from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { CheckpointStore } from "../../restart/checkpoint-store.js";
import { DaemonCheckpointSchema } from "../../restart/daemon-checkpoint.js";
import { createCheckpointAgentClient } from "../../test-utils/checkpoint-agent-client.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

async function createManager(home: string, client: AgentClient) {
  const logger = createTestLogger();
  const registry = new AgentStorage(join(home, "agents"), logger);
  await registry.initialize();
  return { manager: new AgentManager({ clients: { codex: client }, registry, logger }), registry };
}

function nativeClient(): { client: AgentClient; servers: FakeCodexAppServer[] } {
  const client = createCheckpointAgentClient();
  const servers: FakeCodexAppServer[] = [];
  let sequence = 0;
  const open = async (config: AgentSessionConfig, handle: { sessionId: string } | null) => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({
        data: [{ id: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: true, serviceTiers: [] }],
      }),
      "thread/resume": (params) => ({
        thread: { id: (params as { threadId: string }).threadId },
      }),
      "thread/read": (params) => ({
        thread: { id: (params as { threadId: string }).threadId, turns: [] },
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

const programs = (server: FakeCodexAppServer) =>
  server
    .requests()
    .filter((request) => request.method === "turn/start")
    .map((request) => (request.params as Record<string, unknown>).cyberAccessProgram ?? null);

test("Daybreak choice and notice survive a controlled restart checkpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-checkpoint-daybreak-"));
  const original = nativeClient();
  const before = await createManager(home, original.client);
  const restored = nativeClient();
  let after: Awaited<ReturnType<typeof createManager>> | undefined;
  try {
    const agent = await before.manager.createAgent(
      { provider: "codex", cwd: home, model: "gpt-6-sol", modeId: "auto" },
      undefined,
      { workspaceId: "workspace" },
    );
    await before.manager.setAgentFeature(agent.id, "daybreak", true);
    await before.manager.runAgent(agent.id, "first");
    expect(programs(original.servers[0]!)).toEqual(["daybreakBlue"]);
    const notices = (manager: AgentManager) =>
      manager
        .getTimeline(agent.id)
        .filter((item) => item.type === "notification")
        .map((item) => (item as { message: string }).message);
    expect(notices(before.manager)).toEqual(["Daybreak is on for new turns."]);

    const agents = await before.manager.quiesceForRestart();
    const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
    await store.commit(
      DaemonCheckpointSchema.parse({
        version: 4,
        agents,
        notifications: [],
        schedules: { runs: [] },
        services: [],
      }),
    );
    const claimed = await store.loadAndClaim();
    const record = claimed!.snapshot.agents.agents.find(
      (entry) => entry.record.id === agent.id,
    )!.record;
    expect(record.config?.featureValues).toMatchObject({ daybreak: true });
    expect(record.persistence?.metadata?.daybreakNotices).toEqual([
      { enabled: true, timestamp: expect.any(String) },
    ]);

    after = await createManager(home, restored.client);
    await after.manager.installRestartCheckpoint(claimed!.snapshot.agents);
    await after.manager.resumeRestartCheckpoint(claimed!.snapshot.agents);
    await ensureAgentLoaded(agent.id, {
      agentManager: after.manager,
      agentStorage: after.registry,
      logger: createTestLogger(),
    });
    expect(notices(after.manager)).toEqual(["Daybreak is on for new turns."]);
    await after.manager.runAgent(agent.id, "second");
    expect(programs(restored.servers[0]!)).toEqual(["daybreakBlue"]);

    await after.manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await after.manager.hydrateTimelineFromProvider(agent.id);
    expect(notices(after.manager)).toEqual(["Daybreak is on for new turns."]);
    for (const server of [...original.servers, ...restored.servers]) server.assertNoErrors();
  } finally {
    await after?.manager.quiesceForRestart();
    await before.manager.quiesceForRestart();
    await rm(home, { recursive: true, force: true });
  }
});
