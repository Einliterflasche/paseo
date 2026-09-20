import http, { type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPreviewHttpPolicy,
  PreviewHttpPolicyError,
  type PreviewHttpRoute,
} from "./http-policy.js";

const controlOrigin = "https://control.test:9443";
const serviceId = "8b39ba96-411c-4c9d-b3a5-487c64b8a3cd";
const prefix = `/__paseo_services/apps/${serviceId}/`;
const servers: http.Server[] = [];

interface ObservedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

interface RequestOptions {
  port: number;
  target: string;
  method?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function sendRequest({ port, target, method = "POST", headers, body }: RequestOptions) {
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path: target, method, headers, agent: false },
      resolve,
    );
    request.on("error", reject);
    request.end(body);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return {
    status: response.statusCode,
    headers: response.headers,
    body: Buffer.concat(chunks).toString(),
  };
}

interface FixtureOptions {
  mount: PreviewHttpRoute["mount"];
  responseHeaders?: http.OutgoingHttpHeaders;
}

async function startFixture({ mount, responseHeaders = {} }: FixtureOptions) {
  let upstreamConnections = 0;
  const observed: ObservedRequest[] = [];
  const denials: string[] = [];
  const app = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(200, responseHeaders);
    response.end("application response");
  });
  app.on("connection", () => {
    upstreamConnections++;
  });
  const port = await listen(app);
  const route: PreviewHttpRoute = { serviceId, port, mount };
  const policy = createPreviewHttpPolicy({
    controlOrigin,
    controlCookieNames: ["PaseoControlFixture"],
  });
  const gatewayPort = await listen(
    http.createServer((request, response) => {
      try {
        const plan = policy.request({ request, route });
        const upstream = http.request(plan, (reply) => {
          try {
            response.writeHead(
              reply.statusCode ?? 502,
              policy.response({ response: reply, route }),
            );
            reply.pipe(response);
          } catch (error) {
            reply.destroy();
            if (!(error instanceof PreviewHttpPolicyError)) {
              response.destroy(
                error instanceof Error ? error : new Error("Unexpected fixture error"),
              );
              return;
            }
            response.writeHead(502);
            response.end("Incompatible application response");
          }
        });
        upstream.on("error", (error) => response.destroy(error));
        request.pipe(upstream);
      } catch (error) {
        if (!(error instanceof PreviewHttpPolicyError)) throw error;
        denials.push(error.code);
        response.writeHead(400);
        response.end("Preview request rejected");
        request.resume();
      }
    }),
  );
  return { gatewayPort, observed, denials, upstreamConnections: () => upstreamConnections };
}

describe("preview HTTP boundary", () => {
  it.each(["GET", "DELETE"])(
    "preserves a chunked %s body as exactly one upstream request",
    async (method) => {
      const fixture = await startFixture({ mount: "preserve" });
      const body = "first chunk\r\nGET /must-remain-body HTTP/1.1\r\n\r\nlast chunk";
      const result = await sendRequest({
        port: fixture.gatewayPort,
        target: prefix,
        method,
        headers: { host: "control.test:9443", "transfer-encoding": "chunked" },
        body,
      });
      expect(result).toMatchObject({ status: 200, body: "application response" });
      expect(fixture.observed).toHaveLength(1);
      expect(fixture.observed[0]).toMatchObject({
        method,
        url: prefix,
        body,
        headers: { "transfer-encoding": "chunked" },
      });
      expect(fixture.upstreamConnections()).toBe(1);
    },
  );

  it.each(["GET", "DELETE"])(
    "reframes a %s body when Connection nominates Content-Length",
    async (method) => {
      const fixture = await startFixture({ mount: "preserve" });
      const body = "body whose framing must survive filtering";
      const result = await sendRequest({
        port: fixture.gatewayPort,
        target: prefix,
        method,
        headers: {
          host: "control.test:9443",
          "content-length": String(Buffer.byteLength(body)),
          connection: "close, Content-Length",
        },
        body,
      });
      expect(result).toMatchObject({ status: 200, body: "application response" });
      expect(fixture.observed).toHaveLength(1);
      expect(fixture.observed[0]).toMatchObject({
        method,
        url: prefix,
        body,
        headers: { "transfer-encoding": "chunked" },
      });
      expect(fixture.observed[0].headers["content-length"]).toBeUndefined();
      expect(fixture.upstreamConnections()).toBe(1);
    },
  );

  it("preserves the public mount, query, method and body while connecting only to the registered port", async () => {
    const fixture = await startFixture({ mount: "preserve" });
    const target = `${prefix}api/a%2Fb?return=https%3A%2F%2Felsewhere.test%2F&x=1&x=2`;
    const result = await sendRequest({
      port: fixture.gatewayPort,
      target,
      headers: { host: "control.test:9443", "content-type": "application/json" },
      body: '{"changed":true}',
    });
    expect(result).toMatchObject({ status: 200, body: "application response" });
    expect(fixture.observed).toHaveLength(1);
    expect(fixture.observed[0]).toMatchObject({
      method: "POST",
      url: target,
      body: '{"changed":true}',
      headers: { host: "control.test:9443", "content-type": "application/json" },
    });
  });

  it("removes control credentials, nominated connection fields and spoofed forwarding headers before app contact", async () => {
    const fixture = await startFixture({ mount: "preserve" });
    const result = await sendRequest({
      port: fixture.gatewayPort,
      target: prefix,
      headers: {
        host: "control.test:9443",
        authorization: "Bearer fixture-control-secret",
        "proxy-authorization": "fixture-proxy-secret",
        "sec-websocket-protocol": "paseo.bearer.fixture-secret",
        cookie:
          "app_session=ordinary; __Secure-PaseoPreview-current=fixture-preview-secret; PaseoControlFixture=fixture-control-cookie; app_theme=dark",
        connection: "close, X-Private-Transport",
        "x-private-transport": "transport-only",
        forwarded: "host=foreign.test;proto=http",
        "x-forwarded-host": "foreign.test",
        "x-forwarded-port": "1234",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "198.51.100.4",
        "x-real-ip": "198.51.100.5",
        "x-original-url": "/api/control",
        "x-rewrite-url": "/api/control",
      },
      body: "one mutation",
    });
    expect(result.status).toBe(200);
    expect(fixture.observed).toHaveLength(1);
    const headers = fixture.observed[0].headers;
    expect(headers).toMatchObject({
      host: "control.test:9443",
      "x-forwarded-host": "control.test:9443",
      "x-forwarded-port": "9443",
      "x-forwarded-proto": "https",
      cookie: "app_session=ordinary; app_theme=dark",
    });
    for (const name of [
      "authorization",
      "proxy-authorization",
      "sec-websocket-protocol",
      "x-private-transport",
      "forwarded",
      "x-forwarded-for",
      "x-real-ip",
      "x-original-url",
      "x-rewrite-url",
    ])
      expect(headers[name]).toBeUndefined();
    expect(fixture.observed[0].body).toBe("one mutation");
  });
});

async function sendRaw(port: number, request: string): Promise<string> {
  const socket = net.connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(socket, "end");
  await once(socket, "connect");
  socket.end(request);
  await ended;
  return Buffer.concat(chunks).toString();
}

it("filters response cookies and origin-wide headers while preserving app restrictions", async () => {
  const fixture = await startFixture({
    mount: "preserve",
    responseHeaders: {
      "clear-site-data": '"*"',
      "service-worker-allowed": "/",
      "strict-transport-security": "max-age=0",
      "alt-svc": 'h3=":9999"',
      nel: '{"report_to":"app-telemetry","max_age":3600}',
      "report-to":
        '{"group":"app-telemetry","max_age":3600,"endpoints":[{"url":"https://collector.test/reports"}]}',
      connection: "close, X-App-Hop",
      "x-app-hop": "transport only",
      "content-security-policy": "default-src 'none'; img-src 'self'",
      "x-frame-options": "SAMEORIGIN",
      "cache-control": "public, max-age=3600",
      "set-cookie": [
        `app_session=value; Path=${prefix}; Secure; HttpOnly; Domain=control.test`,
        "app_default=value; Secure",
        "__Secure-PaseoPreview-current=wrong; Path=/__paseo_services/; Secure",
        "PaseoControlFixture=wrong; Path=/; Secure",
        "app_root=wrong; Path=/; Secure",
        `app_ambiguous=wrong; Path=${prefix}; Path=/; Secure`,
        `app_expiry=value; Path=${prefix}; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure`,
      ],
    },
  });
  const result = await sendRequest({
    port: fixture.gatewayPort,
    target: prefix,
    headers: { host: "control.test:9443" },
    body: "",
  });
  expect(result).toMatchObject({ status: 200, body: "application response" });
  expect(result.headers).toMatchObject({
    "x-frame-options": "SAMEORIGIN",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; img-src 'self', worker-src 'self'",
  });
  for (const name of [
    "clear-site-data",
    "service-worker-allowed",
    "strict-transport-security",
    "alt-svc",
    "nel",
    "report-to",
    "x-app-hop",
  ])
    expect(result.headers[name]).toBeUndefined();
  expect(result.headers["set-cookie"]).toEqual([
    `app_session=value; Path=${prefix}; Secure; HttpOnly`,
    "app_default=value; Secure",
    `app_expiry=value; Path=${prefix}; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure`,
  ]);
});

it("rewrites response cookie paths into the mount under strip while leaving already-mounted and default paths alone", async () => {
  const fixture = await startFixture({
    mount: "strip",
    responseHeaders: {
      "set-cookie": [
        "app_root=value; Path=/; Secure",
        "app_nested=value; Path=/foo/bar; Secure",
        `app_already_mounted=value; Path=${prefix}sub; Secure`,
        "app_default=value; Secure",
        "app_malformed=value; Path; Secure",
        "PaseoControlFixture=wrong; Path=/; Secure",
      ],
    },
  });
  const result = await sendRequest({
    port: fixture.gatewayPort,
    target: prefix,
    headers: { host: "control.test:9443" },
    body: "",
  });
  expect(result.status).toBe(200);
  expect(result.headers["set-cookie"]).toEqual([
    `app_root=value; Path=${prefix}; Secure`,
    `app_nested=value; Path=${prefix}foo/bar; Secure`,
    `app_already_mounted=value; Path=${prefix}sub; Secure`,
    "app_default=value; Secure",
    "app_malformed=value; Secure",
  ]);
});

it("strips exactly the declared prefix while preserving the suffix and raw query", async () => {
  const fixture = await startFixture({ mount: "strip" });
  const result = await sendRequest({
    port: fixture.gatewayPort,
    target: `${prefix}api/a%2Fb?x=%2F&x=2`,
    headers: { host: "control.test:9443" },
    body: "unchanged",
  });
  expect(result.status).toBe(200);
  expect(fixture.observed).toHaveLength(1);
  expect(fixture.observed[0]).toMatchObject({
    method: "POST",
    url: "/api/a%2Fb?x=%2F&x=2",
    body: "unchanged",
  });
});

it.each([
  "/api/control",
  "/__paseo_services/bootstrap",
  "/__paseo_services/apps/other/",
  prefix.slice(0, -1),
  `${prefix}../../api/control`,
  `${prefix}%2e%2e/other/`,
  `${prefix}api#fragment`,
  `https://elsewhere.test${prefix}`,
  `//elsewhere.test${prefix}`,
])(
  "rejects out-of-route or noncanonical target %s before opening an upstream connection",
  async (target) => {
    const fixture = await startFixture({ mount: "preserve" });
    const result = await sendRequest({
      port: fixture.gatewayPort,
      target,
      headers: { host: "control.test:9443" },
      body: "must not arrive",
    });
    expect(result.status).toBe(400);
    expect(fixture.denials).toEqual(["invalid-target"]);
    expect(fixture.upstreamConnections()).toBe(0);
    expect(fixture.observed).toEqual([]);
  },
);

it.each([
  "Host: foreign.test\r\n",
  "Host: control.test:9443\r\nHost: foreign.test\r\n",
  "Host: control.test:9443\r\nHost: control.test:9443\r\n",
  "",
])("rejects missing, foreign or duplicate Host fields: %s", async (hostFields) => {
  const fixture = await startFixture({ mount: "preserve" });
  const result = await sendRaw(
    fixture.gatewayPort,
    `GET ${prefix} HTTP/1.1\r\n${hostFields}Connection: close\r\n\r\n`,
  );
  expect(result.startsWith("HTTP/1.1 400 ")).toBe(true);
  expect(fixture.upstreamConnections()).toBe(0);
  expect(fixture.observed).toEqual([]);
});

it("refuses transfer codings the HTTP stream has not decoded", async () => {
  const fixture = await startFixture({ mount: "preserve" });
  const result = await sendRequest({
    port: fixture.gatewayPort,
    target: prefix,
    headers: { host: "control.test:9443", "transfer-encoding": "gzip, chunked" },
    body: "not decoded gzip",
  });
  expect(result.status).toBe(400);
  expect(fixture.denials).toEqual(["unsupported-transfer-coding"]);
  expect(fixture.upstreamConnections()).toBe(0);
});
