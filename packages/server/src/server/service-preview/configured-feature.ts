import type { DaemonAuthConfig } from "../auth.js";
import type { ListenTarget } from "../bootstrap.js";
import type { ServiceProxySubsystem } from "../service-proxy.js";
import type { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import type { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import { openPreviewFeature } from "./feature.js";
import { readPreviewFeaturePolicy } from "./policy.js";
import type { PreviewTransportConfiguration } from "./transport-config.js";

interface ConfiguredPreviewOptions {
  transport: PreviewTransportConfiguration;
  paseoHome: string;
  auth: DaemonAuthConfig | undefined;
  listenTarget: ListenTarget;
  serviceProxyListenTarget: ListenTarget | null;
  workspaces: FileBackedWorkspaceRegistry;
  runtime: WorkspaceScriptRuntimeStore;
  endpoints: ServiceProxySubsystem;
  onFailure(error: unknown): void | Promise<void>;
}

/** The caller keeps ordinary Paseo available if this opt-in feature cannot start. */
export async function openConfiguredPreviewFeature(options: ConfiguredPreviewOptions) {
  const { transport, listenTarget, serviceProxyListenTarget } = options;
  if (
    transport.status !== "configured" ||
    listenTarget.type !== "tcp" ||
    listenTarget.host !== "127.0.0.1" ||
    listenTarget.port === transport.frontPort
  ) {
    throw new Error("Invalid service preview transport configuration");
  }
  const infrastructurePorts = [transport.frontPort, listenTarget.port];
  if (serviceProxyListenTarget?.type === "tcp")
    infrastructurePorts.push(serviceProxyListenTarget.port);
  const policy = await readPreviewFeaturePolicy(options.paseoHome);
  if (policy.enabled && policy.controlOrigin !== transport.controlOrigin) {
    throw new Error("Service preview policy must use the control transport origin");
  }
  return openPreviewFeature({
    policy,
    auth: options.auth,
    paseoHome: options.paseoHome,
    socketPath: transport.gatewaySocketPath,
    infrastructurePorts,
    // The direct daemon uses WebSocket password admission, not a browser cookie.
    // Reverse-proxy authentication cookies need an explicit integration contract.
    controlCookieNames: [],
    workspaces: options.workspaces,
    runtime: options.runtime,
    endpoints: options.endpoints,
    onFailure: options.onFailure,
  });
}
