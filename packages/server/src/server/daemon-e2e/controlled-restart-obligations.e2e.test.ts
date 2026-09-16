import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, onTestFinished, test } from "vitest";
import {
  drainFinishNotificationWatches,
  setupFinishNotification,
  snapshotFinishNotificationWatches,
} from "../agent/agent-prompt.js";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("a restored child notifies its parent once, without reporting restart suspension as completion", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-obligations-"));
  const dispatchLog = join(home, "dispatch.jsonl");
  const launch = async () => {
    const instance = await createTestPaseoDaemon({
      paseoHomeRoot: home,
      cleanup: false,
      agentClients: { codex: createCheckpointAgentClient(dispatchLog) },
    });
    onTestFinished(() => instance.close());
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${instance.port}/ws`,
      reconnect: { enabled: false },
    });
    onTestFinished(() => client.close());
    await client.connect();
    return { instance, client };
  };
  const original = await launch();
  const parent = await original.client.createAgent({ provider: "codex", cwd: home });
  const child = await original.client.createAgent({ provider: "codex", cwd: home });
  setupFinishNotification({
    agentManager: original.instance.daemon.agentManager,
    agentStorage: original.instance.daemon.agentStorage,
    callerAgentId: parent.id,
    childAgentId: child.id,
    logger: pino({ level: "silent" }),
  });
  await original.client.sendAgentMessage(parent.id, "parent task", { messageId: "parent-input" });
  await original.client.sendAgentMessage(child.id, "child task", { messageId: "child-input" });
  await original.client.prepareRestart();
  const before = snapshotFinishNotificationWatches(original.instance.daemon.agentManager);
  expect(before).toHaveLength(1);
  expect(before[0]!.hasSeenRunning).toBe(true);
  expect(before[0]!.pending).toEqual([]);
  expect((await readFile(dispatchLog, "utf8")).trim().split("\n")).toHaveLength(2);
  await original.client.close();
  await original.instance.close();

  const restored = await launch();
  await restored.client.waitForFinish(child.id, 5000);
  await drainFinishNotificationWatches(restored.instance.daemon.agentManager);
  await restored.client.waitForFinish(parent.id, 5000);
  expect(snapshotFinishNotificationWatches(restored.instance.daemon.agentManager)).toEqual([]);
  const calls: Array<{ text: string; messageId?: string }> = (await readFile(dispatchLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const notifications = calls.filter((call) => call.text.includes(`Agent ${child.id}`));
  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.text).toContain("continued-output");
  expect(notifications[0]!.messageId).toBeTruthy();
  const timeline = await restored.client.fetchAgentTimeline(parent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(timeline.entries.filter((entry) => entry.item.type === "user_message")).toHaveLength(1);
  expect(JSON.stringify(timeline.entries)).not.toContain("<paseo-system>");

  // A completed obligation must not reappear in the next checkpoint or boot.
  await restored.client.prepareRestart();
  await restored.client.close();
  await restored.instance.close();
  const again = await launch();
  expect(snapshotFinishNotificationWatches(again.instance.daemon.agentManager)).toEqual([]);
  expect((await readFile(dispatchLog, "utf8")).trim().split("\n")).toHaveLength(calls.length);
}, 30_000);
