import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS,
  SHUTDOWN_CHECKPOINT_TIMEOUT_ENV,
  SHUTDOWN_STOP_GRACE_MS,
  resolveShutdownCheckpointTimeoutMs,
  resolveWorkerGracefulExitMs,
  stopWithShutdownCheckpoint,
  type ShutdownCheckpointDaemon,
} from "./shutdown-checkpoint.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createDaemon(
  status: ReturnType<ShutdownCheckpointDaemon["getRestartStatus"]>,
  prepare: () => Promise<{ generationId: string }>,
) {
  const calls: string[] = [];
  const daemon: ShutdownCheckpointDaemon = {
    getRestartStatus: () => status,
    prepareRestart: vi.fn(() => {
      calls.push("prepare");
      return prepare();
    }),
    stop: vi.fn(async () => {
      calls.push("stop");
    }),
  };
  return { daemon, calls };
}

describe("stopWithShutdownCheckpoint", () => {
  test("a running daemon commits a checkpoint before it stops", async () => {
    const { daemon, calls } = createDaemon({ state: "running" }, async () => ({
      generationId: "gen-1",
    }));
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, { logger, reason: "test" });

    expect(outcome).toMatchObject({ checkpoint: "committed", generationId: "gen-1" });
    expect(calls).toEqual(["prepare", "stop"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a preparing daemon joins the checkpoint already in flight", async () => {
    const { daemon, calls } = createDaemon({ state: "preparing" }, async () => ({
      generationId: "gen-2",
    }));

    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger: createLogger(),
      reason: "test",
    });

    expect(outcome).toMatchObject({ checkpoint: "committed", generationId: "gen-2" });
    expect(calls).toEqual(["prepare", "stop"]);
  });

  test.each(["paused", "restoring"] as const)(
    "a %s daemon stops without touching its retained recovery state",
    async (state) => {
      const { daemon, calls } = createDaemon(
        { state, generationId: "gen-blocked", error: "later work" },
        async () => ({ generationId: "never" }),
      );
      const logger = createLogger();

      const outcome = await stopWithShutdownCheckpoint(daemon, { logger, reason: "test" });

      expect(outcome).toEqual({
        checkpoint: "skipped",
        state,
        generationId: "gen-blocked",
        error: "later work",
      });
      expect(calls).toEqual(["stop"]);
      expect(daemon.prepareRestart).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ state, generationId: "gen-blocked" }),
        expect.stringContaining("skipped"),
      );
    },
  );

  test("a failed checkpoint still stops the daemon", async () => {
    const failure = new Error("agents did not quiesce");
    const { daemon, calls } = createDaemon({ state: "running" }, () => Promise.reject(failure));
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, { logger, reason: "test" });

    expect(outcome).toMatchObject({ checkpoint: "failed", error: failure });
    expect(calls).toEqual(["prepare", "stop"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure }),
      expect.stringContaining("failed"),
    );
  });

  test("a checkpoint that exceeds the timeout does not block the stop", async () => {
    const { daemon, calls } = createDaemon({ state: "running" }, () => new Promise(() => {}));

    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger: createLogger(),
      reason: "test",
      timeoutMs: 20,
    });

    expect(outcome.checkpoint).toBe("failed");
    expect(String((outcome as { error: unknown }).error)).toContain("did not commit within 20ms");
    expect(calls).toEqual(["prepare", "stop"]);
  });

  test("a failing stop propagates after the checkpoint outcome is known", async () => {
    const { daemon } = createDaemon({ state: "running" }, async () => ({ generationId: "gen-3" }));
    const stopFailure = new Error("server did not close");
    (daemon.stop as ReturnType<typeof vi.fn>).mockRejectedValue(stopFailure);

    await expect(
      stopWithShutdownCheckpoint(daemon, { logger: createLogger(), reason: "test" }),
    ).rejects.toBe(stopFailure);
    expect(daemon.prepareRestart).toHaveBeenCalledTimes(1);
  });
});

describe("shutdown timing", () => {
  test("defaults the checkpoint timeout and derives the supervisor grace from it", () => {
    expect(resolveShutdownCheckpointTimeoutMs({})).toBe(DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS);
    expect(resolveWorkerGracefulExitMs({})).toBe(
      DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS + SHUTDOWN_STOP_GRACE_MS,
    );
  });

  test("reads the checkpoint timeout from the environment", () => {
    const env = { [SHUTDOWN_CHECKPOINT_TIMEOUT_ENV]: "5000" };
    expect(resolveShutdownCheckpointTimeoutMs(env)).toBe(5000);
    expect(resolveWorkerGracefulExitMs(env)).toBe(5000 + SHUTDOWN_STOP_GRACE_MS);
    expect(resolveShutdownCheckpointTimeoutMs({ [SHUTDOWN_CHECKPOINT_TIMEOUT_ENV]: " " })).toBe(
      DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS,
    );
  });

  test("rejects a malformed checkpoint timeout", () => {
    for (const raw of ["abc", "-1", "NaN", "Infinity"]) {
      expect(() =>
        resolveShutdownCheckpointTimeoutMs({ [SHUTDOWN_CHECKPOINT_TIMEOUT_ENV]: raw }),
      ).toThrow(SHUTDOWN_CHECKPOINT_TIMEOUT_ENV);
    }
  });
});
