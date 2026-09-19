import { describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import type { WSOutboundMessage } from "../messages.js";
import { PREVIEW_SOURCE_CAPABILITY, PreviewSources } from "./sources.js";

const origin = "https://control.test";
const capable = { [PREVIEW_SOURCE_CAPABILITY]: 1 };

const reply: WSOutboundMessage = {
  type: "session",
  message: { type: "status", payload: { status: "error", message: "inert source reply" } },
};

async function queued() {
  return true;
}

interface FixtureOptions {
  send?: (frame: string) => Promise<boolean>;
}

function fixture({ send = queued }: FixtureOptions = {}) {
  const sources = new PreviewSources(origin);
  const socket = { readyState: 1 };
  sources.admitDirectOwner({
    socket,
    connectionId: "source-a",
    principalId: "owner",
    origin,
    permissions: OWNER_PERMISSIONS,
    send,
  });
  sources.negotiate(socket, capable);
  return { sources, socket };
}

describe("preview source authority captures", () => {
  it.each(["detach", "permission", "feature", "negotiation", "shutdown"])(
    "notifies outstanding authorization work when %s invalidates its capture",
    async (kind) => {
      const { sources, socket } = fixture();
      const capture = sources.capture(socket);
      expect(capture).not.toBeNull();
      if (!capture) throw new Error("Expected eligible fixture source");
      const invalidation = capture.invalidated.then(() => "invalidated");
      expect(await Promise.race([capture.invalidated, Promise.resolve("pending")])).toBe("pending");
      if (kind === "detach") sources.detach(socket);
      if (kind === "permission") {
        sources.replacePrincipalPermissions("owner", []);
        sources.replacePrincipalPermissions("owner", OWNER_PERMISSIONS);
      }
      if (kind === "feature") {
        sources.setEnabled(false);
        sources.setEnabled(true);
      }
      if (kind === "negotiation") {
        sources.negotiate(socket, null);
        sources.negotiate(socket, capable);
      }
      if (kind === "shutdown") sources.close();
      await expect(invalidation).resolves.toBe("invalidated");
      expect(await Promise.race([capture.invalidated, Promise.resolve("pending")])).toBeUndefined();
      expect(capture.isCurrent()).toBe(false);
    },
  );

  it("keeps new authorization work pending after an earlier revision was invalidated", async () => {
    const { sources, socket } = fixture();
    const first = sources.capture(socket);
    sources.setEnabled(false);
    sources.setEnabled(true);
    const second = sources.capture(socket);
    if (!first || !second) throw new Error("Expected eligible fixture sources");
    await expect(first.invalidated).resolves.toBeUndefined();
    const invalidation = second.invalidated.then(() => "invalidated");
    sources.negotiate(socket, capable);
    expect(await Promise.race([second.invalidated, Promise.resolve("pending")])).toBe("pending");
    expect(second.isCurrent()).toBe(true);
    sources.detach(socket);
    await expect(invalidation).resolves.toBe("invalidated");
  });

  it("captures only the admitted physical source after its own negotiation", () => {
    const { sources, socket } = fixture();
    const capture = sources.capture(socket);
    expect(capture?.isCurrent()).toBe(true);
    expect(capture?.connectionId).toBe("source-a");
    expect(capture?.controlOrigin).toBe(origin);
    expect(sources.capture({ readyState: 1 })).toBeNull();
    sources.negotiate(socket, null);
    expect(sources.capture(socket)).toBeNull();
    sources.negotiate(socket, capable);
    expect(capture?.isCurrent()).toBe(false);
    expect(sources.capture(socket)?.isCurrent()).toBe(true);
  });

  it("does not revive detached captures when the same socket object is readmitted", () => {
    const { sources, socket } = fixture();
    const capture = sources.capture(socket);
    sources.detach(socket);
    sources.admitDirectOwner({
      socket,
      connectionId: "source-b",
      principalId: "owner",
      origin,
      permissions: OWNER_PERMISSIONS,
      send: queued,
    });
    sources.negotiate(socket, capable);
    expect(capture?.isCurrent()).toBe(false);
    expect(sources.capture(socket)?.connectionId).toBe("source-b");
  });

  it("permission and feature restoration leave previous captures invalid", () => {
    const { sources, socket } = fixture();
    const first = sources.capture(socket);
    sources.replacePrincipalPermissions("owner", []);
    expect(sources.capture(socket)).toBeNull();
    sources.replacePrincipalPermissions("owner", OWNER_PERMISSIONS);
    expect(first?.isCurrent()).toBe(false);
    const second = sources.capture(socket);
    expect(second?.isCurrent()).toBe(true);
    sources.setEnabled(false);
    expect(sources.capture(socket)).toBeNull();
    sources.setEnabled(true);
    expect(second?.isCurrent()).toBe(false);
    expect(sources.capture(socket)?.isCurrent()).toBe(true);
  });

  it("principal updates cannot widen the source's original permission ceiling", () => {
    const sources = new PreviewSources(origin);
    const socket = { readyState: 1 };
    sources.admitDirectOwner({
      socket,
      connectionId: "read-only",
      principalId: "owner",
      origin,
      permissions: ["daemon.read"],
      send: queued,
    });
    sources.negotiate(socket, capable);
    sources.replacePrincipalPermissions("owner", OWNER_PERMISSIONS);
    expect(sources.capture(socket)).toBeNull();
  });

  it("rejects unapproved and absent Origins independently of owner claims", () => {
    const sources = new PreviewSources(origin);
    for (const observed of [
      undefined,
      "null",
      "https://other.control.test",
      "https://control.test:444",
    ]) {
      const socket = { readyState: 1 };
      sources.admitDirectOwner({
        socket,
        connectionId: "wrong-origin",
        principalId: "owner",
        origin: observed,
        permissions: OWNER_PERMISSIONS,
        send: queued,
      });
      sources.negotiate(socket, capable);
      expect(sources.capture(socket)).toBeNull();
    }
  });

  it("immediately refuses a closing transport before its close event", () => {
    const { sources, socket } = fixture();
    const capture = sources.capture(socket);
    socket.readyState = 2;
    expect(capture?.isCurrent()).toBe(false);
    expect(sources.capture(socket)).toBeNull();
  });

  it("shutdown is terminal and a replacement owner has a different epoch", () => {
    const { sources, socket } = fixture();
    const capture = sources.capture(socket);
    sources.close();
    sources.setEnabled(true);
    sources.admitDirectOwner({
      socket,
      connectionId: "late",
      principalId: "owner",
      origin,
      permissions: OWNER_PERMISSIONS,
      send: queued,
    });
    sources.negotiate(socket, capable);
    expect(capture?.isCurrent()).toBe(false);
    expect(sources.capture(socket)).toBeNull();
    const replacement = fixture();
    expect(replacement.sources.capture(replacement.socket)?.authorityEpoch).not.toBe(
      capture?.authorityEpoch,
    );
  });
});

describe("exact-source reply outcomes", () => {
  it("reports queued only after the source transport reports success", async () => {
    const frames: string[] = [];
    const { sources, socket } = fixture({
      send: async (frame) => {
        frames.push(frame);
        return true;
      },
    });
    await expect(sources.capture(socket)?.send(reply)).resolves.toBe("queued");
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([reply]);
  });

  it.each([false, true])(
    "returns a fixed failure outcome for send failure (throws=%s)",
    async (throws) => {
      const { sources, socket } = fixture({
        send: async () => {
          if (throws) throw new Error("fixture-private-error");
          return false;
        },
      });
      await expect(sources.capture(socket)?.send(reply)).resolves.toBe("failed");
    },
  );

  it.each(["detach", "permission", "feature", "shutdown"])(
    "settles a held delivery on %s without waiting for transport",
    async (kind) => {
      let finishTransport: (queued: boolean) => void = () => {};
      const transport = new Promise<boolean>((resolve) => {
        finishTransport = resolve;
      });
      let sends = 0;
      const { sources, socket } = fixture({
        send: () => {
          sends++;
          return transport;
        },
      });
      const capture = sources.capture(socket);
      const sending = capture?.send(reply);
      if (kind === "detach") sources.detach(socket);
      if (kind === "permission") {
        sources.replacePrincipalPermissions("owner", []);
        sources.replacePrincipalPermissions("owner", OWNER_PERMISSIONS);
      }
      if (kind === "feature") {
        sources.setEnabled(false);
        sources.setEnabled(true);
      }
      if (kind === "shutdown") sources.close();
      await expect(sending).resolves.toBe("invalidated");
      finishTransport(true);
      await expect(sending).resolves.toBe("invalidated");
      await expect(capture?.send(reply)).resolves.toBe("invalidated");
      expect(sends).toBe(1);
    },
  );

  it("observes a transport rejection created during synchronous invalidation", async () => {
    let invalidate = () => {};
    const { sources, socket } = fixture({
      send: () => {
        invalidate();
        return Promise.reject(new Error("invalidation race fixture"));
      },
    });
    invalidate = () => sources.detach(socket);
    await expect(sources.capture(socket)?.send(reply)).resolves.toBe("invalidated");
  });

  it("checks current authority after serialization and never queues an invalidated reply", async () => {
    let sends = 0;
    const { sources, socket } = fixture({
      send: async () => {
        sends++;
        return true;
      },
    });
    const capture = sources.capture(socket);
    const reentrant: WSOutboundMessage = {
      type: "session",
      message: {
        type: "status",
        payload: {
          status: "error",
          get message() {
            sources.detach(socket);
            return "inert fixture";
          },
        },
      },
    };
    await expect(capture?.send(reentrant)).resolves.toBe("invalidated");
    expect(sends).toBe(0);
  });
});
