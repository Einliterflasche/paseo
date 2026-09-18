import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { fileGrantUrl, resolveFileHttpTarget } from "./http-target";

export function captureFileConnection(serverId: string) {
  const store = getHostRuntimeStore();
  const snapshot = store.getSnapshot(serverId);
  if (!snapshot?.client || snapshot.connectionStatus !== "online") {
    throw new Error("Connect to this host to open or download the file.");
  }
  const client = snapshot.client;
  const host = store.getHosts().find((entry) => entry.serverId === serverId);
  return {
    client,
    httpTarget: () => resolveFileHttpTarget(host, snapshot.activeConnectionId),
    assertCurrent() {
      const current = store.getSnapshot(serverId);
      if (
        current?.client !== client ||
        current.connectionStatus !== "online" ||
        current.connectionEpoch !== snapshot.connectionEpoch ||
        current.lastOnlineAt !== snapshot.lastOnlineAt
      ) {
        throw new Error("The host connection changed. Please try opening the file again.");
      }
    },
  };
}

export async function requestFileAccess(
  serverId: string,
  cwd: string,
  path: string,
  preview = false,
) {
  const connection = captureFileConnection(serverId);
  // COMPAT(fileAccess): added in v0.8.0 fork, remove after 2027-03-18 once the daemon floor supports fileAccess.
  if (useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.fileAccess !== true) {
    throw new Error("Update this host to open file previews and downloads from chat.");
  }
  const result = await connection.client.getFileAccess({ cwd, path, preview });
  connection.assertCurrent();
  if (result.error || !result.file) throw new Error(result.error ?? "File is unavailable.");
  return { ...result, file: result.file };
}

export function useFileAccess(input: {
  serverId: string;
  cwd: string | null;
  path: string | null;
  enabled: boolean;
}) {
  const runtime = useHostRuntimeSnapshot(input.serverId);
  const query = useFetchQuery({
    queryKey: [
      "fileAccess",
      input.serverId,
      input.cwd,
      input.path,
      runtime?.clientGeneration,
      runtime?.connectionEpoch,
      runtime?.lastOnlineAt,
    ],
    queryFn: () => requestFileAccess(input.serverId, input.cwd!, input.path!, true),
    enabled: input.enabled && !!input.cwd && !!input.path && runtime?.connectionStatus === "online",
    retry: false,
    // Refetch on activation: a grant is bound to a live connection and file revision.
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
  });
  return {
    ...query,
    connectionError:
      runtime?.connectionStatus === "online"
        ? null
        : "Connect to this host to open or download the file.",
  };
}

export function resolveFilePreviewUrl(serverId: string, token: string): string {
  return fileGrantUrl(captureFileConnection(serverId).httpTarget(), "preview", token);
}
