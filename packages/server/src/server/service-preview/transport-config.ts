import path from "node:path";
import { parseControlOrigin } from "./control-transport.js";

export type PreviewTransportConfiguration =
  | { status: "configured"; frontPort: number; gatewaySocketPath: string; controlOrigin: string }
  | { status: "invalid" };

/** Kept outside persisted daemon configuration for downgrade compatibility. */
export function resolvePreviewTransportEnvironment(
  env: NodeJS.ProcessEnv,
): PreviewTransportConfiguration | undefined {
  const port = env.PASEO_SERVICES_FRONT_PORT;
  const socket = env.PASEO_SERVICES_GATEWAY_SOCKET;
  const controlOrigin = env.PASEO_SERVICES_CONTROL_ORIGIN;
  if (port === undefined && socket === undefined && controlOrigin === undefined) return undefined;
  try {
    parseControlOrigin(controlOrigin ?? "");
  } catch {
    return { status: "invalid" };
  }
  const frontPort = Number(port);
  if (
    controlOrigin === undefined ||
    port === undefined ||
    !/^\d+$/.test(port) ||
    !Number.isInteger(frontPort) ||
    frontPort < 1 ||
    frontPort > 65535 ||
    !socket ||
    !path.isAbsolute(socket) ||
    /[{}]/.test(socket) ||
    socket.includes("\0")
  ) {
    return { status: "invalid" };
  }
  return { status: "configured", frontPort, gatewaySocketPath: socket, controlOrigin };
}
