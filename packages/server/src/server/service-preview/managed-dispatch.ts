import { ZodError } from "zod";
import type {
  ServiceManagedEnableRequest,
  ServiceManagedDisableRequest,
  ServiceManagedResponseMessage,
  SessionInboundMessage,
} from "../messages.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import { PreviewBrokerError, type PreviewBroker } from "./broker.js";
import { ManagedEnrollmentError } from "./managed-services.js";
import type { PreviewPhysicalSource } from "./sources.js";

type ManagedRequest = ServiceManagedEnableRequest | ServiceManagedDisableRequest;
const responseTypes = {
  "service.managed.enable.request": "service.managed.enable.response",
  "service.managed.disable.request": "service.managed.disable.response",
} as const;

export function isManagedPreviewRequest(message: SessionInboundMessage): message is ManagedRequest {
  return Object.hasOwn(responseTypes, message.type);
}

export function managedPreviewResponseType(request: ManagedRequest) {
  return responseTypes[request.type];
}

function refusal(error: unknown): ServiceManagedResponseMessage["payload"]["result"] {
  if (error instanceof PreviewBrokerError) return { status: "error", code: "unavailable" };
  if (error instanceof RestartInProgressError) return { status: "error", code: "restarting" };
  if (error instanceof ZodError) return { status: "error", code: "invalid-input" };
  if (error instanceof ManagedEnrollmentError)
    return {
      status: "error",
      code: error.code === "invalid-store" ? "storage-error" : error.code,
    };
  throw error;
}

export async function dispatchManagedPreview({
  broker,
  socket,
  request,
  runAdmission,
}: {
  broker: PreviewBroker;
  socket: PreviewPhysicalSource;
  request: ManagedRequest;
  runAdmission<T>(operation: () => Promise<T>): Promise<T>;
}): Promise<void> {
  const source = broker.sources.capture(socket);
  const services = broker.managedServices;
  if (broker.isClosed || !source || !services) throw new PreviewBrokerError("unavailable");
  const assertCurrent = () => {
    if (broker.isClosed || !source.isCurrent()) throw new PreviewBrokerError("unavailable");
  };
  let result: ServiceManagedResponseMessage["payload"]["result"];
  try {
    const input = { workspaceId: request.workspaceId, scriptName: request.scriptName };
    const serviceId =
      request.type === "service.managed.enable.request"
        ? await runAdmission(() =>
            services.enable({ ...input, mount: request.mount }, assertCurrent),
          )
        : await services.disable(input, assertCurrent);
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
