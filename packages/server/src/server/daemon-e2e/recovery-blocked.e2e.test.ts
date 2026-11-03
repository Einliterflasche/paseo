import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
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
  const blockedPid = blocked.child.pid;
  await expect(blocked.client.acknowledgeCrash("wrong-generation", true)).rejects.toThrow();
  const acknowledged = await blocked.client.acknowledgeCrash(checkpoint.generationId!, true);
  expect(acknowledged.generationId).not.toBe(checkpoint.generationId);
  expect(blocked.child.pid).toBe(blockedPid);
  expect(blocked.child.exitCode).toBeNull();
  expect(await readFile(join(home, "provider-dispatches.jsonl"), "utf8")).toBe(dispatchesBefore);
  expect((await blocked.client.scheduleInspect({ id: scheduleId })).schedule?.runs[0]?.status).toBe(
    "failed",
  );
  expect(
    await Promise.all(preservedNames.map((name) => readFile(join(generationDir, name), "utf8"))),
  ).toEqual(filesBefore);
  const auditNames = (await readdir(generationDir)).filter((name) =>
    name.startsWith("operator-crash-acknowledgment-"),
  );
  expect(auditNames).toHaveLength(1);
  expect(JSON.parse(await readFile(join(generationDir, auditNames[0]!), "utf8"))).toMatchObject({
    generationId: checkpoint.generationId,
    daemonPid: blockedPid,
    requester: {
      principalId: "owner",
      clientId: expect.any(String),
      sessionId: expect.any(String),
    },
  });
  await expect(
    blocked.client.createAgent({ provider: "codex", cwd: home }),
  ).resolves.toHaveProperty("id");
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

test("Restart anyway replaces a production worker with corrupt recovery and reconnects the same client", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-anyway-process-"));
  await mkdir(join(home, "restart-checkpoints"));
  const pointer = join(home, "restart-checkpoints", "ready.json");
  const corrupt = "{incomplete ready pointer";
  await writeFile(pointer, corrupt);
  const runner = join(home, "supervisor.mjs");
  const supervisorUrl = new URL("../../../scripts/supervisor.ts", import.meta.url).href;
  const workerPath = fileURLToPath(new URL("../daemon-worker.ts", import.meta.url));
  await writeFile(
    runner,
    `
    import { runSupervisor } from ${JSON.stringify(supervisorUrl)};
    const workerEnv = { ...process.env };
    runSupervisor({
      name: "EmergencyRestartTest", startupMessage: "starting",
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
      workerArgs: ["--no-mcp", "--no-relay", "--no-web-ui"], workerEnv,
      onWorkerReady: message => {
        workerEnv.PASEO_LISTEN = message.listen;
        process.send(message);
      },
    });
  `,
  );
  const supervisor = fork(runner, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
      ),
      HOME: home,
      USERPROFILE: home,
      PASEO_HOME: home,
      PASEO_LISTEN: "127.0.0.1:0",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      PASEO_DICTATION_ENABLED: "0",
      PASEO_VOICE_MODE_ENABLED: "0",
    },
  });
  let logs = "";
  supervisor.stdout?.on("data", (chunk) => {
    logs += String(chunk);
  });
  supervisor.stderr?.on("data", (chunk) => {
    logs += String(chunk);
  });
  const workers: number[] = [];
  onTestFinished(async () => {
    for (const pid of workers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      const exited = once(supervisor, "exit");
      supervisor.kill("SIGKILL");
      await exited;
    }
  });
  const ready = await new Promise<{ listen: string }>((resolve, reject) => {
    supervisor.once("message", (message) => resolve(message as { listen: string }));
    supervisor.once("exit", (code) => reject(new Error(`Supervisor exited ${code}: ${logs}`)));
    supervisor.once("error", reject);
  });
  const client = new DaemonClient({ url: `ws://${ready.listen}/ws` });
  onTestFinished(() => client.close());
  await client.connect();
  await client.observeEvents(["status.server_info"]).ready;
  const oldPid = (await client.getDaemonStatus()).pid;
  workers.push(oldPid);
  const error = client.getLastServerInfoMessage()!.restartRecoveryError!;
  expect(client.getLastServerInfoMessage()).toMatchObject({
    features: { restartAnyway: true },
    restartRecoveryState: "paused",
  });
  await expect(client.restartAnyway("outdated error", null)).rejects.toThrow("Recovery changed");
  expect((await client.getDaemonStatus()).pid).toBe(oldPid);
  const request = await client.restartAnyway(error, null);
  await expect
    .poll(() => client.getLastServerInfoMessage()?.restartAnywayId, { timeout: 20_000 })
    .toBe(request.restartId);
  expect(client.getLastServerInfoMessage()?.restartRecoveryState, logs).toBe("running");
  const newPid = (await client.getDaemonStatus()).pid;
  workers.push(newPid);
  expect(newPid).not.toBe(oldPid);
  expect(await readFile(pointer, "utf8")).toBe(corrupt);
  await expect(client.restartAnyway(error, null)).rejects.toThrow("Recovery changed");
  // A later orderly restart uses a new checkpoint and consumes no emergency bypass.
  const checkpoint = await client.prepareRestart();
  await client.restartServer();
  await expect
    .poll(
      () => ({
        state: client.getLastServerInfoMessage()?.restartRecoveryState,
        generation: client.getLastServerInfoMessage()?.restartRecoveryGeneration,
        emergency: client.getLastServerInfoMessage()?.restartAnywayId,
      }),
      { timeout: 20_000 },
    )
    .toEqual({ state: "running", generation: checkpoint.generationId, emergency: undefined });
  workers.push((await client.getDaemonStatus()).pid);
  await client.shutdownServer();
}, 60_000);
