import { describe, expect, it } from "vitest";
import type {
  ServerInfoStatusPayload,
  ServiceExternalResponseMessage,
} from "@getpaseo/protocol/messages";
import type { CatalogWorkspace } from "./catalog";
import {
  buildExternalCatalog,
  createExternalCatalogOperations,
  ExternalServiceActionError,
  type ExternalRuntime,
} from "./external-catalog";
import type { ExternalServiceInput } from "./registration-form";

type Previews = NonNullable<ServerInfoStatusPayload["servicePreviews"]>;
type Reply = ServiceExternalResponseMessage["payload"];

const external: Previews["services"][number] = {
  kind: "external",
  serviceId: "external-atlas",
  name: "Atlas",
  workspaceId: "workspace-a",
  scriptName: null,
  port: 5173,
  available: false,
  revision: "revision-1",
};
const previews: Previews = {
  version: 1,
  externalRegistration: 1,
  origin: "https://paseo.example.test",
  services: [external],
};
const workspace: CatalogWorkspace = {
  id: "workspace-a",
  name: "main",
  title: "React workspace",
  projectDisplayName: "Atlas",
  archivingAt: null,
  scripts: [],
};
const registration: ExternalServiceInput = {
  name: "Atlas",
  port: 5173,
  workspaceId: "workspace-a",
  mount: "preserve",
};

function fixture() {
  let info: Pick<ServerInfoStatusPayload, "servicePreviews"> | null = { servicePreviews: previews };
  let reply: Reply = {
    requestId: "fixture-request",
    result: { status: "ok", serviceId: external.serviceId },
  };
  const calls: Array<{ action: string; input: ExternalServiceInput | { serviceId: string } }> = [];
  const client: NonNullable<ExternalRuntime["client"]> = {
    getLastServerInfoMessage: () => info,
    async registerExternalService(input) {
      calls.push({ action: "register", input });
      return reply;
    },
    async connectExternalService(input) {
      calls.push({ action: "connect", input });
      return reply;
    },
    async disconnectExternalService(input) {
      calls.push({ action: "disconnect", input });
      return reply;
    },
  };
  const rendered: ExternalRuntime = {
    client,
    connectionStatus: "online",
    clientGeneration: 1,
    connectionEpoch: 2,
  };
  let current: ExternalRuntime | null = rendered;
  const operations = createExternalCatalogOperations(() => current);
  const [entry] = buildExternalCatalog({ serverId: "host", workspaces: [workspace], previews });
  return {
    entry,
    rendered,
    operations,
    calls,
    setCurrent(value: ExternalRuntime | null) {
      current = value;
    },
    setInfo(value: typeof info) {
      info = value;
    },
    setReply(value: Reply) {
      reply = value;
    },
  };
}

describe("external service catalog", () => {
  it("projects only explicitly external definitions, retaining unavailable registrations", () => {
    const entries = buildExternalCatalog({
      serverId: "host",
      workspaces: [workspace].values(),
      previews: {
        ...previews,
        services: [
          { ...external, kind: undefined, serviceId: "managed" },
          external,
          { ...external, serviceId: "host-only", workspaceId: null },
          { ...external, serviceId: "unknown-workspace", workspaceId: "missing" },
        ],
      },
    });
    expect(entries).toEqual([
      {
        kind: "external",
        id: '["host","external-atlas"]',
        serverId: "host",
        serviceId: "external-atlas",
        name: "Atlas",
        port: 5173,
        workspaceId: "workspace-a",
        workspaceName: "React workspace",
        available: false,
        revision: "revision-1",
      },
      {
        kind: "external",
        id: '["host","host-only"]',
        serverId: "host",
        serviceId: "host-only",
        name: "Atlas",
        port: 5173,
        workspaceId: null,
        workspaceName: null,
        available: false,
        revision: "revision-1",
      },
      {
        kind: "external",
        id: '["host","unknown-workspace"]',
        serverId: "host",
        serviceId: "unknown-workspace",
        name: "Atlas",
        port: 5173,
        workspaceId: "missing",
        workspaceName: null,
        available: false,
        revision: "revision-1",
      },
    ]);
    expect(buildExternalCatalog({ serverId: "host", workspaces: [workspace] })).toEqual([]);
    expect(external.available).toBe(false);
  });

  it("keeps service identity across metadata changes and separates hosts without mutating inputs", () => {
    const [initial] = buildExternalCatalog({ serverId: "host", workspaces: [workspace], previews });
    const [updated] = buildExternalCatalog({
      serverId: "host",
      workspaces: [{ ...workspace, title: null }],
      previews: {
        ...previews,
        services: [
          { ...external, name: "Renamed", available: true, port: 9000, revision: "revision-2" },
        ],
      },
    });
    expect(updated).toEqual({
      ...initial,
      name: "Renamed",
      available: true,
      port: 9000,
      revision: "revision-2",
      workspaceName: "main",
    });
    const [other] = buildExternalCatalog({ serverId: "other", workspaces: [workspace], previews });
    expect(other.id).not.toBe(initial.id);
    expect(external.name).toBe("Atlas");
    expect(workspace.title).toBe("React workspace");
  });

  it("registers exactly the caller's definition without implicitly enabling it", async () => {
    const f = fixture();
    expect(await f.operations.register(f.rendered, registration)).toEqual({
      requestId: "fixture-request",
      result: { status: "ok", serviceId: external.serviceId },
    });
    expect(f.calls).toEqual([{ action: "register", input: registration }]);
  });

  it.each([
    "missing",
    "offline",
    "new-client",
    "generation",
    "epoch",
    "rendered-offline",
    "rendered-missing",
    "no-info",
    "no-feature",
  ])("rejects %s authority before registration or lifecycle RPC dispatch", async (change) => {
    const f = fixture();
    let rendered: ExternalRuntime | null = f.rendered;
    if (change === "missing") f.setCurrent(null);
    if (change === "offline") f.setCurrent({ ...f.rendered, connectionStatus: "offline" });
    if (change === "new-client") f.setCurrent({ ...f.rendered, client: { ...f.rendered.client! } });
    if (change === "generation") f.setCurrent({ ...f.rendered, clientGeneration: 2 });
    if (change === "epoch") f.setCurrent({ ...f.rendered, connectionEpoch: 3 });
    if (change === "rendered-offline") rendered = { ...f.rendered, connectionStatus: "offline" };
    if (change === "rendered-missing") rendered = null;
    if (change === "no-info") f.setInfo(null);
    if (change === "no-feature")
      f.setInfo({ servicePreviews: { ...previews, externalRegistration: undefined } });
    expect(() => f.operations.register(rendered, registration)).toThrowError(
      new ExternalServiceActionError("unavailable"),
    );
    await expect(f.operations.run({ rendered, entry: f.entry, action: "connect" })).rejects.toEqual(
      new ExternalServiceActionError("unavailable"),
    );
    expect(f.calls).toEqual([]);
  });

  it.each(["removed", "managed", "revision", "availability"])(
    "rejects a %s definition before lifecycle dispatch",
    async (change) => {
      const f = fixture();
      const current = { ...external };
      if (change === "managed") current.kind = undefined;
      if (change === "revision") current.revision = "replacement";
      if (change === "availability") current.available = true;
      f.setInfo({
        servicePreviews: { ...previews, services: change === "removed" ? [] : [current] },
      });
      await expect(
        f.operations.run({ rendered: f.rendered, entry: f.entry, action: "disconnect" }),
      ).rejects.toEqual(new ExternalServiceActionError("unknown-registration"));
      expect(f.calls).toEqual([]);
    },
  );

  it.each(["connect", "disconnect"] as const)(
    "dispatches one explicit %s operation",
    async (action) => {
      const f = fixture();
      await expect(
        f.operations.run({ rendered: f.rendered, entry: f.entry, action }),
      ).resolves.toBeUndefined();
      expect(f.calls).toEqual([{ action, input: { serviceId: external.serviceId } }]);
    },
  );

  it.each(["unknown-registration", "storage-error", "restarting"] as const)(
    "surfaces server %s without retrying",
    async (code) => {
      const f = fixture();
      f.setReply({ requestId: "fixture-request", result: { status: "error", code } });
      await expect(
        f.operations.run({ rendered: f.rendered, entry: f.entry, action: "connect" }),
      ).rejects.toEqual(new ExternalServiceActionError(code));
      expect(f.calls).toHaveLength(1);
    },
  );

  it("does not treat a different service's response as confirmation", async () => {
    const f = fixture();
    f.setReply({
      requestId: "fixture-request",
      result: { status: "ok", serviceId: "another-service" },
    });
    await expect(
      f.operations.run({ rendered: f.rendered, entry: f.entry, action: "disconnect" }),
    ).rejects.toEqual(new ExternalServiceActionError("connection-ended"));
    expect(f.calls).toHaveLength(1);
  });
});
