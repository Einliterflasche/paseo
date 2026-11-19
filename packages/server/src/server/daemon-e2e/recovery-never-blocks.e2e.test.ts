import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  harnessLog,
  launchCheckpointDaemon,
  restartCheckpointDaemon,
} from "./test-utils/checkpoint-daemon.js";

async function failedRestartSteps(home: string): Promise<unknown[]> {
  return (await harnessLog(home))
    .filter((line) => line.msg === "Restart step failed; continuing without it")
    .map((line) => line.step);
}

test("a boot after a crash that followed restoration ignores the used generation and replays nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-used-generation-recovery-"));
  const first = await launchCheckpointDaemon(home);
  const agent = await first.client.createAgent({ provider: "codex", cwd: home });
  await first.client.sendAgentMessage(agent.id, "finish", { messageId: "checkpoint-message" });
  await first.client.waitForFinish(agent.id, 5000);
  const checkpoint = await restartCheckpointDaemon(first);
  const generationDir = join(home, "restart-checkpoints", checkpoint.generationId!);

  const second = await launchCheckpointDaemon(home, { port: first.port });
  expect(second.client.getLastServerInfoMessage()?.restartRecoveryState).toBe("running");
  await second.client.sendAgentMessage(agent.id, "finish", { messageId: "newer-work" });
  await second.client.waitForFinish(agent.id, 5000);
  const scheduledAgent = await second.client.createAgent({ provider: "codex", cwd: home });
  const created = await second.client.scheduleCreate({
    prompt: "work admitted after checkpoint completion",
    target: { type: "agent", agentId: scheduledAgent.id },
    cadence: { type: "cron", expression: "0 0 1 1 *" },
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
  const dispatchesBefore = await readFile(join(home, "provider-dispatches.jsonl"), "utf8");
  const preservedNames = ["manifest.json", "snapshot.json", "claimed.json", "restored.json"];
  const filesBefore = await Promise.all(
    preservedNames.map((name) => readFile(join(generationDir, name), "utf8")),
  );
  const readyBefore = await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8");
  second.child.kill("SIGKILL");
  await second.exited;
  await second.client.close();
  await pendingSchedule;

  const afterCrash = await launchCheckpointDaemon(home, { port: first.port });
  const info = afterCrash.client.getLastServerInfoMessage();
  expect(info?.restartRecoveryState).toBe("running");
  expect(info?.restartRecoveryGeneration).toBeUndefined();
  expect(await failedRestartSteps(home)).toEqual(["load"]);
  await expect(
    afterCrash.client.createAgent({ provider: "codex", cwd: home }),
  ).resolves.toHaveProperty("id");
  expect((await afterCrash.client.scheduleInspect({ id: scheduleId })).schedule?.runs).toHaveLength(
    1,
  );
  expect(await readFile(join(home, "provider-dispatches.jsonl"), "utf8")).toBe(dispatchesBefore);
  expect(
    await Promise.all(preservedNames.map((name) => readFile(join(generationDir, name), "utf8"))),
  ).toEqual(filesBefore);
  expect(await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8")).toBe(readyBefore);
}, 30_000);

test("a corrupt ready pointer still boots a running daemon and keeps the evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-corrupt-pointer-recovery-"));
  await mkdir(join(home, "restart-checkpoints"));
  const pointer = join(home, "restart-checkpoints", "ready.json");
  await writeFile(pointer, "{incomplete ready pointer");
  const daemon = await launchCheckpointDaemon(home);
  const info = daemon.client.getLastServerInfoMessage();
  expect(info?.restartRecoveryState).toBe("running");
  expect(info?.restartRecoveryGeneration).toBeUndefined();
  expect(await failedRestartSteps(home)).toEqual(["load"]);
  const agent = await daemon.client.createAgent({ provider: "codex", cwd: home });
  await daemon.client.sendAgentMessage(agent.id, "finish", { messageId: "after-corrupt-pointer" });
  await daemon.client.waitForFinish(agent.id, 5000);
  expect(daemon.child.exitCode).toBeNull();
  expect(await readFile(pointer, "utf8")).toBe("{incomplete ready pointer");
}, 15_000);
