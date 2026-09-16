import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { tryConnectToDaemon } from "../../utils/client.js";
import {
  resolveLocalDaemonState,
  DEFAULT_STOP_TIMEOUT_MS,
  type LocalDaemonState,
} from "./local-daemon.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface DeployResult {
  action: "deployed";
  home: string;
  generationId: string;
  message: string;
}

const deployResultSchema: OutputSchema<DeployResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "HOME", field: "home" },
    { header: "GENERATION", field: "generationId" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type DeployCommandResult = SingleResult<DeployResult>;

/** Narrow client seam for requesting checkpoint preparation, not process replacement. */
export interface DeployPrepareClient {
  getLastServerInfoMessage(): { features?: { restartRecovery?: boolean } } | null;
  prepareRestart(reason?: string): Promise<{ generationId?: string }>;
  close(): Promise<void>;
}

/** Narrow client seam for polling whether the replacement daemon is running a generation. */
export interface DeployReadinessClient {
  getLastServerInfoMessage(): {
    restartRecoveryState?: string;
    restartRecoveryGeneration?: string;
    restartRecoveryError?: string;
  } | null;
  close(): Promise<void>;
}

export interface DeployActivationResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface DeployLock {
  release(): Promise<void>;
}

export interface DeployCommandDependencies {
  resolveState(home?: string): LocalDaemonState;
  /** Serializes concurrent deploys; rejects immediately if one is already in progress. */
  acquireLock(home: string): Promise<DeployLock>;
  connectPrepare(target: string, timeoutMs: number): Promise<DeployPrepareClient | null>;
  connectReadiness(target: string, timeoutMs: number): Promise<DeployReadinessClient | null>;
  /** Runs the caller-supplied activation argv directly, no shell. */
  spawnActivation(argv: readonly string[]): Promise<DeployActivationResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const LOCK_FILENAME = "deploy.lock";
const READINESS_POLL_INTERVAL_MS = 2000;

async function defaultAcquireLock(home: string): Promise<DeployLock> {
  await fs.mkdir(home, { recursive: true });
  const lockPath = path.join(home, LOCK_FILENAME);
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const lockError: CommandError = {
        code: "DEPLOY_LOCKED",
        message: `Another deploy is already in progress (lock file at ${lockPath}).`,
        details:
          "Wait for it to finish and retry. If a prior attempt crashed without releasing the lock, remove that file after confirming no deploy is running.",
      };
      throw lockError;
    }
    throw error;
  }
  return {
    release: async () => {
      await fs.rm(lockPath, { force: true });
    },
  };
}

function defaultSpawnActivation(argv: readonly string[]): Promise<DeployActivationResult> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const defaultDeployCommandDependencies: DeployCommandDependencies = {
  resolveState: (home) => resolveLocalDaemonState({ home }),
  acquireLock: defaultAcquireLock,
  connectPrepare: (target, timeoutMs) => tryConnectToDaemon({ host: target, timeout: timeoutMs }),
  connectReadiness: (target, timeoutMs) => tryConnectToDaemon({ host: target, timeout: timeoutMs }),
  spawnActivation: defaultSpawnActivation,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function parseTimeoutMs(raw: unknown, fallback: number, code: string): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const error: CommandError = {
      code,
      message: `Invalid timeout value: ${raw}`,
      details: "Timeout must be a positive number of seconds",
    };
    throw error;
  }
  return Math.ceil(seconds * 1000);
}

function toCommandError(err: unknown, fallbackCode: string, fallbackPrefix: string): CommandError {
  if (err && typeof err === "object" && "code" in err) {
    return err as CommandError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: fallbackCode, message: `${fallbackPrefix}: ${message}` };
}

/**
 * Requests checkpoint preparation from the running daemon. Never spawns activation on a
 * daemon that lacks restart-recovery support, is unreachable, or fails to return a ready
 * generation — first-time deployment onto a daemon predating checkpoints is a documented
 * bootstrap limitation (see docs/fork-maintenance.md), not something this command guesses past.
 */
async function prepareGeneration(
  state: LocalDaemonState,
  reason: string | undefined,
  timeoutMs: number,
  deps: DeployCommandDependencies,
): Promise<string> {
  const client = await deps.connectPrepare(state.listen, timeoutMs);
  if (!client) {
    const error: CommandError = {
      code: "DAEMON_UNREACHABLE",
      message: `Cannot reach the daemon at ${state.listen} to prepare a checkpoint.`,
      details:
        "Deploy requires a reachable, checkpoint-capable daemon to prepare against. A daemon predating restart-recovery cannot be deployed this way; see docs/fork-maintenance.md.",
    };
    throw error;
  }

  try {
    const serverInfo = client.getLastServerInfoMessage();
    if (serverInfo?.features?.restartRecovery !== true) {
      const error: CommandError = {
        code: "DEPLOY_UNSUPPORTED",
        message: "The running daemon does not support controlled restart checkpoints.",
        details:
          "First deployment onto a daemon that predates checkpoints needs a manual idle handover, not a blind switch. See docs/fork-maintenance.md.",
      };
      throw error;
    }

    const result = await client.prepareRestart(reason);
    if (!result.generationId) {
      const error: CommandError = {
        code: "DEPLOY_PREPARE_FAILED",
        message: "The daemon did not return a ready checkpoint generation.",
        details: "The daemon's prior state is preserved; the activation command was never run.",
      };
      throw error;
    }
    return result.generationId;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForGenerationRunning(
  state: LocalDaemonState,
  generationId: string,
  waitTimeoutMs: number | undefined,
  deps: DeployCommandDependencies,
): Promise<void> {
  const deadline = waitTimeoutMs === undefined ? Infinity : deps.now() + waitTimeoutMs;
  for (;;) {
    const remaining = deadline - deps.now();
    const client = await deps.connectReadiness(
      state.listen,
      Math.max(1, Math.min(DEFAULT_STOP_TIMEOUT_MS, remaining)),
    );
    if (client) {
      const info = client.getLastServerInfoMessage();
      await client.close().catch(() => undefined);
      if (info?.restartRecoveryState === "paused" && info.restartRecoveryError) {
        throw {
          code: "DEPLOY_RECOVERY_FAILED",
          message: info.restartRecoveryError,
          details:
            "The checkpoint is retained. Inspect the daemon logs before retrying activation.",
        } satisfies CommandError;
      }
      if (
        info?.restartRecoveryState === "running" &&
        info.restartRecoveryGeneration === generationId
      ) {
        return;
      }
    }
    if (deps.now() >= deadline) {
      const error: CommandError = {
        code: "DEPLOY_READINESS_TIMEOUT",
        message: `Activation ran, but no daemon reported generation '${generationId}' running within the wait timeout.`,
        details:
          "Nothing was force-killed or rolled back. Check the daemon/system logs and retry once its state is understood.",
      };
      throw error;
    }
    await deps.sleep(READINESS_POLL_INTERVAL_MS);
  }
}

export async function runDeployCommand(
  argv: readonly string[],
  options: CommandOptions,
  _command: Command,
  deps: DeployCommandDependencies = defaultDeployCommandDependencies,
): Promise<DeployCommandResult> {
  if (argv.length === 0) {
    const error: CommandError = {
      code: "DEPLOY_ARGV_REQUIRED",
      message: "No activation command given.",
      details: "Usage: paseo daemon deploy -- <activation command...>",
    };
    throw error;
  }

  const timeoutMs = parseTimeoutMs(options.timeout, DEFAULT_STOP_TIMEOUT_MS, "INVALID_TIMEOUT");
  const waitTimeoutMs =
    options.waitTimeout === undefined
      ? undefined
      : parseTimeoutMs(options.waitTimeout, Infinity, "INVALID_WAIT_TIMEOUT");
  const reason =
    typeof options.reason === "string" && options.reason.trim() ? options.reason : undefined;
  const home = typeof options.home === "string" ? options.home : undefined;

  const state = deps.resolveState(home);
  const lock = await deps.acquireLock(state.home);

  try {
    const generationId = await prepareGeneration(state, reason, timeoutMs, deps);

    const activation = await deps.spawnActivation(argv);
    if (activation.code !== 0 || activation.signal) {
      const error: CommandError = {
        code: "DEPLOY_ACTIVATION_FAILED",
        message: `Activation command exited ${
          activation.signal ? `via signal ${activation.signal}` : `with code ${activation.code}`
        }.`,
        details: `Checkpoint generation '${generationId}' is retained. Activation may have partly completed; inspect the daemon and activation logs before retrying. The deploy command does not force-kill or roll back anything.`,
      };
      throw error;
    }

    await waitForGenerationRunning(state, generationId, waitTimeoutMs, deps);

    return {
      type: "single",
      data: {
        action: "deployed",
        home: state.home,
        generationId,
        message: `Deployed and confirmed generation '${generationId}' running.`,
      },
      schema: deployResultSchema,
    };
  } catch (err) {
    throw toCommandError(err, "DEPLOY_FAILED", "Deploy failed");
  } finally {
    await lock.release();
  }
}
