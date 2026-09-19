import { describe, expect, it } from "vitest";
import {
  WSInboundMessageSchema,
  type WSInboundMessage,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

class MemoryTransport implements DaemonTransport {
  readonly sent: WSInboundMessage[] = [];
  private messageListeners = new Set<(data: unknown, isBinary: boolean) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<(event?: unknown) => void>();
  private errorListeners = new Set<(event?: unknown) => void>();

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data !== "string") throw new Error("Unexpected binary frame");
    const frame = WSInboundMessageSchema.parse(JSON.parse(data));
    this.sent.push(frame);
    if (frame.type === "ping") {
      for (const listener of this.messageListeners)
        listener(JSON.stringify({ type: "pong" }), false);
    }
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  onMessage(listener: (data: unknown, isBinary: boolean) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
  }

  onClose(listener: (event?: unknown) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onError(listener: (event?: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  respond(message: SessionOutboundMessage): void {
    for (const listener of this.messageListeners) {
      listener(JSON.stringify({ type: "session", message }), false);
    }
  }

  open(): void {
    for (const listener of this.openListeners) listener();
    this.respond({
      type: "status",
      payload: { status: "server_info", serverId: "preview-host", hostname: null, version: null },
    });
  }

  externalRequests() {
    return this.sent.flatMap((frame) =>
      frame.type === "session" &&
      (frame.message.type === "service.external.register.request" ||
        frame.message.type === "service.external.connect.request" ||
        frame.message.type === "service.external.disconnect.request")
        ? [frame.message]
        : [],
    );
  }

  previewRequests() {
    return this.sent.flatMap((frame) =>
      frame.type === "session" &&
      (frame.message.type === "service.preview.prepare.request" ||
        frame.message.type === "service.preview.close.request")
        ? [frame.message]
        : [],
    );
  }

  managedRequests() {
    return this.sent.flatMap((frame) =>
      frame.type === "session" &&
      (frame.message.type === "service.managed.enable.request" ||
        frame.message.type === "service.managed.disable.request")
        ? [frame.message]
        : [],
    );
  }
}

function outcome(request: Promise<unknown>) {
  return request.then(
    () => "resolved",
    () => "rejected",
  );
}

function fixture() {
  const transports: MemoryTransport[] = [];
  const client = new DaemonClient({
    url: "ws://preview-fixture",
    clientId: "preview-client",
    reconnect: { enabled: false },
    transportFactory() {
      const transport = new MemoryTransport();
      transports.push(transport);
      return transport;
    },
  });
  async function connect() {
    const connected = client.connect();
    const transport = transports.at(-1);
    if (!transport) throw new Error("No client transport");
    transport.open();
    await connected;
    return transport;
  }
  return { client, transports, connect };
}

function prepare(client: DaemonClient, attemptId: string) {
  return client.prepareServicePreview({
    requestId: `prepare-${attemptId}`,
    attemptId,
    browserHandle: "11111111-1111-4111-8111-111111111111",
    serviceId: "atlas",
    mode: "iframe",
  });
}

describe("service preview client requests", () => {
  it("never queues Prepare or Close across an unfinished handshake", async () => {
    const { client, transports } = fixture();
    const connected = client.connect();
    const preparing = prepare(client, "early").then(
      () => "resolved",
      () => "rejected",
    );
    const closing = client
      .closeServicePreview({ attemptId: "early", requestId: "close-early" })
      .then(
        () => "resolved",
        () => "rejected",
      );
    try {
      const transport = transports[0];
      expect(transport.previewRequests()).toEqual([]);
      transport.open();
      await connected;
      expect(transport.previewRequests()).toEqual([]);
      expect(await Promise.all([preparing, closing])).toEqual(["rejected", "rejected"]);
    } finally {
      await client.close();
      await Promise.all([preparing, closing]);
    }
  });

  it("correlates overlapping Prepare replies and lets Close settle before Prepare", async () => {
    const { client, connect } = fixture();
    try {
      const transport = await connect();
      const hello = transport.sent.find((frame) => frame.type === "hello");
      if (!hello || hello.type !== "hello") throw new Error("No hello");
      expect(hello.capabilities?.[CLIENT_CAPS.servicePreview]).toBe(1);
      const first = prepare(client, "first");
      const second = prepare(client, "second");
      const closing = client.closeServicePreview({ attemptId: "first", requestId: "close-first" });
      expect(transport.previewRequests().map((message) => message.requestId)).toEqual([
        "prepare-first",
        "prepare-second",
        "close-first",
      ]);

      transport.respond({
        type: "service.preview.close.response",
        payload: {
          requestId: "close-first",
          result: { status: "closed", attemptId: "first" },
        },
      });
      expect(await closing).toEqual({
        requestId: "close-first",
        result: { status: "closed", attemptId: "first" },
      });
      transport.respond({
        type: "service.preview.prepare.response",
        payload: {
          requestId: "prepare-second",
          result: {
            status: "prepared",
            attemptId: "second",
            bootstrapId: "bootstrap-second",
            ticket: "ticket-second",
            serviceId: "atlas",
            mode: "iframe",
          },
        },
      });
      expect((await second).result).toEqual({
        status: "prepared",
        attemptId: "second",
        bootstrapId: "bootstrap-second",
        ticket: "ticket-second",
        serviceId: "atlas",
        mode: "iframe",
      });
      transport.respond({
        type: "service.preview.prepare.response",
        payload: {
          requestId: "prepare-first",
          result: { status: "error", code: "unavailable" },
        },
      });
      expect(await first).toEqual({
        requestId: "prepare-first",
        result: { status: "error", code: "unavailable" },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects an interrupted Prepare and does not replay it on a fresh connection", async () => {
    const { client, connect } = fixture();
    try {
      const oldTransport = await connect();
      const pending = prepare(client, "interrupted").then(
        () => "resolved",
        () => "rejected",
      );
      expect(oldTransport.previewRequests().map((message) => message.requestId)).toEqual([
        "prepare-interrupted",
      ]);
      oldTransport.close();
      expect(await pending).toBe("rejected");
      const newTransport = await connect();
      expect(newTransport.previewRequests()).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

const externalInput = {
  name: "React fixture",
  port: 5173,
  workspaceId: "workspace-a",
  mount: "preserve" as const,
};

describe("external service client requests", () => {
  it("never queues registration, Connect or Disconnect across the handshake", async () => {
    const { client, transports } = fixture();
    const connected = client.connect();
    const requests = [
      client.registerExternalService({ ...externalInput, requestId: "register" }),
      client.connectExternalService({ serviceId: "external-fixture", requestId: "connect" }),
      client.disconnectExternalService({ serviceId: "external-fixture", requestId: "disconnect" }),
    ].map(outcome);
    try {
      const transport = transports[0];
      expect(transport.externalRequests()).toEqual([]);
      transport.open();
      await connected;
      expect(await Promise.all(requests)).toEqual(["rejected", "rejected", "rejected"]);
      expect(transport.externalRequests()).toEqual([]);
    } finally {
      await client.close();
      await Promise.all(requests);
    }
  });

  it("correlates operation and request identity without blocking Disconnect on a held Register", async () => {
    const { client, connect } = fixture();
    try {
      const transport = await connect();
      const registration = client.registerExternalService({
        ...externalInput,
        requestId: "register",
      });
      const connecting = client.connectExternalService({
        serviceId: "external-fixture",
        requestId: "connect",
      });
      const disconnecting = client.disconnectExternalService({
        serviceId: "external-fixture",
        requestId: "disconnect",
      });
      const settled: string[] = [];
      void registration.then(
        () => settled.push("registration"),
        () => settled.push("rejected"),
      );
      expect(transport.externalRequests().map((request) => request.requestId)).toEqual([
        "register",
        "connect",
        "disconnect",
      ]);
      transport.respond({
        type: "service.external.connect.response",
        payload: {
          requestId: "register",
          result: { status: "ok", serviceId: "must-not-match-register" },
        },
      });
      transport.respond({
        type: "service.external.disconnect.response",
        payload: {
          requestId: "disconnect",
          result: { status: "ok", serviceId: "external-fixture" },
        },
      });
      expect(await disconnecting).toEqual({
        requestId: "disconnect",
        result: { status: "ok", serviceId: "external-fixture" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toEqual([]);
      transport.respond({
        type: "service.external.connect.response",
        payload: {
          requestId: "connect",
          result: { status: "error", code: "restarting" },
        },
      });
      expect((await connecting).result).toEqual({ status: "error", code: "restarting" });
      transport.respond({
        type: "service.external.register.response",
        payload: {
          requestId: "register",
          result: { status: "ok", serviceId: "external-created" },
        },
      });
      expect((await registration).result).toEqual({ status: "ok", serviceId: "external-created" });
    } finally {
      await client.close();
    }
  });

  it("rejects interrupted external operations without replay on reconnect", async () => {
    const { client, connect } = fixture();
    try {
      const old = await connect();
      const requests = [
        client.registerExternalService({ ...externalInput, requestId: "register" }),
        client.connectExternalService({ serviceId: "external-fixture", requestId: "connect" }),
        client.disconnectExternalService({
          serviceId: "external-fixture",
          requestId: "disconnect",
        }),
      ].map(outcome);
      expect(old.externalRequests()).toHaveLength(3);
      old.close();
      expect(await Promise.all(requests)).toEqual(["rejected", "rejected", "rejected"]);
      const current = await connect();
      expect(current.externalRequests()).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

const managedInput = {
  workspaceId: "workspace-a",
  scriptName: "web",
  mount: "preserve" as const,
};

describe("managed service client requests", () => {
  it("never queues Enable or Disable across an unfinished handshake", async () => {
    const { client, transports } = fixture();
    const connected = client.connect();
    const requests = [
      client.enableManagedServicePreview({ ...managedInput, requestId: "enable" }),
      client.disableManagedServicePreview({
        workspaceId: managedInput.workspaceId,
        scriptName: managedInput.scriptName,
        requestId: "disable",
      }),
    ].map(outcome);
    try {
      const transport = transports[0];
      expect(transport.managedRequests()).toEqual([]);
      transport.open();
      await connected;
      expect(await Promise.all(requests)).toEqual(["rejected", "rejected"]);
      expect(transport.managedRequests()).toEqual([]);
    } finally {
      await client.close();
      await Promise.all(requests);
    }
  });

  it("rejects interrupted managed operations without replay on reconnect", async () => {
    const { client, connect } = fixture();
    try {
      const old = await connect();
      const requests = [
        client.enableManagedServicePreview({ ...managedInput, requestId: "enable" }),
        client.disableManagedServicePreview({
          workspaceId: managedInput.workspaceId,
          scriptName: managedInput.scriptName,
          requestId: "disable",
        }),
      ].map(outcome);
      expect(old.managedRequests()).toHaveLength(2);
      old.close();
      expect(await Promise.all(requests)).toEqual(["rejected", "rejected"]);
      const current = await connect();
      expect(current.managedRequests()).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("correlates Enable and Disable replies by request identity", async () => {
    const { client, connect } = fixture();
    try {
      const transport = await connect();
      const enabling = client.enableManagedServicePreview({ ...managedInput, requestId: "enable" });
      const disabling = client.disableManagedServicePreview({
        workspaceId: managedInput.workspaceId,
        scriptName: managedInput.scriptName,
        requestId: "disable",
      });
      expect(transport.managedRequests().map((request) => request.requestId)).toEqual([
        "enable",
        "disable",
      ]);
      transport.respond({
        type: "service.managed.disable.response",
        payload: { requestId: "disable", result: { status: "ok", serviceId: "managed-atlas" } },
      });
      expect(await disabling).toEqual({
        requestId: "disable",
        result: { status: "ok", serviceId: "managed-atlas" },
      });
      transport.respond({
        type: "service.managed.enable.response",
        payload: { requestId: "enable", result: { status: "error", code: "already-enabled" } },
      });
      expect(await enabling).toEqual({
        requestId: "enable",
        result: { status: "error", code: "already-enabled" },
      });
    } finally {
      await client.close();
    }
  });
});
