import { describe, expect, it, vi } from "vitest";
import {
  runDeployCommand,
  type DeployCommandDependencies,
  type DeployPrepareClient,
  type DeployReadinessClient,
} from "./deploy.js";
import type { LocalDaemonState } from "./local-daemon.js";

function baseState(overrides: Partial<LocalDaemonState> = {}): LocalDaemonState {
  return {
    home: "/home/test/.paseo",
    listen: "127.0.0.1:6767",
    relayEnabled: true,
    relayEndpoint: "relay.paseo.sh:443",
    relayUseTls: false,
    relayPublicUseTls: false,
    logPath: "/home/test/.paseo/daemon.log",
    pidPath: "/home/test/.paseo/paseo.pid",
    pidInfo: { pid: 4242 },
    running: true,
    stalePidFile: false,
    ...overrides,
  };
}

function prepareClient(overrides: Partial<DeployPrepareClient> = {}): DeployPrepareClient {
  return {
    getLastServerInfoMessage: () => ({ features: { restartRecovery: true } }),
    prepareRestart: async () => ({ generationId: "gen-1" }),
    close: async () => {},
    ...overrides,
  };
}

function readinessClient(overrides: Partial<DeployReadinessClient> = {}): DeployReadinessClient {
  return {
    getLastServerInfoMessage: () => ({
      restartRecoveryState: "running",
      restartRecoveryGeneration: "gen-1",
    }),
    close: async () => {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DeployCommandDependencies> = {}): {
  deps: DeployCommandDependencies;
  calls: {
    lockAcquired: number;
    lockReleased: number;
    connectPrepare: number;
    spawnActivation: readonly string[][];
    connectReadiness: number;
  };
} {
  const calls = {
    lockAcquired: 0,
    lockReleased: 0,
    connectPrepare: 0,
    spawnActivation: [] as readonly string[][],
    connectReadiness: 0,
  };
  const deps: DeployCommandDependencies = {
    resolveState: () => baseState(),
    acquireLock: async () => {
      calls.lockAcquired += 1;
      return {
        release: async () => {
          calls.lockReleased += 1;
        },
      };
    },
    connectPrepare: async () => {
      calls.connectPrepare += 1;
      return prepareClient();
    },
    connectReadiness: async () => {
      calls.connectReadiness += 1;
      return readinessClient();
    },
    targetFormats: async () => [1, 2, 3],
    validateTarget: async () => {},
    spawnActivation: async (argv) => {
      calls.spawnActivation = [...calls.spawnActivation, [...argv]];
      return { code: 0, signal: null };
    },
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
  return { deps, calls };
}

describe("runDeployCommand", () => {
  it("refuses a target without offline validation before pausing", async () => {
    const { deps, calls } = makeDeps({
      targetFormats: async () => {
        throw new Error("unsupported command");
      },
    });
    await expect(
      runDeployCommand(["activate"], { targetCli: "/old/bin/paseo" }, {} as never, deps),
    ).rejects.toMatchObject({ code: "DEPLOY_FAILED" });
    expect(calls.connectPrepare).toBe(0);
    expect(calls.spawnActivation).toEqual([]);
  });
  it("rejects an advertised incompatible format without preparing", async () => {
    const prepareRestart = vi.fn();
    const { deps, calls } = makeDeps({
      targetFormats: async () => [1],
      connectPrepare: async () =>
        prepareClient({
          getLastServerInfoMessage: () => ({
            features: { restartRecovery: true },
            restartCheckpointFormat: 3,
          }),
          prepareRestart,
        }),
    });
    await expect(
      runDeployCommand(["activate"], { targetCli: "/old/bin/paseo" }, {} as never, deps),
    ).rejects.toMatchObject({ code: "DEPLOY_CHECKPOINT_INCOMPATIBLE" });
    expect(prepareRestart).not.toHaveBeenCalled();
    expect(calls.spawnActivation).toEqual([]);
  });
  it("requires validation of the exact ready generation before activation", async () => {
    const validateTarget = vi.fn(async () => {
      throw new Error("incompatible checkpoint");
    });
    const { deps, calls } = makeDeps({ validateTarget });
    await expect(
      runDeployCommand(["activate"], { targetCli: "/target/bin/paseo" }, {} as never, deps),
    ).rejects.toMatchObject({ code: "DEPLOY_FAILED" });
    expect(validateTarget).toHaveBeenCalledExactlyOnceWith(
      "/target/bin/paseo",
      "/home/test/.paseo",
      "gen-1",
    );
    expect(calls.spawnActivation).toEqual([]);
    expect(calls.lockReleased).toBe(1);
  });
  it.each(["stopping", "blocked"])(
    "reports failed recovery while %s without waiting forever",
    async (stage) => {
      const { deps } = makeDeps({
        connectReadiness: async () =>
          readinessClient({
            getLastServerInfoMessage: () => ({
              restartRecoveryState: "restoring",
              restartRecoveryStage: stage,
              restartRecoveryGeneration: "gen-1",
              restartRecoveryError: "stop not confirmed",
            }),
          }),
      });
      await expect(
        runDeployCommand(["activate"], { targetCli: "/target/bin/paseo" }, {} as never, deps),
      ).rejects.toMatchObject({ code: "DEPLOY_RECOVERY_FAILED" });
    },
  );
  it("reports a successor recovery instead of accepting the wrong generation", async () => {
    const { deps } = makeDeps({
      connectReadiness: async () =>
        readinessClient({
          getLastServerInfoMessage: () => ({
            restartRecoveryState: "running",
            restartRecoveryGeneration: "gen-2",
            restartRecoveryPreviousGeneration: "gen-1",
          }),
        }),
    });
    await expect(
      runDeployCommand(["activate"], { targetCli: "/target/bin/paseo" }, {} as never, deps),
    ).rejects.toMatchObject({ code: "DEPLOY_GENERATION_SUPERSEDED" });
  });
  it("refuses an empty activation command before touching anything", async () => {
    const { deps, calls } = makeDeps();

    await expect(
      runDeployCommand([], { targetCli: "/nix/store/target/bin/paseo" }, {} as never, deps),
    ).rejects.toMatchObject({
      code: "DEPLOY_ARGV_REQUIRED",
    });
    expect(calls.lockAcquired).toBe(0);
  });

  it("serializes deployments: a locked deploy never prepares or activates", async () => {
    const { deps, calls } = makeDeps({
      acquireLock: async () => {
        throw { code: "DEPLOY_LOCKED", message: "locked" };
      },
    });

    await expect(
      runDeployCommand(
        ["echo", "ok"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({
      code: "DEPLOY_LOCKED",
    });
    expect(calls.connectPrepare).toBe(0);
    expect(calls.spawnActivation).toHaveLength(0);
  });

  it("never activates when the daemon is unreachable for preparation", async () => {
    const { deps, calls } = makeDeps({ connectPrepare: async () => null });

    await expect(
      runDeployCommand(
        ["echo", "ok"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
    });
    expect(calls.spawnActivation).toHaveLength(0);
    expect(calls.lockReleased).toBe(1);
  });

  it("never activates on a daemon that predates checkpoint support", async () => {
    const { deps, calls } = makeDeps({
      connectPrepare: async () =>
        prepareClient({
          getLastServerInfoMessage: () => ({ features: { restartRecovery: false } }),
        }),
    });

    await expect(
      runDeployCommand(
        ["echo", "ok"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({
      code: "DEPLOY_UNSUPPORTED",
    });
    expect(calls.spawnActivation).toHaveLength(0);
  });

  it("never activates when preparation fails to return a ready generation", async () => {
    const { deps, calls } = makeDeps({
      connectPrepare: async () => prepareClient({ prepareRestart: async () => ({}) }),
    });

    await expect(
      runDeployCommand(
        ["echo", "ok"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({
      code: "DEPLOY_PREPARE_FAILED",
    });
    expect(calls.spawnActivation).toHaveLength(0);
  });

  it("never activates when prepareRestart itself throws", async () => {
    const { deps, calls } = makeDeps({
      connectPrepare: async () =>
        prepareClient({
          prepareRestart: async () => {
            throw new Error("checkpoint write failed");
          },
        }),
    });

    await expect(
      runDeployCommand(
        ["echo", "ok"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({
      code: "DEPLOY_FAILED",
    });
    expect(calls.spawnActivation).toHaveLength(0);
  });

  it("spawns the exact activation argv, unmodified, only after a ready generation exists", async () => {
    const { deps, calls } = makeDeps();

    const result = await runDeployCommand(
      ["sudo", "/nix/store/xyz/bin/switch-to-configuration", "switch"],
      { targetCli: "/nix/store/target/bin/paseo" },
      {} as never,
      deps,
    );

    expect(calls.spawnActivation).toEqual([
      ["sudo", "/nix/store/xyz/bin/switch-to-configuration", "switch"],
    ]);
    expect(result.data).toMatchObject({ action: "deployed", generationId: "gen-1" });
  });

  it("reports activation failure without ever polling for readiness", async () => {
    const { deps, calls } = makeDeps({
      spawnActivation: async () => ({ code: 1, signal: null }),
    });

    await expect(
      runDeployCommand(
        ["sudo", "switch"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({ code: "DEPLOY_ACTIVATION_FAILED" });
    expect(calls.connectReadiness).toBe(0);
  });

  it("reports activation failure when killed by a signal", async () => {
    const { deps } = makeDeps({
      spawnActivation: async () => ({ code: null, signal: "SIGTERM" }),
    });

    await expect(
      runDeployCommand(
        ["sudo", "switch"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({ code: "DEPLOY_ACTIVATION_FAILED" });
  });

  it("confirms the replacement daemon is running the exact prepared generation", async () => {
    const { deps } = makeDeps({
      connectPrepare: async () =>
        prepareClient({ prepareRestart: async () => ({ generationId: "gen-7" }) }),
      connectReadiness: async () =>
        readinessClient({
          getLastServerInfoMessage: () => ({
            restartRecoveryState: "running",
            restartRecoveryGeneration: "gen-7",
          }),
        }),
    });

    const result = await runDeployCommand(
      ["sudo", "switch"],
      { targetCli: "/nix/store/target/bin/paseo" },
      {} as never,
      deps,
    );
    expect(result.data.generationId).toBe("gen-7");
  });

  it("keeps polling through unreachable/mismatched readiness checks until timeout, never killing anything", async () => {
    let now = 0;
    let readinessAttempts = 0;
    const { deps } = makeDeps({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      connectReadiness: async () => {
        readinessAttempts += 1;
        // Always unreachable/mismatched: readiness never arrives within the timeout.
        return null;
      },
    });

    await expect(
      runDeployCommand(
        ["sudo", "switch"],
        { targetCli: "/nix/store/target/bin/paseo", waitTimeout: "1" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({ code: "DEPLOY_READINESS_TIMEOUT" });
    expect(readinessAttempts).toBeGreaterThan(0);
  });

  it("releases the lock on success so a subsequent deploy can proceed", async () => {
    const { deps, calls } = makeDeps();

    await runDeployCommand(
      ["sudo", "switch"],
      { targetCli: "/nix/store/target/bin/paseo" },
      {} as never,
      deps,
    );
    expect(calls.lockAcquired).toBe(1);
    expect(calls.lockReleased).toBe(1);
  });

  it("does not impose a default deadline on a slow healthy replacement", async () => {
    let now = 0;
    let attempts = 0;
    const { deps } = makeDeps({
      now: () => now,
      sleep: async () => {
        now += 1_000_000;
      },
      connectReadiness: async () => (++attempts === 3 ? readinessClient() : null),
    });
    const result = await runDeployCommand(
      ["activate"],
      { targetCli: "/nix/store/target/bin/paseo" },
      {} as never,
      deps,
    );
    expect(result.data.generationId).toBe("gen-1");
    expect(attempts).toBe(3);
  });

  it("reports failed restoration without waiting forever or issuing another activation", async () => {
    const { deps, calls } = makeDeps({
      connectReadiness: async () =>
        readinessClient({
          getLastServerInfoMessage: () => ({
            restartRecoveryState: "paused",
            restartRecoveryError: "native session unavailable",
          }),
        }),
    });
    await expect(
      runDeployCommand(
        ["activate"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({
      code: "DEPLOY_RECOVERY_FAILED",
      message: "native session unavailable",
    });
    expect(calls.spawnActivation).toHaveLength(1);
    expect(calls.lockReleased).toBe(1);
  });

  it("releases the lock after a failed attempt, allowing a retry", async () => {
    const { deps, calls } = makeDeps({ connectPrepare: async () => null });

    await expect(
      runDeployCommand(
        ["sudo", "switch"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toBeTruthy();
    expect(calls.lockReleased).toBe(1);

    // Retry after the lock was released succeeds.
    const second = await runDeployCommand(
      ["sudo", "switch"],
      { targetCli: "/nix/store/target/bin/paseo" },
      {} as never,
      makeDeps().deps,
    );
    expect(second.data.action).toBe("deployed");
  });

  it("closes the prepare client even when checkpoint preparation fails", async () => {
    const client = prepareClient({
      prepareRestart: async () => {
        throw new Error("boom");
      },
    });
    const close = vi.spyOn(client, "close");
    const { deps } = makeDeps({ connectPrepare: async () => client });

    await expect(
      runDeployCommand(
        ["sudo", "switch"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      ),
    ).rejects.toBeTruthy();
    expect(close).toHaveBeenCalledOnce();
  });
});
