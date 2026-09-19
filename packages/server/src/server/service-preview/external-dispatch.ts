import { ZodError } from "zod";
import type {
  ServiceExternalRegisterRequest,
  ServiceExternalConnectRequest,
  ServiceExternalDisconnectRequest,
  ServiceExternalResponseMessage,
  SessionInboundMessage,
} from "../messages.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import { PreviewBrokerError, type PreviewBroker } from "./broker.js";
import { ExternalPreviewError } from "./external.js";
import { PreviewRegistrationError } from "./registrations.js";
import type { PreviewPhysicalSource } from "./sources.js";

type ExternalRequest =
  | ServiceExternalRegisterRequest
  | ServiceExternalConnectRequest
  | ServiceExternalDisconnectRequest;

const responseTypes = {
  "service.external.register.request": "service.external.register.response",
  "service.external.connect.request": "service.external.connect.response",
  "service.external.disconnect.request": "service.external.disconnect.response",
} as const;

interface ExternalDispatchOptions {
  broker: PreviewBroker;
  socket: PreviewPhysicalSource;
  request: ExternalRequest;
  runAdmission<T>(operation: () => Promise<T>): Promise<T>;
}

type ExternalResult = ServiceExternalResponseMessage["payload"]["result"];

function refusal(error: unknown): ExternalResult {
  if (error instanceof PreviewBrokerError) return { status: "error", code: "unavailable" };
  if (error instanceof RestartInProgressError) return { status: "error", code: "restarting" };
  if (error instanceof ZodError) return { status: "error", code: "invalid-input" };
  if (error instanceof ExternalPreviewError)
    return { status: "error", code: error.code === "closed" ? "unavailable" : error.code };
  if (error instanceof PreviewRegistrationError)
    return { status: "error", code: error.code === "invalid-store" ? "storage-error" : error.code };
  throw error;
}

export function isExternalPreviewRequest(
  message: SessionInboundMessage,
): message is ExternalRequest {
  return Object.hasOwn(responseTypes, message.type);
}

export function externalPreviewResponseType(request: ExternalRequest) {
  return responseTypes[request.type];
}

/** Physical-source dispatch only. No session-global capability or reply fallback. */
export async function dispatchExternalPreview({
  broker,
  socket,
  request,
  runAdmission,
}: ExternalDispatchOptions): Promise<void> {
  const source = broker.sources.capture(socket);
  const services = broker.externalServices;
  if (broker.isClosed || !source || !services) throw new PreviewBrokerError("unavailable");
  const assertCurrent = () => {
    if (broker.isClosed || !source.isCurrent()) throw new PreviewBrokerError("unavailable");
  };
  let result: ExternalResult;
  try {
    let serviceId: string;
    if (request.type === "service.external.register.request") {
      serviceId = await runAdmission(async () => {
        const { name, port, workspaceId, mount } = request;
        const entry = await services.register({
          input: { name, port, workspaceId, mount },
          assertCurrent,
        });
        return entry.serviceId;
      });
    } else {
      serviceId = request.serviceId;
      if (request.type === "service.external.connect.request") {
        await runAdmission(() => services.connect({ serviceId, assertCurrent }));
      } else {
        // Revocation stays available during preparation/restoration. It reduces
        // authority synchronously before awaiting its durable archive write.
        assertCurrent();
        await services.disconnect(serviceId);
      }
    }
    result = { status: "ok", serviceId };
  } catch (error) {
    result = refusal(error);
  }
  await source.send({
    type: "session",
    message: {
      type: responseTypes[request.type],
      payload: { requestId: request.requestId, result },
    },
  });
}
