import type { QueryClient } from "@tanstack/react-query";
import {
  ExternalServiceActionError,
  type ExternalCatalogEntry,
  type ExternalRuntime,
  type createExternalCatalogOperations,
} from "./external-catalog";
import type { RegistrationFailure } from "./registration-form";

type ExternalAction = "connect" | "disconnect";
export type ExternalActionState =
  | { status: "pending"; action: ExternalAction }
  | { status: "success" }
  | { status: "error"; code: RegistrationFailure };

export function externalActionKey(entry: Pick<ExternalCatalogEntry, "serverId" | "serviceId">) {
  return ["services.external.action", entry.serverId, entry.serviceId];
}

interface ExternalActionInput {
  client: QueryClient;
  operations: ReturnType<typeof createExternalCatalogOperations>;
  rendered: ExternalRuntime | null;
  entry: ExternalCatalogEntry;
  action: ExternalAction;
}

/** One mutation/outcome per host and service, independent of mounted cards. */
export async function runExternalAction({
  client,
  operations,
  rendered,
  entry,
  action,
}: ExternalActionInput): Promise<void> {
  const key = externalActionKey(entry);
  if (client.getQueryData<ExternalActionState>(key)?.status === "pending") return;
  client.setQueryDefaults(key, { gcTime: Infinity });
  // Reserve synchronously before the mutation executor or another card can run.
  client.setQueryData<ExternalActionState>(key, { status: "pending", action });
  const mutation = client.getMutationCache().build(client, {
    mutationKey: key,
    retry: false,
    networkMode: "always",
    mutationFn: () => operations.run({ rendered, entry, action }),
  });
  try {
    await mutation.execute(undefined);
    client.setQueryData<ExternalActionState>(key, { status: "success" });
  } catch (error) {
    const code = error instanceof ExternalServiceActionError ? error.code : "connection-ended";
    client.setQueryData<ExternalActionState>(key, { status: "error", code });
  }
}
