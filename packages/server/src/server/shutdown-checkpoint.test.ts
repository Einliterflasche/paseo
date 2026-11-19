import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { RestartStepTimeoutError } from "./restart/best-effort.js";
import { CheckpointStore } from "./restart/checkpoint-store.js";
import { RestartController } from "./restart/restart-controller.js";
import {
  DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS,
  SHUTDOWN_CHECKPOINT_TIMEOUT_ENV,
  SHUTDOWN_CLEANUP_GRACE_MS,
  SHUTDOWN_STOP_GRACE_MS,
  resolveShutdownCheckpointTimeoutMs,
  resolveWorkerGracefulExitMs,
  stopWithShutdownCheckpoint,
  type ShutdownCheckpointDaemon,
} from "./shutdown-checkpoint.js";

interface LoggedLine {
  level: "info" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

function createLogger() {
  const lines: LoggedLine[] = [];
  return {
    lines,
    warnings: () => lines.filter((line) => line.level === "warn"),
    info(fields: Record<string, unknown>, message: string) {
      lines.push({ level: "info", fields, message });
    },
    warn(fields: Record<string, unknown>, message: string) {
      lines.push({ level: "warn", fields, message });
    },
  };
}

function createDaemon(options: {
  prepare: () => Promise<{ generationId?: string }>;
  stop?: () => Promise<void>;
}) {
  const calls: string[] = [];
  const daemon: ShutdownCheckpointDaemon = {
    prepareRestart: () => {
      calls.push("prepare");
      return options.prepare();
    },
    stop: async () => {
      calls.push("stop");
      await options.stop?.();
    },
  };
  return { daemon, calls };
}

const MessageSchema = z.object({ message: z.string() });

function createController(home: string) {
  return new RestartController({
    store: new CheckpointStore(home, MessageSchema.parse),
    capture: async () => ({ message: "retained" }),
    failed: () => {},
    prepareTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 1_000,
  });
}

function controllerDaemon(controller: RestartController<z.infer<typeof MessageSchema>>) {
  const calls: string[] = [];
  const daemon: ShutdownCheckpointDaemon = {
    prepareRestart: () => controller.prepare(),
    stop: async () => {
      calls.push("stop");
    },
  };
  return { daemon, calls };
}

describe("stopWithShutdownCheckpoint", () => {
  test("a running daemon commits a checkpoint before it stops", async () => {
    const { daemon, calls } = createDaemon({ prepare: async () => ({ generationId: "gen-1" }) });
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, { logger, reason: "test" });

    expect(outcome).toMatchObject({ checkpoint: "committed", generationId: "gen-1" });
    expect(calls).toEqual(["prepare", "stop"]);
    expect(logger.warnings()).toEqual([]);
  });

  test("service cleanup runs after the successful checkpoint and daemon stop", async () => {
    const { daemon, calls } = createDaemon({
      prepare: async () => ({ generationId: "gen-cleanup" }),
    });
    await stopWithShutdownCheckpoint(daemon, {
      logger: createLogger(),
      reason: "service stop",
      cleanup: async () => {
        calls.push("cleanup");
      },
    });
    expect(calls).toEqual(["prepare", "stop", "cleanup"]);
  });

  test.each([
    ["missing", async () => ({})],
    ["rejected", () => Promise.reject(new Error("checkpoint write failed"))],
  ] as const)("a %s checkpoint still stops the daemon and runs cleanup", async (_name, prepare) => {
    const { daemon, calls } = createDaemon({ prepare });
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger,
      reason: "service stop",
      cleanup: async () => {
        calls.push("cleanup");
      },
    });

    expect(outcome).toMatchObject({ checkpoint: "missing" });
    expect(calls).toEqual(["prepare", "stop", "cleanup"]);
    expect(logger.warnings().map((line) => line.message)).toContainEqual(
      expect.stringContaining("Shutdown checkpoint missing"),
    );
  });

  test("a controlled restart joins the checkpoint already in flight", async () => {
    const controller = createController(await mkdtemp(join(tmpdir(), "paseo-shutdown-join-")));
    const { daemon, calls } = controllerDaemon(controller);
    let outcome: Awaited<ReturnType<typeof stopWithShutdownCheckpoint>> | undefined;

    await controller.replace(async () => {
      // Replacement asks the supervisor to stop this worker while the stage is "replacing".
      outcome = await stopWithShutdownCheckpoint(daemon, {
        logger: createLogger(),
        reason: "controlled restart",
      });
    });

    const { generationId } = await controller.prepare();
    expect(generationId).toEqual(expect.any(String));
    expect(outcome).toMatchObject({ checkpoint: "committed", generationId });
    expect(calls).toEqual(["stop"]);
  });

  test.each(["running", "restoring", "paused"] as const)(
    "a %s daemon still stops",
    async (state) => {
      const home = await mkdtemp(join(tmpdir(), `paseo-shutdown-${state}-`));
      if (state === "restoring") await createController(home).prepare();
      const controller = createController(home);
      if (state === "restoring") await controller.claim();
      if (state === "paused") await controller.prepare();
      expect(controller.status.state).toBe(state);
      const { daemon, calls } = controllerDaemon(controller);

      const outcome = await stopWithShutdownCheckpoint(daemon, {
        logger: createLogger(),
        reason: "test",
      });

      expect(outcome).toMatchObject({ checkpoint: "committed" });
      expect(calls).toEqual(["stop"]);
    },
  );

  test("a slow stop is abandoned after the stop limit and cleanup still runs", async () => {
    const { daemon, calls } = createDaemon({
      prepare: async () => ({ generationId: "gen-slow" }),
      stop: () => new Promise(() => {}),
    });
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger,
      reason: "test",
      stopTimeoutMs: 20,
      cleanup: async () => {
        calls.push("cleanup");
      },
    });

    expect(outcome).toMatchObject({ checkpoint: "committed", generationId: "gen-slow" });
    expect(calls).toEqual(["prepare", "stop", "cleanup"]);
    expect(logger.warnings()).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          step: "stop",
          err: new RestartStepTimeoutError("stop", 20),
        }),
      }),
    ]);
  });

  test("a failing stop and a failing cleanup are logged and the function returns", async () => {
    const stopFailure = new Error("server did not close");
    const cleanupFailure = new Error("cgroup still busy");
    const { daemon } = createDaemon({
      prepare: async () => ({ generationId: "gen-3" }),
      stop: () => Promise.reject(stopFailure),
    });
    const logger = createLogger();

    const outcome = await stopWithShutdownCheckpoint(daemon, {
      logger,
      reason: "test",
      cleanup: () => Promise.reject(cleanupFailure),
    });

    expect(outcome).toMatchObject({ checkpoint: "committed", generationId: "gen-3" });
    expect(logger.warnings().map((line) => line.fields)).toEqual([
      expect.objectContaining({ step: "stop", err: stopFailure }),
      expect.objectContaining({ step: "cleanup", err: cleanupFailure }),
    ]);
  });

  test("a slow cleanup is abandoned after the cleanup limit", async () => {
    const { daemon } = createDaemon({ prepare: async () => ({ generationId: "gen-4" }) });
    const logger = createLogger();

    await stopWithShutdownCheckpoint(daemon, {
      logger,
      reason: "test",
      cleanup: () => new Promise(() => {}),
      cleanupTimeoutMs: 20,
    });

    expect(logger.warnings().map((line) => line.fields)).toEqual([
      expect.objectContaining({ step: "cleanup", err: new RestartStepTimeoutError("cleanup", 20) }),
    ]);
  });
});

describe("shutdown timing", () => {
  test("defaults the checkpoint timeout and derives the supervisor grace from it", () => {
    expect(resolveShutdownCheckpointTimeoutMs({})).toBe(DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS);
    expect(resolveWorkerGracefulExitMs({})).toBe(
      DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS +
        SHUTDOWN_STOP_GRACE_MS +
        SHUTDOWN_CLEANUP_GRACE_MS +
        5_000,
    );
  });

  test("reads the checkpoint timeout from the environment", () => {
    const env = { [SHUTDOWN_CHECKPOINT_TIMEOUT_ENV]: "5000" };
    expect(resolveShutdownCheckpointTimeoutMs(env)).toBe(5000);
    expect(resolveWorkerGracefulExitMs(env)).toBe(
      5000 + SHUTDOWN_STOP_GRACE_MS + SHUTDOWN_CLEANUP_GRACE_MS + 5_000,
    );
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
