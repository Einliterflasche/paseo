import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";

async function launch(
  home: string,
  port?: number,
): Promise<{ child: ChildProcess; client: DaemonClient; port: number }> {
  const child = fork(
    fileURLToPath(new URL("../test-utils/checkpoint-daemon-process.ts", import.meta.url)),
    [home, String(port ?? 0)],
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
  onTestFinished(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const ready = await new Promise<{ port: number }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as { port: number }));
    child.once("exit", (code) => reject(new Error(`Daemon exited ${code}: ${errors}`)));
    child.once("error", reject);
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${ready.port}/ws`,
    reconnect: { enabled: false },
  });
  onTestFinished(() => client.close());
  await client.connect();
  return { child, client, port: ready.port };
}

async function dispatches(
  home: string,
): Promise<Array<{ sessionId: string; text: string; resumed: boolean; messageId?: string }>> {
  return (await readFile(join(home, "provider-dispatches.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
}

test("two real process replacements preserve the prefix and never duplicate or resurrect requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-controlled-process-"));
  const old = await launch(home);
  const active = await old.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  const stopped = await old.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await old.client.sendAgentMessage(active.id, "same text", { messageId: "active-1" });
  await old.client.sendAgentMessage(stopped.id, "same text", { messageId: "stopped-1" });
  await old.client.cancelAgent(stopped.id);
  const nativeSessionId = (await dispatches(home))[0]!.sessionId;
  const checkpoint = await old.client.prepareRestart();
  expect(checkpoint.generationId).not.toBeUndefined();
  const saved = JSON.parse(
    await readFile(
      join(home, "restart-checkpoints", checkpoint.generationId!, "snapshot.json"),
      "utf8",
    ),
  );
  const prefix = saved.agents.timelines[active.id];
  expect(prefix.rows.map((row: { item: { text?: string } }) => row.item.text)).toContain(
    "late-close-output",
  );
  const exited = once(old.child, "exit");
  // Exercise the public restart operation too; it reuses the prepared generation.
  const restart = await old.client.restartServer();
  expect(restart.generationId).toBe(checkpoint.generationId);
  await exited;
  await old.client.close();

  const next = await launch(home, old.port);
  expect(next.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBe(
    checkpoint.generationId,
  );
  await next.client.waitForFinish(active.id, 5000);
  // Retrying an acknowledged ID must return its old receipt without provider dispatch.
  await next.client.sendAgentMessage(active.id, "same text", { messageId: "active-1" });
  const calls = await dispatches(home);
  expect(calls).toHaveLength(3);
  expect(calls.filter((call) => call.resumed)).toHaveLength(1);
  expect(calls[2]!.sessionId).toBe(nativeSessionId);
  expect(calls.filter((call) => call.messageId === "stopped-1")).toHaveLength(1);
  const second = await next.client.prepareRestart();
  const secondExit = once(next.child, "exit");
  await next.client.restartServer();
  await secondExit;
  await next.client.close();

  const third = await launch(home, old.port);
  expect(third.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBe(
    second.generationId,
  );
  const timeline = await third.client.fetchAgentTimeline(active.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(timeline.epoch).toBe(prefix.epoch);
  expect(
    timeline.entries.slice(0, prefix.rows.length).map((row) => ({
      seq: row.seqStart,
      item: row.item,
      timestamp: row.timestamp,
      turnId: row.turnId,
    })),
  ).toEqual(
    prefix.rows.map((row: { seq: number; item: unknown; timestamp: string; turnId?: string }) => ({
      seq: row.seq,
      item: row.item,
      timestamp: row.timestamp,
      turnId: row.turnId,
    })),
  );
  expect(timeline.entries.every((row) => row.seqStart === row.seqEnd)).toBe(true);
  expect(timeline.entries.filter((row) => row.item.type === "user_message")).toHaveLength(1);
  expect(JSON.stringify(timeline.entries)).not.toContain("<paseo-system>");
  expect(await dispatches(home)).toEqual(calls);
}, 30_000);

test("failed checkpoint keeps the real daemon alive and never produces a ready generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-controlled-failure-"));
  const current = await launch(home);
  const agent = await current.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await current.client.sendAgentMessage(agent.id, "preserve me", { messageId: "original" });
  await mkdir(join(home, "restart-checkpoints", "ready.json"), { recursive: true });
  await expect(current.client.restartServer()).rejects.toThrow();
  expect(current.child.exitCode).toBeNull();
  expect(current.client.getLastServerInfoMessage()?.restartRecoveryState).toBe("paused");
  const timeline = await current.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(timeline.entries.filter((row) => row.item.type === "user_message")).toHaveLength(1);
  expect(
    timeline.entries.map((row) => (row.item.type === "assistant_message" ? row.item.text : "")),
  ).toContain("late-close-output");
  expect(await dispatches(home)).toHaveLength(1);
}, 30_000);
