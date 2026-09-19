import { mkdtemp, mkdir, readFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import pino from "pino";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { hashDaemonPassword } from "./auth.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import { PreviewGrantStore } from "./file-preview/grant-store.js";
import {
  WSOutboundMessageSchema,
  parseServerInfoStatusPayload,
  type WSOutboundMessage,
  type WSInboundMessage,
} from "./messages.js";
import { createPluginClientId } from "./plugins/plugin-session-identity.js";
import type { ScheduleService } from "./schedule/service.js";
import { PREVIEW_SOURCE_CAPABILITY, PreviewSources } from "./service-preview/sources.js";
import { PreviewBroker } from "./service-preview/broker.js";
import { PreviewRoutes } from "./service-preview/routes.js";
import { ExternalPreviewServices } from "./service-preview/external.js";
import { PreviewRegistrationStore } from "./service-preview/registrations.js";
import { createPreviewIngress } from "./service-preview/ingress.js";
import { AdmissionGate } from "./restart/admission-gate.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { VoiceAssistantWebSocketServer, type WebSocketLike } from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

const controlOrigin = "https://control.test";
const fixturePassword = "isolated-preview-source-test-password";
const passwordHash = hashDaemonPassword(fixturePassword);
const capable = { [PREVIEW_SOURCE_CAPABILITY]: 1 };
const cleanups: Array<() => Promise<void>> = [];

const previewRequest = {
  type: "service.preview.prepare.request" as const,
  requestId: "prepare-atlas",
  attemptId: "attempt-atlas",
  browserHandle: "test-profile",
  serviceId: "atlas",
  mode: "iframe" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const externalRegistration = {
  type: "service.external.register.request" as const,
  requestId: "register-external",
  name: "External React page",
  workspaceId: "workspace-a",
  port: 5174,
  mount: "preserve" as const,
};

function externalReplies(messages: readonly WSOutboundMessage[]) {
  return messages.flatMap((frame) => {
    if (
      frame.type === "session" &&
      (frame.message.type === "service.external.register.response" ||
        frame.message.type === "service.external.connect.response" ||
        frame.message.type === "service.external.disconnect.response")
    )
      return [frame.message];
    return [];
  });
}

function externalServiceId(messages: readonly WSOutboundMessage[]) {
  const reply = externalReplies(messages).find(
    (frame) => frame.type === "service.external.register.response",
  );
  if (reply?.payload.result.status !== "ok") throw new Error("Expected successful registration");
  return reply.payload.result.serviceId;
}

function receivedOrdinaryRpc(messages: readonly WSOutboundMessage[]) {
  return messages.some(
    (frame) =>
      frame.type === "session" &&
      frame.message.type === "get_providers_snapshot_response" &&
      frame.message.payload.requestId === "ordinary-rpc",
  );
}

function previewReplies(messages: readonly WSOutboundMessage[]) {
  return messages.flatMap((frame) => {
    if (frame.type === "session" && frame.message.type === "service.preview.prepare.response")
      return [frame.message];
    return [];
  });
}

function closeReplies(messages: readonly WSOutboundMessage[]) {
  return messages.flatMap((frame) => {
    if (frame.type === "session" && frame.message.type === "service.preview.close.response")
      return [frame.message];
    return [];
  });
}

function previewCatalogs(messages: readonly WSOutboundMessage[]) {
  return messages.flatMap((frame) => {
    if (
      frame.type === "session" &&
      frame.message.type === "status" &&
      frame.message.payload.status === "server_info"
    )
      return [parseServerInfoStatusPayload(frame.message.payload)?.servicePreviews];
    return [];
  });
}
const initialCatalog = {
  version: 1,
  origin: controlOrigin,
  services: [
    {
      serviceId: "atlas",
      name: "atlas",
      workspaceId: null,
      scriptName: null,
      port: 5173,
      available: true,
      revision: expect.any(String),
    },
  ],
};
function closeRequest(attemptId = previewRequest.attemptId): WSInboundMessage {
  return {
    type: "session",
    message: { type: "service.preview.close.request", requestId: `close-${attemptId}`, attemptId },
  };
}

function confirmReply(broker: PreviewBroker, frame: ReturnType<typeof previewReplies>[number]) {
  if (frame.payload.result.status !== "prepared") throw new Error("Expected prepared reply");
  const credential = broker.redeem(frame.payload.result);
  const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
  broker.confirm({ bootstrapId: credential.bootstrapId, cookieHeader, mode: credential.mode });
  return { cookieHeader, serviceId: credential.serviceId };
}

function countReply(messages: readonly WSOutboundMessage[], reply: WSOutboundMessage): number {
  const serialized = JSON.stringify(reply);
  return messages.filter((message) => JSON.stringify(message) === serialized).length;
}

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

interface ConnectOptions {
  password?: string | null;
  origin?: string | null;
  capabilities?: Record<string, unknown> | null;
  clientId?: string;
}

describe("preview admission through the real daemon WebSocket transport", () => {
  it("retains password verification through the exclusively dispatched upgrade owner", async () => {
    const host = await harness({ externallyDispatched: true });
    const valid = await host.connect({});
    await valid.ready();
    expect(host.sources.capture(valid.server())).not.toBeNull();
    valid.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(valid.messages).length).toBe(1);
    expect(previewReplies(valid.messages)[0].payload.result.status).toBe("prepared");
    const wrong = await host.connect({ password: "wrong-fixture-password" });
    await wrong.closed;
    expect(host.sources.capture(wrong.server())).toBeNull();
    expect(wrong.messages).toEqual([]);
    await valid.roundTrip();
    expect(host.externallyDispatchedUpgrades()).toBe(2);
    expect(host.failures).toEqual([]);
  });

  it("withdraws available services after broker shutdown without advertising them to siblings", async () => {
    const host = await harness();
    const eligible = await host.connect({});
    await eligible.ready();
    const ineligible = await host.connect({ capabilities: null });
    await ineligible.ready();
    host.broker.close();
    await eligible.roundTrip();
    await ineligible.roundTrip();
    expect(previewCatalogs(eligible.messages)).toEqual([
      initialCatalog,
      {
        ...initialCatalog,
        services: initialCatalog.services.map((service) => ({ ...service, available: false })),
      },
    ]);
    expect(previewCatalogs(ineligible.messages)).toEqual([undefined, undefined]);
    host.broker.close();
    await eligible.roundTrip();
    expect(previewCatalogs(eligible.messages)).toHaveLength(2);
  });

  it("removes and restores source-specific metadata when principal eligibility changes", async () => {
    const host = await harness();
    const eligible = await host.connect({});
    const ineligible = await host.connect({ capabilities: null });
    await eligible.ready();
    await ineligible.ready();
    expect(previewCatalogs(eligible.messages).at(-1)).toEqual(initialCatalog);
    const captured = host.sources.capture(eligible.server());
    if (!captured) throw new Error("Expected eligible source");
    host.server.updatePrincipalPermissions("owner", []);
    await eligible.roundTrip();
    expect(captured.isCurrent()).toBe(false);
    expect(previewCatalogs(eligible.messages).at(-1)).toBeUndefined();
    host.server.updatePrincipalPermissions("owner", OWNER_PERMISSIONS);
    await eligible.roundTrip();
    await ineligible.roundTrip();
    expect(previewCatalogs(eligible.messages).at(-1)).toEqual(initialCatalog);
    expect(previewCatalogs(ineligible.messages).every((catalog) => catalog === undefined)).toBe(
      true,
    );
    expect(captured.isCurrent()).toBe(false);
  });

  it.each([true, false])(
    "keeps preview metadata source-specific on hello and registry updates when capable is first: %s",
    async (capableFirst) => {
      const host = await harness();
      const first = await host.connect({ capabilities: capableFirst ? capable : null });
      await first.ready();
      const second = await host.connect({ capabilities: capableFirst ? null : capable });
      await second.ready();
      const eligible = capableFirst ? first : second;
      const ineligible = capableFirst ? second : first;
      expect(host.server.listSessions()).toHaveLength(1);
      expect(previewCatalogs(eligible.messages)).toEqual([initialCatalog]);
      expect(previewCatalogs(ineligible.messages)).toEqual([undefined]);

      host.routes.register({
        serviceId: "beacon",
        name: "Beacon React",
        workspaceId: "workspace-b",
        scriptName: "web",
        port: 5174,
        mount: "strip",
      });
      await eligible.roundTrip();
      await ineligible.roundTrip();
      expect(previewCatalogs(eligible.messages).at(-1)).toEqual({
        ...initialCatalog,
        services: [
          ...initialCatalog.services,
          {
            serviceId: "beacon",
            name: "Beacon React",
            workspaceId: "workspace-b",
            scriptName: "web",
            port: 5174,
            available: true,
            revision: expect.any(String),
          },
        ],
      });
      expect(previewCatalogs(ineligible.messages)).toEqual([undefined, undefined]);

      const previousRevision = previewCatalogs(eligible.messages).at(-1)?.services[1].revision;
      expect(previousRevision).toEqual(expect.any(String));
      const captured = host.routes.capture("beacon");
      if (!captured) throw new Error("Expected registered route");
      host.routes.replace({
        serviceId: "beacon",
        name: "Beacon changed",
        workspaceId: "workspace-b",
        scriptName: "web",
        port: 5180,
        mount: "preserve",
      });
      expect(captured.isCurrent()).toBe(false);
      await captured.invalidated;
      await eligible.roundTrip();
      const replacementRevision = previewCatalogs(eligible.messages).at(-1)?.services[1].revision;
      expect(replacementRevision).not.toBe(previousRevision);
      expect(previewCatalogs(eligible.messages).at(-1)?.services[1]).toEqual({
        serviceId: "beacon",
        name: "Beacon changed",
        workspaceId: "workspace-b",
        scriptName: "web",
        port: 5180,
        available: true,
        revision: expect.any(String),
      });
      host.routes.markUnavailable("beacon");
      await eligible.roundTrip();
      await ineligible.roundTrip();
      expect(previewCatalogs(eligible.messages).at(-1)?.services[1].revision).toBe(
        replacementRevision,
      );
      expect(previewCatalogs(eligible.messages).at(-1)?.services[1]).toEqual({
        serviceId: "beacon",
        name: "Beacon changed",
        workspaceId: "workspace-b",
        scriptName: "web",
        port: 5180,
        available: false,
        revision: expect.any(String),
      });
      expect(previewCatalogs(ineligible.messages)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    },
  );

  it("dispatches Close while a Prepare reply is held, without shared-session queuing", async () => {
    const host = await harness();
    const socket = new InternalSocket();
    await host.server.attachExternalSocket(socket);
    let release = (_value: boolean) => {};
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const frames: WSOutboundMessage[] = [];
    // This adapter holds transport completion deterministically. Real password
    // admission is covered by the adjacent TCP WebSocket cases, not this fixture.
    host.sources.admitDirectOwner({
      socket,
      connectionId: "held-preview",
      principalId: "owner",
      origin: controlOrigin,
      permissions: OWNER_PERMISSIONS,
      send(frame) {
        const parsed = WSOutboundMessageSchema.parse(JSON.parse(frame));
        frames.push(parsed);
        if (parsed.type === "session" && parsed.message.type === "service.preview.prepare.response")
          return held;
        return Promise.resolve(true);
      },
    });
    socket.hello("held-preview");
    socket.emit("message", JSON.stringify({ type: "session", message: previewRequest }));
    const response = previewReplies(frames)[0];
    const result = response.payload.result;
    if (result.status !== "prepared") throw new Error("Expected provisional reply");
    expect(() => host.broker.redeem(result)).toThrow("invalid-bootstrap");
    socket.emit("message", JSON.stringify(closeRequest()));
    expect(closeReplies(frames)[0].payload.result).toEqual({
      status: "closed",
      attemptId: previewRequest.attemptId,
    });
    release(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => host.broker.redeem(result)).toThrow("invalid-bootstrap");
    socket.close();
    expect(host.failures).toEqual([]);
  });

  it("returns a fixed source-only refusal when the optional broker is absent", async () => {
    const host = await harness({ previewInstalled: false });
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    expect(previewCatalogs(a.messages)).toEqual([undefined]);
    expect(previewCatalogs(b.messages)).toEqual([undefined]);
    a.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(a.messages).length).toBe(1);
    expect(previewReplies(a.messages)[0].payload.result).toEqual({
      status: "error",
      code: "unavailable",
    });
    a.send(closeRequest());
    await expect.poll(() => closeReplies(a.messages).length).toBe(1);
    expect(closeReplies(a.messages)[0].payload.result).toEqual({
      status: "error",
      code: "unavailable",
    });
    await b.roundTrip();
    expect(previewReplies(b.messages)).toEqual([]);
    expect(closeReplies(b.messages)).toEqual([]);
  });

  it.each([true, false])(
    "keeps negotiated eligibility physical when the capable socket connects first: %s",
    async (capableFirst) => {
      const host = await harness();
      const first = await host.connect({ capabilities: capableFirst ? capable : null });
      await first.ready();
      const second = await host.connect({ capabilities: capableFirst ? null : capable });
      await second.ready();
      const eligible = capableFirst ? first : second;
      const ineligible = capableFirst ? second : first;
      ineligible.send({
        type: "session",
        message: { ...previewRequest, requestId: "denied-source" },
      });
      eligible.send({ type: "session", message: previewRequest });
      await expect.poll(() => previewReplies(eligible.messages).length).toBe(1);
      await expect.poll(() => previewReplies(ineligible.messages).length).toBe(1);
      expect(previewReplies(eligible.messages)[0].payload.result.status).toBe("prepared");
      expect(previewReplies(ineligible.messages)[0].payload).toEqual({
        requestId: "denied-source",
        result: { status: "error", code: "unavailable" },
      });
      await eligible.roundTrip();
      await ineligible.roundTrip();
      expect(previewReplies(eligible.messages).map((reply) => reply.payload.requestId)).toEqual([
        previewRequest.requestId,
      ]);
      expect(previewReplies(ineligible.messages).map((reply) => reply.payload.requestId)).toEqual([
        "denied-source",
      ]);
    },
  );

  it("scopes Close to its source and ends old authority across reconnect and shutdown", async () => {
    const host = await harness();
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    a.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(a.messages).length).toBe(1);
    await a.roundTrip();
    const authority = confirmReply(host.broker, previewReplies(a.messages)[0]);
    const first = await host.broker.run(authority, (job) => job.activationId);
    b.send(closeRequest());
    await expect.poll(() => closeReplies(b.messages).length).toBe(1);
    expect(closeReplies(b.messages)[0].payload.result).toEqual({
      status: "closed",
      attemptId: previewRequest.attemptId,
    });
    expect(await host.broker.run(authority, (job) => job.activationId)).toBe(first);
    expect(closeReplies(a.messages)).toEqual([]);
    await a.close();
    await expect(host.broker.run(authority, (job) => job.activationId)).rejects.toThrow(
      "authorization-ended",
    );
    const c = await host.connect({});
    await c.ready();
    c.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(c.messages).length).toBe(1);
    await c.roundTrip();
    const fresh = confirmReply(host.broker, previewReplies(c.messages)[0]);
    expect(await host.broker.run(fresh, (job) => job.activationId)).not.toBe(first);
    host.server.prepareForShutdown();
    await expect(host.broker.run(fresh, (job) => job.activationId)).rejects.toThrow(
      "authorization-ended",
    );
    expect(previewReplies(b.messages)).toEqual([]);
    expect(host.failures).toEqual([]);
  });

  it("routes Prepare success and denial only to their physical sockets within a shared session", async () => {
    const host = await harness();
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    a.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(a.messages).length).toBe(1);
    const reply = previewReplies(a.messages)[0];
    expect(reply.payload.requestId).toBe(previewRequest.requestId);
    expect(reply.payload.result.status).toBe("prepared");
    await b.roundTrip();
    expect(previewReplies(b.messages)).toEqual([]);
    b.send({ type: "session", message: { ...previewRequest, serviceId: "missing" } });
    await expect.poll(() => previewReplies(b.messages).length).toBe(1);
    expect(previewReplies(b.messages)[0].payload.result).toEqual({
      status: "error",
      code: "unavailable",
    });
    await a.roundTrip();
    expect(previewReplies(a.messages)).toEqual([reply]);
  });

  it("settles a held reply before the unexpected-hello close handshake finishes", async () => {
    const host = await harness();
    const socket = new HeldCloseSocket();
    let release = (_queued: boolean) => {};
    const transport = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    await host.server.attachExternalSocket(socket);
    // Authority is explicitly supplied by this lifecycle fixture; external
    // admission remains ineligible in the separate real-transport tests.
    host.sources.admitDirectOwner({
      socket,
      connectionId: "held-close",
      principalId: "owner",
      origin: controlOrigin,
      permissions: OWNER_PERMISSIONS,
      send: () => transport,
    });
    socket.hello("held-close");
    const capture = host.sources.capture(socket);
    expect(capture?.isCurrent()).toBe(true);
    const pending = capture!.send({ type: "pong" });
    try {
      socket.hello("held-close");
      expect(socket.closing).toEqual({ code: 4002, reason: "Unexpected hello" });
      expect(socket.readyState).toBe(2);
      expect(socket.closeEvents).toBe(0);
      await expect(capture!.invalidated).resolves.toBeUndefined();
      await expect(Promise.race([pending, Promise.resolve("still pending")])).resolves.toBe(
        "invalidated",
      );
      release(true);
      await expect(pending).resolves.toBe("invalidated");
      expect(socket.closeEvents).toBe(0);
    } finally {
      release(false);
      socket.finishClosing();
    }
  });

  it("delivers a reply only to the captured physical source, with no sibling fallback", async () => {
    const host = await harness();
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    const capture = host.sources.capture(a.server());
    const reply: WSOutboundMessage = {
      type: "session",
      message: {
        type: "status",
        payload: { status: "error", message: "inert exact-source fixture" },
      },
    };
    await expect(capture?.send(reply)).resolves.toBe("queued");
    await expect.poll(() => countReply(a.messages, reply)).toBe(1);
    await b.roundTrip();
    expect(countReply(b.messages, reply)).toBe(0);
    await a.close();
    await expect(capture?.send(reply)).resolves.toBe("invalidated");
    await b.roundTrip();
    expect(countReply(b.messages, reply)).toBe(0);
  });

  it("keeps source capabilities and detach separate inside a shared session", async () => {
    const host = await harness();
    const a = await host.connect({ capabilities: capable });
    await a.ready();
    const first = host.sources.capture(a.server());
    expect(first?.isCurrent()).toBe(true);
    const b = await host.connect({ capabilities: null });
    await b.ready();
    expect(host.server.listSessions()).toHaveLength(1);
    expect(host.sources.capture(b.server())).toBeNull();
    expect(first?.isCurrent()).toBe(true);
    await a.close();
    expect(first?.isCurrent()).toBe(false);
    await expect(first!.invalidated).resolves.toBeUndefined();
    expect(host.sources.capture(a.server())).toBeNull();

    const c = await host.connect({ capabilities: capable });
    await c.ready();
    expect(host.server.listSessions()).toHaveLength(1);
    expect(host.sources.capture(c.server())?.connectionId).not.toBe(first?.connectionId);
    expect(host.sources.capture(c.server())?.isCurrent()).toBe(true);
    expect(host.sources.capture(b.server())).toBeNull();
    expect(first?.isCurrent()).toBe(false);
  });

  it("requires a verified password and an independently exact approved Origin", async () => {
    const host = await harness();
    const missing = await host.connect({ password: null });
    await missing.closed;
    expect(host.sources.capture(missing.server())).toBeNull();
    expect(missing.messages).toEqual([]);
    const wrong = await host.connect({ password: "wrong-fixture-password" });
    await wrong.closed;
    expect(host.sources.capture(wrong.server())).toBeNull();
    expect(wrong.messages).toEqual([]);

    const noOrigin = await host.connect({ origin: null });
    await noOrigin.ready();
    expect(host.sources.capture(noOrigin.server())).toBeNull();
    // The ordinary daemon's wildcard admission is deliberately wider here.
    const foreign = await host.connect({ origin: "https://unrelated.test" });
    await foreign.ready();
    expect(host.sources.capture(foreign.server())).toBeNull();
    const valid = await host.connect({});
    await valid.ready();
    expect(host.sources.capture(valid.server())?.isCurrent()).toBe(true);
  });

  it("does not infer authentication from a browser hello on an authless daemon", async () => {
    const host = await harness({ authenticated: false });
    const connection = await host.connect({ password: null });
    await connection.ready();
    expect(host.sources.capture(connection.server())).toBeNull();
    expect(previewCatalogs(connection.messages)).toEqual([undefined]);
    host.routes.replace({ serviceId: "atlas", port: 5180, mount: "preserve" });
    await connection.roundTrip();
    expect(previewCatalogs(connection.messages)).toEqual([undefined, undefined]);
  });

  it("leaves plugin and external default-owner admission ineligible", async () => {
    const host = await harness();
    const plugin = new InternalSocket();
    const external = new InternalSocket();
    await host.server.attachPluginSocket("preview-fixture", plugin);
    plugin.hello(createPluginClientId("preview-fixture"));
    await host.server.attachExternalSocket(external);
    external.hello("external-fixture");
    expect(host.server.listSessions()).toHaveLength(2);
    expect(host.sources.capture(plugin)).toBeNull();
    expect(host.sources.capture(external)).toBeNull();
    expect(previewCatalogs(plugin.messages)).toEqual([undefined]);
    expect(previewCatalogs(external.messages)).toEqual([undefined]);
    host.routes.replace({ serviceId: "atlas", port: 5180, mount: "preserve" });
    expect(previewCatalogs(plugin.messages)).toEqual([undefined, undefined]);
    expect(previewCatalogs(external.messages)).toEqual([undefined, undefined]);
  });

  it("invalidates pending authority across permission restoration and shutdown", async () => {
    const host = await harness();
    const connection = await host.connect({});
    await connection.ready();
    const before = host.sources.capture(connection.server());
    expect(before?.isCurrent()).toBe(true);
    host.server.updatePrincipalPermissions("owner", []);
    expect(host.sources.capture(connection.server())).toBeNull();
    host.server.updatePrincipalPermissions("owner", OWNER_PERMISSIONS);
    expect(before?.isCurrent()).toBe(false);
    await expect(before!.invalidated).resolves.toBeUndefined();
    const restored = host.sources.capture(connection.server());
    expect(restored?.isCurrent()).toBe(true);
    host.server.prepareForShutdown();
    expect(restored?.isCurrent()).toBe(false);
    await expect(restored!.invalidated).resolves.toBeUndefined();
    expect(host.sources.capture(connection.server())).toBeNull();
  });
});

describe("external registration through the real daemon WebSocket transport", () => {
  it.each([true, false])(
    "keeps registration permission and metadata physical when capable first: %s",
    async (capableFirst) => {
      const host = await harness({ externalInstalled: true });
      const first = await host.connect({ capabilities: capableFirst ? capable : null });
      await first.ready();
      const second = await host.connect({ capabilities: capableFirst ? null : capable });
      await second.ready();
      const eligible = capableFirst ? first : second;
      const ineligible = capableFirst ? second : first;
      expect(host.server.listSessions()).toHaveLength(1);
      expect(previewCatalogs(eligible.messages).at(-1)?.externalRegistration).toBe(1);
      expect(previewCatalogs(ineligible.messages)).toEqual([undefined]);
      ineligible.send({
        type: "session",
        message: { ...externalRegistration, requestId: "ineligible" },
      });
      await expect.poll(() => externalReplies(ineligible.messages).length).toBe(1);
      expect(externalReplies(ineligible.messages)[0].payload).toEqual({
        requestId: "ineligible",
        result: { status: "error", code: "unavailable" },
      });
      expect(await host.registrations.list()).toEqual([]);
      eligible.send({ type: "session", message: externalRegistration });
      await expect.poll(() => externalReplies(eligible.messages).length).toBe(1);
      const id = externalServiceId(eligible.messages);
      expect(host.routes.capture(id)).toBeNull();
      expect(
        previewCatalogs(eligible.messages)
          .at(-1)
          ?.services.find((route) => route.serviceId === id)?.available,
      ).toBe(false);
      await ineligible.roundTrip();
      expect(previewCatalogs(ineligible.messages).every((catalog) => catalog === undefined)).toBe(
        true,
      );
      expect(externalReplies(ineligible.messages).map((reply) => reply.payload.requestId)).toEqual([
        "ineligible",
      ]);
    },
  );

  it("registers definitions, explicitly connects, then Disconnect revokes and archives", async () => {
    const host = await harness({ externalInstalled: true });
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    a.send({ type: "session", message: externalRegistration });
    await expect.poll(() => externalReplies(a.messages).length).toBe(1);
    const serviceId = externalServiceId(a.messages);
    expect(host.routes.capture(serviceId)).toBeNull();
    a.send({
      type: "session",
      message: { type: "service.external.connect.request", requestId: "connect", serviceId },
    });
    await expect.poll(() => externalReplies(a.messages).length).toBe(2);
    expect(externalReplies(a.messages)[1].payload.result).toEqual({ status: "ok", serviceId });
    const route = host.routes.capture(serviceId);
    expect(route?.isCurrent()).toBe(true);
    a.send({ type: "session", message: { ...previewRequest, serviceId } });
    await expect.poll(() => previewReplies(a.messages).length).toBe(1);
    await a.roundTrip();
    const authority = confirmReply(host.broker, previewReplies(a.messages)[0]);
    await expect(host.broker.run(authority, () => "authorized")).resolves.toBe("authorized");
    a.send({
      type: "session",
      message: { type: "service.external.disconnect.request", requestId: "disconnect", serviceId },
    });
    await expect.poll(() => route?.isCurrent()).toBe(false);
    await expect(host.broker.run(authority, () => "must not run")).rejects.toThrow(
      "authorization-ended",
    );
    await expect.poll(() => externalReplies(a.messages).length).toBe(3);
    expect(externalReplies(a.messages)[2].payload.result).toEqual({ status: "ok", serviceId });
    expect((await host.registrations.list())[0]).toMatchObject({
      serviceId,
      archivedAt: expect.any(String),
    });
    expect(host.routes.describe().some((item) => item.serviceId === serviceId)).toBe(false);
    await b.roundTrip();
    expect(externalReplies(b.messages)).toEqual([]);
    expect(previewReplies(b.messages)).toEqual([]);
  });

  it.each([false, true])(
    "drains accepted external archival before closing the real transport; observer fails=%s",
    async (failObserver) => {
      const host = await harness({ externalInstalled: true });
      const a = await host.connect({});
      await a.ready();
      a.send({ type: "session", message: externalRegistration });
      await expect.poll(() => externalReplies(a.messages).length).toBe(1);
      const serviceId = externalServiceId(a.messages);
      a.send({
        type: "session",
        message: { type: "service.external.connect.request", requestId: "connect", serviceId },
      });
      await expect.poll(() => externalReplies(a.messages).length).toBe(2);
      const capture = host.routes.capture(serviceId);
      expect(capture?.isCurrent()).toBe(true);
      const held = host.holdNextValidation();
      a.send({
        type: "session",
        message: { type: "service.external.connect.request", requestId: "held-connect", serviceId },
      });
      await held.entered.promise;
      a.send({
        type: "session",
        message: {
          type: "service.external.disconnect.request",
          requestId: "disconnect",
          serviceId,
        },
      });
      await expect.poll(() => capture?.isCurrent()).toBe(false);
      const original = new Error("transport shutdown observer failed");
      if (failObserver) {
        host.broker.subscribeCatalog(() => {
          throw original;
        });
      }
      const closing = host.closeServer();
      void closing.catch(() => {});
      try {
        expect(host.broker.isClosed).toBe(true);
        expect(host.sources.capture(a.server())).toBeNull();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const sentinel = Symbol("waiting for accepted archival");
        expect(await Promise.race([closing, Promise.resolve(sentinel)])).toBe(sentinel);
        // Transport cleanup does not wait on this owner: the client socket may
        // already be closing. What must still hold is that the archival write
        // accepted before shutdown began has not been abandoned.
        const midDrain = JSON.parse(await readFile(host.registrationFile, "utf8"));
        expect(midDrain.registrations).toEqual([
          expect.objectContaining({ serviceId, archivedAt: null }),
        ]);
      } finally {
        held.result.resolve(true);
      }
      // A synchronous catalog-observer failure during prepareForShutdown is
      // caught and logged there; it does not reject the transport's own close
      // promise, and it must not abandon the archival write already queued
      // before shutdown began.
      await closing;
      await a.closed;
      await expect
        .poll(async () => {
          const current = JSON.parse(await readFile(host.registrationFile, "utf8"));
          return current.registrations[0]?.archivedAt ?? null;
        })
        .not.toBeNull();
      const persisted = JSON.parse(await readFile(host.registrationFile, "utf8"));
      expect(persisted.registrations).toEqual([
        expect.objectContaining({ serviceId, archivedAt: expect.any(String) }),
      ]);
      expect(host.routes.capture(serviceId)).toBeNull();
      expect(externalReplies(a.messages)).toHaveLength(2);
      if (!failObserver) expect(host.failures).toEqual([]);
    },
  );

  it.each([
    ["register", "permissions"],
    ["connect", "permissions"],
    ["register", "detach"],
    ["connect", "detach"],
  ] as const)(
    "does not commit held %s after source %s and restoration",
    async (operation, invalidation) => {
      const host = await harness({ externalInstalled: true });
      const a = await host.connect({});
      await a.ready();
      const b = await host.connect({});
      await b.ready();
      let serviceId = "unused";
      if (operation === "connect") {
        a.send({ type: "session", message: externalRegistration });
        await expect.poll(() => externalReplies(a.messages).length).toBe(1);
        serviceId = externalServiceId(a.messages);
      }
      const initialReplies = externalReplies(a.messages).length;
      const held = host.holdNextValidation();
      a.send({
        type: "session",
        message:
          operation === "register"
            ? externalRegistration
            : {
                type: "service.external.connect.request",
                requestId: "held-connect",
                serviceId,
              },
      });
      await held.entered.promise;
      if (invalidation === "detach") {
        await a.close();
        const replacement = await host.connect({});
        await replacement.ready();
        expect(externalReplies(replacement.messages)).toEqual([]);
      } else {
        host.server.updatePrincipalPermissions("owner", []);
        host.server.updatePrincipalPermissions("owner", OWNER_PERMISSIONS);
      }
      const finished = host.admissions.freeze();
      held.result.resolve(true);
      await finished;
      host.admissions.open();
      expect(await host.registrations.list()).toHaveLength(operation === "register" ? 0 : 1);
      expect(host.routes.capture(serviceId)).toBeNull();
      await b.roundTrip();
      if (invalidation === "permissions") await a.roundTrip();
      expect(externalReplies(a.messages)).toHaveLength(initialReplies);
      expect(externalReplies(b.messages)).toEqual([]);
      expect(host.broker.isClosed).toBe(false);
    },
  );

  it("keeps Close and Disconnect available while the admission gate rejects new work", async () => {
    const host = await harness({ externalInstalled: true });
    const a = await host.connect({});
    await a.ready();
    a.send({ type: "session", message: externalRegistration });
    await expect.poll(() => externalReplies(a.messages).length).toBe(1);
    const serviceId = externalServiceId(a.messages);
    a.send({
      type: "session",
      message: {
        type: "service.external.connect.request",
        requestId: "initial-connect",
        serviceId,
      },
    });
    await expect.poll(() => externalReplies(a.messages).length).toBe(2);
    a.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(a.messages).length).toBe(1);
    await a.roundTrip();
    const authority = confirmReply(host.broker, previewReplies(a.messages)[0]);
    await host.admissions.freeze();
    a.send({
      type: "session",
      message: { ...externalRegistration, requestId: "frozen-register", port: 5180 },
    });
    a.send({
      type: "session",
      message: { type: "service.external.connect.request", requestId: "frozen-connect", serviceId },
    });
    a.send({
      type: "session",
      message: { ...previewRequest, requestId: "frozen-open", attemptId: "frozen-open" },
    });
    await expect.poll(() => externalReplies(a.messages).length).toBe(4);
    await expect.poll(() => previewReplies(a.messages).length).toBe(2);
    expect(
      externalReplies(a.messages)
        .slice(2)
        .map((reply) => reply.payload.result),
    ).toEqual([
      { status: "error", code: "restarting" },
      { status: "error", code: "restarting" },
    ]);
    expect(previewReplies(a.messages)[1].payload.result.status).toBe("error");
    expect(host.broker.isClosed).toBe(false);
    a.send(closeRequest());
    await expect.poll(() => closeReplies(a.messages).length).toBe(1);
    expect(closeReplies(a.messages)[0].payload.result.status).toBe("closed");
    await expect(host.broker.run(authority, () => "must not run")).rejects.toThrow(
      "authorization-ended",
    );
    a.send({
      type: "session",
      message: {
        type: "service.external.disconnect.request",
        requestId: "frozen-disconnect",
        serviceId,
      },
    });
    await expect.poll(() => externalReplies(a.messages).length).toBe(5);
    expect(externalReplies(a.messages)[4].payload.result).toEqual({ status: "ok", serviceId });
    expect(await host.registrations.list()).toHaveLength(1);
    expect(host.routes.capture(serviceId)).toBeNull();
  });

  it("returns fixed storage errors without reviving disconnected routes", async () => {
    const host = await harness({ externalInstalled: true });
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    a.send({ type: "session", message: externalRegistration });
    await expect.poll(() => externalReplies(a.messages).length).toBe(1);
    const serviceId = externalServiceId(a.messages);
    a.send({
      type: "session",
      message: { type: "service.external.connect.request", requestId: "connect", serviceId },
    });
    await expect.poll(() => externalReplies(a.messages).length).toBe(2);
    const old = host.routes.capture(serviceId);
    await rename(host.registrationFile, `${host.registrationFile}.retained-before-error`);
    await mkdir(host.registrationFile);
    a.send({
      type: "session",
      message: {
        type: "service.external.disconnect.request",
        requestId: "disk-failure",
        serviceId,
      },
    });
    await expect.poll(() => externalReplies(a.messages).length).toBe(3);
    expect(externalReplies(a.messages)[2].payload).toEqual({
      requestId: "disk-failure",
      result: { status: "error", code: "storage-error" },
    });
    expect(old?.isCurrent()).toBe(false);
    expect(host.routes.capture(serviceId)).toBeNull();
    expect((await host.registrations.list())[0].archivedAt).toBeNull();
    await b.roundTrip();
    expect(externalReplies(b.messages)).toEqual([]);
    expect(host.broker.isClosed).toBe(false);
  });

  it("contains unexpected dependency failures and preserves unrelated session RPCs", async () => {
    const host = await harness({ externalInstalled: true });
    const a = await host.connect({});
    await a.ready();
    const b = await host.connect({});
    await b.ready();
    a.send({ type: "session", message: previewRequest });
    await expect.poll(() => previewReplies(a.messages).length).toBe(1);
    await a.roundTrip();
    const authority = confirmReply(host.broker, previewReplies(a.messages)[0]);
    const held = host.holdNextValidation();
    a.send({ type: "session", message: externalRegistration });
    await held.entered.promise;
    held.result.reject(new Error("private dependency details must remain server side"));
    await expect.poll(() => externalReplies(a.messages).length).toBe(1);
    expect(externalReplies(a.messages)[0].payload).toEqual({
      requestId: externalRegistration.requestId,
      result: { status: "error", code: "unavailable" },
    });
    expect(host.broker.isClosed).toBe(true);
    await expect(host.broker.run(authority, () => "must not run")).rejects.toThrow(
      "authorization-ended",
    );
    expect(host.broker.describe().services.every((route) => !route.available)).toBe(true);
    expect(await host.registrations.list()).toEqual([]);
    b.send({
      type: "session",
      message: { type: "get_providers_snapshot_request", requestId: "ordinary-rpc" },
    });
    await expect.poll(() => receivedOrdinaryRpc(b.messages)).toBe(true);
    expect(externalReplies(b.messages)).toEqual([]);
  });

  it("does not infer external registration permission from authless or plugin admission", async () => {
    const host = await harness({ authenticated: false, externalInstalled: true });
    const a = await host.connect({ password: null });
    await a.ready();
    const plugin = new InternalSocket();
    await host.server.attachPluginSocket("external-registration-fixture", plugin);
    plugin.hello(createPluginClientId("external-registration-fixture"));
    a.send({ type: "session", message: externalRegistration });
    plugin.emit("message", JSON.stringify({ type: "session", message: externalRegistration }));
    await expect.poll(() => externalReplies(a.messages).length).toBe(1);
    await expect.poll(() => externalReplies(plugin.messages).length).toBe(1);
    expect(externalReplies(a.messages)[0].payload.result).toEqual({
      status: "error",
      code: "unavailable",
    });
    expect(externalReplies(plugin.messages)[0].payload.result).toEqual({
      status: "error",
      code: "unavailable",
    });
    expect(await host.registrations.list()).toEqual([]);
    expect(previewCatalogs(a.messages)).toEqual([undefined]);
    expect(previewCatalogs(plugin.messages)).toEqual([undefined]);
  });
});

class InternalSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  readonly messages: WSOutboundMessage[] = [];
  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string")
      this.messages.push(WSOutboundMessageSchema.parse(JSON.parse(data)));
    callback?.();
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, "fixture closed");
  }
  hello(clientId: string): void {
    this.emit("message", JSON.stringify(hello(clientId, capable)));
  }
}

interface CloseRequest {
  code: number | undefined;
  reason: string | undefined;
}

class HeldCloseSocket extends InternalSocket {
  closing: CloseRequest | null = null;
  closeEvents = 0;
  override close(code?: number, reason?: string): void {
    this.closing = { code, reason };
    this.readyState = 2;
  }
  finishClosing(): void {
    this.readyState = 3;
    this.closeEvents++;
    this.emit("close", 1000, "fixture finished");
  }
}

function hello(clientId: string, capabilities: Record<string, unknown> | null) {
  const featureFields = capabilities === null ? {} : { capabilities };
  return { type: "hello", clientId, clientType: "browser", protocolVersion: 1, ...featureFields };
}

interface HarnessOptions {
  authenticated?: boolean;
  previewInstalled?: boolean;
  externalInstalled?: boolean;
  externallyDispatched?: boolean;
}

async function harness({
  authenticated = true,
  previewInstalled = true,
  externalInstalled = false,
  externallyDispatched = false,
}: HarnessOptions = {}) {
  const http = createServer();
  const sources = new PreviewSources(controlOrigin);
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  routes.register({ serviceId: "atlas", port: 5173, mount: "preserve" });
  const failures: unknown[] = [];
  const home = await mkdtemp(join(tmpdir(), "paseo-preview-source-"));
  const admissions = new AdmissionGate();
  let heldValidation: {
    entered: ReturnType<typeof deferred<void>>;
    result: ReturnType<typeof deferred<boolean>>;
  } | null = null;
  const registrations = new PreviewRegistrationStore({
    paseoHome: home,
    excludedPorts: () => new Set([6767]),
    async workspaceExists(workspaceId) {
      const held = heldValidation;
      heldValidation = null;
      if (held) {
        held.entered.resolve();
        return held.result.promise;
      }
      return workspaceId === "workspace-a";
    },
  });
  const externalServices = externalInstalled
    ? await ExternalPreviewServices.open({ store: registrations, routes })
    : undefined;
  const broker = new PreviewBroker({
    sources,
    routes,
    externalServices,
    onFailure(error) {
      failures.push(error);
    },
  });
  const server = new VoiceAssistantWebSocketServer(
    http,
    pino({ level: "silent" }),
    "fixture-preview-host",
    createStub<AgentManager>({
      setAgentAttentionCallback() {},
      // The actual gate is the same owner delegated by AgentManager.
      runRequestAdmission: <T>(operation: () => Promise<T>) => admissions.run(operation),
      subscribe: () => () => {},
      getMetricsSnapshot: () => ({
        total: 0,
        byLifecycle: {},
        withActiveForegroundTurn: 0,
        timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
      }),
    }),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    new PreviewGrantStore(),
    home,
    createStub<DaemonConfigStore>({ onApply: () => () => {}, onChange: () => () => {} }),
    null,
    {
      allowedOrigins: new Set(["*"]),
      previewBroker: previewInstalled ? broker : undefined,
      externallyDispatched,
    },
    createStub<WorkspaceAutoName>({ scheduleForWorktree() {}, scheduleForDirectory() {} }),
    authenticated ? { password: passwordHash } : undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe() {},
      scheduleRefreshForCwd() {},
      dispose() {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
  );
  const accepted: WebSocket[] = [];
  const { wss } = asInternals<{ wss: WebSocketServer }>(server);
  wss.on("connection", (socket) => accepted.push(socket));
  const clients: WebSocket[] = [];
  let dispatchedUpgrades = 0;
  const ingress = externallyDispatched
    ? createPreviewIngress({
        preview: null,
        application(_request, response) {
          response.writeHead(404);
          response.end();
        },
        legacyUpgrade() {
          return false;
        },
        daemonUpgrade(request, socket, head) {
          dispatchedUpgrades += 1;
          server.handleUpgrade(request, socket, head);
        },
      })
    : null;
  if (ingress) {
    http.on("request", ingress.handle);
    http.on("upgrade", ingress.upgrade);
    http.on("connect", ingress.connect);
  }
  let serverClosing: Promise<void> | null = null;
  function closeServer() {
    serverClosing ??= server.close();
    return serverClosing;
  }
  cleanups.push(async () => {
    ingress?.close();
    for (const client of clients) client.terminate();
    // A test may deliberately exercise a failed close. Its assertion owns that
    // result; fixture cleanup retries after the injected observer has retired.
    await server.close();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind a TCP address");

  return {
    sources,
    routes,
    broker,
    failures,
    externallyDispatchedUpgrades: () => dispatchedUpgrades,
    server,
    closeServer,
    admissions,
    registrations,
    registrationFile: join(home, "services", "registrations-v1.json"),
    holdNextValidation() {
      const held = { entered: deferred<void>(), result: deferred<boolean>() };
      heldValidation = held;
      return held;
    },
    async connect(options: ConnectOptions) {
      const index = accepted.length;
      const password = options.password === undefined ? fixturePassword : options.password;
      const origin = options.origin === undefined ? controlOrigin : options.origin;
      const protocols = password === null ? [] : [`paseo.bearer.${password}`];
      const headers = origin === null ? {} : { Origin: origin };
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, protocols, { headers });
      clients.push(client);
      const messages: WSOutboundMessage[] = [];
      const errors: string[] = [];
      client.on("error", (error) => errors.push(error.message));
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.on("message", (data, binary) => {
        if (binary) return;
        const message: unknown = JSON.parse(data.toString());
        messages.push(WSOutboundMessageSchema.parse(message));
      });
      client.on("open", () => {
        const capabilities = options.capabilities === undefined ? capable : options.capabilities;
        client.send(
          JSON.stringify(hello(options.clientId ?? "shared-preview-profile", capabilities)),
        );
      });
      await expect.poll(() => accepted.length).toBe(index + 1);
      return {
        messages,
        send(message: WSInboundMessage) {
          client.send(JSON.stringify(message));
        },
        closed,
        async roundTrip() {
          const before = messages.filter((message) => message.type === "pong").length;
          client.send(JSON.stringify({ type: "ping" }));
          await expect
            .poll(() => messages.filter((message) => message.type === "pong").length)
            .toBe(before + 1);
        },
        server: () => accepted[index]!,
        async ready() {
          await expect
            .poll(() =>
              messages.some(
                (message) =>
                  message.type === "session" &&
                  message.message.type === "status" &&
                  message.message.payload.status === "server_info",
              ),
            )
            .toBe(true);
          expect(errors).toEqual([]);
        },
        async close() {
          client.close();
          await closed;
          await expect.poll(() => accepted[index]!.readyState).toBe(WebSocket.CLOSED);
        },
      };
    },
  };
}
