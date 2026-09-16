import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { AgentClient, AgentSession } from "../agent/agent-sdk-types.js";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function scheduledClient(log: string, allowCompletion: boolean): AgentClient {
  const client = createCheckpointAgentClient(log);
  const attach = (session: AgentSession) => {
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener) =>
      subscribe((event) => {
        if (event.type !== "turn_completed" || allowCompletion) listener(event);
      });
    return session;
  };
  return {
    ...client,
    createSession: async (...args) => attach(await client.createSession(...args)),
    resumeSession: async (...args) => attach(await client.resumeSession(...args)),
  };
}

test("the original scheduled run survives two active restarts and completes once", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-schedule-"));
  const log = join(home, "dispatches.jsonl");
  const launch = async (allowCompletion: boolean) => {
    const instance = await createTestPaseoDaemon({
      paseoHomeRoot: home,
      cleanup: false,
      agentClients: { codex: scheduledClient(log, allowCompletion) },
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
  const first = await launch(false);
  const agent = await first.client.createAgent({ provider: "codex", cwd: home });
  const created = await first.client.scheduleCreate({
    prompt: "scheduled work",
    target: { type: "agent", agentId: agent.id },
    cadence: { type: "every", everyMs: 86_400_000 },
    runOnCreate: false,
  });
  if (!created.schedule) throw new Error(created.error ?? "Schedule was not created");
  const scheduleId = created.schedule.id;
  const inspect = async (client: DaemonClient) => {
    const response = await client.scheduleInspect({ id: scheduleId });
    if (!response.schedule) throw new Error(response.error ?? "Schedule disappeared");
    return response.schedule;
  };
  // This RPC waits for the task. Checkpoint preparation must not wait for its response.
  const pendingRpc = first.client.scheduleRunOnce({ id: scheduleId }).catch(() => undefined);
  await expect.poll(() => first.instance.daemon.agentManager.hasInFlightRun(agent.id)).toBe(true);
  const original = (await inspect(first.client)).runs[0]!;
  expect(original).toMatchObject({ status: "running", agentId: agent.id, endedAt: null });
  const checkpoint = await first.client.prepareRestart();
  expect((await inspect(first.client)).runs).toEqual([original]);
  await first.client.close();
  await pendingRpc;
  await first.instance.close();

  const second = await launch(false);
  expect(second.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBe(
    checkpoint.generationId,
  );
  expect((await inspect(second.client)).runs).toEqual([original]);
  expect(second.instance.daemon.agentManager.hasInFlightRun(agent.id)).toBe(true);
  await second.client.prepareRestart();
  expect((await inspect(second.client)).runs).toEqual([original]);
  await second.client.close();
  await second.instance.close();

  const third = await launch(true);
  await expect.poll(async () => (await inspect(third.client)).runs[0]?.status).toBe("succeeded");
  const final = await inspect(third.client);
  expect(final.runs).toHaveLength(1);
  expect(final.runs[0]).toMatchObject({
    id: original.id,
    startedAt: original.startedAt,
    agentId: agent.id,
    status: "succeeded",
    error: null,
    output: "partial-outputlate-close-outputcontinued-outputcontinued-output",
  });
  const savedAgent = await third.instance.daemon.agentStorage.get(agent.id);
  expect(savedAgent).not.toBeNull();
  expect(savedAgent?.archivedAt).toBeFalsy();
  const calls: Array<{ sessionId: string; resumed: boolean }> = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(3);
  expect(calls.map((call) => call.resumed)).toEqual([false, true, true]);
  expect(new Set(calls.map((call) => call.sessionId)).size).toBe(1);
}, 30_000);
