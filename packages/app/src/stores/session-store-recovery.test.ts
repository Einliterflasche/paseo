import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { selectRecoveryFailedHostIds, useSessionStore } from "./session-store";

const serverId = "recovery-test-host";
const client = new DaemonClient({ url: "ws://localhost:1", clientId: "recovery-store-test" });

afterEach(() => {
  useSessionStore.getState().clearSession(serverId);
});

describe("host recovery status", () => {
  it("shows failed hosts on any route and keeps normal restart phases out of the error banner", () => {
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client);
    const base = { serverId, hostname: "Host", version: "0.8.0" };
    for (const restartRecoveryState of ["preparing", "restoring", "running"] as const) {
      store.updateSessionServerInfo(serverId, {
        ...base,
        restartRecoveryState,
        restartRecoveryError: "Prior failure",
      });
      expect(selectRecoveryFailedHostIds(useSessionStore.getState())).toEqual([]);
    }
    store.updateSessionServerInfo(serverId, { ...base, restartRecoveryState: "paused" });
    expect(selectRecoveryFailedHostIds(useSessionStore.getState())).toEqual([]);
    store.updateSessionServerInfo(serverId, {
      ...base,
      restartRecoveryState: "paused",
      restartRecoveryError: "The checkpoint is incomplete",
    });
    expect(selectRecoveryFailedHostIds(useSessionStore.getState())).toEqual([serverId]);
  });

  it("publishes changed recovery errors and generations while the host remains paused", () => {
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client);
    const base = { serverId, hostname: "Host", version: "0.8.0" };
    const updates: unknown[] = [];
    const unsubscribe = useSessionStore.subscribe(
      (state) => state.sessions[serverId]?.serverInfo,
      (info) => updates.push(info),
    );
    const paused = {
      ...base,
      restartRecoveryState: "paused" as const,
      restartRecoveryGeneration: "generation-one",
      restartRecoveryError: "The checkpoint could not be restored",
    };
    store.updateSessionServerInfo(serverId, paused);
    store.updateSessionServerInfo(serverId, paused);
    store.updateSessionServerInfo(serverId, {
      ...paused,
      restartRecoveryError: "The checkpoint is incomplete",
    });
    store.updateSessionServerInfo(serverId, {
      ...paused,
      restartRecoveryGeneration: "generation-two",
      restartRecoveryError: "The checkpoint is incomplete",
    });
    unsubscribe();

    expect(updates).toEqual([
      paused,
      { ...paused, restartRecoveryError: "The checkpoint is incomplete" },
      {
        ...paused,
        restartRecoveryGeneration: "generation-two",
        restartRecoveryError: "The checkpoint is incomplete",
      },
    ]);
  });

  it("clears old failure details when a newer status omits them", () => {
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client);
    const base = { serverId, hostname: "Host", version: "0.8.0" };
    store.updateSessionServerInfo(serverId, {
      ...base,
      restartRecoveryState: "paused",
      restartRecoveryGeneration: "generation-one",
      restartRecoveryError: "The checkpoint could not be restored",
    });

    store.updateSessionServerInfo(serverId, { ...base, restartRecoveryState: "restoring" });
    expect(useSessionStore.getState().sessions[serverId]?.serverInfo).toEqual({
      ...base,
      restartRecoveryState: "restoring",
    });
    store.updateSessionServerInfo(serverId, { ...base, restartRecoveryState: "running" });
    expect(useSessionStore.getState().sessions[serverId]?.serverInfo).toEqual({
      ...base,
      restartRecoveryState: "running",
    });
    store.updateSessionServerInfo(serverId, base);
    expect(useSessionStore.getState().sessions[serverId]?.serverInfo).toEqual(base);
  });
});

it("shows stopping and unconfirmed stop failures without claiming paused, and clears successor details", () => {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, client);
  const base = {
    serverId,
    hostname: "Host",
    version: "0.8.0",
    restartRecoveryState: "restoring" as const,
    restartRecoveryError: "Stop failed",
    restartRecoveryGeneration: "successor",
    restartRecoveryPreviousGeneration: "original",
  };
  for (const restartRecoveryStage of ["stopping", "blocked"] as const) {
    store.updateSessionServerInfo(serverId, {
      ...base,
      restartRecoveryStage,
      restartRecoveryAffectedAgents: ["agent-a"],
    });
    expect(selectRecoveryFailedHostIds(useSessionStore.getState())).toEqual([serverId]);
    expect(useSessionStore.getState().sessions[serverId]?.serverInfo).toMatchObject({
      restartRecoveryState: "restoring",
      restartRecoveryStage,
      restartRecoveryAffectedAgents: ["agent-a"],
      restartRecoveryPreviousGeneration: "original",
    });
  }
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: "Host",
    version: "0.8.0",
    restartRecoveryState: "running",
  });
  expect(selectRecoveryFailedHostIds(useSessionStore.getState())).toEqual([]);
  expect(useSessionStore.getState().sessions[serverId]?.serverInfo).not.toHaveProperty(
    "restartRecoveryStage",
  );
  expect(useSessionStore.getState().sessions[serverId]?.serverInfo).not.toHaveProperty(
    "restartRecoveryAffectedAgents",
  );
  expect(useSessionStore.getState().sessions[serverId]?.serverInfo).not.toHaveProperty(
    "restartRecoveryPreviousGeneration",
  );
});
