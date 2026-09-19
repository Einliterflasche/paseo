import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import { useSessionStore, type DaemonServerInfo } from "./session-store";

const hostA = "preview-metadata-host-a";
const hostB = "preview-metadata-host-b";
const clients: DaemonClient[] = [];

function initialize(serverId: string) {
  // The real client supplies the store's existing client dependency. This test
  // never connects it or starts a transport, provider, timer, or paid API call.
  const client = new DaemonClient({ url: "ws://fixture.invalid/ws", clientId: serverId });
  clients.push(client);
  useSessionStore.getState().initializeSession(serverId, client);
}

function metadata(serviceId = "atlas"): NonNullable<ServerInfoStatusPayload["servicePreviews"]> {
  return {
    version: 1,
    origin: "https://paseo.example.test",
    services: [
      {
        serviceId,
        name: "Atlas React",
        workspaceId: "workspace-one",
        scriptName: "dev",
        port: 5173,
        available: true,
      },
    ],
  };
}

function info(
  serverId: string,
  servicePreviews?: ServerInfoStatusPayload["servicePreviews"],
): DaemonServerInfo {
  return {
    serverId,
    hostname: "fixture",
    version: "1.2.3",
    ...(servicePreviews ? { servicePreviews } : {}),
  };
}

afterEach(async () => {
  useSessionStore.getState().clearSession(hostA);
  useSessionStore.getState().clearSession(hostB);
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("session preview metadata", () => {
  it("publishes metadata-only changes without requiring other server information to change", () => {
    initialize(hostA);
    const received: Array<ServerInfoStatusPayload["servicePreviews"]> = [];
    const stop = useSessionStore.subscribe(
      (state) => state.sessions[hostA]?.serverInfo?.servicePreviews,
      (value) => received.push(value),
    );
    try {
      useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA));
      useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA, metadata()));
      const unavailable = metadata();
      unavailable.services[0].available = false;
      useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA, unavailable));

      expect(received).toEqual([metadata(), unavailable]);
      expect(useSessionStore.getState().sessions[hostA].serverInfo).toEqual(
        info(hostA, unavailable),
      );
    } finally {
      stop();
    }
  });

  it("preserves the session object when an equivalent metadata snapshot is delivered again", () => {
    initialize(hostA);
    useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA, metadata()));
    const before = useSessionStore.getState().sessions[hostA];

    useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA, metadata()));

    expect(useSessionStore.getState().sessions[hostA]).toBe(before);
  });

  it("removes old previews when later server info omits the optional field", () => {
    initialize(hostA);
    useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA, metadata()));

    useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA));

    expect(useSessionStore.getState().sessions[hostA].serverInfo).toEqual(info(hostA));
    expect(useSessionStore.getState().sessions[hostA].serverInfo).not.toHaveProperty(
      "servicePreviews",
    );
  });

  it("keeps host metadata isolated and does not inherit it when a cleared session is recreated", () => {
    initialize(hostA);
    initialize(hostB);
    useSessionStore.getState().updateSessionServerInfo(hostA, info(hostA, metadata("atlas-a")));
    useSessionStore.getState().updateSessionServerInfo(hostB, info(hostB, metadata("atlas-b")));
    const other = useSessionStore.getState().sessions[hostB];

    useSessionStore.getState().clearSession(hostA);
    initialize(hostA);

    expect(useSessionStore.getState().sessions[hostA].serverInfo).toBeNull();
    expect(useSessionStore.getState().sessions[hostB]).toBe(other);
    expect(other.serverInfo?.servicePreviews).toEqual(metadata("atlas-b"));
  });
});
