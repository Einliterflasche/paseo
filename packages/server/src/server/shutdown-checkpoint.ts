import { withTimeout } from "../utils/promise-timeout.js";

/** Upper bound for committing a restart checkpoint when the service stops. */
export const DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS = 120_000;
/** Time the daemon's own stop may take once the checkpoint phase is over. */
export const SHUTDOWN_STOP_GRACE_MS = 30_000;
export const SHUTDOWN_CHECKPOINT_TIMEOUT_ENV = "PASEO_SHUTDOWN_CHECKPOINT_TIMEOUT_MS";

export interface ShutdownCheckpointDaemon {
  getRestartStatus(): {
    state: "running" | "preparing" | "paused" | "restoring";
    generationId?: string;
    stage?: string;
    error?: string;
  };
  prepareRestart(): Promise<{ generationId: string }>;
  stop(): Promise<void>;
}

export interface ShutdownCheckpointLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export type ShutdownCheckpointOutcome =
  | { checkpoint: "committed"; generationId: string; elapsedMs: number }
  | { checkpoint: "skipped"; state: string; generationId?: string; error?: string }
  | { checkpoint: "failed"; error: unknown; elapsedMs: number };

interface ShutdownCheckpointOptions {
  logger: ShutdownCheckpointLogger;
  reason: string;
  timeoutMs?: number;
  cleanup?: () => Promise<void>;
}

export function resolveShutdownCheckpointTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SHUTDOWN_CHECKPOINT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${SHUTDOWN_CHECKPOINT_TIMEOUT_ENV} must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.floor(parsed);
}

/** How long a supervisor waits for its worker to exit after a graceful stop request. */
export function resolveWorkerGracefulExitMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveShutdownCheckpointTimeoutMs(env) + SHUTDOWN_STOP_GRACE_MS;
}

/** A failed checkpoint keeps the daemon and its execution owners alive for diagnosis/retry. */
export async function stopWithShutdownCheckpoint(
  daemon: ShutdownCheckpointDaemon,
  options: ShutdownCheckpointOptions,
): Promise<ShutdownCheckpointOutcome> {
  const outcome = await checkpointBeforeStop(daemon, options);
  if (outcome.checkpoint !== "failed") {
    await daemon.stop();
    await options.cleanup?.();
  }
  return outcome;
}

async function checkpointBeforeStop(
  daemon: ShutdownCheckpointDaemon,
  options: { logger: ShutdownCheckpointLogger; reason: string; timeoutMs?: number },
): Promise<ShutdownCheckpointOutcome> {
  const { logger, reason } = options;
  const status = daemon.getRestartStatus();
  // A committed generation stays authoritative once it is ready, including after a
  // controlled restart has handed it to replacement: that hand-off is what asks the
  // supervisor to stop this worker.
  if (
    status.state === "paused" &&
    (status.stage === "ready" || status.stage === "replacing") &&
    status.generationId &&
    !status.error
  ) {
    logger.info(
      { reason, ...status },
      "Shutdown checkpoint skipped; retained recovery state stays authoritative",
    );
    return {
      checkpoint: "skipped",
      state: status.state,
      ...(status.generationId ? { generationId: status.generationId } : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  }
  if (status.state !== "running" && status.state !== "preparing") {
    const error = new Error(
      `Shutdown refused while recovery is ${status.state}; no prepared generation is ready`,
    );
    logger.warn(
      { reason, ...status, err: error },
      "Shutdown remains blocked; retained recovery state stays authoritative",
    );
    return { checkpoint: "failed", error, elapsedMs: 0 };
  }
  const timeoutMs = options.timeoutMs ?? resolveShutdownCheckpointTimeoutMs();
  const startedAt = Date.now();
  logger.info(
    { reason, timeoutMs, state: status.state },
    "Committing shutdown checkpoint before stopping",
  );
  try {
    const { generationId } = await withTimeout(
      daemon.prepareRestart(),
      timeoutMs,
      `Shutdown checkpoint did not commit within ${timeoutMs}ms`,
    );
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      { reason, generationId, elapsedMs },
      "Shutdown checkpoint committed; the next start restores it",
    );
    return { checkpoint: "committed", generationId, elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.warn(
      { err: error, reason, elapsedMs },
      "Shutdown checkpoint failed; daemon remains alive and replacement is blocked",
    );
    return { checkpoint: "failed", error, elapsedMs };
  }
}
