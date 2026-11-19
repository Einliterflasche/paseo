import { type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  dispatches,
  harnessLog,
  launchCheckpointDaemon,
  readyGeneration,
  restartCheckpointDaemon,
  type CheckpointDaemon,
} from "./test-utils/checkpoint-daemon.js";

async function terminate(daemon: { child: ChildProcess; exited: Promise<number | null> }) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

async function crash(daemon: CheckpointDaemon): Promise<void> {
  daemon.child.kill("SIGKILL");
  await daemon.exited;
  await daemon.client.close();
}

test("a SIGTERM stop of a running daemon commits a checkpoint that the next start restores", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-sigterm-checkpoint-"));
  const first = await launchCheckpointDaemon(home);
  const agent = await first.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await first.client.sendAgentMessage(agent.id, "survive the stop", { messageId: "sigterm-1" });
  expect(await readyGeneration(home)).toBeNull();

  expect(await terminate(first)).toBe(0);
  await first.client.close();
  const generationId = await readyGeneration(home);
  expect(generationId).not.toBeNull();
  const committed = await readdir(join(home, "restart-checkpoints", generationId!));
  expect(committed).toEqual(expect.arrayContaining(["manifest.json", "snapshot.json"]));
  expect(committed).not.toContain("claimed.json");

  const next = await launchCheckpointDaemon(home, { port: first.port });
  expect(next.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: generationId,
  });
  await next.client.waitForFinish(agent.id, 5000);
  expect((await dispatches(home)).filter((call) => call.resumed)).toHaveLength(1);
  const timeline = await next.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(
    timeline.entries.flatMap((row) =>
      row.item.type === "user_message"
        ? [{ sender: row.item.sender, messageId: row.item.clientMessageId }]
        : [],
    ),
  ).toEqual([
    { sender: { kind: "human" }, messageId: "sigterm-1" },
    { sender: { kind: "system", source: "Restart recovery" }, messageId: expect.any(String) },
  ]);
  expect(await readdir(join(home, "restart-checkpoints", generationId!))).toEqual(
    expect.arrayContaining(["claimed.json", "restored.json"]),
  );
}, 30_000);

test("a daemon that booted after a crash runs, and SIGTERM saves a new checkpoint and exits", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-sigterm-after-crash-"));
  const first = await launchCheckpointDaemon(home);
  const agent = await first.client.createAgent({ provider: "codex", cwd: home });
  await first.client.sendAgentMessage(agent.id, "finish", { messageId: "before-checkpoint" });
  await first.client.waitForFinish(agent.id, 5000);
  const checkpoint = await restartCheckpointDaemon(first);

  const second = await launchCheckpointDaemon(home, { port: first.port });
  expect(second.client.getLastServerInfoMessage()?.restartRecoveryState).toBe("running");
  await second.client.sendAgentMessage(agent.id, "finish", { messageId: "newer-work" });
  await second.client.waitForFinish(agent.id, 5000);
  await crash(second);

  const afterCrash = await launchCheckpointDaemon(home, { port: first.port });
  const info = afterCrash.client.getLastServerInfoMessage();
  expect(info?.restartRecoveryState).toBe("running");
  expect(info?.restartRecoveryGeneration).toBeUndefined();
  await expect(
    afterCrash.client.createAgent({ provider: "codex", cwd: home }),
  ).resolves.toHaveProperty("id");

  expect(await terminate(afterCrash)).toBe(0);
  const generationId = await readyGeneration(home);
  expect(generationId).not.toBeNull();
  expect(generationId).not.toBe(checkpoint.generationId);
  expect(await readdir(join(home, "restart-checkpoints", generationId!))).not.toContain(
    "claimed.json",
  );
}, 30_000);

test("a checkpoint commit failure still lets SIGTERM stop the daemon in bounded time", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-sigterm-commit-failure-"));
  const first = await launchCheckpointDaemon(home);
  await mkdir(join(home, "restart-checkpoints", "ready.json"), { recursive: true });
  const startedAt = Date.now();
  expect(await terminate(first)).toBe(0);
  expect(Date.now() - startedAt).toBeLessThan(15_000);
  expect(await readyGeneration(home)).toBeNull();
  expect(
    (await harnessLog(home)).find(
      (line) => line.msg === "Restart step failed; continuing without it",
    ),
  ).toMatchObject({ step: "checkpoint" });
}, 30_000);
