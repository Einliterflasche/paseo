import { once } from "node:events";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import {
  ClientRequest,
  createServer,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { connect as connectTcp, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { PreviewBroker } from "./broker.js";
import { createPreviewGateway } from "./gateway.js";
import { PreviewRoutes } from "./routes.js";
import { PREVIEW_SOURCE_CAPABILITY, PreviewSources } from "./sources.js";

const controlOrigin = "https://control.test";
const appPath = "/__paseo_services/apps/atlas/?token=app-hmr-token";
const cleanups: Array<() => Promise<void>> = [];
const firefoxMetadata = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "websocket",
  "Sec-Fetch-Dest": "empty",
};

interface Frame {
  body: Buffer;
  binary: boolean;
}

interface SocketOptions {
  cookie?: string;
  origin?: string | null;
  headers?: OutgoingHttpHeaders;
  protocols?: string[];
  path?: string;
}

interface ObservedUpgrade {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

interface HeldUpgrade {
  started: ReturnType<typeof deferred>;
  closed: ReturnType<typeof deferred>;
  released: ReturnType<typeof deferred>;
  finished: ReturnType<typeof deferred>;
}

function frameBody(value: RawData): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.concat(value);
  return value;
}

function watch(socket: WebSocket) {
  const frames: Frame[] = [];
  const pending: Array<(frame: Frame) => void> = [];
  const available: Frame[] = [];
  socket.on("message", (value, binary) => {
    const frame = { body: frameBody(value), binary };
    frames.push(frame);
    const resolve = pending.shift();
    if (resolve) resolve(frame);
    else available.push(frame);
  });
  // Abrupt-reset cases observe close outcomes rather than treating expected
  // WebSocket errors as unhandled fixture failures.
  socket.on("error", () => {});
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  function next(): Promise<Frame> {
    const frame = available.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => pending.push(resolve));
  }
  return { socket, frames, next, closed };
}

type ObservedSocket = ReturnType<typeof watch>;

async function listen(server: Server | HttpsServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing fixture port");
  return address.port;
}

async function stop(server: Server | HttpsServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function fixture({ tls = false }: { tls?: boolean } = {}) {
  const failures: unknown[] = [];
  const upgrades: ObservedUpgrade[] = [];
  const appSockets: ObservedSocket[] = [];
  const appTransports: Socket[] = [];
  const gatewayUpstreams: Socket[] = [];
  const clients: WebSocket[] = [];
  const upstreamTcp = new Set<Socket>();
  const rawClients: Socket[] = [];
  const warnings: Error[] = [];
  const warned = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  process.on("warning", warned);
  const ingressUpgrades: Array<{ socket: Duplex; headLength: number; settled: Promise<void> }> = [];
  let upstreamConnections = 0;
  let refuseNext = false;
  let heldUpgrade: HeldUpgrade | null = null;
  let openAfterFin: {
    ended: ReturnType<typeof deferred>;
    closed: ReturnType<typeof deferred>;
  } | null = null;
  const upstream = createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  upstream.on("connection", (socket) => {
    upstreamConnections += 1;
    upstreamTcp.add(socket);
    socket.once("close", () => upstreamTcp.delete(socket));
  });
  const app = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  app.on("connection", (socket, request) => {
    appSockets.push(watch(socket));
    appTransports.push(request.socket);
    socket.send("ready");
    socket.on("message", (message, binary) => socket.send(message, { binary }));
  });
  upstream.on("upgrade", (request, socket, head) => {
    upgrades.push({ url: request.url, headers: request.headers });
    if (openAfterFin) {
      const held = openAfterFin;
      openAfterFin = null;
      // A raw upstream peer deliberately keeps its writable half open after EOF.
      // This fixture must not supply the gateway's missing teardown itself.
      socket.allowHalfOpen = true;
      socket.on("error", () => {});
      socket.once("end", held.ended.resolve);
      socket.once("close", held.closed.resolve);
      socket.resume();
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
      );
      return;
    }
    if (refuseNext) {
      refuseNext = false;
      socket.destroy();
      return;
    }
    if (heldUpgrade) {
      const held = heldUpgrade;
      heldUpgrade = null;
      socket.once("close", held.closed.resolve);
      socket.once("end", () => socket.destroy());
      socket.resume();
      held.started.resolve();
      void held.released.promise
        .then(() => {
          app.handleUpgrade(request, socket, head, (websocket) =>
            app.emit("connection", websocket, request),
          );
          held.finished.resolve();
          return undefined;
        })
        .catch((error) => {
          failures.push(error);
          held.finished.resolve();
        });
      return;
    }
    app.handleUpgrade(request, socket, head, (websocket) =>
      app.emit("connection", websocket, request),
    );
  });
  const upstreamPort = await listen(upstream);
  // Observe the gateway-owned app socket through Node's public diagnostics
  // channel. No stream behavior is patched or substituted for these checks.
  const requestStart = channel("http.client.request.start");
  const observeRequest = (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("request" in message) ||
      !(message.request instanceof ClientRequest)
    )
      return;
    message.request.once("upgrade", (_response, socket) => {
      if (socket instanceof Socket && socket.remotePort === upstreamPort) {
        gatewayUpstreams.push(socket);
      }
    });
  };
  requestStart.subscribe(observeRequest);
  const sources = new PreviewSources(controlOrigin);
  const routes = new PreviewRoutes({ excludedPorts: [] });
  routes.register({ serviceId: "atlas", port: upstreamPort, mount: "preserve" });
  const broker = new PreviewBroker({
    sources,
    routes,
    onFailure(error) {
      failures.push(error);
    },
  });
  const gateway = createPreviewGateway({
    broker,
    controlOrigin,
    controlCookieNames: ["paseo-control"],
  });
  const certificate = tls
    ? readFileSync(new URL("./test-fixtures/control-cert.pem", import.meta.url))
    : undefined;
  const ingress = tls
    ? createHttpsServer({
        cert: certificate,
        key: readFileSync(new URL("./test-fixtures/control-key.pem", import.meta.url)),
      })
    : createServer();
  ingress.on("request", (request, response) => {
    void gateway.handle(request, response).catch((error) => {
      failures.push(error);
      response.destroy();
    });
  });
  ingress.on("upgrade", (request, socket, head) => {
    const settled = gateway.upgrade(request, socket, head).catch((error) => {
      failures.push(error);
      socket.destroy();
    });
    ingressUpgrades.push({ socket, headLength: head.length, settled });
  });
  const port = await listen(ingress);
  cleanups.push(async () => {
    gateway.close();
    sources.close();
    routes.close();
    for (const client of clients) client.terminate();
    for (const client of rawClients) client.destroy();
    for (const client of app.clients) client.terminate();
    for (const socket of upstreamTcp) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      app.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await Promise.all([stop(ingress), stop(upstream)]);
    requestStart.unsubscribe(observeRequest);
    process.off("warning", warned);
    expect(failures).toEqual([]);
  });

  let sourceSequence = 0;
  function controlSource() {
    const socket = { readyState: 1 };
    const frames: string[] = [];
    sources.admitDirectOwner({
      socket,
      connectionId: `ws-source-${++sourceSequence}`,
      principalId: "owner",
      origin: controlOrigin,
      permissions: OWNER_PERMISSIONS,
      async send(frame) {
        frames.push(frame);
        return true;
      },
    });
    sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
    return { socket, frames };
  }

  function openSocket({
    cookie,
    origin = controlOrigin,
    headers = {},
    protocols = ["vite-hmr"],
    path = appPath,
  }: SocketOptions) {
    const requestHeaders: OutgoingHttpHeaders = { Host: "control.test", ...headers };
    if (cookie !== undefined) requestHeaders.Cookie = cookie;
    if (origin !== null) requestHeaders.Origin = origin;
    const socket = new WebSocket(`${tls ? "wss" : "ws"}://127.0.0.1:${port}${path}`, protocols, {
      headers: requestHeaders,
      perMessageDeflate: false,
      ...(tls ? { ca: certificate, servername: "control.test" } : {}),
    });
    clients.push(socket);
    const observed = watch(socket);
    return new Promise<ObservedSocket>((resolve, reject) => {
      socket.once("open", () => resolve(observed));
      socket.once("error", reject);
    });
  }

  return {
    broker,
    sources,
    routes,
    gateway,
    controlSource,
    openSocket,
    upgrades,
    appSockets,
    appTransports,
    gatewayUpstreams,
    warnings,
    keepNextUpstreamOpenAfterFin() {
      const held = { ended: deferred(), closed: deferred() };
      openAfterFin = held;
      return { ended: held.ended.promise, closed: held.closed.promise };
    },
    ingressUpgrades,
    async rawUpgrade(cookie: string, firstFrame: Buffer = Buffer.alloc(0)) {
      const socket = connectTcp({ host: "127.0.0.1", port });
      rawClients.push(socket);
      socket.on("error", () => {});
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      const accepted = new Promise<void>((resolve) => {
        let response = "";
        const read = (chunk: Buffer) => {
          response += chunk.toString("latin1");
          if (response.includes("\r\n\r\n")) {
            socket.off("data", read);
            if (response.startsWith("HTTP/1.1 101 ")) resolve();
          }
        };
        socket.on("data", read);
      });
      await once(socket, "connect");
      const head = [
        `GET ${appPath} HTTP/1.1`,
        "Host: control.test",
        `Origin: ${controlOrigin}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol: vite-hmr",
        "",
        "",
      ].join("\r\n");
      socket.write(Buffer.concat([Buffer.from(head), firstFrame]));
      return { socket, closed, accepted };
    },
    upstreamConnections: () => upstreamConnections,
    refuseNextUpgrade() {
      refuseNext = true;
    },
    holdNextUpgrade() {
      const held: HeldUpgrade = {
        started: deferred(),
        closed: deferred(),
        released: deferred(),
        finished: deferred(),
      };
      heldUpgrade = held;
      return {
        started: held.started.promise,
        closed: held.closed.promise,
        async release() {
          held.released.resolve();
          await held.finished.promise;
        },
      };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Source = ReturnType<Fixture["controlSource"]>;

async function authorize(host: Fixture, source: Source, attemptId = "open-1") {
  await host.broker.prepare({
    socket: source.socket,
    request: {
      type: "service.preview.prepare.request",
      requestId: `prepare-${attemptId}`,
      attemptId,
      browserHandle: "ws-browser-profile",
      serviceId: "atlas",
      mode: "iframe",
    },
  });
  const frame = source.frames.at(-1);
  if (!frame) throw new Error("Missing fixture Prepare response");
  const response = ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(frame).message);
  if (response.payload.result.status !== "prepared") throw new Error("Expected prepared reply");
  const credential = host.broker.redeem(response.payload.result);
  const cookie = `${credential.cookieName}=${credential.cookieValue}`;
  host.broker.confirm({
    bootstrapId: credential.bootstrapId,
    cookieHeader: cookie,
    mode: credential.mode,
  });
  return cookie;
}

async function expectReady(socket: ObservedSocket): Promise<void> {
  const frame = await socket.next();
  expect(frame).toEqual({ body: Buffer.from("ready"), binary: false });
  expect(socket.socket.protocol).toBe("vite-hmr");
}

async function expectEcho(socket: ObservedSocket, message: string): Promise<void> {
  socket.socket.send(message);
  expect(await socket.next()).toEqual({ body: Buffer.from(message), binary: false });
}

function maskedText(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("Fixture supports short text frames only");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % mask.length]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

function unmaskedText(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("Fixture supports short text frames only");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function binaryFrame(payload: Buffer, masked: boolean): Buffer {
  const header = Buffer.alloc(masked ? 14 : 10);
  header[0] = 0x82;
  header[1] = (masked ? 0x80 : 0) | 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(header, 10);
  const bytes = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    bytes[index] = payload[index] ^ mask[index % mask.length];
  }
  return Buffer.concat([header, bytes]);
}

async function expectBinaryBeforeClose(socket: ObservedSocket, body: Buffer): Promise<void> {
  const frame = await Promise.race([
    socket.next(),
    socket.closed.then((code) => {
      throw new Error(`WebSocket closed (${code}) before the complete final binary frame`);
    }),
  ]);
  expect(frame.binary).toBe(true);
  expect(frame.body.equals(body)).toBe(true);
}

async function expectNextBeforeClose(socket: ObservedSocket, text: string): Promise<void> {
  const outcome = await Promise.race([
    socket.next().then((frame) => ({ frame })),
    socket.closed.then((close) => ({ close })),
  ]);
  expect(outcome).toEqual({ frame: { body: Buffer.from(text), binary: false } });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Real WebSocket ingress, upstream handshake and framed application traffic.
// Source admission and browser metadata are explicit fixture inputs. HTTP cookie
// bootstrap has separate wire coverage; these checks do not replace browser tests.
describe("optional preview WebSocket gateway", () => {
  it("does not add excessive TLS close listeners across complete WebSocket sessions", async () => {
    const host = await fixture({ tls: true });
    const cookie = await authorize(host, host.controlSource());
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const client = await host.openSocket({ cookie });
      await expectReady(client);
      await expectEcho(client, `tls-session-${iteration}`);
      client.socket.close(1000, "complete");
      expect(await client.closed).toBe(1000);
      expect(await host.appSockets[iteration].closed).toBe(1000);
      await host.ingressUpgrades[iteration].settled;
    }
    expect(host.warnings).toEqual([]);
  });

  it("settles an accepted raw client FIN even when upstream keeps its writable half open", async ({
    onTestFailed,
  }) => {
    const started = performance.now();
    const phases: Array<{ phase: string; elapsedMs: number }> = [];
    const phase = (name: string) =>
      phases.push({ phase: name, elapsedMs: performance.now() - started });
    onTestFailed(() => console.info({ acceptedFinPhases: phases }));
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const upstream = host.keepNextUpstreamOpenAfterFin();
    const client = await host.rawUpgrade(cookie);
    await client.accepted;
    phase("client-received-101");
    host.ingressUpgrades[0].socket.once("end", () => phase("gateway-client-readable-ended"));
    host.ingressUpgrades[0].socket.once("finish", () => phase("gateway-client-writable-finished"));
    host.gatewayUpstreams[0].once("end", () => phase("gateway-upstream-readable-ended"));
    host.gatewayUpstreams[0].once("finish", () => phase("gateway-upstream-writable-finished"));
    client.socket.end();
    await Promise.race([upstream.ended, upstream.closed]);
    phase("upstream-observed-eof-or-close");
    await host.ingressUpgrades[0].settled;
    phase("gateway-settled");
    await client.closed;
    phase("client-closed");
    const fresh = await host.openSocket({ cookie });
    phase("fresh-opened");
    await expectReady(fresh);
    phase("fresh-ready");
    await expectEcho(fresh, "after-accepted-fin");
    phase("fresh-echoed");
  });

  it("preserves final client data before FIN and settles both gateway directions", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const client = await host.rawUpgrade(cookie);
    await client.accepted;
    client.socket.end(maskedText("final-client-frame"));
    await expectNextBeforeClose(host.appSockets[0], "final-client-frame");
    await host.ingressUpgrades[0].settled;
    await client.closed;
  });

  it("preserves final upstream data before FIN and settles both gateway directions", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const client = await host.openSocket({ cookie });
    await expectReady(client);
    host.appTransports[0].end(unmaskedText("final-upstream-frame"));
    await expectNextBeforeClose(client, "final-upstream-frame");
    await host.ingressUpgrades[0].settled;
    await client.closed;
  });

  it("preserves a backpressured binary frame after the upstream reader resumes", async () => {
    const host = await fixture({ tls: true });
    const cookie = await authorize(host, host.controlSource());
    const client = await host.openSocket({ cookie });
    await expectReady(client);
    const app = host.appSockets[0];
    app.socket.pause();
    const body = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    const sent = new Promise<Error | null>((resolve) =>
      client.socket.send(body, (error) => resolve(error ?? null)),
    );
    await expect.poll(() => host.gatewayUpstreams[0]?.writableNeedDrain).toBe(true);
    expect(app.frames).toEqual([]);
    app.socket.resume();
    expect(await sent).toBeNull();
    const frame = await client.next();
    expect(frame.binary).toBe(true);
    expect(frame.body.equals(body)).toBe(true);
    await expectEcho(client, "after-drain");
    expect(host.warnings).toEqual([]);
  });

  it("drains final client frame plus FIN under observed upstream backpressure", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const client = await host.rawUpgrade(cookie);
    await client.accepted;
    const app = host.appSockets[0];
    app.socket.pause();
    const body = Buffer.alloc(8 * 1024 * 1024, 0x7c);
    client.socket.end(binaryFrame(body, true));
    await expect.poll(() => host.gatewayUpstreams[0]?.writableNeedDrain).toBe(true);
    expect(app.frames).toEqual([]);
    const received = expectBinaryBeforeClose(app, body);
    app.socket.resume();
    await received;
    await host.ingressUpgrades[0].settled;
    await client.closed;
  });

  it("drains final upstream frame plus FIN under observed TLS client backpressure", async () => {
    const host = await fixture({ tls: true });
    const cookie = await authorize(host, host.controlSource());
    const client = await host.openSocket({ cookie });
    await expectReady(client);
    client.socket.pause();
    const body = Buffer.alloc(8 * 1024 * 1024, 0x3e);
    host.appTransports[0].end(binaryFrame(body, false));
    await expect.poll(() => host.ingressUpgrades[0]?.socket.writableNeedDrain).toBe(true);
    expect(client.frames.map((frame) => frame.body.toString())).toEqual(["ready"]);
    const received = expectBinaryBeforeClose(client, body);
    client.socket.resume();
    await received;
    await host.ingressUpgrades[0].settled;
    await client.closed;
    expect(host.warnings).toEqual([]);
  });

  it("settles backpressured work on revocation before the upstream reader resumes", async () => {
    const host = await fixture({ tls: true });
    const source = host.controlSource();
    const cookie = await authorize(host, source);
    const client = await host.openSocket({ cookie });
    await expectReady(client);
    const app = host.appSockets[0];
    app.socket.pause();
    const body = Buffer.alloc(8 * 1024 * 1024, 0x6b);
    const sent = new Promise<Error | null>((resolve) =>
      client.socket.send(body, (error) => resolve(error ?? null)),
    );
    await expect.poll(() => host.gatewayUpstreams[0]?.writableNeedDrain).toBe(true);
    host.sources.detach(source.socket);
    await host.ingressUpgrades[0].settled;
    expect(await client.closed).toBe(1006);
    expect(host.gatewayUpstreams[0].destroyed).toBe(true);
    await sent;
    app.socket.resume();
    expect(await app.closed).toBe(1006);
    const freshCookie = await authorize(host, host.controlSource(), "after-revoke");
    const fresh = await host.openSocket({ cookie: freshCookie });
    await expectReady(fresh);
    await expectEcho(fresh, "fresh-after-pressure");
    expect(host.warnings).toEqual([]);
  });

  it.each([
    { label: "absent Chromium-style", metadata: {} },
    { label: "complete Firefox-style", metadata: firefoxMetadata },
  ])("forwards vite-hmr and text/binary frames with $label metadata", async ({ metadata }) => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const client = await host.openSocket({
      cookie: `${cookie}; paseo-control=secret; app=local`,
      headers: {
        ...metadata,
        Authorization: "Bearer paseo-control-secret",
        "X-Forwarded-Host": "forged.test",
      },
    });
    await expectReady(client);
    await expectEcho(client, "hot-update");
    const bytes = Buffer.from([0, 1, 2, 255]);
    client.socket.send(bytes);
    expect(await client.next()).toEqual({ body: bytes, binary: true });
    expect(host.upgrades).toHaveLength(1);
    expect(host.upgrades[0]).toMatchObject({
      url: appPath,
      headers: {
        cookie: "app=local",
        origin: controlOrigin,
        host: "control.test",
        "sec-websocket-protocol": "vite-hmr",
        "x-forwarded-host": "control.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(host.upgrades[0].headers.authorization).toBeUndefined();
    expect(host.upstreamConnections()).toBe(1);
  });

  it("rejects a Paseo bearer subprotocol before contacting the application", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    await expect(
      host.openSocket({ cookie, protocols: ["vite-hmr", "paseo.bearer.control-secret"] }),
    ).rejects.toThrow("Unexpected server response: 403");
    expect(host.upstreamConnections()).toBe(0);
    expect(host.upgrades).toEqual([]);
  });

  it("rejects missing authority and partial, foreign or missing Origin before contacting the application", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const attempts: SocketOptions[] = [
      {},
      { cookie: cookie.split("=", 1)[0] + "=forged" },
      { cookie: `${cookie}; ${cookie}` },
      { cookie, origin: null },
      { cookie, origin: "https://foreign.test" },
      { cookie, headers: { "Sec-Fetch-Site": "same-origin" } },
      { cookie, headers: { ...firefoxMetadata, "Sec-Fetch-Site": "cross-site" } },
      { cookie, headers: { ...firefoxMetadata, "Sec-Fetch-Mode": "cors" } },
      { cookie, headers: { ...firefoxMetadata, "Sec-Fetch-User": "?1" } },
      { cookie, headers: { Host: "foreign.test" } },
      { cookie, path: "/__paseo_services/apps/unknown/" },
    ];
    for (const options of attempts) {
      await expect(host.openSocket(options)).rejects.toThrow("Unexpected server response: 403");
      expect(host.upstreamConnections()).toBe(0);
    }
    expect(host.upgrades).toEqual([]);
  });

  it("closes both sockets on source detach and cannot revive the old stream with a fresh Open", async () => {
    const host = await fixture();
    const source = host.controlSource();
    const cookie = await authorize(host, source);
    const old = await host.openSocket({ cookie });
    await expectReady(old);
    const oldApp = host.appSockets[0];
    host.sources.detach(source.socket);
    const freshCookie = await authorize(host, host.controlSource(), "open-2");
    const fresh = await host.openSocket({ cookie: freshCookie });
    await expectReady(fresh);
    await expectEcho(fresh, "fresh-only");
    expect(await old.closed).toBe(1006);
    expect(await oldApp.closed).toBe(1006);
    const lateError = await new Promise<Error | undefined>((resolve) =>
      oldApp.socket.send("obsolete", resolve),
    );
    expect(lateError?.message).toContain("WebSocket is not open");
    expect(old.frames.map(({ body }) => body.toString())).toEqual(["ready"]);
    expect(fresh.frames.map(({ body }) => body.toString())).toEqual(["ready", "fresh-only"]);
  });

  it("keeps the continuous connection while a sibling contribution remains eligible", async () => {
    const host = await fixture();
    const a = host.controlSource();
    const b = host.controlSource();
    const cookie = await authorize(host, a);
    expect(await authorize(host, b, "open-b")).toBe(cookie);
    const client = await host.openSocket({ cookie });
    await expectReady(client);
    host.sources.detach(a.socket);
    await expectEcho(client, "surviving-sibling");
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    host.sources.detach(b.socket);
    expect(await client.closed).toBe(1006);
    expect(await host.appSockets[0].closed).toBe(1006);
  });

  it("closes both sockets when the registered route becomes unavailable", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const client = await host.openSocket({ cookie });
    await expectReady(client);
    host.routes.markUnavailable("atlas");
    expect(await client.closed).toBe(1006);
    expect(await host.appSockets[0].closed).toBe(1006);
    await expect(host.openSocket({ cookie })).rejects.toThrow("Unexpected server response: 403");
    expect(host.upstreamConnections()).toBe(1);
  });

  it.each(["client", "upstream"])(
    "contains a %s reset and preserves current authority",
    async (side) => {
      const host = await fixture();
      const cookie = await authorize(host, host.controlSource());
      const first = await host.openSocket({ cookie });
      await expectReady(first);
      const app = host.appSockets[0];
      if (side === "client") first.socket.terminate();
      else app.socket.terminate();
      expect(await first.closed).toBe(1006);
      expect(await app.closed).toBe(1006);
      const next = await host.openSocket({ cookie });
      await expectReady(next);
      await expectEcho(next, "after-reset");
      expect(host.upstreamConnections()).toBe(2);
    },
  );

  it("handles an upstream reset during handshake without accepting a browser socket", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    host.refuseNextUpgrade();
    await expect(host.openSocket({ cookie })).rejects.toThrow("Unexpected server response: 403");
    expect(host.appSockets).toEqual([]);
    const next = await host.openSocket({ cookie });
    await expectReady(next);
    await expectEcho(next, "after-handshake-reset");
    expect(host.upstreamConnections()).toBe(2);
  });

  it("permanently cancels a held upstream handshake before a fresh Open becomes active", async () => {
    const host = await fixture();
    const source = host.controlSource();
    const cookie = await authorize(host, source);
    const held = host.holdNextUpgrade();
    const denied = expect(host.openSocket({ cookie })).rejects.toThrow(
      "Unexpected server response: 403",
    );
    await held.started;
    host.sources.detach(source.socket);
    const freshCookie = await authorize(host, host.controlSource(), "open-2");
    const current = await host.openSocket({ cookie: freshCookie });
    await expectReady(current);
    await denied;
    await held.closed;
    await held.release();
    await expectEcho(current, "current-only");
    expect(host.appSockets).toHaveLength(1);
    expect(host.upstreamConnections()).toBe(2);
    expect(current.frames.map(({ body }) => body.toString())).toEqual(["ready", "current-only"]);
  });

  it("settles a held upstream handshake on raw client FIN while control authority remains eligible", async () => {
    const host = await fixture();
    const source = host.controlSource();
    const cookie = await authorize(host, source);
    const held = host.holdNextUpgrade();
    const abandoned = await host.rawUpgrade(cookie);
    await held.started;
    abandoned.socket.end();
    await host.ingressUpgrades[0].settled;
    await held.closed;
    await abandoned.closed;
    expect(source.socket.readyState).toBe(1);
    expect(host.appSockets).toEqual([]);
    const next = await host.openSocket({ cookie });
    await expectReady(next);
    await expectEcho(next, "same-authority-after-fin");
    await held.release();
    expect(host.appSockets).toHaveLength(1);
    expect(host.upstreamConnections()).toBe(2);
  });

  it("preserves early framed bytes from the upgrade head and held-handshake input in order", async () => {
    const host = await fixture();
    const cookie = await authorize(host, host.controlSource());
    const held = host.holdNextUpgrade();
    const earlyHead = maskedText("early-upgrade-head");
    const client = await host.rawUpgrade(cookie, earlyHead);
    await held.started;
    const ingress = host.ingressUpgrades[0];
    expect(ingress.headLength).toBe(earlyHead.length);
    // This observation is only installed after the gateway has begun its held
    // handshake. The FIN regression above adds no data listener to ingress.
    const collected = once(ingress.socket, "data");
    client.socket.write(maskedText("early-held-input"));
    await collected;
    await held.release();
    const app = host.appSockets[0];
    expect(await app.next()).toEqual({ body: Buffer.from("early-upgrade-head"), binary: false });
    expect(await app.next()).toEqual({ body: Buffer.from("early-held-input"), binary: false });
    expect(app.frames).toHaveLength(2);
    client.socket.end();
    await client.closed;
    await ingress.settled;
  });
});
