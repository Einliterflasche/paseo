import type { QueryClient } from "@tanstack/react-query";
import type {
  ServerInfoStatusPayload,
  ServiceManagedResponseMessage,
} from "@getpaseo/protocol/messages";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { ServiceCatalogEntry } from "./catalog";

type ManagedResult = ServiceManagedResponseMessage["payload"]["result"];
type ManagedFailure = Extract<ManagedResult, { status: "error" }>["code"] | "connection-ended";
type ManagedAction = "enable" | "disable";
interface ManagedInput {
  workspaceId: string;
  scriptName: string;
}
interface ManagedClient {
  getLastServerInfoMessage(): Pick<ServerInfoStatusPayload, "servicePreviews"> | null;
  enableManagedServicePreview(
    input: ManagedInput & { mount: "preserve" | "strip" },
  ): Promise<{ result: ManagedResult }>;
  disableManagedServicePreview(input: ManagedInput): Promise<{ result: ManagedResult }>;
}
export type ManagedRuntime = Pick<
  HostRuntimeSnapshot,
  "connectionStatus" | "clientGeneration" | "connectionEpoch"
> & { client: ManagedClient | null };
export type ManagedActionState =
  | { status: "pending"; action: ManagedAction }
  | { status: "success"; serviceId: string }
  | { status: "error"; code: ManagedFailure };

class ManagedActionError extends Error {
  constructor(readonly code: ManagedFailure) {
    super(code);
    this.name = "ManagedActionError";
  }
}

export function managedActionKey(serverId: string, entry: ManagedInput) {
  return ["services.managed.action", serverId, entry.workspaceId, entry.scriptName];
}

function currentClient(getSnapshot: () => ManagedRuntime | null, captured: ManagedRuntime | null) {
  const current = getSnapshot();
  if (
    !captured?.client ||
    !current?.client ||
    captured.connectionStatus !== "online" ||
    current.connectionStatus !== "online" ||
    current.client !== captured.client ||
    current.clientGeneration !== captured.clientGeneration ||
    current.connectionEpoch !== captured.connectionEpoch ||
    current.client.getLastServerInfoMessage()?.servicePreviews?.managedRegistration !== 1
  ) {
    throw new ManagedActionError("unavailable");
  }
  return current.client;
}

export interface ManagedActionInput {
  client: QueryClient;
  serverId: string;
  entry: ServiceCatalogEntry;
  action: ManagedAction;
  getSnapshot(): ManagedRuntime | null;
}

async function execute(input: ManagedActionInput): Promise<string> {
  // The draft outlives a connection. Only an explicit action captures authority.
  const captured = input.getSnapshot();
  const client = currentClient(input.getSnapshot, captured);
  const enrollment = client
    .getLastServerInfoMessage()
    ?.servicePreviews?.managedEnrollments?.find(
      (entry) =>
        entry.workspaceId === input.entry.workspaceId &&
        entry.scriptName === input.entry.scriptName,
    );
  if (input.action === "enable" && enrollment?.enabled)
    throw new ManagedActionError("already-enabled");
  if (input.action === "disable" && !enrollment?.enabled)
    throw new ManagedActionError("unknown-service");
  const target = { workspaceId: input.entry.workspaceId, scriptName: input.entry.scriptName };
  const { result } = await (input.action === "enable"
    ? client.enableManagedServicePreview({ ...target, mount: "strip" })
    : client.disableManagedServicePreview(target));
  try {
    currentClient(input.getSnapshot, captured);
  } catch {
    throw new ManagedActionError("connection-ended");
  }
  if (result.status === "error") throw new ManagedActionError(result.code);
  return result.serviceId;
}

/** A host/script owns its mutation guard and outcome across card and sheet remounts. */
export async function runManagedAction(input: ManagedActionInput): Promise<boolean> {
  const key = managedActionKey(input.serverId, input.entry);
  if (input.client.getQueryData<ManagedActionState>(key)?.status === "pending") return false;
  input.client.setQueryDefaults(key, { gcTime: Infinity });
  input.client.setQueryData<ManagedActionState>(key, { status: "pending", action: input.action });
  const mutation = input.client.getMutationCache().build(input.client, {
    mutationKey: key,
    retry: false,
    networkMode: "always",
    mutationFn: () => execute(input),
  });
  try {
    const serviceId = await mutation.execute(undefined);
    input.client.setQueryData<ManagedActionState>(key, { status: "success", serviceId });
    return true;
  } catch (error) {
    const code = error instanceof ManagedActionError ? error.code : "connection-ended";
    input.client.setQueryData<ManagedActionState>(key, { status: "error", code });
    return false;
  }
}

export function managedErrorKey(code: ManagedFailure) {
  const keys = {
    unavailable: "services.managed.unavailable",
    restarting: "services.registration.restarting",
    "unknown-service": "services.changed",
    "already-enabled": "services.managed.alreadyEnabled",
    "invalid-input": "services.managed.invalidInput",
    "storage-error": "services.registration.storageError",
    "connection-ended": "services.registration.unknownResult",
  } as const;
  return keys[code];
}
