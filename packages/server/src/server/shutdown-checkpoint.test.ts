import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CheckpointStore } from "./restart/checkpoint-store.js";
import { RestartController } from "./restart/restart-controller.js";
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

  test("service cleanup runs after the successful checkpoint and daemon stop", async () => {
    const { daemon, calls } = createDaemon({ state: "running" }, async () => ({
      generationId: "gen-cleanup",
    }));
    await stopWithShutdownCheckpoint(daemon, {
      logger: createLogger(),
      reason: "service stop",
      cleanup: async () => {
        calls.push("cleanup");
      },
    });
    expect(calls).toEqual(["prepare", "stop", "cleanup"]);
  });

  test("a failed checkpoint never starts destructive service cleanup", async () => {
    const { daemon, calls } = createDaemon({ state: "running" }, async () => {
      throw new Error("checkpoint write failed");
    });
    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger: createLogger(),
      reason: "service stop",
      cleanup: async () => {
        calls.push("cleanup");
      },
    });
    expect(outcome.checkpoint).toBe("failed");
    expect(calls).toEqual(["prepare"]);
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

  test("a paused ready generation stops without replacing the checkpoint", async () => {
    const { daemon, calls } = createDaemon(
      { state: "paused", stage: "ready", generationId: "gen-ready" },
      async () => ({ generationId: "never" }),
    );
    expect(
      await stopWithShutdownCheckpoint(daemon, { logger: createLogger(), reason: "test" }),
    ).toMatchObject({ checkpoint: "skipped", generationId: "gen-ready" });
    expect(calls).toEqual(["stop"]);
  });
  test("a paused generation handed to replacement stops without replacing the checkpoint", async () => {
    const { daemon, calls } = createDaemon(
      { state: "paused", stage: "replacing", generationId: "gen-replacing" },
      async () => ({ generationId: "never" }),
    );
    expect(
      await stopWithShutdownCheckpoint(daemon, { logger: createLogger(), reason: "test" }),
    ).toMatchObject({ checkpoint: "skipped", generationId: "gen-replacing" });
    expect(calls).toEqual(["stop"]);
  });

  test("a controlled restart can stop the worker it is replacing", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-shutdown-replacing-"));
    const store = new CheckpointStore(home, z.object({ message: z.string() }).parse);
    const controller = new RestartController({
      store,
      capture: async () => ({ message: "retained" }),
    });
    const stop = vi.fn(async () => {});
    let outcome: Awaited<ReturnType<typeof stopWithShutdownCheckpoint>> | undefined;

    await controller.replace(async () => {
      // Replacement asks the supervisor to stop this worker while the stage is "replacing".
      outcome = await stopWithShutdownCheckpoint(
        {
          getRestartStatus: () => controller.status,
          prepareRestart: () => controller.prepare(),
          stop,
        },
        { logger: createLogger(), reason: "controlled restart" },
      );
    });

    expect(outcome).toMatchObject({
      checkpoint: "skipped",
      generationId: controller.status.generationId,
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  test.each(["paused", "restoring"] as const)(
    "a blocked %s daemon retains execution ownership",
    async (state) => {
      const { daemon, calls } = createDaemon(
        { state, generationId: "gen-blocked", error: "later work" },
        async () => ({ generationId: "never" }),
      );
      expect(
        await stopWithShutdownCheckpoint(daemon, { logger: createLogger(), reason: "test" }),
      ).toMatchObject({ checkpoint: "failed" });
      expect(calls).toEqual([]);
    },
  );

  test("a failed checkpoint retains the daemon for retry", async () => {
    const failure = new Error("agents did not quiesce");
    const { daemon, calls } = createDaemon({ state: "running" }, () => Promise.reject(failure));
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, { logger, reason: "test" });

    expect(outcome).toMatchObject({ checkpoint: "failed", error: failure });
    expect(calls).toEqual(["prepare"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure }),
      expect.stringContaining("failed"),
    );
  });

  test("a checkpoint timeout blocks the stop without abandoning preparation", async () => {
    const { daemon, calls } = createDaemon({ state: "running" }, () => new Promise(() => {}));

    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger: createLogger(),
      reason: "test",
      timeoutMs: 20,
    });

    expect(outcome.checkpoint).toBe("failed");
    expect(String((outcome as { error: unknown }).error)).toContain("did not commit within 20ms");
    expect(calls).toEqual(["prepare"]);
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
