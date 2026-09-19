import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, onTestFinished, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

test("MCP activity and WebSocket fork context read unopened checkpoint history after metadata persistence fails", async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), "paseo-installed-history-source-"));
  const logger = createTestLogger();
  const registry = new AgentStorage(join(sourceHome, "agents"), logger);
  await registry.initialize();
  const source = new AgentManager({
    clients: { codex: createCheckpointAgentClient() },
    registry,
    logger,
  });
  onTestFinished(async () => {
    await source.closeAgentsForShutdown();
    await source.flushForShutdown();
    await rm(sourceHome, { recursive: true, force: true });
  });
  const agent = await source.createAgent(
    { provider: "codex", cwd: sourceHome, title: "Retained source", modeId: "full-access" },
    undefined,
    { workspaceId: "installed-history-workspace" },
  );
  await source.runAgent(agent.id, "finish", { clientMessageId: "saved-input" });
  const checkpoint = await source.quiesceForRestart();

  let providerStarts = 0;
  const provider = createCheckpointAgentClient();
  const forbiddenFactory = async (): Promise<never> => {
    providerStarts++;
    throw new Error("History reads must not activate a native provider");
  };
  provider.createSession = forbiddenFactory;
  provider.resumeSession = forbiddenFactory;
  const target = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  onTestFinished(() => target.close());
  const recordsPath = join(target.paseoHome, "agents");
  const parkedRecordsPath = join(target.paseoHome, "agents-before-write-failure");
  await mkdir(recordsPath, { recursive: true });
  await rename(recordsPath, parkedRecordsPath);
  await writeFile(recordsPath, "block the metadata directory during installation");
  try {
    await expect(target.daemon.agentManager.installRestartCheckpoint(checkpoint)).rejects.toThrow(
      "ENOTDIR",
    );
  } finally {
    await rm(recordsPath);
    await rename(parkedRecordsPath, recordsPath);
  }
  expect(await target.daemon.agentStorage.get(agent.id)).toBeNull();
  expect(target.daemon.agentManager.getAgent(agent.id)).toBeNull();
  expect(target.daemon.agentManager.hasInstalledHistory(agent.id)).toBe(true);
  expect(() => target.daemon.agentManager.assertAcceptingWork()).toThrow(RestartInProgressError);

  const mcp = new Client({ name: "installed-history-read-test", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${target.port}/mcp/agents`)),
  );
  onTestFinished(() => mcp.close());
  const activity = await mcp.callTool({
    name: "get_agent_activity",
    arguments: { agentId: agent.id },
  });
  expect(activity.isError).not.toBe(true);
  expect(activity.structuredContent).toEqual({
    agentId: agent.id,
    updateCount: 2,
    currentModeId: "full-access",
    content: "Showing all 2 activities\n\n[User] finish\npartial-output",
  });

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${target.port}/ws`,
    reconnect: { enabled: false },
  });
  onTestFinished(() => client.close());
  await client.connect();
  const fork = await client.buildAgentForkContext(agent.id, { requestId: "retained-fork" });
  expect(fork).toEqual({
    requestId: "retained-fork",
    agentId: agent.id,
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text:
        "<chat-history-summary>\n" +
        "Chat history from a previous Paseo agent.\n" +
        "Source agent: Retained source\n" +
        `Source directory: ${sourceHome}\n\n` +
        "[User] finish\n[Assistant] partial-output\n</chat-history-summary>",
    },
    itemCount: 2,
    boundaryCursor: null,
    boundaryMessageId: null,
    error: null,
  });
  expect(target.daemon.agentManager.getAgent(agent.id)).toBeNull();
  expect(() => target.daemon.agentManager.assertAcceptingWork()).toThrow(RestartInProgressError);
  expect(providerStarts).toBe(0);
}, 30_000);
