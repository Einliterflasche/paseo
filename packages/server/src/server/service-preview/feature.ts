import type { DaemonAuthConfig } from "../auth.js";
import type { ServiceProxySubsystem } from "../service-proxy.js";
import type { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import type { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import { PreviewBroker } from "./broker.js";
import { ExternalPreviewServices } from "./external.js";
import { ManagedPreviewRoutes } from "./managed.js";
import type { PreviewFeaturePolicy } from "./policy.js";
import { ManagedPreviewServices, ManagedEnrollmentError } from "./managed-services.js";
import { getScriptConfigs, isServiceScript, readPaseoConfig } from "../../utils/worktree.js";
import { PreviewRegistrationStore } from "./registrations.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewSources } from "./sources.js";
import { startPreviewGatewayWorker } from "./worker.js";

interface PreviewFeatureOptions {
  policy: PreviewFeaturePolicy;
  auth: DaemonAuthConfig | undefined;
  paseoHome: string;
  socketPath: string;
  infrastructurePorts: readonly number[];
  controlCookieNames: readonly string[];
  workspaces: FileBackedWorkspaceRegistry;
  runtime: WorkspaceScriptRuntimeStore;
  endpoints: Pick<
    ServiceProxySubsystem,
    "getWorkspaceHealthTargets" | "subscribeWorkspaceServices"
  >;
  onFailure(error: unknown): void | Promise<void>;
}

/** Opt-in feature owner; creating it never installs or changes public ingress. */
export async function openPreviewFeature(options: PreviewFeatureOptions) {
  const { policy, workspaces, onFailure } = options;
  if (!policy.enabled) return null;
  if (!options.auth?.password)
    throw new Error("Service previews require daemon password authentication");

  const blockedWorkspaces = new Set<string>();
  const sources = new PreviewSources(policy.controlOrigin);
  const routes = new PreviewRoutes({ excludedPorts: options.infrastructurePorts });
  const store = new PreviewRegistrationStore({
    paseoHome: options.paseoHome,
    excludedPorts: () => new Set(options.infrastructurePorts),
    workspaceExists: async (workspaceId) => {
      const workspace = await workspaces.get(workspaceId);
      return !!workspace && !workspace.archivedAt && !blockedWorkspaces.has(workspaceId);
    },
  });
  const external = await ExternalPreviewServices.open({
    store,
    routes,
    isWorkspaceBlocked: (workspaceId) => blockedWorkspaces.has(workspaceId),
  });
  const managed = new ManagedPreviewRoutes({
    routes,
    runtime: options.runtime,
    endpoints: options.endpoints,
    onFailure,
  });
  let managedServices: ManagedPreviewServices;
  try {
    managedServices = await ManagedPreviewServices.open({
      paseoHome: options.paseoHome,
      policy: policy.managedServices,
      managed,
      isWorkspaceBlocked: (workspaceId) => blockedWorkspaces.has(workspaceId),
      async validateService(input) {
        const workspace = await workspaces.get(input.workspaceId);
        if (!workspace || workspace.archivedAt || blockedWorkspaces.has(input.workspaceId)) {
          throw new ManagedEnrollmentError("unknown-service");
        }
        const config = readPaseoConfig(workspace.cwd);
        const script = config.ok
          ? getScriptConfigs(config.config).get(input.scriptName)
          : undefined;
        if (!script || !isServiceScript(script))
          throw new ManagedEnrollmentError("unknown-service");
      },
    });
  } catch (error) {
    const failures: unknown[] = [error];
    for (const stop of [
      () => managed.close(),
      () => external.close(),
      () => routes.close(),
      () => sources.close(),
    ]) {
      try {
        stop();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    const failure = new AggregateError(
      failures,
      "Managed preview enrollment initialization failed",
      {
        cause: error,
      },
    );
    throw failure;
  }
  const broker = new PreviewBroker({
    sources,
    routes,
    externalServices: external,
    managedServices,
    onFailure,
  });
  let worker: ReturnType<typeof startPreviewGatewayWorker> | null = null;
  let closed = false;
  const cleanup: Array<() => void> = [];
  const closeFailures: unknown[] = [];

  function close(): void {
    if (closed) return;
    closed = true;
    for (const stop of [
      ...cleanup,
      () => sources.close(),
      () => managed.close(),
      () => broker.close(),
      () => worker?.close(),
      () => routes.close(),
    ]) {
      try {
        stop();
      } catch (error) {
        closeFailures.push(error);
      }
    }
  }

  async function shutdown(): Promise<void> {
    close();
    const failures = [...closeFailures];
    try {
      await broker.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (worker) await worker.closed;
    if (failures.length > 0)
      throw new AggregateError(failures, "Service previews failed to shut down");
  }

  function activateWorkspace(workspaceId: string): void {
    blockedWorkspaces.delete(workspaceId);
    managed.unblockWorkspace(workspaceId);
    managedServices.restoreWorkspace(workspaceId);
  }

  function restoreConfiguredDefaults(workspace: { workspaceId: string; cwd: string }): void {
    const config = readPaseoConfig(workspace.cwd);
    if (!config.ok) return;
    for (const [scriptName, script] of getScriptConfigs(config.config)) {
      if (isServiceScript(script))
        managedServices.restoreDefault(workspace.workspaceId, scriptName);
    }
  }

  async function reportFailure(error: unknown): Promise<void> {
    try {
      await onFailure(error);
    } catch {
      // The feature is already closed; diagnostics cannot undo retirement.
    }
  }

  try {
    cleanup.push(
      options.runtime.subscribe((workspaceId) => {
        if (closed || blockedWorkspaces.has(workspaceId)) return;
        for (const runtime of options.runtime.listForWorkspace(workspaceId)) {
          if (runtime.type === "service")
            managedServices.restoreDefault(workspaceId, runtime.scriptName);
        }
      }),
    );
    cleanup.push(
      workspaces.subscribeBeforeUnavailable(async (workspaceId) => {
        blockedWorkspaces.add(workspaceId);
        managedServices.blockWorkspace(workspaceId);
        external.invalidateWorkspace(workspaceId);
        // Route observers end broker jobs synchronously. The private channel then
        // waits for actual gateway teardown before archive/removal can commit.
        if (worker) await worker.settled();
      }),
    );
    cleanup.push(
      workspaces.subscribeAvailabilityCommitted((workspaceId, available) => {
        if (!closed && available) {
          try {
            // This runs inside the registry's commit queue. An older metadata
            // notification cannot undo a later archive's pre-write block.
            activateWorkspace(workspaceId);
          } catch (error) {
            close();
            void reportFailure(error);
          }
        }
      }),
    );
    for (const workspace of await workspaces.list()) {
      if (workspace.archivedAt || blockedWorkspaces.has(workspace.workspaceId)) continue;
      restoreConfiguredDefaults(workspace);
      activateWorkspace(workspace.workspaceId);
    }
    worker = startPreviewGatewayWorker({
      broker,
      socketPath: options.socketPath,
      controlCookieNames: options.controlCookieNames,
      onFailure,
    });
    await worker.ready;
    void worker.closed.then(close);
    return { broker, managed, socketPath: worker.socketPath, close, shutdown };
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "Service preview initialization failed",
        {
          cause: error,
        },
      );
      throw failure;
    }
    throw error;
  }
}
