import { Command } from "commander";
import {
  readDaemonInstance,
  isSameDaemonInstance,
  DaemonInstanceError,
} from "@getpaseo/server/daemon-control";
import { setTimeout as delay } from "node:timers/promises";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { describeDaemonTarget } from "../../utils/daemon-target.js";
import { parseTimeoutMs, rejectRemovedLaunchFlags } from "./local-daemon.js";

export function daemonRestartCommand(): Command {
  return rejectRemovedLaunchFlags(
    addJsonAndDaemonHostOptions(
      new Command("restart").description(
        "Restart the selected daemon worker, retaining its supervisor launch",
      ),
    ),
  )
    .option("--timeout <seconds>", "Replacement readiness deadline (default: 600)")
    .option("--reason <text>", "Reason recorded in checkpoint")
    .action(
      withOutput<{ action: string; checkpointRestored: boolean }, []>((options, command) =>
        runRestartCommand(options, command),
      ),
    );
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;
export type RestartDaemonClient = Pick<
  ConnectedDaemonClient,
  "getLastServerInfoMessage" | "getDaemonStatus" | "restartServer" | "observeEvents" | "close"
>;
export interface RestartCommandDependencies {
  connect(options: Parameters<typeof connectToDaemon>[0]): Promise<RestartDaemonClient>;
  readInstance: typeof readDaemonInstance;
  now(): number;
  sleep(ms: number): Promise<void>;
}
const defaultDependencies: RestartCommandDependencies = {
  connect: connectToDaemon,
  readInstance: readDaemonInstance,
  now: () => Date.now(),
  sleep: delay,
};

/**
 * Requests a restart and waits for a replacement worker. The checkpoint is best effort, so any
 * daemon qualifies, also one that returns no generation or reports no recovery state. A lost
 * connection during the request means the worker may already be exiting, so the wait continues.
 */
export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
  deps: RestartCommandDependencies = defaultDependencies,
) {
  const target = options.daemonTarget;
  const deadline = deps.now() + parseTimeoutMs(options.timeout);
  const remaining = () => Math.max(1, deadline - deps.now());
  const instance = await readSelectedInstance(target, deps.readInstance);
  async function checkSupervisor() {
    if (target.kind !== "instance") return;
    const current = await deps.readInstance(target.home);
    if (!current || !instance || !isSameDaemonInstance(instance, current))
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor exited or was replaced for ${target.home}.`,
      );
  }
  const client = await deps.connect({
    target,
    instance: instance ?? undefined,
    timeout: remaining(),
  });
  let workerPid: number;
  const serverId = client.getLastServerInfoMessage()?.serverId;
  let acknowledged = false;
  let generationId: string | undefined;
  // Server info updates carry the saved generation when the connection drops before the reply.
  const observation = client.observeEvents(["status.server_info"]);
  try {
    await observation.ready;
    workerPid = (await client.getDaemonStatus({ timeout: remaining() })).pid;
    await checkSupervisor();
    const request = await requestRestart(client, options.reason, remaining());
    generationId = request.generationId;
    acknowledged = request.acknowledged;
  } finally {
    await observation.release().catch(() => undefined);
    await client.close();
  }
  let lastError: unknown = "No replacement worker observed";
  while (deps.now() < deadline) {
    try {
      const replacement = await deps.connect({
        target,
        instance: instance ?? undefined,
        timeout: Math.min(1_000, remaining()),
      });
      try {
        if (replacement.getLastServerInfoMessage()?.serverId !== serverId)
          throw new Error("Connected peer identity changed");
        const status = await replacement.getDaemonStatus({ timeout: Math.min(1_000, remaining()) });
        const info = replacement.getLastServerInfoMessage();
        const replaced = status.pid !== workerPid;
        if (replaced && isRunning(info)) {
          await checkSupervisor();
          const checkpointRestored =
            generationId !== undefined && info?.restartRecoveryGeneration === generationId;
          return {
            type: "single" as const,
            data: {
              action: "restarted",
              target: describeDaemonTarget(target),
              supervisorPid: instance?.pid ?? null,
              previousWorkerPid: workerPid,
              workerPid: status.pid,
              acknowledged,
              generationId,
              checkpointRestored,
            },
            schema: {
              idField: "action" as const,
              columns: [],
              renderHuman: () =>
                `Restarted worker ${workerPid} → ${status.pid} at ${describeDaemonTarget(target)}. Supervisor launch retained. ${
                  checkpointRestored
                    ? `Checkpoint ${generationId} restored.`
                    : "No checkpoint restored; interrupted agents do not resume automatically."
                }`,
            },
          };
        }
        lastError = describeObservedWorker(status.pid, replaced, info);
      } finally {
        await replacement.close();
      }
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string } | null)?.code;
      if (code === "DAEMON_REPLACED" || code === "DAEMON_NOT_RUNNING") break;
      if (!isReconnectFailure(error)) throw error;
    }
    await deps.sleep(Math.min(100, remaining()));
  }
  throw {
    code: "RESTART_NOT_CONFIRMED",
    message: `Replacement was not confirmed for ${describeDaemonTarget(target)}. Restart acknowledged: ${acknowledged}. Last observation: ${String(lastError)}`,
  };
}

async function readSelectedInstance(
  target: CommandOptions["daemonTarget"],
  readInstance: typeof readDaemonInstance,
) {
  if (target.kind !== "instance") return null;
  const instance = await readInstance(target.home);
  if (!instance)
    throw new DaemonInstanceError(
      "DAEMON_NOT_RUNNING",
      `Daemon is not running for ${target.home}.`,
    );
  return instance;
}

function isReconnectFailure(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    [
      "DAEMON_CONNECTION_LOST",
      "DAEMON_REQUEST_TIMEOUT",
      "DAEMON_UNREACHABLE",
      "DAEMON_NOT_READY",
    ].includes(String(error.code)),
  );
}

type RestartInfo = ReturnType<RestartDaemonClient["getLastServerInfoMessage"]>;

async function requestRestart(
  client: RestartDaemonClient,
  reason: unknown,
  timeout: number,
): Promise<{ generationId?: string; acknowledged: boolean }> {
  const before = client.getLastServerInfoMessage()?.restartRecoveryGeneration;
  try {
    const result = await client.restartServer(
      typeof reason === "string" ? reason : "cli_restart",
      undefined,
      { timeout },
    );
    return { generationId: result.generationId, acknowledged: true };
  } catch (error) {
    if (!isReconnectFailure(error)) throw error;
    const observed = client.getLastServerInfoMessage()?.restartRecoveryGeneration;
    return { generationId: observed !== before ? observed : undefined, acknowledged: false };
  }
}

// A daemon without restart recovery reports no state; it is ready once it answers.
function isRunning(info: RestartInfo): boolean {
  const state = info?.restartRecoveryState;
  return state === undefined || state === "running";
}

function describeObservedWorker(pid: number, replaced: boolean, info: RestartInfo): string {
  const state = info?.restartRecoveryState ?? "no recovery state";
  const generation = info?.restartRecoveryGeneration ?? "none";
  return `${replaced ? "Replacement" : "Previous"} worker ${pid} reports ${state} on generation ${generation}`;
}
