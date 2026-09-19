import { describe, expect, it } from "vitest";
import type { ServerInfoStatusPayload, WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { buildServiceCatalog, type CatalogWorkspace } from "./catalog";

const web: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "private-name",
  port: 3000,
  proxyUrl: "https://legacy.example.test",
  localProxyUrl: "http://web.localhost",
  publicProxyUrl: "https://public.example.test",
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: "terminal-1",
};

function workspace(id: string): CatalogWorkspace {
  return {
    id,
    name: "main",
    title: null,
    projectDisplayName: "Example",
    archivingAt: null,
    scripts: [web, { ...web, scriptName: "test", type: "script" }],
  };
}

const previews: NonNullable<ServerInfoStatusPayload["servicePreviews"]> = {
  version: 1,
  origin: "https://paseo.example.test",
  services: [
    {
      serviceId: "registered-web",
      name: "Web application",
      workspaceId: "one",
      scriptName: "web",
      port: 3000,
      available: true,
    },
  ],
};

describe("managed service catalog", () => {
  it("keeps identity across status, title and port changes while separating hosts and workspaces", () => {
    const input = workspace("one");
    const [initial] = buildServiceCatalog({ serverId: "a", workspaces: [input] });
    const [changed] = buildServiceCatalog({
      serverId: "a",
      workspaces: [
        {
          ...input,
          title: "Renamed",
          scripts: [{ ...web, lifecycle: "stopped", health: null, port: null, terminalId: null }],
        },
      ],
    });
    expect(changed.id).toBe(initial.id);
    expect(changed.workspaceName).toBe("Renamed");
    expect(changed.lifecycle).toBe("stopped");
    const [otherHost] = buildServiceCatalog({ serverId: "b", workspaces: [input] });
    const [otherWorkspace] = buildServiceCatalog({ serverId: "a", workspaces: [workspace("two")] });
    expect(new Set([initial.id, otherHost.id, otherWorkspace.id]).size).toBe(3);
  });

  it("removes archiving workspaces and leaves the source directory intact", () => {
    const input = workspace("one");
    const scripts = input.scripts.slice();
    expect(
      buildServiceCatalog({
        serverId: "a",
        workspaces: [{ ...input, archivingAt: "2026-09-18T00:00:00Z" }],
      }),
    ).toEqual([]);
    expect(input.scripts).toEqual(scripts);
  });

  it("projects configured services without inheriting legacy exposure links", () => {
    expect(buildServiceCatalog({ serverId: "host", workspaces: [workspace("workspace")] })).toEqual(
      [
        {
          id: '["host","workspace","web"]',
          workspaceId: "workspace",
          workspaceName: "main",
          projectName: "Example",
          scriptName: "web",
          port: 3000,
          lifecycle: "running",
          health: "healthy",
          exitCode: null,
          terminalId: "terminal-1",
        },
      ],
    );
  });

  it("attaches a registered preview only to its exact managed workspace script", () => {
    const entries = buildServiceCatalog({
      serverId: "host",
      workspaces: [workspace("one"), workspace("two")],
      previews: {
        ...previews,
        services: [
          ...previews.services,
          { ...previews.services[0], serviceId: "ordinary-script", scriptName: "test" },
          { ...previews.services[0], serviceId: "unscoped", workspaceId: null },
          { ...previews.services[0], serviceId: "without-script", scriptName: null },
        ],
      },
    });

    expect(
      entries.map(({ workspaceId, scriptName, previewServiceId }) => ({
        workspaceId,
        scriptName,
        previewServiceId,
      })),
    ).toEqual([
      { workspaceId: "one", scriptName: "web", previewServiceId: "registered-web" },
      { workspaceId: "two", scriptName: "web", previewServiceId: undefined },
    ]);
  });

  it("removes unavailable or absent preview metadata while retaining the service identity", () => {
    const input = { serverId: "host", workspaces: [workspace("one")] };
    const [available] = buildServiceCatalog({ ...input, previews });
    const [unavailable] = buildServiceCatalog({
      ...input,
      previews: { ...previews, services: [{ ...previews.services[0], available: false }] },
    });
    const [removed] = buildServiceCatalog(input);

    expect(available.previewServiceId).toBe("registered-web");
    expect(unavailable).toEqual(removed);
    expect(unavailable.id).toBe(available.id);
    expect(unavailable).not.toHaveProperty("previewServiceId");
  });

  it("updates the advertised route without retaining the previous route or changing catalog identity", () => {
    const input = { serverId: "host", workspaces: [workspace("one")] };
    const [initial] = buildServiceCatalog({ ...input, previews });
    const [replacement] = buildServiceCatalog({
      ...input,
      previews: {
        ...previews,
        services: [{ ...previews.services[0], serviceId: "replacement-web" }],
      },
    });

    expect(replacement).toEqual({ ...initial, previewServiceId: "replacement-web" });
    expect(initial.previewServiceId).toBe("registered-web");
    expect(previews.services[0].serviceId).toBe("registered-web");
  });
});
