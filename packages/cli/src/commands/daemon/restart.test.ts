import { describe, expect, it, vi } from "vitest";
import {
  runRestartCommand,
  type RestartCommandDependencies,
  type RestartDaemonClient,
} from "./restart.js";
import type { CommandOptions } from "../../output/index.js";

function peer(pid: number, generation = "previous", state = "running") {
  const info = {
    serverId: "same-host",
    restartRecoveryGeneration: generation,
    restartRecoveryState: state,
    features: {
      restartRecovery: true,
      restartRecoveryRetry: true,
      restartCrashAcknowledgment: true,
    },
  };
  const release = vi.fn(async () => {});
  const client = {
    getLastServerInfoMessage: () => info,
    getDaemonStatus: async () => ({ pid }),
    observeEvents: vi.fn(() => ({ ready: Promise.resolve({}), release })),
    restartServer: vi.fn(async () => ({ generationId: "prepared" })),
    retryRecovery: vi.fn(async () => {
      info.restartRecoveryGeneration = "recovered";
      info.restartRecoveryState = "running";
      return { generationId: "recovered" };
    }),
    acknowledgeCrash: vi.fn(async () => {
      info.restartRecoveryGeneration = "reconciled";
      info.restartRecoveryState = "running";
      return { generationId: "reconciled" };
    }),
    close: vi.fn(async () => {}),
  };
  return { client: client as unknown as RestartDaemonClient, calls: client, info, release };
}

function dependencies(...clients: RestartDaemonClient[]) {
  let now = 0;
  const connect = vi.fn(async () => {
    const client = clients.length > 1 ? clients.shift() : clients[0];
    if (!client) throw { code: "DAEMON_UNREACHABLE" };
    return client;
  });
  const deps: RestartCommandDependencies = {
    connect,
    readInstance: async () => null,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return { deps, connect };
}
const options = {
  daemonTarget: { kind: "endpoint", host: "127.0.0.1:6767" },
  timeout: "0.1",
} as CommandOptions;

describe("controlled restart CLI", () => {
  it("confirms the exact checkpoint generation on the replacement worker", async () => {
    const before = peer(10);
    const after = peer(11, "prepared");
    const { deps } = dependencies(before.client, after.client);
    const result = await runRestartCommand({ ...options, reason: "deploy" }, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      generationId: "prepared",
      previousWorkerPid: 10,
      workerPid: 11,
    });
    expect(before.calls.restartServer).toHaveBeenCalledWith("deploy", undefined, { timeout: 100 });
    expect(before.calls.observeEvents).toHaveBeenCalledWith(["status.server_info"]);
    expect(before.release).toHaveBeenCalledOnce();
    expect(before.calls.close).toHaveBeenCalledOnce();
    expect(after.calls.close).toHaveBeenCalledOnce();
  });

  it("a listening replacement with another generation cannot report success", async () => {
    const before = peer(10);
    const after = peer(11, "another");
    const { deps } = dependencies(before.client, after.client);
    await expect(runRestartCommand(options, {} as never, deps)).rejects.toMatchObject({
      code: "RESTART_NOT_CONFIRMED",
    });
    expect(before.calls.restartServer).toHaveBeenCalledOnce();
  });

  it("retains the failed checkpoint and surfaces paused restoration", async () => {
    const before = peer(10);
    const after = peer(11, "prepared", "paused");
    const { deps } = dependencies(before.client, after.client);
    await expect(runRestartCommand(options, {} as never, deps)).rejects.toMatchObject({
      code: "RESTART_RECOVERY_FAILED",
    });
    expect(after.calls.close).toHaveBeenCalledOnce();
  });

  it("checkpoint preparation failure does not initiate another connection or replacement", async () => {
    const before = peer(10);
    before.calls.restartServer.mockRejectedValueOnce(new Error("checkpoint write failed"));
    const { deps, connect } = dependencies(before.client);
    await expect(runRestartCommand(options, {} as never, deps)).rejects.toThrow(
      "checkpoint write failed",
    );
    expect(connect).toHaveBeenCalledOnce();
    expect(before.release).toHaveBeenCalledOnce();
    expect(before.calls.close).toHaveBeenCalledOnce();
  });

  it("retries retained recovery without replacing the current worker", async () => {
    const current = peer(10, "failed", "paused");
    const { deps, connect } = dependencies(current.client);
    const result = await runRestartCommand({ ...options, retryRecovery: true }, {} as never, deps);
    expect(result.data).toEqual({ action: "recovery_retried", generationId: "recovered" });
    expect(current.calls.restartServer).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("acknowledges the exact consumed generation only with reconciliation", async () => {
    const current = peer(10, "consumed", "paused");
    const { deps } = dependencies(current.client);
    const result = await runRestartCommand(
      { ...options, acknowledgeCrash: "consumed", orphanExecutionReconciled: true },
      {} as never,
      deps,
    );
    expect(current.calls.acknowledgeCrash).toHaveBeenCalledWith("consumed", true);
    expect(result.data).toEqual({ action: "crash_acknowledged", generationId: "reconciled" });
    expect(current.calls.restartServer).not.toHaveBeenCalled();
  });

  it.each([
    { acknowledgeCrash: "consumed" },
    { orphanExecutionReconciled: true },
    { acknowledgeCrash: "consumed", orphanExecutionReconciled: true, retryRecovery: true },
    { force: true },
  ])("rejects conflicting or incomplete recovery options before connecting: %j", async (extra) => {
    const { deps, connect } = dependencies();
    await expect(
      runRestartCommand({ ...options, ...extra }, {} as never, deps),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(connect).not.toHaveBeenCalled();
  });
});
