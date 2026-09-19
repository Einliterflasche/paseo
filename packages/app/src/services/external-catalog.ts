import type {
  ServerInfoStatusPayload,
  ServiceExternalResponseMessage,
} from "@getpaseo/protocol/messages";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { CatalogWorkspace } from "./catalog";
import type { ExternalServiceInput, RegistrationFailure } from "./registration-form";

export interface ExternalCatalogEntry {
  kind: "external";
  id: string;
  serverId: string;
  serviceId: string;
  name: string;
  port: number;
  workspaceId: string | null;
  workspaceName: string | null;
  available: boolean;
  revision: string | undefined;
}

export function buildExternalCatalog({
  serverId,
  workspaces,
  previews,
}: {
  serverId: string;
  workspaces: Iterable<CatalogWorkspace>;
  previews?: ServerInfoStatusPayload["servicePreviews"];
}): ExternalCatalogEntry[] {
  const names = new Map(
    [...workspaces].map((workspace) => [workspace.id, workspace.title || workspace.name]),
  );
  return (previews?.services ?? [])
    .filter((service) => service.kind === "external")
    .map((service) => ({
      kind: "external",
      id: JSON.stringify([serverId, service.serviceId]),
      serverId,
      serviceId: service.serviceId,
      name: service.name,
      port: service.port,
      workspaceId: service.workspaceId,
      workspaceName: service.workspaceId ? (names.get(service.workspaceId) ?? null) : null,
      available: service.available,
      revision: service.revision,
    }));
}

type ExternalPayload = ServiceExternalResponseMessage["payload"];
interface ExternalClient {
  getLastServerInfoMessage(): Pick<ServerInfoStatusPayload, "servicePreviews"> | null;
  registerExternalService(input: ExternalServiceInput): Promise<ExternalPayload>;
  connectExternalService(input: { serviceId: string }): Promise<ExternalPayload>;
  disconnectExternalService(input: { serviceId: string }): Promise<ExternalPayload>;
}

export type ExternalRuntime = Pick<
  HostRuntimeSnapshot,
  "connectionStatus" | "clientGeneration" | "connectionEpoch"
> & {
  client: ExternalClient | null;
};

export class ExternalServiceActionError extends Error {
  constructor(readonly code: RegistrationFailure) {
    super(code);
    this.name = "ExternalServiceActionError";
  }
}

export function createExternalCatalogOperations(getSnapshot: () => ExternalRuntime | null) {
  function client(rendered: ExternalRuntime | null) {
    const current = getSnapshot();
    if (
      !rendered ||
      !current?.client ||
      current.connectionStatus !== "online" ||
      rendered.connectionStatus !== "online" ||
      current.client !== rendered.client ||
      current.clientGeneration !== rendered.clientGeneration ||
      current.connectionEpoch !== rendered.connectionEpoch ||
      current.client.getLastServerInfoMessage()?.servicePreviews?.externalRegistration !== 1
    ) {
      throw new ExternalServiceActionError("unavailable");
    }
    return current.client;
  }

  return {
    register(rendered: ExternalRuntime | null, input: ExternalServiceInput) {
      return client(rendered).registerExternalService(input);
    },
    async run({
      rendered,
      entry,
      action,
    }: {
      rendered: ExternalRuntime | null;
      entry: ExternalCatalogEntry;
      action: "connect" | "disconnect";
    }) {
      const current = client(rendered);
      const service = current
        .getLastServerInfoMessage()
        ?.servicePreviews?.services.find((item) => item.serviceId === entry.serviceId);
      if (
        !service ||
        service.kind !== "external" ||
        service.revision !== entry.revision ||
        service.available !== entry.available
      ) {
        throw new ExternalServiceActionError("unknown-registration");
      }
      const { result } = await (action === "connect"
        ? current.connectExternalService({ serviceId: entry.serviceId })
        : current.disconnectExternalService({ serviceId: entry.serviceId }));
      if (result.status === "error") throw new ExternalServiceActionError(result.code);
      if (result.serviceId !== entry.serviceId)
        throw new ExternalServiceActionError("connection-ended");
    },
  };
}
