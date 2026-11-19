import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { DaemonClient } from "../../test-utils/daemon-client.js";

export interface CheckpointDaemonOptions {
  port?: number;
  behavior?: string;
  /** Extra harness environment, see `test-utils/checkpoint-daemon-process.ts`. */
  env?: Record<string, string>;
}

export interface CheckpointDaemonProcess {
  child: ChildProcess;
  port: number;
  /** Settles with the exit code; created at spawn so no exit is missed. */
  exited: Promise<number | null>;
}

export interface CheckpointDaemon extends CheckpointDaemonProcess {
  client: DaemonClient;
}

export interface ProviderDispatch {
  sessionId: string;
  text: string;
  resumed: boolean;
  messageId?: string;
}

const PROCESS_ENTRY = fileURLToPath(
  new URL("../../test-utils/checkpoint-daemon-process.ts", import.meta.url),
);

/** The test runner may live inside a production daemon; its PASEO_* settings must never leak. */
function isolatedEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    PASEO_SUPERVISED: "0",
    ...extra,
  };
}

export async function spawnCheckpointDaemon(
  home: string,
  options: CheckpointDaemonOptions = {},
): Promise<CheckpointDaemonProcess> {
  const child = fork(
    PROCESS_ENTRY,
    [home, String(options.port ?? 0), ...(options.behavior ? [options.behavior] : [])],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: isolatedEnv(options.env),
    },
  );
  const exited = once(child, "exit").then(([code]) => code as number | null);
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += String(data);
  });
  child.stdout?.resume();
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const ready = await new Promise<{ port: number }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as { port: number }));
    void exited.then((code) => reject(new Error(`Daemon exited ${code}: ${errors}`)));
    child.once("error", reject);
  });
  return { child, port: ready.port, exited };
}

export async function launchCheckpointDaemon(
  home: string,
  options: CheckpointDaemonOptions = {},
): Promise<CheckpointDaemon> {
  const daemon = await spawnCheckpointDaemon(home, options);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    reconnect: { enabled: false },
  });
  onTestFinished(() => client.close());
  await client.connect();
  await client.observeEvents(["status.server_info"]).ready;
  return { ...daemon, client };
}

/** Requests an ordinary restart and waits until the old process has exited. */
export async function restartCheckpointDaemon(
  daemon: CheckpointDaemon,
): Promise<{ generationId?: string; exitCode: number | null }> {
  const { generationId } = await daemon.client.restartServer();
  const exitCode = await daemon.exited;
  await daemon.client.close();
  return { generationId, exitCode };
}

export async function dispatches(home: string): Promise<ProviderDispatch[]> {
  return (await readFile(join(home, "provider-dispatches.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
}

export async function readyGeneration(home: string): Promise<string | null> {
  try {
    const ready = JSON.parse(
      await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8"),
    );
    return typeof ready.generationId === "string" ? ready.generationId : null;
  } catch {
    return null;
  }
}

export interface HarnessLogLine {
  msg: string;
  [field: string]: unknown;
}

export async function harnessLog(home: string): Promise<HarnessLogLine[]> {
  return (await readFile(join(home, "harness-daemon.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
