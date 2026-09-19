import { describe, expect, it, vi } from "vitest";
import {
  runRestartCommand,
  type RestartCommandDependencies,
  type RestartDaemonClient,
} from "./restart.js";
import type {
  DaemonStartOptions,
  DetachedStartResult,
  LocalDaemonState,
  StopLocalDaemonOptions,
  StopLocalDaemonResult,
} from "./local-daemon.js";

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

function makeDeps(overrides: Partial<RestartCommandDependencies> = {}): {
  deps: RestartCommandDependencies;
  calls: { stop: StopLocalDaemonOptions[]; start: DaemonStartOptions[]; connect: number };
} {
  const calls = {
    stop: [] as StopLocalDaemonOptions[],
    start: [] as DaemonStartOptions[],
    connect: 0,
  };
  const deps: RestartCommandDependencies = {
    resolveState: () => baseState(),
    connect: async () => {
      calls.connect += 1;
      return null;
    },
    stop: async (options) => {
      calls.stop.push(options);
      return {
        action: "stopped",
        home: "/home/test/.paseo",
        pid: 4242,
        forced: options.force === true,
        usedLifecycleRpc: false,
        reason: "owner_pid_signal",
        message: "stopped",
      } satisfies StopLocalDaemonResult;
    },
    start: async (options) => {
      calls.start.push(options);
      return { pid: 9999, logPath: "/home/test/.paseo/daemon.log" } satisfies DetachedStartResult;
    },
    ...overrides,
  };
  return { deps, calls };
}

function stubClient(overrides: Partial<RestartDaemonClient> = {}): RestartDaemonClient {
  return {
    getLastServerInfoMessage: () => ({ features: { restartRecovery: true } }),
    restartServer: async () => ({ generationId: "gen-1" }),
    retryRecovery: async () => ({ generationId: "successor-1" }),
    acknowledgeCrash: async () => ({ generationId: "crash-successor-1" }),
    close: async () => {},
    ...overrides,
  };
}

describe("runRestartCommand", () => {
  it("acknowledges the exact consumed generation without replacing the daemon", async () => {
    const client = stubClient();
    const acknowledge = vi.spyOn(client, "acknowledgeCrash");
    const restart = vi.spyOn(client, "restartServer");
    const { deps, calls } = makeDeps({ connect: async () => client });
    const result = await runRestartCommand(
      { acknowledgeCrash: "consumed", orphanExecutionReconciled: true },
      {} as never,
      deps,
    );
    expect(result.data).toMatchObject({
      action: "crash_acknowledged",
      generationId: "crash-successor-1",
    });
    expect(acknowledge).toHaveBeenCalledWith("consumed", true);
    expect(restart).not.toHaveBeenCalled();
    expect(calls.start).toEqual([]);
    expect(calls.stop).toEqual([]);
  });
  it.each([
    { acknowledgeCrash: "consumed" },
    { acknowledgeCrash: "consumed", orphanExecutionReconciled: true, force: true },
    { acknowledgeCrash: "consumed", orphanExecutionReconciled: true, retryRecovery: true },
    { orphanExecutionReconciled: true },
  ])(
    "rejects incomplete or conflicting crash acknowledgment before connecting: %j",
    async (options) => {
      const { deps, calls } = makeDeps();
      await expect(runRestartCommand(options, {} as never, deps)).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
      expect(calls.connect).toBe(0);
      expect(calls.start).toEqual([]);
      expect(calls.stop).toEqual([]);
    },
  );
  it("does not start a daemon for crash acknowledgment", async () => {
    const { deps, calls } = makeDeps({
      resolveState: () => baseState({ running: false, pidInfo: null }),
    });
    await expect(
      runRestartCommand(
        { acknowledgeCrash: "consumed", orphanExecutionReconciled: true },
        {} as never,
        deps,
      ),
    ).rejects.toMatchObject({ code: "DAEMON_NOT_RUNNING" });
    expect(calls.start).toEqual([]);
  });
  it("retries the current recovery without replacing the process", async () => {
    const client = stubClient();
    const restart = vi.spyOn(client, "restartServer");
    const { deps, calls } = makeDeps({ connect: async () => client });
    const result = await runRestartCommand({ retryRecovery: true }, {} as never, deps);
    expect(result.data).toMatchObject({ action: "recovery_retried", generationId: "successor-1" });
    expect(restart).not.toHaveBeenCalled();
    expect(calls.stop).toEqual([]);
    expect(calls.start).toEqual([]);
  });
  it("refuses to start a new process for a retry of retained recovery state", async () => {
    const { deps, calls } = makeDeps({
      resolveState: () => baseState({ pidInfo: null, running: false }),
    });
    await expect(
      runRestartCommand({ retryRecovery: true }, {} as never, deps),
    ).rejects.toMatchObject({ code: "DAEMON_NOT_RUNNING" });
    expect(calls.start).toEqual([]);
  });
  it("refuses forced replacement in a recovery retry", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      runRestartCommand({ retryRecovery: true, force: true }, {} as never, deps),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(calls.stop).toEqual([]);
  });
  it("starts fresh without any RPC when the daemon is not running", async () => {
    const { deps, calls } = makeDeps({
      resolveState: () => baseState({ pidInfo: null, running: false, stalePidFile: false }),
    });

    const result = await runRestartCommand({}, {} as never, deps);

    expect(result.data.action).toBe("started");
    expect(calls.connect).toBe(0);
    expect(calls.stop).toHaveLength(0);
  });

  it("requests a controlled restart and returns the checkpoint generation", async () => {
    const client = stubClient();
    const restartServer = vi.spyOn(client, "restartServer");
    const { deps, calls } = makeDeps({
      connect: async () => client,
    });

    const result = await runRestartCommand({ reason: "deploy" }, {} as never, deps);

    expect(result.data).toMatchObject({ action: "restart_requested", generationId: "gen-1" });
    expect(restartServer).toHaveBeenCalledWith("deploy");
    expect(calls.stop).toHaveLength(0);
    expect(calls.start).toHaveLength(0);
  });

  it("never kills an unreachable running daemon", async () => {
    const { deps, calls } = makeDeps({ connect: async () => null });

    await expect(runRestartCommand({}, {} as never, deps)).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
    });
    expect(calls.stop).toHaveLength(0);
    expect(calls.start).toHaveLength(0);
  });

  it("refuses a daemon that does not advertise restart-recovery support, without falling back", async () => {
    const client = stubClient({
      getLastServerInfoMessage: () => ({ features: { restartRecovery: false } }),
    });
    const { deps, calls } = makeDeps({ connect: async () => client });

    await expect(runRestartCommand({}, {} as never, deps)).rejects.toMatchObject({
      code: "RESTART_UNSUPPORTED",
    });
    expect(calls.stop).toHaveLength(0);
    expect(calls.start).toHaveLength(0);
  });

  it("surfaces a failed checkpoint request without an implicit force fallback", async () => {
    const client = stubClient({
      restartServer: async () => {
        throw new Error("checkpoint write failed");
      },
    });
    const { deps, calls } = makeDeps({ connect: async () => client });

    await expect(runRestartCommand({}, {} as never, deps)).rejects.toMatchObject({
      code: "RESTART_FAILED",
    });
    expect(calls.stop).toHaveLength(0);
    expect(calls.start).toHaveLength(0);
  });

  it("closes the client connection even when the restart request fails", async () => {
    const client = stubClient({
      restartServer: async () => {
        throw new Error("boom");
      },
    });
    const close = vi.spyOn(client, "close");
    const { deps } = makeDeps({ connect: async () => client });

    await expect(runRestartCommand({}, {} as never, deps)).rejects.toBeTruthy();
    expect(close).toHaveBeenCalledOnce();
  });

  it("--force uses a raw stop/start and never calls the restart RPC", async () => {
    const { deps, calls } = makeDeps();
    const connect = vi.fn(deps.connect);

    const result = await runRestartCommand({ force: true }, {} as never, { ...deps, connect });

    expect(result.data.action).toBe("restarted");
    expect(connect).not.toHaveBeenCalled();
    expect(calls.stop).toEqual([{ home: undefined, timeoutMs: 15000, force: true }]);
    expect(calls.start).toHaveLength(1);
  });

  it("rejects an invalid --timeout before touching the daemon", async () => {
    const { deps, calls } = makeDeps();

    await expect(
      runRestartCommand({ timeout: "not-a-number" }, {} as never, deps),
    ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    expect(calls.connect).toBe(0);
  });

  it("rejects --listen combined with --port before touching the daemon", async () => {
    const { deps, calls } = makeDeps();

    await expect(
      runRestartCommand({ listen: "127.0.0.1:7000", port: "7000" }, {} as never, deps),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(calls.connect).toBe(0);
  });
});
