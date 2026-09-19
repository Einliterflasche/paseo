import { describe, expect, it } from "vitest";
import { PreviewRoutes } from "./routes.js";
import { PreviewSources } from "./sources.js";
import { PreviewBroker } from "./broker.js";

const descriptor = {
  serviceId: "atlas",
  name: "Atlas React",
  workspaceId: "workspace-a",
  scriptName: "web",
  port: 5173,
  available: true,
  revision: expect.any(String),
};

describe("preview registry catalog", () => {
  it("keeps a binding revision stable until replacement and never reuses its previous revision", () => {
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const registration = { serviceId: "atlas", port: 5173, mount: "preserve" as const };
    routes.register(registration);
    const first = routes.describe()[0].revision;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(routes.describe()[0].revision).toBe(first);
    routes.markUnavailable("atlas");
    expect(routes.describe()[0].revision).toBe(first);
    routes.replace(registration);
    const second = routes.describe()[0].revision;
    expect(second).not.toBe(first);
    routes.replace(registration);
    const third = routes.describe()[0].revision;
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it("publishes broker shutdown once and releases its route subscription", () => {
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const sources = new PreviewSources("https://control.test");
    const broker = new PreviewBroker({ sources, routes, onFailure: () => undefined });
    routes.register({
      serviceId: "atlas",
      name: "Atlas React",
      workspaceId: "workspace-a",
      scriptName: "web",
      port: 5173,
      mount: "preserve",
    });
    const events: ReturnType<PreviewBroker["describe"]>[] = [];
    broker.subscribeCatalog(() => events.push(broker.describe()));
    broker.close();
    expect(events).toEqual([
      {
        version: 1,
        origin: "https://control.test",
        services: [{ ...descriptor, available: false }],
      },
    ]);
    broker.close();
    routes.replace({ serviceId: "atlas", port: 5180, mount: "preserve" });
    expect(events).toHaveLength(1);
    expect(broker.describe().services[0].available).toBe(false);
  });

  it("copies registration metadata and returns a detached public description", () => {
    const routes = new PreviewRoutes({ excludedPorts: [6767] });
    const registration = {
      serviceId: "atlas",
      name: "Atlas React",
      workspaceId: "workspace-a",
      scriptName: "web",
      port: 5173,
      mount: "preserve" as const,
    };
    routes.register(registration);
    registration.name = "changed outside registry";
    registration.port = 6767;
    registration.workspaceId = "other-workspace";
    const first = routes.describe();
    expect(first).toEqual([descriptor]);
    first[0].name = "changed returned snapshot";
    first[0].port = 6767;
    expect(routes.describe()).toEqual([descriptor]);
    expect(routes.capture("atlas")?.route.port).toBe(5173);
  });

  it("publishes committed replacement and availability changes with old captures already invalid", async () => {
    const routes = new PreviewRoutes({ excludedPorts: [] });
    routes.register({ serviceId: "atlas", port: 5173, mount: "preserve" });
    const old = routes.capture("atlas");
    if (!old) throw new Error("Expected route");
    const events: { current: boolean; services: ReturnType<PreviewRoutes["describe"]> }[] = [];
    const unsubscribe = routes.subscribe(() =>
      events.push({ current: old.isCurrent(), services: routes.describe() }),
    );
    routes.replace({
      serviceId: "atlas",
      name: "Atlas React",
      workspaceId: "workspace-a",
      scriptName: "web",
      port: 5173,
      mount: "strip",
    });
    expect(events).toEqual([{ current: false, services: [descriptor] }]);
    await old.invalidated;
    const replacement = routes.capture("atlas");
    if (!replacement) throw new Error("Expected replacement");
    routes.markUnavailable("atlas");
    expect(events[1]).toEqual({ current: false, services: [{ ...descriptor, available: false }] });
    expect(replacement.isCurrent()).toBe(false);
    await replacement.invalidated;
    unsubscribe();
    routes.replace({ serviceId: "atlas", port: 5174, mount: "preserve" });
    expect(events).toHaveLength(2);
    expect(old.isCurrent()).toBe(false);
    expect(replacement.isCurrent()).toBe(false);
    routes.close();
    expect(routes.describe()).toEqual([
      {
        serviceId: "atlas",
        name: "atlas",
        workspaceId: null,
        scriptName: null,
        port: 5174,
        available: false,
        revision: expect.any(String),
      },
    ]);
  });

  it("publishes broker catalogs for registered routes without disclosing authority", () => {
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const sources = new PreviewSources("https://control.test");
    const broker = new PreviewBroker({ sources, routes, onFailure: () => undefined });
    const events: ReturnType<PreviewBroker["describe"]>[] = [];
    const unsubscribe = broker.subscribeCatalog(() => events.push(broker.describe()));
    expect(broker.describe()).toEqual({ version: 1, origin: "https://control.test", services: [] });
    routes.register({
      serviceId: "atlas",
      name: "Atlas React",
      workspaceId: "workspace-a",
      scriptName: "web",
      port: 5173,
      mount: "preserve",
    });
    expect(events).toEqual([
      { version: 1, origin: "https://control.test", services: [descriptor] },
    ]);
    routes.close();
    expect(events.at(-1)).toEqual({
      version: 1,
      origin: "https://control.test",
      services: [{ ...descriptor, available: false }],
    });
    unsubscribe();
    broker.close();
    expect(events).toHaveLength(2);
  });
});
