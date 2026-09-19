import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";

async function launch(home: string): Promise<{ child: ChildProcess; client: DaemonClient }> {
  const child = fork(
    fileURLToPath(new URL("../test-utils/checkpoint-daemon-process.ts", import.meta.url)),
    [home, "0"],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, PASEO_SUPERVISED: "0" },
    },
  );
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += String(data);
  });
  child.stdout?.resume();
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const { port } = await new Promise<{ port: number }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as { port: number }));
    child.once("exit", (code) => reject(new Error(`Daemon exited ${code}: ${errors}`)));
    child.once("error", reject);
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    reconnect: { enabled: false },
  });
  onTestFinished(() => client.close());
  await client.connect();
  return { child, client };
}

test("a crash after completed restoration serves the blocked generation without replaying older work", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-blocked-completed-recovery-"));
  const first = await launch(home);
  const agent = await first.client.createAgent({ provider: "codex", cwd: home });
  await first.client.sendAgentMessage(agent.id, "finish", { messageId: "checkpoint-message" });
  await first.client.waitForFinish(agent.id, 5000);
  const checkpoint = await first.client.prepareRestart();
  const generationDir = join(home, "restart-checkpoints", checkpoint.generationId!);
  const firstExit = once(first.child, "exit");
  await first.client.restartServer();
  await firstExit;
  await first.client.close();

  const second = await launch(home);
  expect(second.client.getLastServerInfoMessage()?.restartRecoveryState).toBe("running");
  await second.client.sendAgentMessage(agent.id, "finish", { messageId: "newer-work" });
  await second.client.waitForFinish(agent.id, 5000);
  const scheduledAgent = await second.client.createAgent({ provider: "codex", cwd: home });
  const created = await second.client.scheduleCreate({
    prompt: "work admitted after checkpoint completion",
    target: { type: "agent", agentId: scheduledAgent.id },
    cadence: { type: "every", everyMs: 86_400_000 },
    runOnCreate: false,
  });
  if (!created.schedule) throw new Error(created.error ?? "Schedule was not created");
  const scheduleId = created.schedule.id;
  const pendingSchedule = second.client.scheduleRunOnce({ id: scheduleId }).catch(() => undefined);
  await expect
    .poll(
      async () =>
        (await second.client.scheduleInspect({ id: scheduleId })).schedule?.runs[0]?.status,
    )
    .toBe("running");
  await expect
    .poll(
      async () =>
        (await readFile(join(home, "provider-dispatches.jsonl"), "utf8")).trim().split("\n").length,
    )
    .toBe(3);
  const scheduleBefore = (await second.client.scheduleInspect({ id: scheduleId })).schedule;
  const dispatchesBefore = await readFile(join(home, "provider-dispatches.jsonl"), "utf8");
  const preservedNames = ["manifest.json", "snapshot.json", "claimed.json", "restored.json"];
  const filesBefore = await Promise.all(
    preservedNames.map((name) => readFile(join(generationDir, name), "utf8")),
  );
  const readyBefore = await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8");
  const secondExit = once(second.child, "exit");
  second.child.kill("SIGKILL");
  await secondExit;
  await second.client.close();
  await pendingSchedule;

  const blocked = await launch(home);
  expect(blocked.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "paused",
    restartRecoveryGeneration: checkpoint.generationId,
    restartRecoveryError: expect.stringContaining("later work"),
  });
  await expect(blocked.client.createAgent({ provider: "codex", cwd: home })).rejects.toThrow();
  await expect(
    blocked.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    }),
  ).rejects.toThrow();
  await expect(blocked.client.prepareRestart()).rejects.toThrow("later work");
  expect(blocked.child.exitCode).toBeNull();
  expect(await readFile(join(home, "provider-dispatches.jsonl"), "utf8")).toBe(dispatchesBefore);
  expect((await blocked.client.scheduleInspect({ id: scheduleId })).schedule).toEqual(
    scheduleBefore,
  );
  expect(
    await Promise.all(preservedNames.map((name) => readFile(join(generationDir, name), "utf8"))),
  ).toEqual(filesBefore);
  expect(await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8")).toBe(readyBefore);
}, 30_000);

test("a corrupt ready pointer leaves a reachable paused daemon and preserves the evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-blocked-corrupt-recovery-"));
  await mkdir(join(home, "restart-checkpoints"));
  const pointer = join(home, "restart-checkpoints", "ready.json");
  await writeFile(pointer, "{incomplete ready pointer");
  const blocked = await launch(home);
  expect(blocked.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "paused",
    restartRecoveryError: expect.stringContaining("ready.json"),
  });
  await expect(blocked.client.createAgent({ provider: "codex", cwd: home })).rejects.toThrow();
  await expect(blocked.client.restartServer()).rejects.toThrow("ready.json");
  expect(blocked.child.exitCode).toBeNull();
  expect(await readFile(pointer, "utf8")).toBe("{incomplete ready pointer");
}, 15_000);
