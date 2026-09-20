import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { PreviewBroker } from "./broker.js";
import type { PreviewGatewayAuthority } from "./authority.js";
import { createPreviewGateway } from "./gateway.js";
import { PreviewRoutes } from "./routes.js";
import { PREVIEW_SOURCE_CAPABILITY, PreviewSources } from "./sources.js";

const controlOrigin = "https://control.test";
const appPrefix = "/__paseo_services/apps/atlas/";
const page = `<!doctype html><html><head><title>Atlas preview</title><script defer src="${appPrefix}app.js"></script></head><body><h1>Atlas preview</h1><form method="post" action="${appPrefix}echo"><label>Draft<input name="draft"></label><button>Save</button></form></body></html>`;
const asset = 'document.body.dataset.appLoaded = "yes";';
const cleanups: Array<() => Promise<void>> = [];

interface ObservedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface WireRequest {
  path: string;
  method?: string;
  headers?: OutgoingHttpHeaders;
  chunks?: readonly string[];
}

interface WireResponse {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface StreamResult {
  complete: boolean;
  body: string;
}

interface HeldStream {
  started: ReturnType<typeof deferred<ServerResponse>>;
  released: ReturnType<typeof deferred<void>>;
  closed: ReturnType<typeof deferred<void>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing fixture port");
  return address.port;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString("utf8");
}

function writeHygieneResponse(response: ServerResponse): void {
  response.setHeader("Clear-Site-Data", '"cookies", "storage"');
  response.setHeader("NEL", '{"report_to":"app","max_age":3600}');
  response.setHeader("Report-To", '{"group":"app","endpoints":[{"url":"https://collector.test"}]}');
  response.setHeader("Service-Worker-Allowed", "/");
  response.setHeader("Strict-Transport-Security", "max-age=3600");
  response.setHeader("Alt-Svc", 'h3=":443"');
  response.setHeader("Connection", "x-upstream-private");
  response.setHeader("X-Upstream-Private", "omit");
  response.setHeader("Content-Security-Policy", "default-src 'self'");
  response.setHeader("Set-Cookie", [
    "paseo-control=overwrite; Path=/; Secure",
    "__Secure-PaseoPreview-forged=overwrite; Path=/; Secure",
    "app=ok; Domain=control.test; Path=/__paseo_services/apps/atlas/; HttpOnly",
    "global=omit; Path=/",
  ]);
  response.end("hygiene");
}

async function respondToApp({
  request,
  response,
  requests,
  stream,
  rogueUpgradeClosed,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  requests: ObservedRequest[];
  stream: HeldStream;
  rogueUpgradeClosed: ReturnType<typeof deferred<void>>;
}): Promise<void> {
  const body = await readBody(request);
  requests.push({ method: request.method, url: request.url, headers: request.headers, body });
  const path = request.url?.split("?", 1)[0];
  if (path?.endsWith("/reset")) {
    response.destroy();
    return;
  }
  if (path?.endsWith("/rogue-upgrade")) {
    response.socket?.once("close", () => rogueUpgradeClosed.resolve());
    response.writeHead(101, { Connection: "Upgrade", Upgrade: "websocket" });
    response.flushHeaders();
    return;
  }
  if (path?.endsWith("/stream")) {
    response.setHeader("Content-Type", "text/plain");
    response.on("close", () => stream.closed.resolve());
    response.write("first\n");
    stream.started.resolve(response);
    await stream.released.promise;
    response.end("late\n");
    return;
  }
  if (path?.endsWith("/hygiene")) return writeHygieneResponse(response);
  if (path?.endsWith("/app.js")) {
    response.setHeader("Content-Type", "application/javascript");
    response.end(asset);
    return;
  }
  if (path?.endsWith("/echo")) {
    response.setHeader("Content-Type", "text/plain");
    response.end(body);
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(page);
}

async function fixture(
  mount: "preserve" | "strip" = "preserve",
  authority?: (broker: PreviewBroker) => PreviewGatewayAuthority,
) {
  const requests: ObservedRequest[] = [];
  const failures: unknown[] = [];
  const bootstrapBodyStarted = deferred<void>();
  const bootstrapHandled = deferred<void>();
  const rogueUpgradeClosed = deferred<void>();
  const handledPaths: string[] = [];
  const disconnectedPaths: string[] = [];
  const stream: HeldStream = {
    started: deferred<ServerResponse>(),
    released: deferred<void>(),
    closed: deferred<void>(),
  };
  let upstreamConnections = 0;
  const upstream = createServer((request, response) => {
    void respondToApp({ request, response, requests, stream, rogueUpgradeClosed }).catch(
      (error) => {
        failures.push(error);
        response.destroy();
      },
    );
  });
  upstream.on("connection", () => {
    upstreamConnections += 1;
  });
  const upstreamPort = await listen(upstream);
  const sources = new PreviewSources(controlOrigin);
  const routes = new PreviewRoutes({ excludedPorts: [] });
  routes.register({ serviceId: "atlas", port: upstreamPort, mount });
  const broker = new PreviewBroker({
    sources,
    routes,
    onFailure(error) {
      failures.push(error);
    },
  });
  const gateway = createPreviewGateway({
    broker: authority?.(broker) ?? broker,
    controlOrigin,
    controlCookieNames: ["paseo-control"],
  });
  const ingress = createServer((request, response) => {
    response.once("close", () => {
      if (!response.writableFinished) disconnectedPaths.push(request.url ?? "");
    });
    const bootstrap = request.url?.startsWith("/__paseo_services/bootstrap/");
    if (bootstrap) request.once("readable", () => bootstrapBodyStarted.resolve());
    void gateway
      .handle(request, response)
      .catch((error) => {
        failures.push(error);
        response.destroy();
      })
      .finally(() => {
        handledPaths.push(request.url ?? "");
        if (bootstrap) bootstrapHandled.resolve();
      });
  });
  ingress.on("upgrade", (request, socket, head) => {
    void gateway.upgrade(request, socket, head).catch((error) => {
      failures.push(error);
      socket.destroy();
    });
  });
  const port = await listen(ingress);
  cleanups.push(async () => {
    gateway.close();
    broker.close();
    sources.close();
    routes.close();
    stream.released.resolve();
    await Promise.all([stop(ingress), stop(upstream)]);
    expect(failures).toEqual([]);
  });

  let sourceSequence = 0;
  function connect() {
    const socket = { readyState: 1 };
    const frames: string[] = [];
    sources.admitDirectOwner({
      socket,
      connectionId: `wire-source-${++sourceSequence}`,
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

  function wireRequest({ path, method = "GET", headers = {}, chunks = [] }: WireRequest) {
    return new Promise<WireResponse>((resolve, reject) => {
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: { Host: "control.test", ...headers },
      });
      outgoing.on("error", reject);
      outgoing.on("response", (incoming) => {
        void readBody(incoming).then(
          (body) => resolve({ status: incoming.statusCode, headers: incoming.headers, body }),
          reject,
        );
      });
      for (const chunk of chunks) outgoing.write(chunk);
      outgoing.end();
    });
  }

  return {
    broker,
    sources,
    routes,
    gateway,
    connect,
    request: wireRequest,
    port,
    requests,
    stream,
    bootstrapBodyStarted: bootstrapBodyStarted.promise,
    bootstrapHandled: bootstrapHandled.promise,
    rogueUpgradeClosed: rogueUpgradeClosed.promise,
    handledPaths,
    disconnectedPaths,
    upstreamConnections: () => upstreamConnections,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Client = ReturnType<Fixture["connect"]>;
type Mode = "iframe" | "tab";

function observeRedemptions() {
  let calls = 0;
  return {
    count: () => calls,
    adapt(broker: PreviewBroker): PreviewGatewayAuthority {
      return {
        redeem(input) {
          calls += 1;
          return broker.redeem(input);
        },
        confirm: broker.confirm.bind(broker),
        run: broker.run.bind(broker),
        close: () => broker.close(),
      };
    },
  };
}

function navigation(mode: Mode): OutgoingHttpHeaders {
  return {
    Origin: controlOrigin,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": mode === "iframe" ? "iframe" : "document",
  };
}

function appHeaders(cookie?: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
  if (cookie !== undefined) headers.Cookie = cookie;
  return headers;
}

async function prepare({
  host,
  client,
  attemptId = "open-1",
  mode = "iframe",
}: {
  host: Fixture;
  client: Client;
  attemptId?: string;
  mode?: Mode;
}) {
  await host.broker.prepare({
    socket: client.socket,
    request: {
      type: "service.preview.prepare.request",
      requestId: `prepare-${attemptId}`,
      attemptId,
      browserHandle: "wire-profile",
      serviceId: "atlas",
      mode,
    },
  });
  const frame = client.frames.at(-1);
  if (!frame) throw new Error("Missing fixture Prepare response");
  const parsed = ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(frame).message);
  if (parsed.payload.result.status !== "prepared") throw new Error("Prepare was not accepted");
  return parsed.payload.result;
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

function bootstrapRequest(prepared: Prepared): WireRequest {
  return {
    path: `/__paseo_services/bootstrap/${prepared.bootstrapId}`,
    method: "POST",
    headers: {
      ...navigation(prepared.mode),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    chunks: [new URLSearchParams({ ticket: prepared.ticket }).toString()],
  };
}

function readCookie(response: WireResponse): string {
  const cookies = response.headers["set-cookie"];
  expect(cookies).toHaveLength(1);
  const header = cookies?.[0];
  if (!header) throw new Error("Missing bootstrap cookie");
  expect(header).toMatch(/^__Secure-PaseoPreview-/);
  expect(header).toMatch(/;\s*Secure(?:;|$)/i);
  expect(header).toMatch(/;\s*HttpOnly(?:;|$)/i);
  expect(header).toMatch(/;\s*Path=\/__paseo_services(?:\/)?(?:;|$)/i);
  expect(header).not.toMatch(/;\s*Domain=/i);
  return header.split(";", 1)[0];
}

function expectConfirmation(response: WireResponse, prepared: Prepared): void {
  expect(response.status).toBe(200);
  expect(response.headers.location).toBeUndefined();
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(response.headers["cache-control"]).toBe("no-store");
  const nonce = response.body.match(/<script nonce="([A-Za-z0-9+/=]+)">/)?.[1];
  expect(nonce).toBeTruthy();
  expect(response.headers["content-security-policy"]).toBe(
    `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`,
  );
  expect(response.body).toContain("data-paseo-preview-confirmation");
  expect(response.body).toContain(`location.replace(${JSON.stringify(appPrefix)})`);
  expect(response.body).not.toContain(prepared.ticket);
}

async function open({
  host,
  client,
  attemptId,
  mode,
}: {
  host: Fixture;
  client: Client;
  attemptId?: string;
  mode?: Mode;
}) {
  const prepared = await prepare({ host, client, attemptId, mode });
  const bootstrap = await host.request(bootstrapRequest(prepared));
  expect(bootstrap.status).toBe(303);
  expect(bootstrap.headers.location).toBe(`/__paseo_services/confirm/${prepared.bootstrapId}`);
  const cookie = readCookie(bootstrap);
  const confirmation = await host.request({
    path: `/__paseo_services/confirm/${prepared.bootstrapId}`,
    headers: { ...navigation(prepared.mode), Cookie: cookie },
  });
  expectConfirmation(confirmation, prepared);
  return { cookie, prepared };
}

function startStream(host: Fixture, cookie: string) {
  return new Promise<{
    first: string;
    closed: Promise<StreamResult>;
    disconnect(): void;
  }>((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: host.port,
      path: `${appPrefix}stream`,
      agent: false,
      headers: { Host: "control.test", ...appHeaders(cookie) },
    });
    outgoing.on("error", reject);
    outgoing.on("response", (incoming) => {
      const parts: Buffer[] = [];
      const closed = new Promise<StreamResult>((finish) => {
        incoming.on("data", (part) => parts.push(Buffer.from(part)));
        incoming.on("error", () => {});
        incoming.on("close", () => {
          finish({ complete: incoming.complete, body: Buffer.concat(parts).toString("utf8") });
        });
      });
      incoming.once("data", (part) => {
        resolve({
          first: Buffer.from(part).toString("utf8"),
          closed,
          disconnect: () => outgoing.destroy(),
        });
      });
    });
    outgoing.end();
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// These are real HTTP wire tests. HTTPS admission and Fetch Metadata are synthetic
// fixture inputs; browser generation/enforcement needs separate browser evidence.
describe("optional preview HTTP gateway", () => {
  it("awaits asynchronous redemption and confirmation before writing either navigation response", async () => {
    const redeem = { entered: deferred<void>(), release: deferred<void>() };
    const confirm = { entered: deferred<void>(), release: deferred<void>() };
    const host = await fixture("preserve", (broker) => ({
      async redeem(input) {
        const value = broker.redeem(input);
        redeem.entered.resolve();
        await redeem.release.promise;
        return value;
      },
      async confirm(input) {
        const value = broker.confirm(input);
        confirm.entered.resolve();
        await confirm.release.promise;
        return value;
      },
      run: broker.run.bind(broker),
      close: () => broker.close(),
    }));
    const prepared = await prepare({ host, client: host.connect() });
    const bootstrap = host.request(bootstrapRequest(prepared));
    await redeem.entered.promise;
    expect(host.handledPaths).toEqual([]);
    expect(host.upstreamConnections()).toBe(0);
    redeem.release.resolve();
    const issued = await bootstrap;
    expect(issued.status).toBe(303);
    const cookie = readCookie(issued);
    const path = `/__paseo_services/confirm/${prepared.bootstrapId}`;
    const confirmation = host.request({
      path,
      headers: { ...navigation("iframe"), Cookie: cookie },
    });
    await confirm.entered.promise;
    expect(host.handledPaths).toEqual([bootstrapRequest(prepared).path]);
    expect(host.upstreamConnections()).toBe(0);
    confirm.release.resolve();
    expectConfirmation(await confirmation, prepared);
    expect(await host.request({ path: appPrefix, headers: appHeaders(cookie) })).toMatchObject({
      status: 200,
      body: page,
    });
  });

  it.each(["redeem", "confirm"] as const)(
    "does not emit a delayed %s result after gateway close",
    async (operation) => {
      const held = { entered: deferred<void>(), release: deferred<void>() };
      const host = await fixture("preserve", (broker) => ({
        async redeem(input) {
          const result = broker.redeem(input);
          if (operation === "redeem") {
            held.entered.resolve();
            await held.release.promise;
          }
          return result;
        },
        async confirm(input) {
          const result = broker.confirm(input);
          if (operation === "confirm") {
            held.entered.resolve();
            await held.release.promise;
          }
          return result;
        },
        run: broker.run.bind(broker),
        close: () => broker.close(),
      }));
      const prepared = await prepare({ host, client: host.connect() });
      let request = bootstrapRequest(prepared);
      if (operation === "confirm") {
        const issued = await host.request(request);
        request = {
          path: `/__paseo_services/confirm/${prepared.bootstrapId}`,
          headers: { ...navigation("iframe"), Cookie: readCookie(issued) },
        };
      }
      const pending = host.request(request);
      await held.entered.promise;
      host.gateway.close();
      held.release.resolve();
      const result = await pending;
      expect(result.status).toBe(403);
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(result.headers.location).toBeUndefined();
      expect(result.body).not.toContain("data-paseo-preview-confirmation");
      expect(host.upstreamConnections()).toBe(0);
    },
  );

  it.each(["redeem", "confirm"] as const)(
    "does not emit a delayed %s result after the browser disconnects",
    async (operation) => {
      const held = { entered: deferred<void>(), release: deferred<void>() };
      const host = await fixture("preserve", (broker) => ({
        async redeem(input) {
          const result = broker.redeem(input);
          if (operation === "redeem") {
            held.entered.resolve();
            await held.release.promise;
          }
          return result;
        },
        async confirm(input) {
          const result = broker.confirm(input);
          if (operation === "confirm") {
            held.entered.resolve();
            await held.release.promise;
          }
          return result;
        },
        run: broker.run.bind(broker),
        close: () => broker.close(),
      }));
      const prepared = await prepare({ host, client: host.connect() });
      let request = bootstrapRequest(prepared);
      if (operation === "confirm") {
        const issued = await host.request(request);
        request = {
          path: `/__paseo_services/confirm/${prepared.bootstrapId}`,
          headers: { ...navigation("iframe"), Cookie: readCookie(issued) },
        };
      }
      const responses: number[] = [];
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port: host.port,
        path: request.path,
        method: request.method ?? "GET",
        agent: false,
        headers: { Host: "control.test", ...request.headers },
      });
      outgoing.on("error", () => {});
      outgoing.on("response", (response) => {
        responses.push(response.statusCode ?? 0);
        response.resume();
      });
      const disconnected = new Promise<void>((resolve) => outgoing.once("close", resolve));
      for (const chunk of request.chunks ?? []) outgoing.write(chunk);
      outgoing.end();
      await held.entered.promise;
      outgoing.destroy();
      await disconnected;
      await expect.poll(() => host.disconnectedPaths.includes(request.path)).toBe(true);
      held.release.resolve();
      await expect.poll(() => host.handledPaths.includes(request.path)).toBe(true);
      expect(responses).toEqual([]);
      expect(host.upstreamConnections()).toBe(0);
    },
  );

  it.each<Mode>(["iframe", "tab"])(
    "confirms the %s cookie before serving HTML, assets and one form submission",
    async (mode) => {
      const host = await fixture();
      const client = host.connect();
      const { cookie } = await open({ host, client, mode });
      expect(host.upstreamConnections()).toBe(0);
      const document = await host.request({
        path: appPrefix,
        headers: { ...navigation(mode), Cookie: cookie },
      });
      expect(document).toMatchObject({ status: 200, body: page });
      expect(document.headers["content-type"]).toBe("text/html; charset=utf-8");
      const script = await host.request({
        path: `${appPrefix}app.js`,
        headers: appHeaders(cookie),
      });
      expect(script).toMatchObject({ status: 200, body: asset });
      const formBody = "draft=Saved+from+HTML+form&emoji=%F0%9F%8C%8D";
      const form = await host.request({
        path: `${appPrefix}echo`,
        method: "POST",
        headers: {
          ...navigation(mode),
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        chunks: [formBody.slice(0, 12), formBody.slice(12)],
      });
      expect(form).toMatchObject({ status: 200, body: formBody });
      expect(host.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
        { method: "GET", url: appPrefix, body: "" },
        { method: "GET", url: `${appPrefix}app.js`, body: "" },
        { method: "POST", url: `${appPrefix}echo`, body: formBody },
      ]);
      expect(host.requests.map(({ headers }) => headers.cookie)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    },
  );

  it("keeps an issued ticket usable after a wrong navigation destination and rejects replay", async () => {
    const host = await fixture();
    const client = host.connect();
    const prepared = await prepare({ host, client });
    const wrong = bootstrapRequest(prepared);
    wrong.headers = { ...wrong.headers, "Sec-Fetch-Dest": "document" };
    expect((await host.request(wrong)).status).toBe(403);
    const accepted = await host.request(bootstrapRequest(prepared));
    expect(accepted.status).toBe(303);
    const cookie = readCookie(accepted);
    expect((await host.request(bootstrapRequest(prepared))).status).toBe(403);
    const path = `/__paseo_services/confirm/${prepared.bootstrapId}`;
    expect((await host.request({ path, headers: navigation("iframe") })).status).toBe(403);
    expect(
      (await host.request({ path, headers: { ...navigation("tab"), Cookie: cookie } })).status,
    ).toBe(403);
    const confirmation = await host.request({
      path,
      headers: { ...navigation("iframe"), Cookie: cookie },
    });
    expectConfirmation(confirmation, prepared);
    expect(host.upstreamConnections()).toBe(0);
  });

  it("requires the bootstrap secret in the POST body and exact same-origin metadata", async () => {
    const host = await fixture();
    const prepared = await prepare({ host, client: host.connect() });
    const original = bootstrapRequest(prepared);
    const attempts: WireRequest[] = [
      { ...original, method: "GET", chunks: [] },
      { ...original, chunks: [], headers: { ...original.headers, Authorization: prepared.ticket } },
      { ...original, headers: { ...original.headers, Origin: "https://foreign.test" } },
      { ...original, headers: { ...original.headers, "Sec-Fetch-Site": "cross-site" } },
      { ...original, headers: { ...original.headers, "Sec-Fetch-Mode": "cors" } },
      { ...original, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    ];
    for (const request of attempts) {
      const denied = await host.request(request);
      expect(denied.status).toBe(403);
      expect(denied.headers["set-cookie"]).toBeUndefined();
      expect(denied.body).not.toContain(prepared.ticket);
    }
    const querySecret = await host.request({
      ...original,
      path: `${original.path}?ticket=${prepared.ticket}`,
      chunks: [],
    });
    expect(querySecret.status).toBe(404);
    expect(querySecret.headers["set-cookie"]).toBeUndefined();
    expect(querySecret.body).not.toContain(prepared.ticket);
    expect((await host.request(original)).status).toBe(303);
    expect(host.upstreamConnections()).toBe(0);
  });

  it("denies a noncanonical form without consuming the ticket, then accepts the exact generated form", async () => {
    const redemption = observeRedemptions();
    const host = await fixture("preserve", redemption.adapt);
    const prepared = await prepare({ host, client: host.connect() });
    const encodedTicket = Array.from(
      Buffer.from(prepared.ticket),
      (byte, index) => `%${byte.toString(16)[index % 2 === 0 ? "toUpperCase" : "toLowerCase"]()}`,
    ).join("");
    const body = `?${"&".repeat(1024)}%74%69%63%6b%65%74=${encodedTicket}${"&".repeat(1024)}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(50);
    expect([...new URLSearchParams(body)]).toEqual([["ticket", prepared.ticket]]);
    const denied = await host.request({
      ...bootstrapRequest(prepared),
      chunks: Array.from(body),
    });
    expect(denied.status).toBe(403);
    expect(denied.headers["set-cookie"]).toBeUndefined();
    expect(denied.body).not.toContain(prepared.ticket);
    expect(redemption.count()).toBe(0);
    expect(host.upstreamConnections()).toBe(0);
    expect(host.requests).toEqual([]);
    const exactBody = new URLSearchParams({ ticket: prepared.ticket }).toString();
    expect(Buffer.byteLength(exactBody)).toBe(50);
    const issued = await host.request({
      ...bootstrapRequest(prepared),
      chunks: Array.from(exactBody),
    });
    expect(issued.status).toBe(303);
    expect(redemption.count()).toBe(1);
    expect(host.upstreamConnections()).toBe(0);
    expect(host.requests).toEqual([]);
    const cookie = readCookie(issued);
    const confirmed = await host.request({
      path: `/__paseo_services/confirm/${prepared.bootstrapId}`,
      headers: { ...navigation("iframe"), Cookie: cookie },
    });
    expectConfirmation(confirmed, prepared);
    expect(host.upstreamConnections()).toBe(0);
    expect(await host.request({ path: appPrefix, headers: appHeaders(cookie) })).toMatchObject({
      status: 200,
      body: page,
    });
    expect(host.requests).toHaveLength(1);
  });

  it.each(["field", "duplicate", "malformed escape", "overlong token"] as const)(
    "ends an impossible streaming %s form before its sender finishes without redeeming",
    async (malformation) => {
      const redemption = observeRedemptions();
      const host = await fixture("preserve", redemption.adapt);
      const prepared = await prepare({ host, client: host.connect() });
      const prefixes = {
        field: "other=",
        duplicate: `ticket=${prepared.ticket}&ticket=`,
        "malformed escape": "ticket=%GG",
        "overlong token": `ticket=${prepared.ticket}A`,
      };
      const bootstrap = bootstrapRequest(prepared);
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port: host.port,
        path: bootstrap.path,
        method: "POST",
        agent: false,
        headers: { Host: "control.test", ...bootstrap.headers, "Transfer-Encoding": "chunked" },
      });
      const statuses: number[] = [];
      const errors: Array<string | undefined> = [];
      const bodies: Promise<string>[] = [];
      outgoing.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code));
      outgoing.on("response", (response) => {
        statuses.push(response.statusCode ?? 0);
        bodies.push(readBody(response).catch(String));
      });
      const closed = new Promise<void>((resolve) => outgoing.once("close", resolve));
      outgoing.write(prefixes[malformation]);
      await host.bootstrapHandled;
      await closed;
      expect(outgoing.writableEnded).toBe(false);
      expect(statuses).toEqual([403]);
      expect(errors).toEqual([]);
      expect(await Promise.all(bodies)).toEqual([
        expect.stringContaining("data-paseo-preview-error"),
      ]);
      expect((await Promise.all(bodies)).join("")).not.toContain(prepared.ticket);
      expect(redemption.count()).toBe(0);
      expect(host.upstreamConnections()).toBe(0);
      expect(host.requests).toEqual([]);
      // The malformed body must not consume the issued one-use ticket.
      expect((await host.request(bootstrapRequest(prepared))).status).toBe(303);
      expect(redemption.count()).toBe(1);
    },
  );

  it("leaves ordinary application form uploads byte-for-byte unchanged", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const body = `ticket=ordinary-short-value&ticket=second&draft=${"hello+%F0%9F%8C%8D&".repeat(256)}broken=%GG`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(50);
    const result = await host.request({
      path: `${appPrefix}echo`,
      method: "POST",
      headers: {
        ...navigation("iframe"),
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      chunks: [body.slice(0, 17), body.slice(17, 61), body.slice(61)],
    });
    expect(result).toMatchObject({ status: 200, body });
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({ method: "POST", url: `${appPrefix}echo`, body });
  });

  it("denies missing, forged and duplicate authority or foreign requests before any upstream connection", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const cookieName = cookie.split("=", 1)[0];
    const requests: WireRequest[] = [
      { path: appPrefix, headers: appHeaders() },
      { path: appPrefix, headers: appHeaders(`${cookieName}=forged`) },
      { path: appPrefix, headers: appHeaders(`${cookie}; ${cookie}`) },
      { path: appPrefix, headers: { ...appHeaders(cookie), Origin: "https://foreign.test" } },
      { path: appPrefix, headers: { ...appHeaders(cookie), "Sec-Fetch-Site": "cross-site" } },
      { path: appPrefix, headers: { Cookie: cookie } },
      { path: appPrefix, headers: { ...appHeaders(cookie), Host: "foreign.test" } },
      { path: "/__paseo_services/apps/unknown/", headers: appHeaders(cookie) },
      { path: `${appPrefix}../other/`, headers: appHeaders(cookie) },
    ];
    for (const request of requests) {
      expect((await host.request(request)).status).toBe(403);
      expect(host.upstreamConnections()).toBe(0);
    }
    expect(host.requests).toEqual([]);
  });

  it.each(["GET", "DELETE"])("preserves one chunked %s body across the gateway", async (method) => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const result = await host.request({
      path: `${appPrefix}echo`,
      method,
      headers: { ...appHeaders(cookie), Origin: controlOrigin, "Transfer-Encoding": "chunked" },
      chunks: ["first-", "second"],
    });
    expect(result).toMatchObject({ status: 200, body: "first-second" });
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({ method, body: "first-second" });
  });

  it("reconstructs framing when Connection removes Content-Length", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const result = await host.request({
      path: `${appPrefix}echo`,
      method: "DELETE",
      headers: {
        ...appHeaders(cookie),
        Origin: controlOrigin,
        Connection: "content-length",
        "Content-Length": String(Buffer.byteLength("first-second")),
      },
      chunks: ["first-", "second"],
    });
    expect(result).toMatchObject({ status: 200, body: "first-second" });
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({
      method: "DELETE",
      body: "first-second",
      headers: { "transfer-encoding": "chunked" },
    });
  });

  it("keeps control credentials and origin-wide response effects out of the mounted application", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const result = await host.request({
      path: `${appPrefix}hygiene`,
      headers: {
        ...appHeaders(`${cookie}; paseo-control=secret; app=local`),
        Authorization: "Bearer control-secret",
        "X-Forwarded-Host": "forged.test",
        "X-Original-URL": "/admin",
        Forwarded: "host=forged.test",
      },
    });
    expect(result).toMatchObject({ status: 200, body: "hygiene" });
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0].headers).toMatchObject({
      cookie: "app=local",
      host: "control.test",
      "x-forwarded-host": "control.test",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
    });
    expect(host.requests[0].headers.authorization).toBeUndefined();
    expect(host.requests[0].headers.forwarded).toBeUndefined();
    expect(host.requests[0].headers["x-original-url"]).toBeUndefined();
    for (const name of [
      "clear-site-data",
      "nel",
      "report-to",
      "service-worker-allowed",
      "strict-transport-security",
      "alt-svc",
      "x-upstream-private",
    ]) {
      expect(result.headers[name]).toBeUndefined();
    }
    expect(result.headers["set-cookie"]).toEqual([
      "app=ok; Path=/__paseo_services/apps/atlas/; HttpOnly",
    ]);
    expect(result.headers["content-security-policy"]).toBe("default-src 'self', worker-src 'self'");
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("forwards only the registered stripped path and keeps the public query intact", async () => {
    const host = await fixture("strip");
    const { cookie } = await open({ host, client: host.connect() });
    const result = await host.request({
      path: `${appPrefix}app.js?revision=2`,
      headers: appHeaders(cookie),
    });
    expect(result).toMatchObject({ status: 200, body: asset });
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0].url).toBe("/app.js?revision=2");
  });

  it("cancels an open response on source detach and never revives it after a fresh Open", async () => {
    const host = await fixture();
    const client = host.connect();
    const { cookie } = await open({ host, client });
    const old = await startStream(host, cookie);
    expect(old.first).toBe("first\n");
    await host.stream.started.promise;
    host.sources.detach(client.socket);
    const fresh = await open({ host, client: host.connect(), attemptId: "open-2" });
    const result = await host.request({ path: appPrefix, headers: appHeaders(fresh.cookie) });
    expect(result).toMatchObject({ status: 200, body: page });
    expect(await old.closed).toEqual({ complete: false, body: "first\n" });
    await host.stream.closed.promise;
    host.stream.released.resolve();
    expect(await old.closed).toEqual({ complete: false, body: "first\n" });
    expect(host.requests.map(({ url }) => url)).toEqual([`${appPrefix}stream`, appPrefix]);
  });

  it("closes an in-flight response when the registered route becomes unavailable", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const old = await startStream(host, cookie);
    expect(old.first).toBe("first\n");
    host.routes.markUnavailable("atlas");
    expect(await old.closed).toEqual({ complete: false, body: "first\n" });
    await host.stream.closed.promise;
    expect((await host.request({ path: appPrefix, headers: appHeaders(cookie) })).status).toBe(403);
    expect(host.upstreamConnections()).toBe(1);
  });

  it("reports an upstream reset safely and leaves the authorized session usable", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const failed = await host.request({ path: `${appPrefix}reset`, headers: appHeaders(cookie) });
    expect(failed.status).toBe(502);
    expect(failed.body).toContain("data-paseo-preview-error");
    const next = await host.request({ path: appPrefix, headers: appHeaders(cookie) });
    expect(next).toMatchObject({ status: 200, body: page });
    expect(host.requests.map(({ url }) => url)).toEqual([`${appPrefix}reset`, appPrefix]);
  });

  it("settles an incomplete bootstrap body when the gateway closes", async () => {
    const redemption = observeRedemptions();
    const host = await fixture("preserve", redemption.adapt);
    const prepared = await prepare({ host, client: host.connect() });
    const bootstrap = bootstrapRequest(prepared);
    const responses: number[] = [];
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: host.port,
      path: bootstrap.path,
      method: "POST",
      agent: false,
      headers: { Host: "control.test", ...bootstrap.headers, "Transfer-Encoding": "chunked" },
    });
    outgoing.on("error", () => {});
    outgoing.on("response", (response) => {
      responses.push(response.statusCode ?? 0);
      response.resume();
    });
    const closed = new Promise<void>((resolve) => outgoing.once("close", resolve));
    outgoing.write("ticket=partial");
    await host.bootstrapBodyStarted;
    host.gateway.close();
    await host.bootstrapHandled;
    await closed;
    expect(outgoing.writableEnded).toBe(false);
    expect(responses).not.toContain(303);
    expect(redemption.count()).toBe(0);
    expect(host.upstreamConnections()).toBe(0);
    expect(host.requests).toEqual([]);
  });

  it("rejects an unexpected upstream 101 and keeps the authorized session usable", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const failed = await host.request({
      path: `${appPrefix}rogue-upgrade`,
      headers: appHeaders(cookie),
    });
    expect(failed.status).toBe(502);
    expect(failed.body).toContain("data-paseo-preview-error");
    expect(failed.body).not.toContain(cookie);
    expect(failed.body).not.toContain("preview-upstream");
    await host.rogueUpgradeClosed;
    const next = await host.request({ path: appPrefix, headers: appHeaders(cookie) });
    expect(next).toMatchObject({ status: 200, body: page });
    expect(host.requests.map(({ url }) => url)).toEqual([`${appPrefix}rogue-upgrade`, appPrefix]);
  });

  it("cancels upstream work after the browser disconnects without closing shared authority", async () => {
    const host = await fixture();
    const { cookie } = await open({ host, client: host.connect() });
    const abandoned = await startStream(host, cookie);
    expect(abandoned.first).toBe("first\n");
    abandoned.disconnect();
    expect(await abandoned.closed).toEqual({ complete: false, body: "first\n" });
    await host.stream.closed.promise;
    const next = await host.request({ path: appPrefix, headers: appHeaders(cookie) });
    expect(next).toMatchObject({ status: 200, body: page });
    expect(host.requests.map(({ url }) => url)).toEqual([`${appPrefix}stream`, appPrefix]);
  });
});
