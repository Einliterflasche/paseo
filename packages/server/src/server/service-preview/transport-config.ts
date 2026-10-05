import path from "node:path";
import { parseControlOrigin } from "./control-transport.js";

export type PreviewTransportConfiguration =
  | {
      status: "configured";
      frontPort: number;
      gatewaySocketPath: string;
      controlOrigin: string;
      additionalControlOrigins?: string[];
      additionalFrontPorts?: number[];
    }
  | { status: "invalid" };

function parseFrontPort(value: string | undefined): number {
  const port = Number(value);
  if (
    value === undefined ||
    !/^\d+$/.test(value) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid control front port");
  return port;
}

/** Kept outside persisted daemon configuration for downgrade compatibility. */
export function resolvePreviewTransportEnvironment(
  env: NodeJS.ProcessEnv,
): PreviewTransportConfiguration | undefined {
  const port = env.PASEO_SERVICES_FRONT_PORT;
  const socket = env.PASEO_SERVICES_GATEWAY_SOCKET;
  const controlOrigin = env.PASEO_SERVICES_CONTROL_ORIGIN;
  const additionalOrigins = env.PASEO_SERVICES_ADDITIONAL_CONTROL_ORIGINS;
  const additionalPorts = env.PASEO_SERVICES_ADDITIONAL_FRONT_PORTS;
  if (
    port === undefined &&
    socket === undefined &&
    controlOrigin === undefined &&
    additionalOrigins === undefined &&
    additionalPorts === undefined
  )
    return undefined;
  let additionalControlOrigins: string[] = [];
  let additionalFrontPorts: number[] = [];
  let frontPort: number;
  try {
    frontPort = parseFrontPort(port);
    parseControlOrigin(controlOrigin ?? "");
    if (additionalOrigins !== undefined) {
      additionalControlOrigins = additionalOrigins.split(",");
      for (const origin of additionalControlOrigins) parseControlOrigin(origin);
    }
    if (additionalPorts !== undefined) {
      additionalFrontPorts = additionalPorts.split(",").map(parseFrontPort);
    }
  } catch {
    return { status: "invalid" };
  }
  if (
    controlOrigin === undefined ||
    !socket ||
    !path.isAbsolute(socket) ||
    /[{}]/.test(socket) ||
    socket.includes("\0")
  ) {
    return { status: "invalid" };
  }
  return {
    status: "configured",
    frontPort,
    gatewaySocketPath: socket,
    controlOrigin,
    ...(additionalControlOrigins.length ? { additionalControlOrigins } : {}),
    ...(additionalFrontPorts.length ? { additionalFrontPorts } : {}),
  };
}
