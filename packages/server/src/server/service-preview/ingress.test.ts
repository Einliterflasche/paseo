import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewIngress, type PreviewIngressTarget } from "./ingress.js";

const reserved = "/__paseo_services/apps/atlas/";
const cleanups: Array<() => Promise<void>> = [];

interface Observation {
  owner: "preview" | "application" | "legacy" | "daemon";
  request: IncomingMessage;
  body?: string;
  head?: Buffer;
}

interface FixtureOptions {
  enabled?: boolean;
  handle?: PreviewIngressTarget["handle"];
  upgrade?: PreviewIngressTarget["upgrade"];
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString("utf8");
}

function finishUpgrade(socket: Socket, owner: string): void {
  socket.end(
    `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\nX-Owner: ${owner}\r\n\r\n`,
  );
}

async function fixture(options: FixtureOptions = {}) {
  const observations: Observation[] = [];
  const originalRequests: IncomingMessage[] = [];
  const sockets = new Set<Socket>();
  let previewCloses = 0;
  let legacyChecks = 0;
  const preview: PreviewIngressTarget = {
    async handle(request, response) {
      observations.push({ owner: "preview", request });
      if (options.handle) return options.handle(request, response);
      const body = await bodyOf(request);
      observations.at(-1)!.body = body;
      response.writeHead(201, { "content-type": "text/plain" });
      response.end("preview");
    },
    async upgrade(request, socket, head) {
      observations.push({ owner: "preview", request, head });
      if (options.upgrade) return options.upgrade(request, socket, head);
      finishUpgrade(socket, "preview");
    },
    close() {
      previewCloses += 1;
    },
  };
  const ingress = createPreviewIngress({
    preview: options.enabled === false ? null : preview,
    application(request, response) {
      observations.push({ owner: "application", request });
      request.resume();
      response.writeHead(202);
      response.end(request.headers.host === "legacy.test" ? "legacy-http" : "application");
    },
    legacyUpgrade(request, socket, head) {
      legacyChecks += 1;
      if (request.headers.host === "legacy.test") {
        observations.push({ owner: "legacy", request, head });
        finishUpgrade(socket, "legacy");
        return true;
      }
      if (request.headers.host === "missing.legacy.test") {
        socket.destroy();
        return true;
      }
      return false;
    },
    daemonUpgrade(request, socket, head) {
      observations.push({ owner: "daemon", request, head });
      finishUpgrade(socket, "daemon");
    },
  });
  const server = createServer((request, response) => {
    originalRequests.push(request);
    ingress.handle(request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    if (!(socket instanceof Socket)) throw new Error("Expected a real TCP socket");
    originalRequests.push(request);
    ingress.upgrade(request, socket, head);
  });
  server.on("connect", ingress.connect);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing ingress test port");
  cleanups.push(async () => {
    ingress.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  });
  return {
    ingress,
    observations,
    originalRequests,
    previewCloses: () => previewCloses,
    legacyChecks: () => legacyChecks,
    exchange(raw: string | Buffer) {
      return new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, "127.0.0.1");
        const parts: Buffer[] = [];
        socket.on("data", (part) => parts.push(part));
        socket.on("error", reject);
        socket.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        socket.on("connect", () => socket.write(raw));
      });
    },
  };
}

function wireRequest(target: string, method = "GET", host = "control.test") {
  return `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
}

function upgrade(target: string, host = "control.test", tail = "") {
  return `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n${tail}`;
}

function status(response: string) {
  return Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("single preview ingress owner", () => {
  it("owns reserved requests across methods before legacy HTTP, OPTIONS and SPA handling", async () => {
    const host = await fixture();
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"];
    for (const method of methods)
      expect(status(await host.exchange(wireRequest(reserved, method, "legacy.test")))).toBe(201);
    expect(
      host.observations.map(({ owner, request: incoming }) => [owner, incoming.method]),
    ).toEqual(methods.map((method) => ["preview", method]));
    expect(host.legacyChecks()).toBe(0);
  });

  it("denies bare and normalized aliases without invoking any downstream owner", async () => {
    const host = await fixture();
    const aliases = [
      "/__paseo_services",
      "/__paseo_services?view=1",
      "/ordinary/../__paseo_services/apps/atlas/",
      "/__paseo_services/apps/atlas/../",
      "/%5f%5fpaseo_services/apps/atlas/",
      "/%255f%255fpaseo_services/apps/atlas/",
      "/__paseo_services%2fapps/atlas/",
      "/__paseo_services\\apps\\atlas\\",
      "http://control.test/__paseo_services/apps/atlas/",
      "//control.test/__paseo_services/apps/atlas/",
      "//__paseo_services/apps/atlas/",
      "/__paseo_services/apps/atlas/#fragment",
    ];
    for (const target of aliases) {
      expect(status(await host.exchange(wireRequest(target, "GET", "legacy.test"))), target).toBe(
        400,
      );
      expect(status(await host.exchange(upgrade(target, "legacy.test"))), target).toBe(400);
    }
    expect(host.observations).toEqual([]);
    expect(host.legacyChecks()).toBe(0);
  });

  it("leaves unrelated paths and query text with the ordinary application", async () => {
    const host = await fixture();
    for (const target of [
      "/",
      "/__paseo_services_extra/",
      "/ordinary?next=/__paseo_services/apps/atlas/",
    ]) {
      expect(status(await host.exchange(wireRequest(target)))).toBe(202);
    }
    expect(await host.exchange(wireRequest("/app", "GET", "legacy.test"))).toContain("legacy-http");
    expect(host.observations.map(({ owner }) => owner)).toEqual([
      "application",
      "application",
      "application",
      "application",
    ]);
  });

  it("preserves the original parsed request, duplicate headers and one body", async () => {
    const host = await fixture();
    const rawHeaders = [
      "Host",
      "control.test",
      "Host",
      "duplicate.test",
      "Origin",
      "https://control.test",
      "origin",
      "null",
      "Sec-Fetch-Site",
      "same-origin",
      "Sec-Fetch-Site",
      "cross-site",
      "Content-Length",
      "11",
      "Connection",
      "close",
    ];
    const lines: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2)
      lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
    const target = `${reserved}?encoded=%2f%25&n=2`;
    expect(
      status(
        await host.exchange(`POST ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\nhello-world`),
      ),
    ).toBe(201);
    expect(host.observations).toHaveLength(1);
    const observed = host.observations[0];
    expect(observed.request).toBe(host.originalRequests[0]);
    expect(observed.request.url).toBe(target);
    expect(observed.request.rawHeaders).toEqual(rawHeaders);
    expect(observed.request.headersDistinct.origin).toEqual(["https://control.test", "null"]);
    expect(observed.body).toBe("hello-world");
  });

  it("keeps disabled and closed preview paths reserved while ordinary requests continue", async () => {
    const disabled = await fixture({ enabled: false });
    expect(status(await disabled.exchange(wireRequest(reserved)))).toBe(503);
    expect(status(await disabled.exchange(upgrade(reserved)))).toBe(503);
    expect(disabled.observations).toEqual([]);
    const host = await fixture();
    host.ingress.close();
    host.ingress.close();
    expect(host.previewCloses()).toBe(1);
    expect(status(await host.exchange(wireRequest(reserved)))).toBe(503);
    expect(status(await host.exchange(upgrade(reserved)))).toBe(503);
    expect(status(await host.exchange(wireRequest("/")))).toBe(202);
    expect(host.observations.map(({ owner }) => owner)).toEqual(["application"]);
  });

  it("contains handler rejection without leaking errors or falling through", async () => {
    const host = await fixture({
      handle: async () => {
        throw new Error("private-handler-detail");
      },
      upgrade: async () => {
        throw new Error("private-upgrade-detail");
      },
    });
    const result = await host.exchange(wireRequest(reserved));
    expect(status(result)).toBe(502);
    expect(result).not.toContain("private-handler-detail");
    expect(await host.exchange(upgrade(reserved))).toBe("");
    expect(host.observations.map(({ owner }) => owner)).toEqual(["preview", "preview"]);
    expect(host.legacyChecks()).toBe(0);
  });

  it("destroys a partially written response after failure without appending an error response", async () => {
    const host = await fixture({
      async handle(_request, response: ServerResponse) {
        response.writeHead(200, { "content-length": "20" });
        response.write("partial");
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw new Error("late-failure");
      },
    });
    const result = await host.exchange(wireRequest(reserved));
    expect(status(result)).toBe(200);
    expect(result).toContain("partial");
    expect(result.match(/HTTP\/1\.1/g)).toHaveLength(1);
    expect(host.observations.map(({ owner }) => owner)).toEqual(["preview"]);
  });

  it("chooses exactly one upgrade owner and preserves early upgrade bytes", async () => {
    const host = await fixture();
    expect(await host.exchange(upgrade(reserved, "legacy.test", "early-preview"))).toContain(
      "X-Owner: preview",
    );
    expect(await host.exchange(upgrade("/ws", "legacy.test", "early-legacy"))).toContain(
      "X-Owner: legacy",
    );
    expect(await host.exchange(upgrade("/ws?session=2", "control.test", "early-daemon"))).toContain(
      "X-Owner: daemon",
    );
    expect(host.observations.map(({ owner, head }) => [owner, head?.toString()])).toEqual([
      ["preview", "early-preview"],
      ["legacy", "early-legacy"],
      ["daemon", "early-daemon"],
    ]);
    for (const [index, observation] of host.observations.entries())
      expect(observation.request).toBe(host.originalRequests[index]);
    expect(host.legacyChecks()).toBe(2);
    expect(await host.exchange(upgrade("/ws", "missing.legacy.test"))).toBe("");
    expect(status(await host.exchange(upgrade("/unclaimed")))).toBe(404);
    expect(host.observations).toHaveLength(3);
  });

  it("does not create a CONNECT tunnel", async () => {
    const host = await fixture();
    expect(status(await host.exchange(wireRequest("127.0.0.1:5173", "CONNECT")))).toBe(405);
    expect(host.observations).toEqual([]);
    expect(host.legacyChecks()).toBe(0);
  });
});
