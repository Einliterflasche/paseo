import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { WorkspaceDirectoryState } from "@/runtime/directory-sync";
import type { CatalogWorkspace, ServiceCatalogEntry } from "./catalog";

interface CatalogClient {
  startWorkspaceScriptWithStatus(
    workspaceId: string,
    scriptName: string,
  ): Promise<{ error: string | null }>;
  stopWorkspaceScript(workspaceId: string, scriptName: string): Promise<{ error: string | null }>;
}

export type CatalogRuntime = Pick<
  HostRuntimeSnapshot,
  "connectionStatus" | "clientGeneration" | "connectionEpoch" | "workspaceDirectory"
> & { client: CatalogClient | null };

export interface CatalogPort {
  getSnapshot(): CatalogRuntime | null;
  getWorkspace(workspaceId: string): CatalogWorkspace | undefined;
  refresh(): Promise<WorkspaceDirectoryState | null>;
}

export interface CatalogActionContext {
  rendered: CatalogRuntime | null;
  active: boolean;
  canManage: boolean;
}

export class CatalogChangedError extends Error {
  constructor() {
    super("Service catalog changed");
    this.name = "CatalogChangedError";
  }
}

export const catalogMutationPolicy = { retry: false, networkMode: "always" as const };

export function currentWorkspaceDirectory(snapshot: CatalogRuntime | null) {
  if (!snapshot || snapshot.connectionStatus !== "online") return null;
  const directory = snapshot.workspaceDirectory;
  if (
    !directory ||
    directory.source.clientGeneration !== snapshot.clientGeneration ||
    directory.source.connectionEpoch !== snapshot.connectionEpoch
  )
    return null;
  return directory;
}

export function catalogDirectoryPresentation(snapshot: CatalogRuntime | null, hydrated: boolean) {
  const directory = currentWorkspaceDirectory(snapshot);
  const online = snapshot?.connectionStatus === "online";
  return {
    online,
    ready: directory?.status === "ready",
    loading: online && !hydrated && (!directory || directory.status === "loading"),
    error: directory?.status === "error" ? directory.error : undefined,
    unavailable: directory?.status === "unavailable",
  };
}

function isWorkspaceDirectoryReady(snapshot: CatalogRuntime | null): boolean {
  return currentWorkspaceDirectory(snapshot)?.status === "ready";
}

export function createCatalogOperations(port: CatalogPort) {
  return {
    async refresh() {
      const reconciled = await port.refresh();
      const current = port.getSnapshot();
      if (
        !reconciled ||
        !isWorkspaceDirectoryReady(current) ||
        current?.workspaceDirectory !== reconciled
      )
        throw new CatalogChangedError();
    },
    async runAction(
      context: CatalogActionContext,
      entry: ServiceCatalogEntry,
      action: "start" | "stop",
    ) {
      const { rendered, active, canManage } = context;
      const current = port.getSnapshot();
      const workspace = port.getWorkspace(entry.workspaceId);
      const script = workspace?.scripts.find(
        (item) => item.type === "service" && item.scriptName === entry.scriptName,
      );
      if (
        !canManage ||
        !active ||
        !isWorkspaceDirectoryReady(rendered) ||
        !rendered ||
        !current?.client ||
        !isWorkspaceDirectoryReady(current) ||
        current.client !== rendered.client ||
        current.clientGeneration !== rendered.clientGeneration ||
        current.connectionEpoch !== rendered.connectionEpoch ||
        !workspace ||
        workspace.archivingAt ||
        !script ||
        script.lifecycle !== entry.lifecycle ||
        script.terminalId !== entry.terminalId
      ) {
        throw new CatalogChangedError();
      }
      const result =
        action === "start"
          ? await current.client.startWorkspaceScriptWithStatus(entry.workspaceId, entry.scriptName)
          : await current.client.stopWorkspaceScript(entry.workspaceId, entry.scriptName);
      if (result.error) throw new Error(result.error);
      await port.refresh();
      // The directory owner consumes pushes. No retry or optimistic lifecycle.
    },
  };
}
