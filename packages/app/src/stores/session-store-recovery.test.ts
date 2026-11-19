import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, it } from "vitest";
import { toDaemonServerInfo, useSessionStore } from "./session-store";

const serverId = "recovery-test-host";
const client = new DaemonClient({ url: "ws://localhost:1", clientId: "recovery-store-test" });

afterEach(() => {
  useSessionStore.getState().clearSession(serverId);
});

it("publishes each restart phase for the queue-drain gate and drops legacy recovery details", () => {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, client);
  const base = { serverId, hostname: "Host", version: "0.8.0" };
  const status = { status: "server_info" as const, ...base };
  const updates: unknown[] = [];
  const unsubscribe = useSessionStore.subscribe(
    (state) => state.sessions[serverId]?.serverInfo,
    (info) => updates.push(info),
  );

  store.updateSessionServerInfo(
    serverId,
    toDaemonServerInfo({
      ...status,
      restartRecoveryState: "preparing",
      restartRecoveryStage: "checkpointing",
      restartRecoveryGeneration: "generation-one",
    }),
  );
  // An older daemon can still send the paused failure fields.
  store.updateSessionServerInfo(
    serverId,
    toDaemonServerInfo({
      ...status,
      restartRecoveryState: "restoring",
      restartRecoveryStage: "starting",
      restartRecoveryError: "The checkpoint could not be restored",
      restartRecoveryPreviousGeneration: "generation-zero",
      restartRecoveryAffectedAgents: ["agent-one"],
      restartAnywayId: "replacement-1",
    }),
  );
  store.updateSessionServerInfo(
    serverId,
    toDaemonServerInfo({ ...status, restartRecoveryState: "restoring" }),
  );
  store.updateSessionServerInfo(
    serverId,
    toDaemonServerInfo({ ...status, restartRecoveryState: "running" }),
  );
  store.updateSessionServerInfo(serverId, toDaemonServerInfo(status));
  unsubscribe();

  expect(updates).toEqual([
    { ...base, restartRecoveryState: "preparing" },
    { ...base, restartRecoveryState: "restoring" },
    { ...base, restartRecoveryState: "running" },
    base,
  ]);
});
