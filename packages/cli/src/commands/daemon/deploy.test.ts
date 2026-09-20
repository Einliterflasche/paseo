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
  // getLastServerInfoMessage and prepareRestart default to a stateful pair: once
  // prepareRestart resolves with a generationId, the default server-info snapshot
  // reports that exact generation paused/ready, matching what requirePreparedGeneration
  // checks immediately after prepare and again after the post-prepare terminal check.
  // A test overriding getLastServerInfoMessage directly (to simulate a race or a stale
  // report) takes full precedence over this tracking. A test overriding prepareRestart
  // only (to change the returned generationId or fail) still updates the tracked
  // generation, so every existing generationId-only override keeps working unmodified.
  const {
    prepareRestart: prepareRestartOverride,
    getLastServerInfoMessage: infoOverride,
    ...rest
  } = overrides;
  let preparedGeneration: string | undefined;
  const prepareRestartImpl = prepareRestartOverride ?? (async () => ({ generationId: "gen-1" }));
  return {
    getLastServerInfoMessage:
      infoOverride ??
      (() =>
        preparedGeneration
          ? {
              features: { restartRecovery: true },
              restartRecoveryState: "paused",
              restartRecoveryStage: "ready",
              restartRecoveryGeneration: preparedGeneration,
            }
          : { features: { restartRecovery: true } }),
    listTerminals: async () => ({ terminals: [] }),
    fetchWorkspaces: async () => ({
      entries: [],
      pageInfo: { nextCursor: null, hasMore: false },
    }),
    prepareRestart: async (reason) => {
      const result = await prepareRestartImpl(reason);
      if (result.generationId) preparedGeneration = result.generationId;
      return result;
    },
    close: async () => {},
    ...rest,
  };
}

function runningServiceWorkspacePage(terminalId: string) {
  return {
    entries: [
      {
        scripts: [
          {
            type: "service" as const,
            lifecycle: "running" as const,
            terminalId,
          },
        ],
      },
    ],
    pageInfo: { nextCursor: null, hasMore: false },
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

  // Terminal/managed-service continuity veto. These test the CLI's own request/refuse
  // logic given whatever DeployPrepareClient.listTerminals() actually returns or throws.
  // They do NOT prove the daemon-side enumeration is fail-closed: terminal-session-
  // controller.ts's handleListTerminalsRequest catches enumeration errors and emits
  // terminals:[] rather than propagating them (line ~452-462), so an empty CLI-level
  // reply is not on its own proof of zero live terminals — it is equally consistent with
  // a swallowed server-side enumeration failure. That gap is root's to close server-side;
  // these tests only cover what the CLI does with the client-level outcomes it is given.
  describe("terminal/managed-service continuity veto", () => {
    it("allows running service terminals when checkpoint format 4 preserves them", async () => {
      const fetchWorkspaces = vi
        .fn<DeployPrepareClient["fetchWorkspaces"]>()
        .mockResolvedValue(runningServiceWorkspacePage("service-terminal"));
      let generation: string | undefined;
      const { deps, calls } = makeDeps({
        targetFormats: async () => [1, 2, 3, 4],
        connectPrepare: async () =>
          prepareClient({
            getLastServerInfoMessage: () => ({
              features: { restartRecovery: true },
              restartCheckpointFormat: 4,
              ...(generation
                ? {
                    restartRecoveryState: "paused",
                    restartRecoveryStage: "ready",
                    restartRecoveryGeneration: generation,
                  }
                : {}),
            }),
            listTerminals: async () => ({
              terminals: [{ id: "service-terminal", name: "web" }],
            }),
            fetchWorkspaces,
            prepareRestart: async () => {
              generation = "gen-1";
              return { generationId: generation };
            },
          }),
      });

      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).resolves.toMatchObject({ data: { action: "deployed" } });
      expect(fetchWorkspaces).toHaveBeenCalledTimes(2);
      expect(calls.spawnActivation).toEqual([["sudo", "switch"]]);
    });

    it("still refuses an ordinary terminal alongside a restorable service", async () => {
      const { deps, calls } = makeDeps({
        targetFormats: async () => [1, 2, 3, 4],
        connectPrepare: async () =>
          prepareClient({
            getLastServerInfoMessage: () => ({
              features: { restartRecovery: true },
              restartCheckpointFormat: 4,
            }),
            listTerminals: async () => ({
              terminals: [
                { id: "service-terminal", name: "web" },
                { id: "shell-terminal", name: "shell" },
              ],
            }),
            fetchWorkspaces: async () => runningServiceWorkspacePage("service-terminal"),
          }),
      });

      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).rejects.toMatchObject({
        code: "DEPLOY_TERMINALS_ACTIVE",
        details: "shell (shell-terminal)",
      });
      expect(calls.spawnActivation).toEqual([]);
    });

    it("refuses service terminals when the running daemon cannot checkpoint them", async () => {
      const fetchWorkspaces = vi.fn();
      const { deps } = makeDeps({
        connectPrepare: async () =>
          prepareClient({
            getLastServerInfoMessage: () => ({
              features: { restartRecovery: true },
              restartCheckpointFormat: 3,
            }),
            listTerminals: async () => ({
              terminals: [{ id: "service-terminal", name: "web" }],
            }),
            fetchWorkspaces,
          }),
      });

      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).rejects.toMatchObject({ code: "DEPLOY_TERMINALS_ACTIVE" });
      expect(fetchWorkspaces).not.toHaveBeenCalled();
    });

    it("refuses immediately when terminals are already active, before preparing or activating", async () => {
      const prepareRestart = vi.fn();
      const { deps, calls } = makeDeps({
        connectPrepare: async () =>
          prepareClient({
            listTerminals: async () => ({
              terminals: [{ id: "term-1", name: "install" }],
            }),
            prepareRestart,
          }),
      });
      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).rejects.toMatchObject({ code: "DEPLOY_TERMINALS_ACTIVE" });
      expect(prepareRestart).not.toHaveBeenCalled();
      expect(calls.spawnActivation).toEqual([]);
    });

    it("refuses activation when a terminal starts during preparation (post-prepare check catches the race)", async () => {
      let calls = 0;
      const { deps, calls: depCalls } = makeDeps({
        connectPrepare: async () =>
          prepareClient({
            listTerminals: async () => {
              calls += 1;
              // Empty before prepare, active by the post-prepare recheck: the exact
              // race the second requireNoTerminals call exists to close.
              return calls === 1
                ? { terminals: [] }
                : { terminals: [{ id: "term-2", name: "race-started" }] };
            },
          }),
      });
      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).rejects.toMatchObject({ code: "DEPLOY_TERMINALS_ACTIVE" });
      expect(calls).toBe(2);
      expect(depCalls.spawnActivation).toEqual([]);
    });

    it("never activates when the post-prepare terminal query itself fails", async () => {
      let calls = 0;
      const { deps, calls: depCalls } = makeDeps({
        connectPrepare: async () =>
          prepareClient({
            listTerminals: async () => {
              calls += 1;
              if (calls === 1) return { terminals: [] };
              throw new Error("terminal worker IPC timed out");
            },
          }),
      });
      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).rejects.toMatchObject({ code: "DEPLOY_TERMINAL_INSPECTION_FAILED" });
      expect(calls).toBe(2);
      expect(depCalls.spawnActivation).toEqual([]);
    });

    it("refuses activation when the reported generation changes between the two post-prepare checks", async () => {
      let infoCalls = 0;
      const { deps, calls } = makeDeps({
        connectPrepare: async () =>
          prepareClient({
            getLastServerInfoMessage: () => {
              infoCalls += 1;
              // First requirePreparedGeneration call (right after prepare+validateTarget)
              // sees the prepared generation; the second (after the post-prepare
              // requireNoTerminals) sees a different one, as if another prepare/replace
              // cycle raced this one.
              return infoCalls === 1
                ? {
                    features: { restartRecovery: true },
                    restartRecoveryState: "paused",
                    restartRecoveryStage: "ready",
                    restartRecoveryGeneration: "gen-1",
                  }
                : {
                    features: { restartRecovery: true },
                    restartRecoveryState: "paused",
                    restartRecoveryStage: "ready",
                    restartRecoveryGeneration: "gen-2",
                  };
            },
          }),
      });
      await expect(
        runDeployCommand(
          ["sudo", "switch"],
          { targetCli: "/nix/store/target/bin/paseo" },
          {} as never,
          deps,
        ),
      ).rejects.toMatchObject({ code: "DEPLOY_PREPARATION_CHANGED" });
      expect(calls.spawnActivation).toEqual([]);
    });

    it("deploys normally with zero terminal inventory confirmed against the same exact generation twice", async () => {
      let calls = 0;
      const { deps, calls: depCalls } = makeDeps({
        connectPrepare: async () =>
          prepareClient({
            listTerminals: async () => {
              calls += 1;
              return { terminals: [] };
            },
          }),
      });
      const result = await runDeployCommand(
        ["sudo", "switch"],
        { targetCli: "/nix/store/target/bin/paseo" },
        {} as never,
        deps,
      );
      expect(calls).toBe(2);
      expect(depCalls.spawnActivation).toEqual([["sudo", "switch"]]);
      expect(result.data).toMatchObject({ action: "deployed", generationId: "gen-1" });
    });
  });
});
