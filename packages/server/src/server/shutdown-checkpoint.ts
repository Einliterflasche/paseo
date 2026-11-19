import { attempt, attemptWithin, type RestartFailureReporter } from "./restart/best-effort.js";

/** Upper bound for the restart checkpoint: freeze, stop, capture, and commit. */
export const DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS = 120_000;
/** Part of the checkpoint limit: the admission freeze and the provider stop. */
export const RESTART_STOP_TIMEOUT_MS = 30_000;
/** Longest time a boot keeps admissions frozen while it resumes a checkpoint. */
export const RESTART_RESTORE_TIMEOUT_MS = 120_000;
/** Time the daemon's own stop may take once the checkpoint phase is over. */
export const SHUTDOWN_STOP_GRACE_MS = 30_000;
/** Time the service cgroup cleanup may take after the daemon stop. */
export const SHUTDOWN_CLEANUP_GRACE_MS = 25_000;
export const SHUTDOWN_CHECKPOINT_TIMEOUT_ENV = "PASEO_SHUTDOWN_CHECKPOINT_TIMEOUT_MS";
// Covers the exit itself after the last bounded step, so the supervisor never kills a worker
// that is about to exit on its own.
const WORKER_EXIT_MARGIN_MS = 5_000;

export interface ShutdownCheckpointDaemon {
  prepareRestart(): Promise<{ generationId?: string }>;
  stop(): Promise<void>;
}

export interface ShutdownCheckpointLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export type ShutdownCheckpointOutcome =
  | { checkpoint: "committed"; generationId: string; elapsedMs: number }
  | { checkpoint: "missing"; elapsedMs: number };

interface ShutdownCheckpointOptions {
  logger: ShutdownCheckpointLogger;
  reason: string;
  cleanup?: () => Promise<void>;
  stopTimeoutMs?: number;
  cleanupTimeoutMs?: number;
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

/** Checkpoint limit + SHUTDOWN_STOP_GRACE_MS + SHUTDOWN_CLEANUP_GRACE_MS + 5_000. */
export function resolveWorkerGracefulExitMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    resolveShutdownCheckpointTimeoutMs(env) +
    SHUTDOWN_STOP_GRACE_MS +
    SHUTDOWN_CLEANUP_GRACE_MS +
    WORKER_EXIT_MARGIN_MS
  );
}

/** Saves a best-effort checkpoint, then stops the daemon (at most `SHUTDOWN_STOP_GRACE_MS`), then
 *  runs `cleanup` (at most `SHUTDOWN_CLEANUP_GRACE_MS`). A missing checkpoint and a failed or slow
 *  stop or cleanup are logged. Never rejects and never returns early. */
export async function stopWithShutdownCheckpoint(
  daemon: ShutdownCheckpointDaemon,
  options: ShutdownCheckpointOptions,
): Promise<ShutdownCheckpointOutcome> {
  const { logger, reason } = options;
  const report: RestartFailureReporter = (step, error) => {
    logger.warn({ err: error, reason, step }, "Shutdown step failed; continuing the stop");
  };
  const startedAt = Date.now();
  logger.info({ reason }, "Saving shutdown checkpoint before stopping");
  // The controller bounds the checkpoint and never rejects; the guard only covers a broken daemon.
  const preparation = await attempt(report, "checkpoint", () => daemon.prepareRestart(), {});
  const elapsedMs = Date.now() - startedAt;
  let outcome: ShutdownCheckpointOutcome;
  if (preparation.generationId) {
    logger.info(
      { reason, generationId: preparation.generationId, elapsedMs },
      "Shutdown checkpoint committed; the next start restores it",
    );
    outcome = { checkpoint: "committed", generationId: preparation.generationId, elapsedMs };
  } else {
    logger.warn(
      { reason, elapsedMs },
      "Shutdown checkpoint missing; stopping without it, agents will not resume automatically",
    );
    outcome = { checkpoint: "missing", elapsedMs };
  }
  await attemptWithin(
    report,
    "stop",
    options.stopTimeoutMs ?? SHUTDOWN_STOP_GRACE_MS,
    () => daemon.stop(),
    undefined,
  );
  if (options.cleanup) {
    await attemptWithin(
      report,
      "cleanup",
      options.cleanupTimeoutMs ?? SHUTDOWN_CLEANUP_GRACE_MS,
      options.cleanup,
      undefined,
    );
  }
  return outcome;
}
