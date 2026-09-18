import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";

export interface FileHttpTarget {
  origin: string;
  authHeader: string | null;
  credentials: { username: string; password: string } | null;
}

// A file grant belongs to the connected daemon. A saved address is not evidence
// that it is reachable (or even routes to the same daemon) from this client.
export function resolveFileHttpTarget(
  host: HostProfile | undefined,
  activeConnectionId: string | null,
): FileHttpTarget {
  const connection = host?.connections.find((entry) => entry.id === activeConnectionId);
  if (connection?.type !== "directTcp") {
    throw new Error("File transfer needs an active direct connection to this host.");
  }
  const url = new URL(
    buildDaemonWebSocketUrl(connection.endpoint, {
      useTls: connection.useTls ?? false,
    }),
  );
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const credentials =
    url.username || url.password
      ? {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        }
      : null;
  return {
    origin: url.origin,
    credentials,
    authHeader: credentials
      ? `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`
      : null,
  };
}

export function fileGrantUrl(
  target: FileHttpTarget,
  operation: "preview" | "download",
  token: string,
  includeCredentials = true,
): string {
  const url = new URL(`/api/files/${operation}`, target.origin);
  url.searchParams.set("token", token);
  if (includeCredentials && target.credentials) {
    url.username = target.credentials.username;
    url.password = target.credentials.password;
  }
  return url.toString();
}
