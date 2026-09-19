import { describe, expect, it } from "vitest";
import {
  WSOutboundMessageSchema,
  ServerInfoStatusPayloadSchema,
  parseServerInfoStatusPayload,
} from "../../src/messages.js";
import { validateWSOutboundMessage } from "../../src/validation/ws-outbound.js";

const descriptor = {
  serviceId: "atlas",
  name: "Atlas React",
  workspaceId: "workspace-a",
  scriptName: "web",
  port: 5173,
  available: true,
};

function serverInfo(servicePreviews?: unknown) {
  return {
    type: "session",
    message: {
      type: "status",
      payload: {
        status: "server_info",
        serverId: "preview-host",
        ...(servicePreviews === undefined ? {} : { servicePreviews }),
      },
    },
  };
}

describe("preview catalog protocol validation", () => {
  it("preserves legacy server_info without preview metadata", () => {
    const envelope = serverInfo();
    expect(WSOutboundMessageSchema.safeParse(envelope)).toMatchObject({
      success: true,
      data: envelope,
    });
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  });

  it.each([{}, { revision: "route-generation-a" }])(
    "preserves version 1 metadata with optional revision %j",
    (revision) => {
      const envelope = serverInfo({
        version: 1,
        origin: "https://control.test",
        services: [{ ...descriptor, ...revision }],
      });
      expect(WSOutboundMessageSchema.safeParse(envelope)).toMatchObject({
        success: true,
        data: envelope,
      });
      expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
    },
  );

  it("retains external registration support and the external service discriminator", () => {
    const metadata = {
      version: 1,
      origin: "https://control.test",
      externalRegistration: 1,
      services: [{ ...descriptor, kind: "external", revision: "external-incarnation" }],
    };
    const envelope = serverInfo(metadata);
    const decoded = validateWSOutboundMessage(envelope);
    expect(decoded).toEqual({ success: true, data: envelope });
    expect(parseServerInfoStatusPayload(envelope.message.payload)?.servicePreviews).toEqual(
      metadata,
    );
  });

  it.each([
    { version: 2, services: [descriptor] },
    { version: 1, externalRegistration: 2, services: [descriptor] },
    { version: 1, services: [{ ...descriptor, kind: "unnegotiated-kind" }] },
    { version: 1, services: [{ ...descriptor, revision: 1 }] },
  ])("rejects unsupported preview metadata %j at the typed status boundary", (value) => {
    const envelope = serverInfo({ ...value, origin: "https://control.test" });
    expect(ServerInfoStatusPayloadSchema.safeParse(envelope.message.payload).success).toBe(false);
    const decoded = validateWSOutboundMessage(envelope);
    expect(decoded.success).toBe(true);
    if (
      !decoded.success ||
      decoded.data.type !== "session" ||
      decoded.data.message.type !== "status"
    ) {
      throw new Error("Expected the generic status envelope to survive validation");
    }
    expect(parseServerInfoStatusPayload(decoded.data.message.payload)).toBeNull();
  });
});

describe("external service protocol responses", () => {
  it.each(["register", "connect", "disconnect"])(
    "decodes %s success and sanitized refusal",
    (operation) => {
      for (const result of [
        { status: "ok", serviceId: "external-fixture" },
        { status: "error", code: "storage-error" },
        { status: "error", code: "restarting" },
      ]) {
        const envelope = {
          type: "session",
          message: {
            type: `service.external.${operation}.response`,
            payload: { requestId: "request", result },
          },
        };
        expect(WSOutboundMessageSchema.safeParse(envelope)).toMatchObject({
          success: true,
          data: envelope,
        });
        expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
      }
    },
  );
});

const managedDescriptor = {
  serviceId: "managed-atlas",
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "web",
  mount: "preserve" as const,
  enabled: true,
};

describe("managed preview registry metadata", () => {
  it("preserves managed registration and enrollments alongside the existing route catalog", () => {
    const envelope = serverInfo({
      version: 1,
      origin: "https://control.test",
      managedRegistration: 1,
      managedEnrollments: [
        managedDescriptor,
        { ...managedDescriptor, serviceId: "managed-api", scriptName: "api", enabled: false },
      ],
      services: [descriptor],
    });
    expect(WSOutboundMessageSchema.safeParse(envelope)).toMatchObject({
      success: true,
      data: envelope,
    });
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  });

  it("keeps managedEnrollments optional so an older source omitting it still validates", () => {
    const withoutEnrollments = serverInfo({
      version: 1,
      origin: "https://control.test",
      managedRegistration: 1,
      services: [],
    });
    expect(validateWSOutboundMessage(withoutEnrollments)).toEqual({
      success: true,
      data: withoutEnrollments,
    });
    const enrollmentsWithoutRegistration = serverInfo({
      version: 1,
      origin: "https://control.test",
      managedEnrollments: [managedDescriptor],
      services: [],
    });
    expect(validateWSOutboundMessage(enrollmentsWithoutRegistration)).toEqual({
      success: true,
      data: enrollmentsWithoutRegistration,
    });
  });

  it("rejects an unsupported managed enrollment shape at the typed status boundary but keeps the generic envelope", () => {
    const envelope = serverInfo({
      version: 1,
      origin: "https://control.test",
      managedEnrollments: [{ ...managedDescriptor, mount: "unsupported-mount" }],
      services: [],
    });
    expect(ServerInfoStatusPayloadSchema.safeParse(envelope.message.payload).success).toBe(false);
    const decoded = validateWSOutboundMessage(envelope);
    expect(decoded.success).toBe(true);
    if (
      !decoded.success ||
      decoded.data.type !== "session" ||
      decoded.data.message.type !== "status"
    ) {
      throw new Error("Expected the generic status envelope to survive validation");
    }
    expect(parseServerInfoStatusPayload(decoded.data.message.payload)).toBeNull();
  });
});

describe("managed preview enrollment protocol responses", () => {
  it.each(["enable", "disable"])("decodes %s success and sanitized refusal", (operation) => {
    for (const result of [
      { status: "ok", serviceId: "managed-atlas" },
      { status: "error", code: "unknown-service" },
      { status: "error", code: "already-enabled" },
      { status: "error", code: "storage-error" },
      { status: "error", code: "invalid-input" },
      { status: "error", code: "restarting" },
      { status: "error", code: "unavailable" },
    ]) {
      const envelope = {
        type: "session",
        message: {
          type: `service.managed.${operation}.response`,
          payload: { requestId: "request", result },
        },
      };
      expect(WSOutboundMessageSchema.safeParse(envelope)).toMatchObject({
        success: true,
        data: envelope,
      });
      expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
    }
  });
});
