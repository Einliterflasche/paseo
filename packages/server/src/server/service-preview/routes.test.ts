import { describe, expect, it } from "vitest";
import { PreviewRoutes } from "./routes.js";

const route = { serviceId: "atlas", port: 5173, mount: "preserve" as const };

describe("registered preview routes", () => {
  it("invalidates an approved endpoint before a replacement is available", async () => {
    const routes = new PreviewRoutes({ excludedPorts: [6767, 443] });
    routes.register(route);
    const old = routes.capture("atlas");
    if (!old) throw new Error("Expected registered route");
    routes.replace({ ...route, port: 5174 });
    expect(old.isCurrent()).toBe(false);
    await expect(old.invalidated).resolves.toBeUndefined();
    expect(routes.capture("atlas")?.route.port).toBe(5174);
    routes.replace(route);
    expect(old.isCurrent()).toBe(false);
  });

  it("does not turn a duplicate registration into endpoint replacement", () => {
    const routes = new PreviewRoutes({ excludedPorts: [] });
    routes.register(route);
    const original = routes.capture("atlas");
    expect(() => routes.register({ ...route, port: 5174 })).toThrow("route-already-registered");
    expect(original?.isCurrent()).toBe(true);
    expect(routes.capture("atlas")?.route.port).toBe(5173);
  });

  it("rejects infrastructure ports and noncanonical route identities", () => {
    const routes = new PreviewRoutes({ excludedPorts: [6767, 8443] });
    for (const port of [0, 65536, 1.5, 6767, 8443]) {
      expect(() => routes.register({ ...route, port })).toThrow();
    }
    for (const serviceId of ["", ".", "..", "../daemon", "atlas?port=6767", "atlas%2fdaemon"]) {
      expect(() => routes.register({ ...route, serviceId })).toThrow("invalid-route");
    }
    expect(routes.capture("atlas")).toBeNull();
  });

  it("copies endpoint inputs and keeps stop and shutdown terminal for old captures", async () => {
    const excludedPorts = [6767];
    const routes = new PreviewRoutes({ excludedPorts });
    excludedPorts.length = 0;
    expect(() => routes.register({ ...route, port: 6767 })).toThrow("infrastructure-port");
    const mutable = { ...route };
    routes.register(mutable);
    mutable.port = 6767;
    const approved = routes.capture("atlas");
    if (!approved) throw new Error("Expected route");
    expect(approved.route.port).toBe(5173);
    expect(Object.isFrozen(approved.route)).toBe(true);
    routes.markUnavailable("atlas");
    expect(routes.capture("atlas")).toBeNull();
    expect(approved.isCurrent()).toBe(false);
    await expect(approved.invalidated).resolves.toBeUndefined();
    routes.replace(route);
    const replacement = routes.capture("atlas");
    if (!replacement) throw new Error("Expected replacement route");
    expect(approved.isCurrent()).toBe(false);
    routes.close();
    await expect(replacement.invalidated).resolves.toBeUndefined();
    expect(replacement.isCurrent()).toBe(false);
    expect(() => routes.replace(route)).toThrow("routes-closed");
    expect(routes.capture("atlas")).toBeNull();
  });
});
