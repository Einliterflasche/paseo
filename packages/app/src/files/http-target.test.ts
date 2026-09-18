import { describe, expect, it } from "vitest";
import { fileGrantUrl, resolveFileHttpTarget } from "./http-target";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostProfile } from "@/types/host-connection";

const host: HostProfile = {
  serverId: "host",
  label: "Host",
  appearance: defaultHostAppearance(),
  lifecycle: {},
  createdAt: "",
  updatedAt: "",
  preferredConnectionId: "local",
  connections: [
    { id: "local", type: "directTcp", endpoint: "localhost:6767" },
    {
      id: "public",
      type: "directTcp",
      endpoint: "sample.example:8443",
      useTls: true,
      password: "never-in-the-url",
    },
    { id: "relay", type: "relay", relayEndpoint: "relay.example", daemonPublicKeyB64: "key" },
  ],
};

describe("file HTTP target", () => {
  it("uses the active address, TLS and explicit port, never the first or preferred connection", () => {
    const target = resolveFileHttpTarget(host, "public");
    expect(target).toEqual({
      origin: "https://sample.example:8443",
      credentials: null,
      authHeader: null,
    });
    expect(fileGrantUrl(target, "preview", "token&with?characters")).toBe(
      "https://sample.example:8443/api/files/preview?token=token%26with%3Fcharacters",
    );
    expect(fileGrantUrl(target, "download", "grant")).toBe(
      "https://sample.example:8443/api/files/download?token=grant",
    );
  });
  it("preserves an active plain HTTP endpoint", () => {
    expect(resolveFileHttpTarget(host, "local").origin).toBe("http://localhost:6767");
  });
  it.each([null, "missing", "relay"])(
    "refuses arbitrary saved-address fallback for %s",
    (active) => {
      expect(() => resolveFileHttpTarget(host, active)).toThrow("active direct connection");
    },
  );
});
