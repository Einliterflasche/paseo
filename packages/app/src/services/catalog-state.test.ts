import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceCatalog, type CatalogWorkspace } from "./catalog";
import {
  CatalogChangedError,
  catalogDirectoryPresentation,
  catalogMutationPolicy,
  createCatalogOperations,
  type CatalogActionContext,
  type CatalogPort,
  type CatalogRuntime,
} from "./catalog-state";
import type { WorkspaceDirectoryState } from "@/runtime/directory-sync";

class CatalogAdapter implements CatalogPort {
  readonly calls: { action: string; workspaceId: string; scriptName: string }[] = [];
  refreshCount = 0;
  actionError: Error | null = null;
  refreshError: Error | null = null;
  refreshMode: "ready" | "skip" | "superseded" = "ready";
  readonly workspace: CatalogWorkspace = {
    id: "workspace",
    name: "main",
    title: null,
    projectDisplayName: "App",
    archivingAt: null,
    scripts: [
      {
        type: "service",
        scriptName: "web",
        lifecycle: "stopped",
        health: null,
        port: null,
        terminalId: null,
        exitCode: null,
        hostname: "fixture",
        proxyUrl: null,
        localProxyUrl: null,
        publicProxyUrl: null,
      },
    ],
  };
  readonly client = {
    startWorkspaceScriptWithStatus: async (workspaceId: string, scriptName: string) => {
      this.calls.push({ action: "start", workspaceId, scriptName });
      if (this.actionError) throw this.actionError;
      return { error: null };
    },
    stopWorkspaceScript: async (workspaceId: string, scriptName: string) => {
      this.calls.push({ action: "stop", workspaceId, scriptName });
      if (this.actionError) throw this.actionError;
      return { error: null };
    },
  };
  snapshot: CatalogRuntime = {
    client: this.client,
    connectionStatus: "online",
    clientGeneration: 1,
    connectionEpoch: 1,
    workspaceDirectory: { status: "ready", source: { clientGeneration: 1, connectionEpoch: 1 } },
  };
  getSnapshot() {
    return this.snapshot;
  }
  getWorkspace(id: string) {
    return id === this.workspace.id ? this.workspace : undefined;
  }
  async refresh(): Promise<WorkspaceDirectoryState | null> {
    this.refreshCount += 1;
    if (this.refreshError) throw this.refreshError;
    if (this.refreshMode === "skip") return null;
    const ready: WorkspaceDirectoryState = {
      status: "ready",
      source: {
        clientGeneration: this.snapshot.clientGeneration,
        connectionEpoch: this.snapshot.connectionEpoch,
      },
    };
    this.snapshot.workspaceDirectory = this.refreshMode === "superseded" ? { ...ready } : ready;
    return ready;
  }
  context(): CatalogActionContext {
    return { rendered: { ...this.snapshot }, active: true, canManage: true };
  }
  entry() {
    return buildServiceCatalog({ serverId: "host", workspaces: [this.workspace] })[0];
  }
}

const queryClients: QueryClient[] = [];
afterEach(() => {
  for (const client of queryClients) client.clear();
  queryClients.length = 0;
});

describe("catalog action owner", () => {
  it("reconciles a successful action without manufacturing a new lifecycle", async () => {
    const port = new CatalogAdapter();
    await createCatalogOperations(port).runAction(port.context(), port.entry(), "start");
    expect(port.calls).toEqual([{ action: "start", workspaceId: "workspace", scriptName: "web" }]);
    expect(port.refreshCount).toBe(1);
    expect(port.entry().lifecycle).toBe("stopped");
  });

  it.each(["offline", "generation", "capability", "hidden", "archiving", "client replacement"])(
    "rejects an observed %s change before a lifecycle request",
    async (change) => {
      const port = new CatalogAdapter();
      const context = port.context();
      const entry = port.entry();
      if (change === "offline") port.snapshot.connectionStatus = "offline";
      if (change === "generation") port.snapshot.connectionEpoch += 1;
      if (change === "capability") context.canManage = false;
      if (change === "hidden") context.active = false;
      if (change === "archiving") port.workspace.archivingAt = "2026-09-18T00:00:00Z";
      if (change === "client replacement") port.snapshot.client = { ...port.client };
      await expect(
        createCatalogOperations(port).runAction(context, entry, "start"),
      ).rejects.toBeInstanceOf(CatalogChangedError);
      expect(port.calls).toEqual([]);
    },
  );

  it("rejects Stop when the displayed running terminal has been replaced", async () => {
    const port = new CatalogAdapter();
    port.workspace.scripts[0].lifecycle = "running";
    port.workspace.scripts[0].terminalId = "T1";
    const entry = port.entry();
    port.workspace.scripts[0].terminalId = "T2";
    await expect(
      createCatalogOperations(port).runAction(port.context(), entry, "stop"),
    ).rejects.toBeInstanceOf(CatalogChangedError);
    expect(port.calls).toEqual([]);
  });

  it.each(["skip", "superseded", "error"] as const)(
    "retains uncertainty when explicit refresh is %s, then recovers without replay",
    async (outcome) => {
      const port = new CatalogAdapter();
      const operations = createCatalogOperations(port);
      const client = new QueryClient();
      queryClients.push(client);
      const action = new MutationObserver(client, {
        ...catalogMutationPolicy,
        mutationFn: () => operations.runAction(port.context(), port.entry(), "start"),
      });
      const refresh = new MutationObserver(client, {
        ...catalogMutationPolicy,
        mutationFn: operations.refresh,
        onSuccess: () => action.reset(),
      });
      port.actionError = new Error("acknowledgement lost");
      await expect(action.mutate()).rejects.toThrow("acknowledgement lost");
      expect(action.getCurrentResult().isError).toBe(true);
      if (outcome === "error") port.refreshError = new Error("refresh failed");
      else port.refreshMode = outcome;
      await expect(refresh.mutate()).rejects.toThrow();
      expect(action.getCurrentResult().error?.message).toBe("acknowledgement lost");
      port.refreshMode = "ready";
      port.refreshError = null;
      await refresh.mutate();
      expect(action.getCurrentResult().isIdle).toBe(true);
      expect(port.calls).toEqual([
        { action: "start", workspaceId: "workspace", scriptName: "web" },
      ]);
    },
  );
});

describe("directory presentation", () => {
  it("keeps a previously ready snapshot stale until the current epoch reconciles", () => {
    const port = new CatalogAdapter();
    port.snapshot.connectionEpoch = 2;
    expect(catalogDirectoryPresentation(port.snapshot, true)).toMatchObject({
      ready: false,
      loading: false,
    });
    port.snapshot.workspaceDirectory = {
      status: "ready",
      source: { clientGeneration: 1, connectionEpoch: 2 },
    };
    expect(catalogDirectoryPresentation(port.snapshot, true)).toMatchObject({
      ready: true,
      loading: false,
    });
  });

  it.each(["initial failure", "reconnect failure", "unavailable"])(
    "explains %s and ends loading, then clears the explanation on recovery",
    (scenario) => {
      const port = new CatalogAdapter();
      const source = { clientGeneration: 1, connectionEpoch: 1 };
      const hydrated = scenario === "reconnect failure";
      port.snapshot.workspaceDirectory = { status: "loading", source };
      expect(catalogDirectoryPresentation(port.snapshot, hydrated).loading).toBe(!hydrated);
      port.snapshot.workspaceDirectory =
        scenario === "unavailable"
          ? { status: "unavailable", source }
          : { status: "error", source, error: "directory request failed" };
      expect(catalogDirectoryPresentation(port.snapshot, hydrated)).toEqual({
        online: true,
        ready: false,
        loading: false,
        error: scenario === "unavailable" ? undefined : "directory request failed",
        unavailable: scenario === "unavailable",
      });
      port.snapshot.workspaceDirectory = { status: "ready", source };
      expect(catalogDirectoryPresentation(port.snapshot, true)).toEqual({
        online: true,
        ready: true,
        loading: false,
        error: undefined,
        unavailable: false,
      });
      expect(port.calls).toEqual([]);
    },
  );
});
