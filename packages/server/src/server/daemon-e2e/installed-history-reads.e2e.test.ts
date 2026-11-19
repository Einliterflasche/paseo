import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, onTestFinished, test } from "vitest";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("MCP activity and WebSocket fork context read restored history after metadata persistence fails, and the boot runs", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "paseo-installed-history-source-"));
  onTestFinished(() => rm(sourceRoot, { recursive: true, force: true }));
  const source = await createTestPaseoDaemon({
    paseoHomeRoot: sourceRoot,
    cleanup: false,
    agentClients: { codex: createCheckpointAgentClient() },
  });
  const agent = await source.daemon.agentManager.createAgent(
    { provider: "codex", cwd: sourceRoot, title: "Retained source", modeId: "full-access" },
    undefined,
    { workspaceId: "installed-history-workspace" },
  );
  await source.daemon.agentManager.runAgent(agent.id, "finish", { clientMessageId: "saved-input" });
  const { generationId } = await source.daemon.prepareRestart();
  expect(generationId).toBeTruthy();
  await source.close();

  // The target boots from the source checkpoint, but cannot write the agent's metadata.
  const targetRoot = await mkdtemp(join(tmpdir(), "paseo-installed-history-target-"));
  const targetHome = join(targetRoot, ".paseo");
  await cp(join(source.paseoHome, "restart-checkpoints"), join(targetHome, "restart-checkpoints"), {
    recursive: true,
  });
  const [projectDir] = await readdir(join(source.paseoHome, "agents"));
  await mkdir(join(targetHome, "agents"), { recursive: true });
  await writeFile(join(targetHome, "agents", projectDir!), "block the agent metadata directory");

  let providerStarts = 0;
  const provider = createCheckpointAgentClient();
  const forbiddenFactory = async (): Promise<never> => {
    providerStarts++;
    throw new Error("History reads must not activate a native provider");
  };
  provider.createSession = forbiddenFactory;
  provider.resumeSession = forbiddenFactory;
  const target = await createTestPaseoDaemon({
    paseoHomeRoot: targetRoot,
    agentClients: { codex: provider },
  });
  onTestFinished(() => target.close());
  expect(await target.daemon.agentStorage.get(agent.id)).toBeNull();
  expect(target.daemon.agentManager.getAgent(agent.id)).toBeNull();
  expect(target.daemon.agentManager.hasInstalledHistory(agent.id)).toBe(true);
  expect(() => target.daemon.agentManager.assertAcceptingWork()).not.toThrow();

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${target.port}/ws`,
    reconnect: { enabled: false },
  });
  onTestFinished(() => client.close());
  await client.connect();
  expect(client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: generationId,
  });

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
        `Source directory: ${sourceRoot}\n\n` +
        "[User] finish\n[Assistant] partial-output\n</chat-history-summary>",
    },
    itemCount: 2,
    boundaryCursor: null,
    boundaryMessageId: null,
    error: null,
  });
  expect(target.daemon.agentManager.getAgent(agent.id)).toBeNull();
  expect(providerStarts).toBe(0);
  const schedule = await client.scheduleCreate({
    prompt: "new work after the restored boot",
    target: { type: "agent", agentId: agent.id },
    cadence: { type: "cron", expression: "0 0 1 1 *" },
    runOnCreate: false,
  });
  expect(schedule.error).toBeNull();
}, 30_000);
