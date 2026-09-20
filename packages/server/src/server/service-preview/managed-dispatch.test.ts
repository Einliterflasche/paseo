import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import type { ServiceManagedEnableRequest, ServiceManagedDisableRequest } from "../messages.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import { createServiceProxySubsystem } from "../service-proxy.js";
import {
  WorkspaceScriptRuntimeStore,
  type ScriptRuntimeEntry,
} from "../workspace-script-runtime-store.js";
import { PreviewBroker } from "./broker.js";
import {
  dispatchManagedPreview,
  isManagedPreviewRequest,
  managedPreviewResponseType,
} from "./managed-dispatch.js";
import { ManagedEnrollmentError, ManagedPreviewServices } from "./managed-services.js";
import { ManagedPreviewRoutes } from "./managed.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewSources, PREVIEW_SOURCE_CAPABILITY } from "./sources.js";

const declaration = {
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "Atlas React",
  mount: "preserve" as const,
};

function runtimeEntry(overrides: Partial<ScriptRuntimeEntry> = {}): ScriptRuntimeEntry {
  return {
    workspaceId: declaration.workspaceId,
    scriptName: declaration.scriptName,
    type: "service",
    lifecycle: "running",
    terminalId: "terminal-a",
    exitCode: null,
    ...overrides,
  };
}

async function fixture(
  options: {
    validateService?: (input: { workspaceId: string; scriptName: string }) => Promise<void>;
  } = {},
) {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-dispatch-"));
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
  const routes = new PreviewRoutes({ excludedPorts: [] });
  const sources = new PreviewSources("https://control.test");
  const brokerFailures: unknown[] = [];
  const managed = new ManagedPreviewRoutes({
    runtime,
    endpoints,
    routes,
    qualifyHttp: () => true,
    onFailure() {},
  });
  const services = await ManagedPreviewServices.open({
    paseoHome,
    policy: [],
    managed,
    isWorkspaceBlocked: () => false,
    async validateService(input) {
      await (options.validateService ?? (async () => {}))(input);
    },
  });
  const broker = new PreviewBroker({
    sources,
    routes,
    managedServices: services,
    onFailure(error) {
      brokerFailures.push(error);
    },
  });
  function endpoint(input: { workspaceId?: string; scriptName?: string; port?: number } = {}) {
    const workspaceId = input.workspaceId ?? declaration.workspaceId;
    return endpoints.registerWorkspaceService({
      workspaceId,
      projectSlug: "react-preview",
      branchName: workspaceId,
      scriptName: input.scriptName ?? declaration.scriptName,
      port: input.port ?? 5173,
    });
  }
  function admit(connectionId: string) {
    const socket = { readyState: 1 };
    const frames: string[] = [];
    sources.admitDirectOwner({
      socket,
      connectionId,
      principalId: "owner",
      origin: "https://control.test",
      permissions: OWNER_PERMISSIONS,
      send: async (frame) => {
        frames.push(frame);
        return true;
      },
    });
    sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
    return { socket, frames };
  }
  return {
    paseoHome,
    runtime,
    endpoints,
    endpoint,
    routes,
    sources,
    managed,
    services,
    broker,
    admit,
  };
}

const passthrough = <T>(operation: () => Promise<T>) => operation();

function enableRequest(
  overrides: Partial<ServiceManagedEnableRequest> = {},
): ServiceManagedEnableRequest {
  return {
    type: "service.managed.enable.request",
    requestId: "request-enable",
    workspaceId: declaration.workspaceId,
    scriptName: declaration.scriptName,
    mount: "preserve",
    ...overrides,
  };
}

function disableRequest(
  overrides: Partial<ServiceManagedDisableRequest> = {},
): ServiceManagedDisableRequest {
  return {
    type: "service.managed.disable.request",
    requestId: "request-disable",
    workspaceId: declaration.workspaceId,
    scriptName: declaration.scriptName,
    ...overrides,
  };
}

function lastMessage(frames: string[]): {
  type: string;
  payload: { requestId: string; result: unknown };
} {
  return JSON.parse(frames.at(-1)!).message;
}

describe("managed preview dispatch", () => {
  it("classifies the two managed RPC directions and their response types", () => {
    const enable = enableRequest();
    const disable = disableRequest();
    expect(isManagedPreviewRequest(enable)).toBe(true);
    expect(isManagedPreviewRequest(disable)).toBe(true);
    expect(isManagedPreviewRequest({ type: "service.preview.prepare.request" } as never)).toBe(
      false,
    );
    expect(managedPreviewResponseType(enable)).toBe("service.managed.enable.response");
    expect(managedPreviewResponseType(disable)).toBe("service.managed.disable.response");
  });

  it("replies only to the requesting source, leaving an admitted sibling untouched", async () => {
    const f = await fixture();
    const requester = f.admit("requester");
    const sibling = f.admit("sibling");
    await dispatchManagedPreview({
      broker: f.broker,
      socket: requester.socket,
      request: enableRequest(),
      runAdmission: passthrough,
    });
    expect(requester.frames).toHaveLength(1);
    expect(sibling.frames).toHaveLength(0);
    const message = lastMessage(requester.frames);
    expect(message.type).toBe("service.managed.enable.response");
    expect(message.payload.requestId).toBe("request-enable");
    expect(message.payload.result).toMatchObject({ status: "ok" });
  });

  it("rejects a request from a socket that is not an admitted, connected source", async () => {
    const f = await fixture();
    const detached = { readyState: 1 };
    await expect(
      dispatchManagedPreview({
        broker: f.broker,
        socket: detached,
        request: enableRequest(),
        runAdmission: passthrough,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("gates Enable behind admission and maps a restart-in-progress refusal, while leaving Disable unmediated", async () => {
    const f = await fixture();
    const requester = f.admit("requester");
    const restarting = () => Promise.reject(new RestartInProgressError());
    await dispatchManagedPreview({
      broker: f.broker,
      socket: requester.socket,
      request: enableRequest(),
      runAdmission: restarting,
    });
    expect(lastMessage(requester.frames).payload.result).toEqual({
      status: "error",
      code: "restarting",
    });

    let disableRanThroughAdmission = false;
    await dispatchManagedPreview({
      broker: f.broker,
      socket: requester.socket,
      request: disableRequest(),
      runAdmission: (operation) => {
        disableRanThroughAdmission = true;
        return operation();
      },
    });
    expect(disableRanThroughAdmission).toBe(false);
    expect(lastMessage(requester.frames).payload.result).toEqual({
      status: "error",
      code: "unknown-service",
    });
  });

  it("maps unknown-service, already-enabled, and storage-error enrollment refusals onto the wire result", async () => {
    const unknown = await fixture({
      validateService: async () => {
        throw new ManagedEnrollmentError("unknown-service");
      },
    });
    const unknownSource = unknown.admit("requester");
    await dispatchManagedPreview({
      broker: unknown.broker,
      socket: unknownSource.socket,
      request: enableRequest(),
      runAdmission: passthrough,
    });
    expect(lastMessage(unknownSource.frames).payload.result).toEqual({
      status: "error",
      code: "unknown-service",
    });

    const f = await fixture();
    const source = f.admit("requester");
    await dispatchManagedPreview({
      broker: f.broker,
      socket: source.socket,
      request: enableRequest(),
      runAdmission: passthrough,
    });
    expect(lastMessage(source.frames).payload.result).toMatchObject({ status: "ok" });
    await dispatchManagedPreview({
      broker: f.broker,
      socket: source.socket,
      request: enableRequest({ requestId: "request-enable-2" }),
      runAdmission: passthrough,
    });
    expect(lastMessage(source.frames).payload.result).toEqual({
      status: "error",
      code: "already-enabled",
    });

    const storageError = await fixture();
    const storageSource = storageError.admit("requester");
    storageError.services.close();
    await dispatchManagedPreview({
      broker: storageError.broker,
      socket: storageSource.socket,
      request: enableRequest(),
      runAdmission: passthrough,
    });
    expect(lastMessage(storageSource.frames).payload.result).toEqual({
      status: "error",
      code: "unavailable",
    });
  });

  it("enables through the real broker/route stack, then disables while the runtime service keeps running", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const source = f.admit("requester");
    await dispatchManagedPreview({
      broker: f.broker,
      socket: source.socket,
      request: enableRequest(),
      runAdmission: passthrough,
    });
    const enableResult = lastMessage(source.frames).payload.result as {
      status: string;
      serviceId: string;
    };
    expect(enableResult.status).toBe("ok");
    const route = f.routes.capture(enableResult.serviceId);
    expect(route?.isCurrent()).toBe(true);

    await dispatchManagedPreview({
      broker: f.broker,
      socket: source.socket,
      request: disableRequest(),
      runAdmission: passthrough,
    });
    const disableResult = lastMessage(source.frames).payload.result as {
      status: string;
      serviceId: string;
    };
    expect(disableResult).toEqual({ status: "ok", serviceId: enableResult.serviceId });
    expect(route?.isCurrent()).toBe(false);
    expect(f.routes.capture(enableResult.serviceId)).toBeNull();
    expect(f.runtime.get(declaration)).toEqual(runtimeEntry());
  });
});
