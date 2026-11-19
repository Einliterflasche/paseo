import { describe, expect, it, vi } from "vitest";
import {
  runRestartCommand,
  type RestartCommandDependencies,
  type RestartDaemonClient,
} from "./restart.js";
import type { CommandOptions } from "../../output/index.js";

function peer(pid: number, generation?: string, state: string | undefined = "running") {
  const info: Record<string, unknown> = {
    serverId: "same-host",
    restartRecoveryGeneration: generation,
    restartRecoveryState: state,
    features: { restartRecovery: true },
  };
  const release = vi.fn(async () => {});
  const client = {
    getLastServerInfoMessage: () => info,
    getDaemonStatus: async () => ({ pid }),
    observeEvents: vi.fn(() => ({ ready: Promise.resolve({}), release })),
    restartServer: vi.fn(
      async (): Promise<{ generationId?: string }> => ({
        generationId: "prepared",
      }),
    ),
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
  it("reports a restored checkpoint when the replacement runs the returned generation", async () => {
    const before = peer(10, "previous");
    const after = peer(11, "prepared");
    const { deps } = dependencies(before.client, after.client);
    const result = await runRestartCommand({ ...options, reason: "deploy" }, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      generationId: "prepared",
      checkpointRestored: true,
      acknowledged: true,
      previousWorkerPid: 10,
      workerPid: 11,
    });
    expect(result.schema.renderHuman?.()).toContain("Checkpoint prepared restored.");
    expect(before.calls.restartServer).toHaveBeenCalledWith("deploy", undefined, { timeout: 100 });
    expect(before.calls.observeEvents).toHaveBeenCalledWith(["status.server_info"]);
    expect(before.release).toHaveBeenCalledOnce();
    expect(before.calls.close).toHaveBeenCalledOnce();
    expect(after.calls.close).toHaveBeenCalledOnce();
  });

  it("confirms a running replacement that started without the returned generation", async () => {
    const before = peer(10, "previous");
    const after = peer(11, "previous");
    const { deps } = dependencies(before.client, after.client);
    const result = await runRestartCommand(options, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      generationId: "prepared",
      checkpointRestored: false,
      workerPid: 11,
    });
    expect(result.schema.renderHuman?.()).toContain("No checkpoint restored");
  });

  it("waits for the replacement when the request returns no generation", async () => {
    const before = peer(10, "previous");
    before.calls.restartServer.mockResolvedValueOnce({});
    const after = peer(11, "previous");
    const { deps, connect } = dependencies(before.client, after.client);
    const result = await runRestartCommand(options, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      generationId: undefined,
      checkpointRestored: false,
      acknowledged: true,
      workerPid: 11,
    });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("restarts a daemon that reports no recovery fields", async () => {
    const before = peer(10, undefined, undefined);
    before.info.features = {};
    before.calls.restartServer.mockResolvedValueOnce({});
    const after = peer(11, undefined, undefined);
    after.info.features = {};
    const { deps } = dependencies(before.client, after.client);
    const result = await runRestartCommand(options, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      checkpointRestored: false,
      previousWorkerPid: 10,
      workerPid: 11,
    });
  });

  it("confirms the replacement after the connection drops during the request", async () => {
    const before = peer(10, "previous");
    before.calls.restartServer.mockImplementationOnce(async () => {
      before.info.restartRecoveryState = "paused";
      before.info.restartRecoveryGeneration = "prepared";
      throw { code: "DAEMON_CONNECTION_LOST" };
    });
    const after = peer(11, "prepared");
    const { deps } = dependencies(before.client, after.client);
    const result = await runRestartCommand(options, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      acknowledged: false,
      generationId: "prepared",
      checkpointRestored: true,
      workerPid: 11,
    });
    expect(before.calls.close).toHaveBeenCalledOnce();
  });

  it("waits while the previous worker still holds the checkpoint during handover", async () => {
    const before = peer(10, "previous");
    const draining = peer(10, "prepared", "paused");
    const restoring = peer(11, "prepared", "restoring");
    const after = peer(11, "prepared");
    const { deps } = dependencies(before.client, draining.client, restoring.client, after.client);
    const result = await runRestartCommand({ ...options, timeout: "1" }, {} as never, deps);
    expect(result.data).toMatchObject({
      action: "restarted",
      checkpointRestored: true,
      previousWorkerPid: 10,
      workerPid: 11,
    });
    expect(draining.calls.close).toHaveBeenCalledOnce();
    expect(restoring.calls.close).toHaveBeenCalledOnce();
  });

  it("reports the stalled previous worker when no replacement takes over", async () => {
    const before = peer(10, "previous");
    const stalled = peer(10, "prepared", "paused");
    const { deps } = dependencies(before.client, stalled.client);
    await expect(runRestartCommand(options, {} as never, deps)).rejects.toMatchObject({
      code: "RESTART_NOT_CONFIRMED",
      message: expect.stringContaining(
        "Last observation: Previous worker 10 reports paused on generation prepared",
      ),
    });
  });
});
