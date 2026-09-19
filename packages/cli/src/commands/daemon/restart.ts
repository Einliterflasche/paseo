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
    .option("--retry-recovery", "Retry retained recovery in the current daemon")
    .option(
      "--acknowledge-crash <generation>",
      "Reconcile the exact consumed generation without replay",
    )
    .option(
      "--orphan-execution-reconciled",
      "Attest orphan provider execution was inspected and stopped",
    )
    .action(
      withOutput<{ action: string; generationId: string | undefined }, []>((options, command) =>
        runRestartCommand(options, command),
      ),
    );
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;
export type RestartDaemonClient = Pick<
  ConnectedDaemonClient,
  | "getLastServerInfoMessage"
  | "getDaemonStatus"
  | "restartServer"
  | "retryRecovery"
  | "acknowledgeCrash"
  | "observeEvents"
  | "close"
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

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
  deps: RestartCommandDependencies = defaultDependencies,
) {
  const operation = recoveryOperation(options);
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
  const observation = client.observeEvents(["status.server_info"]);
  try {
    await observation.ready;
    if (operation !== "restart") {
      await checkSupervisor();
      return await recoverInCurrentDaemon(client, operation, options);
    }
    workerPid = (await client.getDaemonStatus({ timeout: remaining() })).pid;
    await checkSupervisor();
    const request = await requestControlledRestart(client, options.reason, remaining());
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

function recoveryOperation(options: CommandOptions): "restart" | "retry" | "crash" {
  const retry = options.retryRecovery === true;
  const crash = typeof options.acknowledgeCrash === "string" && options.acknowledgeCrash.length > 0;
  const attested = options.orphanExecutionReconciled === true;
  if (options.force === true || (retry && crash) || crash !== attested) {
    throw {
      code: "INVALID_OPTIONS",
      message:
        "Recovery retry and crash acknowledgment are separate operations; crash acknowledgment requires reconciliation. Forced replacement is unsupported.",
    };
  }
  if (crash) return "crash";
  return retry ? "retry" : "restart";
}

async function recoverInCurrentDaemon(
  client: RestartDaemonClient,
  operation: "retry" | "crash",
  options: CommandOptions,
) {
  const features = client.getLastServerInfoMessage()?.features;
  const supported =
    operation === "retry" ? features?.restartRecoveryRetry : features?.restartCrashAcknowledgment;
  if (!supported)
    throw {
      code: "RECOVERY_UNSUPPORTED",
      message: "The selected daemon does not support this recovery operation.",
    };
  const result =
    operation === "retry"
      ? await client.retryRecovery()
      : await client.acknowledgeCrash(String(options.acknowledgeCrash), true);
  const info = client.getLastServerInfoMessage();
  assertRecoveryHealthy(info);
  if (!isRestoredGeneration(info, result.generationId)) {
    throw {
      code: "RECOVERY_NOT_CONFIRMED",
      message: "The daemon did not report the recovered generation running.",
    };
  }
  return {
    type: "single" as const,
    data: {
      action: operation === "retry" ? "recovery_retried" : "crash_acknowledged",
      generationId: result.generationId,
    },
    schema: { idField: "action" as const, columns: [] },
  };
}
