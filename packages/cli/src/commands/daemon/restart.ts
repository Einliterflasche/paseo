import type { Command } from "commander";
import { tryConnectToDaemon } from "../../utils/client.js";
import {
  startLocalDaemonDetached,
  stopLocalDaemon,
  resolveLocalDaemonState,
  DEFAULT_STOP_TIMEOUT_MS,
  type DaemonStartOptions,
  type DetachedStartResult,
  type LocalDaemonState,
  type StopLocalDaemonOptions,
  type StopLocalDaemonResult,
} from "./local-daemon.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface RestartResult {
  action: "started" | "restart_requested" | "restarted" | "recovery_retried" | "crash_acknowledged";
  home: string;
  pid: string;
  message: string;
  generationId?: string;
}

const restartResultSchema: OutputSchema<RestartResult> = {
  idField: "action",
  columns: [
    {
      header: "STATUS",
      field: "action",
      color: () => "green",
    },
    { header: "HOME", field: "home" },
    { header: "PID", field: "pid" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type RestartCommandResult = SingleResult<RestartResult>;

/**
 * A restart-capable connection to the running daemon. Narrower than the full
 * `DaemonClient` so tests can supply a stub without a real WebSocket connection.
 */
export interface RestartDaemonClient {
  getLastServerInfoMessage(): { features?: { restartRecovery?: boolean } } | null;
  restartServer(reason?: string): Promise<{ generationId?: string }>;
  retryRecovery(reason?: string): Promise<{ generationId?: string }>;
  acknowledgeCrash(
    generationId: string,
    orphanExecutionReconciled: true,
  ): Promise<{ generationId?: string }>;
  close(): Promise<void>;
}

export interface RestartCommandDependencies {
  resolveState(home?: string): LocalDaemonState;
  /** Returns null when the daemon is unreachable rather than throwing. */
  connect(target: string, timeoutMs: number): Promise<RestartDaemonClient | null>;
  stop(options: StopLocalDaemonOptions): Promise<StopLocalDaemonResult>;
  start(options: DaemonStartOptions): Promise<DetachedStartResult>;
}

const defaultRestartCommandDependencies: RestartCommandDependencies = {
  resolveState: (home) => resolveLocalDaemonState({ home }),
  connect: (target, timeoutMs) => tryConnectToDaemon({ host: target, timeout: timeoutMs }),
  stop: stopLocalDaemon,
  start: startLocalDaemonDetached,
};

function parseTimeoutMs(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_STOP_TIMEOUT_MS;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const error: CommandError = {
      code: "INVALID_TIMEOUT",
      message: `Invalid timeout value: ${raw}`,
      details: "Timeout must be a positive number of seconds",
    };
    throw error;
  }

  return Math.ceil(seconds * 1000);
}

function toStartOptions(options: CommandOptions): DaemonStartOptions {
  const startOptions: DaemonStartOptions = {
    home: typeof options.home === "string" ? options.home : undefined,
    listen: typeof options.listen === "string" ? options.listen : undefined,
    port: typeof options.port === "string" ? options.port : undefined,
    relay: typeof options.relay === "boolean" ? options.relay : undefined,
    mcp: typeof options.mcp === "boolean" ? options.mcp : undefined,
    injectMcp: typeof options.injectMcp === "boolean" ? options.injectMcp : undefined,
    webUi: typeof options.webUi === "boolean" ? options.webUi : undefined,
    hostnames: typeof options.hostnames === "string" ? options.hostnames : undefined,
  };

  if (startOptions.listen && startOptions.port) {
    const error: CommandError = {
      code: "INVALID_OPTIONS",
      message: "Cannot use --listen and --port together",
    };
    throw error;
  }

  return startOptions;
}

function toCommandError(err: unknown, fallbackCode: string, fallbackPrefix: string): CommandError {
  if (err && typeof err === "object" && "code" in err) {
    return err as CommandError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: fallbackCode, message: `${fallbackPrefix}: ${message}` };
}

/**
 * Raw SIGTERM/SIGKILL stop-then-start, kept only behind explicit `--force`. This is
 * outside the controlled-restart guarantee: it does not checkpoint pending work, and
 * on a timeout it kills the daemon rather than waiting for a supervisor-owned replacement.
 */
async function runForcedRestart(
  startOptions: DaemonStartOptions,
  timeoutMs: number,
  deps: RestartCommandDependencies,
): Promise<RestartCommandResult> {
  try {
    const stopResult = await deps.stop({ home: startOptions.home, timeoutMs, force: true });
    const startup = await deps.start(startOptions);
    const before = stopResult.pid === null ? "not running" : `PID ${stopResult.pid}`;
    const after = startup.pid === null ? "unknown PID" : `PID ${startup.pid}`;

    return {
      type: "single",
      data: {
        action: "restarted",
        home: stopResult.home,
        pid: startup.pid === null ? "-" : String(startup.pid),
        message: `Local daemon force-restarted outside the restart-recovery guarantee (${before} -> ${after})`,
      },
      schema: restartResultSchema,
    };
  } catch (err) {
    throw toCommandError(err, "RESTART_FAILED", "Failed to force-restart local daemon");
  }
}

/**
 * Requests a controlled restart from a live daemon: it checkpoints in-flight work and
 * the supervisor replaces the running process, all behind a single RPC. There is no
 * client-side timeout/fallback here — a failed or rejected request leaves the daemon's
 * prior state untouched, exactly as the daemon reports it.
 */
async function runSafeRestart(
  options: CommandOptions,
  timeoutMs: number,
  state: LocalDaemonState,
  deps: RestartCommandDependencies,
): Promise<RestartCommandResult> {
  const reason =
    typeof options.reason === "string" && options.reason.trim() ? options.reason : undefined;

  const client = await deps.connect(state.listen, timeoutMs);
  if (!client) {
    const error: CommandError = {
      code: "DAEMON_UNREACHABLE",
      message: `Daemon process is running (PID ${state.pidInfo?.pid ?? "unknown"}) but not reachable at ${state.listen}.`,
      details:
        "A running daemon is never killed automatically. Pass --force for a raw stop/start outside the restart-recovery guarantee.",
    };
    throw error;
  }

  try {
    const serverInfo = client.getLastServerInfoMessage();
    if (serverInfo?.features?.restartRecovery !== true) {
      const error: CommandError = {
        code: "RESTART_UNSUPPORTED",
        message: "This daemon does not support controlled restart checkpoints.",
        details:
          "Update the daemon, or pass --force for a raw stop/start outside the restart-recovery guarantee.",
      };
      throw error;
    }

    if (typeof options.acknowledgeCrash === "string") {
      const result = await client.acknowledgeCrash(options.acknowledgeCrash, true);
      return {
        type: "single",
        schema: restartResultSchema,
        data: {
          action: "crash_acknowledged",
          home: state.home,
          pid: state.pidInfo ? String(state.pidInfo.pid) : "-",
          generationId: result.generationId,
          message: `Unexpected crash acknowledged; successor '${result.generationId}' is active in the same daemon. Old checkpoint work was not replayed.`,
        },
      };
    }
    if (options.retryRecovery === true) {
      const result = await client.retryRecovery(reason);
      return {
        type: "single",
        schema: restartResultSchema,
        data: {
          action: "recovery_retried",
          home: state.home,
          pid: state.pidInfo ? String(state.pidInfo.pid) : "-",
          generationId: result.generationId,
          message: `Recovery completed using successor generation '${result.generationId}'. The daemon process was preserved.`,
        },
      };
    }
    const result = await client.restartServer(reason);
    return {
      type: "single",
      data: {
        action: "restart_requested",
        home: state.home,
        pid: state.pidInfo ? String(state.pidInfo.pid) : "-",
        message: result.generationId
          ? `Restart requested; checkpoint generation ${result.generationId} is ready. The supervisor will replace the running daemon.`
          : "Restart requested. The supervisor will replace the running daemon once its checkpoint is ready.",
        generationId: result.generationId,
      },
      schema: restartResultSchema,
    };
  } catch (err) {
    throw toCommandError(err, "RESTART_FAILED", "Failed to request a controlled restart");
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
  deps: RestartCommandDependencies = defaultRestartCommandDependencies,
): Promise<RestartCommandResult> {
  const timeoutMs = parseTimeoutMs(options.timeout);
  const force = options.force === true;
  const startOptions = toStartOptions(options);
  const acknowledgeCrash =
    typeof options.acknowledgeCrash === "string" && options.acknowledgeCrash.trim().length > 0;

  if (
    (options.acknowledgeCrash !== undefined && !acknowledgeCrash) ||
    (acknowledgeCrash &&
      (force || options.retryRecovery === true || options.orphanExecutionReconciled !== true)) ||
    (!acknowledgeCrash && options.orphanExecutionReconciled === true)
  ) {
    throw {
      code: "INVALID_OPTIONS",
      message:
        "--acknowledge-crash <generation> requires --orphan-execution-reconciled and cannot be combined with --force or --retry-recovery.",
    } satisfies CommandError;
  }

  if (force && options.retryRecovery === true) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--retry-recovery cannot be combined with --force.",
    } satisfies CommandError;
  }

  if (force) {
    return runForcedRestart(startOptions, timeoutMs, deps);
  }

  const state = deps.resolveState(startOptions.home);

  if (!state.pidInfo || !state.running) {
    if (options.retryRecovery === true || acknowledgeCrash) {
      throw {
        code: "DAEMON_NOT_RUNNING",
        message:
          "Recovery controls require the existing paused daemon process; they will not start or replay an older checkpoint.",
      } satisfies CommandError;
    }
    try {
      const startup = await deps.start(startOptions);
      return {
        type: "single",
        data: {
          action: "started",
          home: state.home,
          pid: startup.pid === null ? "-" : String(startup.pid),
          message: "Daemon was not running; started it fresh.",
        },
        schema: restartResultSchema,
      };
    } catch (err) {
      throw toCommandError(err, "RESTART_FAILED", "Failed to start local daemon");
    }
  }

  return runSafeRestart(options, timeoutMs, state, deps);
}
