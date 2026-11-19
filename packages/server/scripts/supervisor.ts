import { fork, spawn, type ChildProcess } from "child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import {
  createStream as createRotatingFileStream,
  type RotatingFileStream,
} from "rotating-file-stream";
import { prepareProcessTreeTermination, terminateWithTreeKill } from "../src/utils/tree-kill.js";
import { withTimeout } from "../src/utils/promise-timeout.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_TERMINATION_GRACE_MS = 10_000;

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
      serverId: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
}

interface SupervisorGracefulShutdownMessage {
  type: "paseo:graceful-shutdown";
  reason: string;
}

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string; serverId: string }) => Promise<void> | void;
  onWorkerExit?: () => Promise<void> | void;
  restartOnCrash?: boolean;
  /** Wait for a cooperative exit after the graceful request; the worker may checkpoint first. */
  gracefulExitTimeoutMs?: number;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
}

export interface SupervisorController {
  requestShutdown(reason: string): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:ready") {
    const { listen, serverId } = msg as { listen?: unknown; serverId?: unknown };
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    if (typeof serverId !== "string" || serverId.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen, serverId };
  }
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

// daemon.log is best effort: a full disk or a replaced log path must not take the
// supervisor, and with it the worker, down. A failed stream is dropped and a new one
// is opened on the next write, so logging resumes once the file is writable again.
function createDurableLog(
  options: SupervisorLogFileOptions | undefined,
  reportFailure: (message: string) => void,
) {
  let stream: RotatingFileStream | null = null;
  let failing = false;

  const open = (logFile: SupervisorLogFileOptions): RotatingFileStream => {
    const next = createRotatingFileStream(path.basename(logFile.path), {
      path: path.dirname(logFile.path),
      size: toRotatingFileStreamSize(logFile.rotate.maxSize),
      maxFiles: logFile.rotate.maxFiles,
    });
    next.on("error", (error) => {
      if (stream === next) {
        stream = null;
      }
      if (!failing) {
        failing = true;
        reportFailure(
          `Cannot write ${logFile.path}, will retry on the next log line: ${error.message}`,
        );
      }
    });
    return next;
  };

  return {
    write(chunk: string | Buffer): void {
      if (!options) {
        return;
      }
      stream ??= open(options);
      stream.write(chunk, (error) => {
        if (!error) {
          failing = false;
        }
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (!stream) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      });
    },
  };
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;
  const gracefulExitTimeoutMs = options.gracefulExitTimeoutMs ?? WORKER_TERMINATION_GRACE_MS;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  let lifecycleFailed = false;
  let publication = Promise.resolve();
  const durableLog = createDurableLog(options.logFile, (message) => {
    process.stderr.write(`[${options.name}] ${message}\n`);
  });
  let workerStop: Promise<void> | null = null;
  let workerStopFinished = false;
  let workerClosed: Promise<void> = Promise.resolve();
  let workerExit: {
    child: ChildProcess;
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  let workerReachedReady = false;

  const writeDurableChunk = (chunk: string | Buffer): void => {
    durableLog.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> => durableLog.close();

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const isAlive = (currentChild: ChildProcess): boolean =>
    currentChild.exitCode === null && currentChild.signalCode === null;

  const waitForExit = async (currentChild: ChildProcess, timeoutMs: number): Promise<boolean> => {
    if (!isAlive(currentChild)) return true;
    const waiting = new AbortController();
    try {
      const exited = once(currentChild, "exit", { signal: waiting.signal }).then(() => true);
      const expired = delay(timeoutMs, false, { signal: waiting.signal });
      return await Promise.race([exited, expired]);
    } finally {
      waiting.abort();
    }
  };

  // Every step is bounded and a failed step only logs: a stop must finish without an operator.
  const stopWorker = async (currentChild: ChildProcess, reason: string): Promise<void> => {
    const workerPid = currentChild.pid ?? null;
    try {
      // Capture before IPC: a cooperative worker can exit immediately, leaving
      // descendant stdio detached and no leader from which to discover ownership.
      await prepareProcessTreeTermination(currentChild, { timeoutMs: WORKER_TERMINATION_GRACE_MS });
    } catch (error) {
      writeLifecycleLog("Worker process tree capture failed", {
        reason,
        workerPid,
        error: describeError(error),
      });
    }
    if (isAlive(currentChild)) {
      const exited = waitForExit(currentChild, gracefulExitTimeoutMs);
      requestWorkerShutdown(currentChild, reason);
      if (!(await exited)) {
        log(`Worker did not exit within ${gracefulExitTimeoutMs}ms; killing its process tree`);
        writeLifecycleLog("Worker did not exit after graceful shutdown request", {
          reason,
          gracefulExitTimeoutMs,
          workerPid,
        });
      }
    }
    try {
      const result = await terminateWithTreeKill(currentChild, {
        gracefulSignal: "SIGKILL",
        forceSignal: "SIGKILL",
        gracefulTimeoutMs: WORKER_TERMINATION_GRACE_MS,
        forceTimeoutMs: WORKER_TERMINATION_GRACE_MS,
      });
      if (result === "kill-timeout") {
        writeLifecycleLog("Worker descendants survived SIGKILL", { reason, workerPid });
      }
    } catch (error) {
      writeLifecycleLog("Worker process tree kill failed", {
        reason,
        workerPid,
        error: describeError(error),
      });
    }
    if (isAlive(currentChild)) {
      currentChild.kill("SIGKILL");
      if (!(await waitForExit(currentChild, WORKER_TERMINATION_GRACE_MS))) {
        writeLifecycleLog("Worker process survived SIGKILL", { reason, workerPid });
      }
    }
    try {
      await withTimeout(workerClosed, WORKER_TERMINATION_GRACE_MS, "Worker output drain");
    } catch (error) {
      writeLifecycleLog("Worker output did not drain", { reason, error: describeError(error) });
    }
    // Surviving descendants can hold inherited pipes open; their output must not hold the stop.
    currentChild.stdout?.destroy();
    currentChild.stderr?.destroy();
  };

  const beginWorkerStop = (reason: string): void => {
    if (!child || workerStop) return;
    const currentChild = child;
    workerStop = (async () => {
      await stopWorker(currentChild, reason);
      workerStopFinished = true;
      if (isAlive(currentChild)) {
        // The service manager clears the process group and starts the service again.
        log(`Worker ${currentChild.pid ?? "unknown"} survived SIGKILL. Supervisor exiting.`);
        exitSupervisor(1);
        return;
      }
      if (workerExit?.child === currentChild) finishWorkerExit(workerExit.code, workerExit.signal);
    })();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    writeLifecycleLog("Spawning worker", { workerEntry });
    const nextEnv = spawnSpec?.env ?? workerEnv;
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: nextEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: nextEnv,
        execArgv: workerExecArgv,
      });
    }

    workerExit = null;
    workerStop = null;
    workerStopFinished = false;
    const currentChild = child;
    workerReachedReady = false;
    workerClosed = new Promise((resolve) => currentChild.once("close", () => resolve()));
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = { type: "paseo:supervisor-heartbeat" };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage || child !== currentChild) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        workerReachedReady = true;
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        publication = publication
          .then(() =>
            options.onWorkerReady?.({
              listen: lifecycleMessage.listen,
              serverId: lifecycleMessage.serverId,
            }),
          )
          .catch((error) => {
            lifecycleFailed = true;
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
            requestShutdown("endpoint_publication_failed");
          });
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", { reason });
        requestShutdown(reason);
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", { reason });
      requestRestart(reason);
    });

    child.on("error", (error) => {
      lifecycleFailed = true;
      log(`Worker spawn failed: ${error.message}`);
      exitSupervisor(1);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      const exitDescriptor = describeExit(code, signal);
      writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });
      workerExit = { child: currentChild, code, signal };
      // A controlled stop finalizes the exit itself, after it killed the captured tree.
      if (workerStopFinished || (!restarting && !shuttingDown)) finishWorkerExit(code, signal);
    });
  };

  const finishWorkerExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!child || workerExit?.child !== child) return;
    child = null;
    const reachedReady = workerReachedReady;
    publication = publication
      .then(() => options.onWorkerExit?.())
      .catch((error) => {
        lifecycleFailed = true;
        log(`Worker exit callback failed: ${String(error)}`);
      });
    void publication.then(() => {
      const exitDescriptor = describeExit(code, signal);
      // A restart requested during the boot restore, before ready, still spawns the replacement.
      if (lifecycleFailed || (!reachedReady && !shuttingDown && !restarting)) {
        log(`Worker exited before successful readiness (${exitDescriptor}). Supervisor exiting.`);
        exitSupervisor(1);
        return;
      }
      if (shuttingDown) {
        log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
        exitSupervisor(0);
        return;
      }
      const crashed =
        restartOnCrash &&
        ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));
      if (restarting || crashed) {
        restarting = false;
        log(
          crashed
            ? `Worker crashed (${exitDescriptor}). Restarting worker...`
            : `Worker exited (${exitDescriptor}). Restarting worker...`,
        );
        spawnWorker();
        return;
      }
      log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
      exitSupervisor(typeof code === "number" ? code : 1);
      return;
    });
  };

  const requestWorkerShutdown = (currentChild: ChildProcess, reason: string): void => {
    const message: SupervisorGracefulShutdownMessage = {
      type: "paseo:graceful-shutdown",
      reason,
    };
    writeLifecycleLog("Supervisor requesting graceful worker shutdown", {
      reason,
      supervisorPid: process.pid,
      workerPid: currentChild.pid ?? null,
    });
    if (!currentChild.connected) {
      writeLifecycleLog("Graceful worker shutdown IPC unavailable", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      return;
    }
    currentChild.send?.(message, (error) => {
      if (error) {
        writeLifecycleLog("Graceful worker shutdown IPC send failed", {
          error: error instanceof Error ? error.message : String(error),
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      }
    });
  };

  const requestRestart = (reason: string) => {
    if (!child || shuttingDown || restarting) return;
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    log(`${reason}. Stopping worker for restart...`);
    beginWorkerStop(reason);
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    restarting = false;
    writeLifecycleLog("Supervisor shutdown requested", { reason });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      void publication.then(() => {
        exitSupervisor(lifecycleFailed ? 1 : 0);
        return;
      });
      return;
    }
    beginWorkerStop(reason);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}
