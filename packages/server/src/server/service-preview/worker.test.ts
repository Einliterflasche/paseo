import { once } from "node:events";
import { mkdtemp, readdir } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { PreviewBroker } from "./broker.js";
import { PreviewRoutes } from "./routes.js";
import { PREVIEW_SOURCE_CAPABILITY, PreviewSources } from "./sources.js";
import { startPreviewGatewayWorker } from "./worker.js";

const origin = "https://control.test";
const prefix = "/__paseo_services/apps/atlas/";
const html = `<!doctype html><title>Worker HTML fixture</title><h1>Atlas page</h1><script src="${prefix}app.js"></script><form method="post" action="${prefix}echo"><input name="draft"><button>Save</button></form>`;
const asset = 'document.body.dataset.loaded = "yes";';
const cleanups: Array<() => Promise<void>> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readBody(request: IncomingMessage) {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString("utf8");
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const navigation = {
  Origin: origin,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
function appHeaders(cookie?: string): OutgoingHttpHeaders {
  return {
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...(cookie === undefined ? {} : { Cookie: cookie }),
  };
}

function observeWebSocket(socket: WebSocket) {
  const ready = deferred<void>();
  const messages: string[] = [];
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  socket.on("error", () => {});
  socket.on("message", (data) => {
    const message = data.toString();
    messages.push(message);
    if (message === "ready") ready.resolve();
  });
  return { socket, messages, closed, ready: ready.promise };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-gw-wire-"));
  const socketPath = join(directory, "gateway.sock");
  const observed: Array<{
    method: string | undefined;
    path: string | undefined;
    body: string;
    cookie: string | undefined;
    authorization: string | undefined;
  }> = [];
  const failures: unknown[] = [];
  const tcp = new Set<Socket>();
  const clients: WebSocket[] = [];
  const appSockets: ReturnType<typeof observeWebSocket>[] = [];
  const stream = { started: deferred<ServerResponse>(), closed: deferred<void>() };
  const heldHeaders = { started: deferred<Socket>(), closed: deferred<void>() };
  const heldUpgrade = { started: deferred<Socket>(), closed: deferred<void>() };
  let connections = 0;
  const app = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  app.on("connection", (socket) => {
    appSockets.push(observeWebSocket(socket));
    socket.send("ready");
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  async function handleApp(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    observed.push({
      method: request.method,
      path: request.url,
      body,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    const path = request.url?.split("?", 1)[0];
    if (path === `${prefix}stream`) {
      response.write("first\n");
      response.once("close", () => stream.closed.resolve());
      stream.started.resolve(response);
    } else if (path === `${prefix}hold`) {
      request.socket.once("close", () => heldHeaders.closed.resolve());
      heldHeaders.started.resolve(request.socket);
    } else if (path === `${prefix}echo`) response.end(body);
    else if (path === `${prefix}app.js`) {
      response.setHeader("Content-Type", "application/javascript");
      response.end(asset);
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    }
  }
  const upstream = createServer((request, response) => {
    void handleApp(request, response).catch((error) => {
      failures.push(error);
      response.destroy();
    });
  });
  upstream.on("connection", (socket) => {
    connections += 1;
    tcp.add(socket);
    socket.once("close", () => tcp.delete(socket));
  });
  upstream.on("upgrade", (request, socket, head) => {
    if (!(socket instanceof Socket)) throw new Error("Expected real upstream socket");
    if (request.url === `${prefix}hold-ws`) {
      socket.on("error", () => {});
      socket.once("end", () => socket.destroy());
      socket.once("close", () => heldUpgrade.closed.resolve());
      socket.resume();
      heldUpgrade.started.resolve(socket);
      return;
    }
    app.handleUpgrade(request, socket, head, (client) => app.emit("connection", client, request));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  const sources = new PreviewSources(origin);
  const routes = new PreviewRoutes({ excludedPorts: [] });
  routes.register({ serviceId: "atlas", port: address.port, mount: "preserve" });
  const broker = new PreviewBroker({
    sources,
    routes,
    onFailure: (error) => {
      failures.push(error);
    },
  });
  const worker = startPreviewGatewayWorker({
    broker,
    socketPath,
    controlCookieNames: ["paseo-control"],
    onFailure: (error) => {
      failures.push(error);
    },
  });
  cleanups.push(async () => {
    worker.close();
    await worker.closed;
    for (const client of clients) client.terminate();
    for (const client of app.clients) client.terminate();
    for (const socket of tcp) socket.destroy();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    sources.close();
    routes.close();
    broker.close();
    expect(failures).toEqual([]);
  });
  await worker.ready;
  let sourceSequence = 0;
  function source() {
    const socket = { readyState: 1 };
    const frames: string[] = [];
    sources.admitDirectOwner({
      socket,
      connectionId: `worker-source-${++sourceSequence}`,
      principalId: "owner",
      origin,
      permissions: OWNER_PERMISSIONS,
      async send(frame) {
        frames.push(frame);
        return true;
      },
    });
    sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
    return { socket, frames };
  }
  function sendRequest(
    path: string,
    options: { method?: string; headers?: OutgoingHttpHeaders; chunks?: string[] } = {},
  ) {
    return new Promise<{
      status: number | undefined;
      headers: IncomingMessage["headers"];
      body: string;
    }>((resolve, reject) => {
      const outgoing = httpRequest({
        socketPath,
        path,
        method: options.method ?? "GET",
        agent: false,
        headers: { Host: "control.test", ...options.headers },
      });
      outgoing.on("error", reject);
      outgoing.on("response", (incoming) => {
        void readBody(incoming).then(
          (body) => resolve({ status: incoming.statusCode, headers: incoming.headers, body }),
          reject,
        );
      });
      for (const chunk of options.chunks ?? []) outgoing.write(chunk);
      outgoing.end();
    });
  }
  async function open(sourceInput = source(), attemptId = `open-${sourceSequence}`) {
    await broker.prepare({
      socket: sourceInput.socket,
      request: {
        type: "service.preview.prepare.request",
        requestId: `request-${attemptId}`,
        attemptId,
        browserHandle: "worker-browser",
        serviceId: "atlas",
        mode: "iframe",
      },
    });
    const frame = sourceInput.frames.at(-1);
    if (!frame) throw new Error("No Prepare response");
    const result = ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(frame).message)
      .payload.result;
    if (result.status !== "prepared") throw new Error("Prepare failed");
    const bootstrap = await sendRequest(`/__paseo_services/bootstrap/${result.bootstrapId}`, {
      method: "POST",
      headers: { ...navigation, "Content-Type": "application/x-www-form-urlencoded" },
      chunks: [new URLSearchParams({ ticket: result.ticket }).toString()],
    });
    expect(bootstrap.status).toBe(303);
    const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!cookie) throw new Error("Missing preview cookie");
    const confirmation = await sendRequest(`/__paseo_services/confirm/${result.bootstrapId}`, {
      headers: { ...navigation, Cookie: cookie },
    });
    expect(confirmation.status).toBe(200);
    expect(confirmation.body).toContain("data-paseo-preview-confirmation");
    return { source: sourceInput, cookie };
  }
  function websocket(cookie?: string, path = prefix) {
    const socket = new WebSocket(`ws+unix://${socketPath}:${path}`, ["vite-hmr"], {
      perMessageDeflate: false,
      headers: {
        Host: "control.test",
        Origin: origin,
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
    });
    clients.push(socket);
    return observeWebSocket(socket);
  }
  async function startStream(cookie: string) {
    const first = deferred<void>();
    const closed = deferred<{ body: string; complete: boolean }>();
    let body = "";
    const outgoing = httpRequest({
      socketPath,
      path: `${prefix}stream`,
      headers: { Host: "control.test", ...appHeaders(cookie) },
      agent: false,
    });
    outgoing.on("error", () => {});
    outgoing.on("response", (incoming) => {
      incoming.on("data", (chunk) => {
        body += chunk.toString();
        first.resolve();
      });
      incoming.on("error", () => {});
      incoming.on("close", () => closed.resolve({ body, complete: incoming.complete }));
    });
    outgoing.end();
    await first.promise;
    return { closed: closed.promise, response: await stream.started.promise };
  }
  return {
    worker,
    broker,
    sources,
    routes,
    source,
    open,
    request: sendRequest,
    websocket,
    startStream,
    stream,
    heldHeaders,
    heldUpgrade,
    observed,
    appSockets,
    socketPath,
    upstreamPort: address.port,
    failures,
    connections: () => connections,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Actual fork, ordered IPC and Unix HTTP/WS data plane. Admission provenance and
// browser metadata are supplied explicitly; browser/password tests are separate.
describe("isolated forked preview gateway", () => {
  it("rejects non-Unix paths before attaching the broker or creating a listener", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-gw-invalid-path-"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing reserved port");
    await stopServer(reservation);
    const sources = new PreviewSources(origin);
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const failures: unknown[] = [];
    const broker = new PreviewBroker({ sources, routes, onFailure() {} });
    let worker: ReturnType<typeof startPreviewGatewayWorker> | undefined;
    cleanups.push(async () => {
      worker?.close();
      await worker?.closed;
      broker.close();
      routes.close();
      sources.close();
    });
    for (const socketPath of [
      String(address.port),
      "",
      "relative.sock",
      `${directory}/bad\0sock`,
    ]) {
      expect(() =>
        startPreviewGatewayWorker({
          broker,
          socketPath,
          controlCookieNames: [],
          onFailure(error) {
            failures.push(error);
          },
        }),
      ).toThrow();
    }
    const probe = new Socket();
    const refused = new Promise<Error>((resolve, reject) => {
      probe.once("error", resolve);
      probe.once("connect", () => reject(new Error("Invalid path opened a TCP listener")));
    });
    probe.connect(address.port, "127.0.0.1");
    try {
      await expect(refused).resolves.toMatchObject({ code: "ECONNREFUSED" });
    } finally {
      probe.destroy();
    }
    expect(await readdir(directory)).toEqual([]);
    expect(broker.isClosed).toBe(false);
    worker = startPreviewGatewayWorker({
      broker,
      socketPath: join(directory, "valid.sock"),
      controlCookieNames: [],
      onFailure(error) {
        failures.push(error);
      },
    });
    await worker.ready;
    expect(failures).toEqual([]);
  });

  it("settles failed actual spawn cleanup and preserves its missing-executable diagnostic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-gw-spawn-failure-"));
    const sources = new PreviewSources(origin);
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const failures: unknown[] = [];
    const broker = new PreviewBroker({ sources, routes, onFailure() {} });
    const nodeExecutable = join(directory, "nonexistent-node");
    const worker = startPreviewGatewayWorker({
      broker,
      socketPath: join(directory, "gateway.sock"),
      controlCookieNames: [],
      nodeExecutable,
      onFailure(error) {
        failures.push(error);
      },
    });
    cleanups.push(async () => {
      worker.close();
      await worker.closed;
      broker.close();
      routes.close();
      sources.close();
    });
    await expect(worker.ready).rejects.toMatchObject({ code: "ENOENT", path: nodeExecutable });
    await worker.closed;
    expect(worker.pid).toBeUndefined();
    expect(broker.isClosed).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "ENOENT", path: nodeExecutable });
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses an existing Unix socket without removing or replacing its owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-gw-collision-"));
    const socketPath = join(directory, "existing.sock");
    const existing = createServer((_request, response) => response.end("existing-owner"));
    existing.listen(socketPath);
    await once(existing, "listening");
    const sources = new PreviewSources(origin);
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const broker = new PreviewBroker({ sources, routes, onFailure() {} });
    const failures: unknown[] = [];
    const worker = startPreviewGatewayWorker({
      broker,
      socketPath,
      controlCookieNames: [],
      onFailure(error) {
        failures.push(error);
      },
    });
    cleanups.push(async () => {
      worker.close();
      await worker.closed;
      await stopServer(existing);
      broker.close();
      routes.close();
      sources.close();
    });
    await expect(worker.ready).rejects.toThrow("preview-worker-ended-before-ready");
    await worker.closed;
    expect(broker.isClosed).toBe(true);
    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest({ socketPath, path: "/", agent: false }, (incoming) => {
        void readBody(incoming).then(resolve, reject);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(body).toBe("existing-owner");
    expect(failures).toEqual([]);
  });

  it("serves HTML, assets and one chunked form body and forwards the Vite HMR protocol", async () => {
    const host = await fixture();
    expect(host.worker.pid).not.toBe(process.pid);
    expect((await host.request(prefix, { headers: appHeaders() })).status).toBe(403);
    expect(host.connections()).toBe(0);
    const { cookie } = await host.open();
    expect(host.connections()).toBe(0);
    expect(await host.request(prefix, { headers: appHeaders(cookie) })).toMatchObject({
      status: 200,
      body: html,
    });
    expect(await host.request(`${prefix}app.js`, { headers: appHeaders(cookie) })).toMatchObject({
      status: 200,
      body: asset,
    });
    expect(
      await host.request(`${prefix}echo`, {
        method: "POST",
        headers: {
          ...appHeaders(`${cookie}; paseo-control=secret`),
          Origin: origin,
          Authorization: "Bearer private",
          "Transfer-Encoding": "chunked",
        },
        chunks: ["draft=hello", "+world"],
      }),
    ).toMatchObject({ status: 200, body: "draft=hello+world" });
    expect(
      host.observed.map(({ method, body, cookie: forwardedCookie, authorization }) => ({
        method,
        body,
        forwardedCookie,
        authorization,
      })),
    ).toEqual([
      { method: "GET", body: "", forwardedCookie: undefined, authorization: undefined },
      { method: "GET", body: "", forwardedCookie: undefined, authorization: undefined },
      {
        method: "POST",
        body: "draft=hello+world",
        forwardedCookie: undefined,
        authorization: undefined,
      },
    ]);
    const hmr = host.websocket(cookie);
    await hmr.ready;
    expect(hmr.socket.protocol).toBe("vite-hmr");
    hmr.socket.send("hot-update");
    await expect.poll(() => hmr.messages).toEqual(["ready", "hot-update"]);
    expect(host.appSockets).toHaveLength(1);
  });

  it("preserves a sibling contribution, then closes actual streams before fresh authority can be used", async () => {
    const host = await fixture();
    const a = await host.open();
    const b = await host.open();
    const stream = await host.startStream(a.cookie);
    const hmr = host.websocket(a.cookie);
    await hmr.ready;
    host.sources.detach(a.source.socket);
    hmr.socket.send("still-active");
    await expect.poll(() => hmr.messages).toEqual(["ready", "still-active"]);
    expect(await host.request(prefix, { headers: appHeaders(b.cookie) })).toMatchObject({
      status: 200,
      body: html,
    });
    host.sources.detach(b.source.socket);
    expect(await stream.closed).toEqual({ complete: false, body: "first\n" });
    await host.stream.closed.promise;
    expect(await hmr.closed).toBe(1006);
    expect(await host.appSockets[0].closed).toBe(1006);
    await host.worker.settled();
    const c = await host.open();
    expect(await host.request(prefix, { headers: appHeaders(c.cookie) })).toMatchObject({
      status: 200,
      body: html,
    });
    stream.response.end("must-not-resume\n");
    expect(await stream.closed).toEqual({ complete: false, body: "first\n" });
    expect(hmr.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("cancels held HTTP headers and WebSocket handshakes when the registered route is withdrawn", async () => {
    const host = await fixture();
    const { cookie } = await host.open();
    const pending = host
      .request(`${prefix}hold`, { headers: appHeaders(cookie) })
      .catch((error: unknown) => error);
    const httpSocket = await host.heldHeaders.started.promise;
    const pendingWs = host.websocket(cookie, `${prefix}hold-ws`);
    const wsSocket = await host.heldUpgrade.started.promise;
    host.routes.markUnavailable("atlas");
    await Promise.all([
      host.heldHeaders.closed.promise,
      host.heldUpgrade.closed.promise,
      pendingWs.closed,
    ]);
    expect(httpSocket.destroyed).toBe(true);
    expect(wsSocket.destroyed).toBe(true);
    const result = await pending;
    expect(result).toMatchObject({ status: 403 });
    await host.worker.settled();
    expect((await host.request(prefix, { headers: appHeaders(cookie) })).status).toBe(403);
  });

  it("retires its authority on worker close without stopping the upstream app", async () => {
    const host = await fixture();
    const { cookie } = await host.open();
    const hmr = host.websocket(cookie);
    await hmr.ready;
    host.worker.close();
    await host.worker.closed;
    expect(await hmr.closed).toBe(1006);
    expect(await host.appSockets[0].closed).toBe(1006);
    expect(host.broker.isClosed).toBe(true);
    const direct = await fetch(`http://127.0.0.1:${host.upstreamPort}${prefix}`);
    expect(await direct.text()).toBe(html);
    expect(() =>
      startPreviewGatewayWorker({
        broker: host.broker,
        socketPath: host.socketPath,
        controlCookieNames: [],
        onFailure() {},
      }),
    ).toThrow("preview-broker-already-attached");
    expect(host.failures).toEqual([]);
  });
});
