import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
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

async function dispatches(home: string): Promise<Array<{ resumed: boolean }>> {
  return (await readFile(join(home, "provider-dispatches.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
}

async function readyGeneration(home: string): Promise<string | null> {
  try {
    const ready = JSON.parse(
      await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8"),
    );
    return typeof ready.generationId === "string" ? ready.generationId : null;
  } catch {
    return null;
  }
}

async function terminate(child: ChildProcess): Promise<number | null> {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exited;
  return code as number | null;
}

test("a SIGTERM stop of a running daemon commits a checkpoint that the next start restores", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-sigterm-checkpoint-"));
  const first = await launch(home);
  const agent = await first.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await first.client.sendAgentMessage(agent.id, "survive the stop", { messageId: "sigterm-1" });
  expect(await readyGeneration(home)).toBeNull();

  expect(await terminate(first.child)).toBe(0);
  await first.client.close();
  const generationId = await readyGeneration(home);
  expect(generationId).not.toBeNull();
  const committed = await readdir(join(home, "restart-checkpoints", generationId!));
  expect(committed).toEqual(expect.arrayContaining(["manifest.json", "snapshot.json"]));
  expect(committed).not.toContain("claimed.json");

  const next = await launch(home, first.port);
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
  expect(timeline.entries.filter((row) => row.item.type === "user_message")).toHaveLength(1);
  expect(await readdir(join(home, "restart-checkpoints", generationId!))).toEqual(
    expect.arrayContaining(["claimed.json", "restored.json"]),
  );
}, 30_000);

test("a SIGTERM stop of a blocked daemon leaves the consumed generation untouched", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-sigterm-blocked-"));
  const first = await launch(home);
  const agent = await first.client.createAgent({ provider: "codex", cwd: home });
  await first.client.sendAgentMessage(agent.id, "finish", { messageId: "before-checkpoint" });
  await first.client.waitForFinish(agent.id, 5000);
  const checkpoint = await first.client.prepareRestart();
  const firstExit = once(first.child, "exit");
  await first.client.restartServer();
  await firstExit;
  await first.client.close();

  const second = await launch(home, first.port);
  expect(second.client.getLastServerInfoMessage()?.restartRecoveryState).toBe("running");
  await second.client.sendAgentMessage(agent.id, "finish", { messageId: "newer-work" });
  await second.client.waitForFinish(agent.id, 5000);
  const secondExit = once(second.child, "exit");
  second.child.kill("SIGKILL");
  await secondExit;
  await second.client.close();

  const blocked = await launch(home, first.port);
  expect(blocked.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "paused",
    restartRecoveryGeneration: checkpoint.generationId,
  });
  const generationsBefore = await readdir(join(home, "restart-checkpoints"));
  const readyBefore = await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8");

  expect(await terminate(blocked.child)).toBe(0);
  await blocked.client.close();
  expect(await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8")).toBe(readyBefore);
  expect(await readdir(join(home, "restart-checkpoints"))).toEqual(generationsBefore);

  const again = await launch(home, first.port);
  expect(again.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "paused",
    restartRecoveryGeneration: checkpoint.generationId,
  });
}, 30_000);
