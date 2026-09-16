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
    .action(withOutput(runRestartCommand));
}

export async function runRestartCommand(options: CommandOptions, _command: Command) {
  const target = options.daemonTarget;
  const deadline = Date.now() + parseTimeoutMs(options.timeout);
  const remaining = () => Math.max(1, deadline - Date.now());
  const instance = target.kind === "instance" ? await readDaemonInstance(target.home) : null;
  async function checkSupervisor() {
    if (target.kind !== "instance") return;
    const current = await readDaemonInstance(target.home);
    if (!current || !instance || !isSameDaemonInstance(instance, current))
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor exited or was replaced for ${target.home}.`,
      );
  }
  if (target.kind === "instance" && !instance)
    throw new DaemonInstanceError(
      "DAEMON_NOT_RUNNING",
      `Daemon is not running for ${target.home}.`,
    );
  const client = await connectToDaemon({
    target,
    instance: instance ?? undefined,
    timeout: remaining(),
  });
  let workerPid: number;
  const serverId = client.getLastServerInfoMessage()?.serverId;
  let acknowledged = false;
  let generationId: string | undefined;
  try {
    workerPid = (await client.getDaemonStatus({ timeout: remaining() })).pid;
    await checkSupervisor();
    const request = await requestControlledRestart(client, options.reason, remaining());
    generationId = request.generationId;
    acknowledged = request.acknowledged;
  } finally {
    await client.close();
  }
  let lastError: unknown = "No replacement worker observed";
  while (Date.now() < deadline) {
    try {
      const replacement = await connectToDaemon({
        target,
        instance: instance ?? undefined,
        timeout: Math.min(1_000, remaining()),
      });
      try {
        if (replacement.getLastServerInfoMessage()?.serverId !== serverId)
          throw new Error("Connected peer identity changed");
        const status = await replacement.getDaemonStatus({ timeout: Math.min(1_000, remaining()) });
        const info = replacement.getLastServerInfoMessage();
        assertRecoveryHealthy(info);
        if (status.pid !== workerPid && isRestoredGeneration(info, generationId)) {
          await checkSupervisor();
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
            },
            schema: {
              idField: "action" as const,
              columns: [],
              renderHuman: () =>
                `Restarted worker ${workerPid} → ${status.pid} at ${describeDaemonTarget(target)}. Supervisor launch retained.`,
            },
          };
        }
      } finally {
        await replacement.close();
      }
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string } | null)?.code;
      if (code === "DAEMON_REPLACED" || code === "DAEMON_NOT_RUNNING") break;
      if (!isReconnectFailure(error)) throw error;
    }
    await delay(Math.min(100, remaining()));
  }
  throw {
    code: "RESTART_NOT_CONFIRMED",
    message: `Replacement was not confirmed for ${describeDaemonTarget(target)}. Restart acknowledged: ${acknowledged}. Last observation: ${String(lastError)}`,
  };
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

type RestartDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;
type RestartInfo = ReturnType<RestartDaemonClient["getLastServerInfoMessage"]>;

async function requestControlledRestart(
  client: RestartDaemonClient,
  reason: unknown,
  timeout: number,
): Promise<{ generationId?: string; acknowledged: boolean }> {
  const before = client.getLastServerInfoMessage();
  if (before?.features?.restartRecovery !== true)
    throw {
      code: "RESTART_UNSUPPORTED",
      message: "The selected daemon does not support controlled restart checkpoints.",
    };
  try {
    const result = await client.restartServer(
      typeof reason === "string" ? reason : "cli_restart",
      undefined,
      { timeout },
    );
    if (!result.generationId)
      throw { code: "RESTART_NOT_CONFIRMED", message: "No checkpoint generation returned." };
    return { generationId: result.generationId, acknowledged: true };
  } catch (error) {
    if (!isReconnectFailure(error)) throw error;
    const observed = client.getLastServerInfoMessage()?.restartRecoveryGeneration;
    return {
      generationId: observed !== before.restartRecoveryGeneration ? observed : undefined,
      acknowledged: false,
    };
  }
}

function assertRecoveryHealthy(info: RestartInfo): void {
  if (info?.restartRecoveryState === "paused")
    throw {
      code: "RESTART_RECOVERY_FAILED",
      message: info.restartRecoveryError ?? "Restoration paused; checkpoint retained.",
    };
}

function isRestoredGeneration(info: RestartInfo, generationId: string | undefined): boolean {
  return (
    !!generationId &&
    info?.restartRecoveryState === "running" &&
    info.restartRecoveryGeneration === generationId
  );
}
