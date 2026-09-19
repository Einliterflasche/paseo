import { once } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolveSkillTargets } from "./orchestration-skills/internal/paths.js";
import { findFreePort } from "./service-proxy.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";

const origin = "https://control.test:9443";
const controlHost = "control.test:9443";
const password = "isolated-control-transport-password";
const page = "<!doctype html><h1>Owned legacy marker</h1>";
const workspaceId = "control-transport-workspace";
const logger = pino({ level: "silent" });
const cleanups: Array<() => Promise<void>> = [];

interface FixtureOptions {
  invalidTransport?: boolean;
  policyOrigin?: string;
  occupiedGateway?: boolean;
  separateLegacy?: boolean;
  publicBaseUrl?: string;
}

interface MarkerRequest {
  method: string;
  target: string;
  host: string;
  upgrade: boolean;
}

async function responseBody(response: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of response) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString();
}

function request(port: number, target: string, host: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      path: target,
      agent: false,
      headers: { Host: host, ...headers },
    });
    outgoing.on("error", reject);
    outgoing.on("response", (incoming) => {
      void responseBody(incoming).then(
        (body) => resolve({ status: incoming.statusCode, body }),
        reject,
      );
    });
    outgoing.end();
  });
}

function raw(port: number, target: string, hostLines: string[], upgrade = false) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const parts: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (part) => parts.push(part));
    socket.on("end", () => resolve(Buffer.concat(parts).toString()));
    socket.on("connect", () => {
      const connection = upgrade
        ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
        : "Connection: close";
      socket.write(`GET ${target} HTTP/1.1\r\n${hostLines.join("\r\n")}\r\n${connection}\r\n\r\n`);
    });
  });
}

function status(response: string): number {
  return Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
}

async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-control-transport-"));
  const cwd = path.join(home, "workspace");
  const staticDir = path.join(home, "static");
  const socketPath = path.join(home, "gateway.sock");
  await mkdir(cwd);
  await mkdir(staticDir);
  await mkdir(path.join(home, "services"));
  const frontReservation = createServer((_request, response) => response.end("reserved front"));
  frontReservation.listen(0, "127.0.0.1");
  await once(frontReservation, "listening");
  const frontAddress = frontReservation.address();
  if (!frontAddress || typeof frontAddress === "string") throw new Error("Expected fixture front");
  const frontPort = frontAddress.port;
  cleanups.push(async () => {
    frontReservation.closeAllConnections();
    await new Promise<void>((resolve) => frontReservation.close(() => resolve()));
  });
  const legacyPort = options.separateLegacy ? await findFreePort() : null;
  const policy =
    options.policyOrigin || options.occupiedGateway
      ? {
          version: 1,
          enabled: true,
          controlOrigin: options.policyOrigin ?? origin,
          managedServices: [],
        }
      : { version: 1, enabled: false };
  const policyText = `${JSON.stringify(policy)}\n`;
  await writeFile(path.join(home, "services/policy-v1.json"), policyText);
  if (options.occupiedGateway) await writeFile(socketPath, "retained occupied gateway\n");

  const timestamp = "2026-09-19T00:00:00.000Z";
  await new FileBackedProjectRegistry(path.join(home, "projects/projects.json"), logger).upsert(
    createPersistedProjectRecord({
      projectId: "control-project",
      rootPath: cwd,
      kind: "non_git",
      displayName: "Control fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await new FileBackedWorkspaceRegistry(path.join(home, "projects/workspaces.json"), logger).upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "control-project",
      cwd,
      kind: "directory",
      displayName: "Control fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await writeFile(
    path.join(cwd, "marker.mjs"),
    `import {createServer} from 'node:http';
import fs from 'node:fs';
const record=(request,upgrade)=>fs.appendFileSync('marker-requests.jsonl',JSON.stringify({method:request.method,target:request.url,host:request.headers.host,upgrade})+'\\n');
const server=createServer((request,response)=>{record(request,false);request.resume();response.setHeader('content-type','text/html');response.end(${JSON.stringify(page)});});
server.on('upgrade',(request,socket)=>{record(request,true);socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');});
server.listen(Number(process.env.PASEO_PORT),'127.0.0.1',()=>fs.writeFileSync('marker-ready.json',JSON.stringify({pid:process.pid,port:server.address().port})));
`,
  );
  await writeFile(
    path.join(cwd, "paseo.json"),
    JSON.stringify({
      scripts: {
        marker: { type: "service", command: `${process.execPath} marker.mjs` },
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    PASEO_LISTEN: "127.0.0.1:0",
    PASEO_PASSWORD: password,
    PASEO_SERVICES_FRONT_PORT: String(frontPort),
    PASEO_SERVICES_CONTROL_ORIGIN: origin,
    ...(options.invalidTransport ? {} : { PASEO_SERVICES_GATEWAY_SOCKET: socketPath }),
  };
  const config = loadConfig(home, { env });
  Object.assign(config, {
    staticDir,
    agentClients: createTestAgentClients(),
    relayEnabled: false,
    pluginsEnabled: false,
    mcpEnabled: false,
    hostnames: true,
    corsAllowedOrigins: [origin],
    isDev: true,
    speech: {
      providers: Object.fromEntries(
        ["dictationStt", "voiceTurnDetection", "voiceStt", "voiceTts"].map((id) => [
          id,
          { provider: "local", explicit: true, enabled: false },
        ]),
      ),
    },
    serviceProxy: {
      publicBaseUrl: options.publicBaseUrl ?? null,
      standaloneListen: legacyPort === null ? null : `127.0.0.1:${legacyPort}`,
    },
  } satisfies Partial<PaseoDaemonConfig>);
  let skillResolutions = 0;
  const dependencies = {
    resolveSkillTargets: () => {
      skillResolutions++;
      return resolveSkillTargets(home);
    },
  };
  const clients: DaemonClient[] = [];
  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | null = null;
  cleanups.push(async () => {
    for (const client of clients) await client.close();
    await daemon?.stop();
  });
  async function connectClient(
    port: number,
    host: string,
    browser: boolean,
    extraHeaders: Record<string, string> = {},
  ) {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: `control-${clients.length}`,
      clientType: browser ? "browser" : "cli",
      appVersion: "0.8.0",
      password,
      reconnect: { enabled: false },
      webSocketFactory: (url, socketOptions) =>
        new WebSocket(url, socketOptions?.protocols, {
          headers: {
            ...socketOptions?.headers,
            Host: host,
            ...(browser ? { Origin: origin } : {}),
            ...extraHeaders,
          },
        }),
    });
    clients.push(client);
    await client.connect();
    await client.ping();
    return client;
  }
  async function start() {
    daemon = await createPaseoDaemon(config, logger, dependencies);
    await daemon.start();
    const target = daemon.getListenTarget();
    if (target.type !== "tcp") throw new Error("Expected fixture TCP daemon");
    const client = await connectClient(target.port, `127.0.0.1:${target.port}`, false);
    const started = await client.startWorkspaceScriptWithStatus(workspaceId, "marker");
    expect(started.error).toBeNull();
    await expect
      .poll(async () => readFile(path.join(cwd, "marker-ready.json"), "utf8").catch(() => ""))
      .not.toBe("");
    const ready = JSON.parse(await readFile(path.join(cwd, "marker-ready.json"), "utf8")) as {
      pid: number;
      port: number;
    };
    const scripts = await client.listWorkspaceScripts(workspaceId);
    const script = scripts.scripts.find((entry) => entry.scriptName === "marker");
    if (!script?.hostname || script.lifecycle !== "running")
      throw new Error("Managed marker missing");
    expect(script.port).toBe(ready.port);
    expect((await request(ready.port, "/positive-marker", "direct-marker.test")).body).toBe(page);
    return { daemon, client, port: target.port, script, ready };
  }
  async function requests(): Promise<MarkerRequest[]> {
    return (await readFile(path.join(cwd, "marker-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MarkerRequest);
  }
  return {
    home,
    config,
    dependencies,
    socketPath,
    policyText,
    frontPort,
    legacyPort,
    start,
    connectClient,
    requests,
    skillResolutions: () => skillResolutions,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("control-only daemon transport", () => {
  it("admits exact control and required CLI authorities while rejecting legacy and ambiguous requests before app contact", async () => {
    const f = await fixture();
    const host = await f.start();
    const baseline = await f.requests();
    expect(baseline).toHaveLength(1);
    expect(host.script.localProxyUrl).toBeNull();
    expect(host.script.proxyUrl).toBeNull();
    const positiveHosts = [
      controlHost,
      "CoNtRoL.TeSt:9443",
      `127.0.0.1:${host.port}`,
      `localhost:${host.port}`,
      `127.0.0.1:${f.frontPort}`,
      `localhost:${f.frontPort}`,
    ];
    for (const authority of positiveHosts) {
      expect(
        (
          await request(host.port, "/api/status", authority, {
            Authorization: `Bearer ${password}`,
          })
        ).status,
      ).toBe(200);
    }
    const browser = await f.connectClient(host.port, controlHost, true);
    expect(browser.getLastServerInfoMessage()?.servicePreviews).toBeUndefined();
    const spoofed = {
      "X-Forwarded-Host": host.script.hostname,
      Forwarded: `host=${host.script.hostname}`,
    };
    expect(
      (
        await request(host.port, "/api/status", controlHost, {
          Authorization: `Bearer ${password}`,
          ...spoofed,
        })
      ).status,
    ).toBe(200);
    await f.connectClient(host.port, controlHost, true, spoofed);
    const deniedHosts = [
      host.script.hostname,
      `${host.script.hostname}:9443`,
      "control.test",
      "control.test:443",
      "control.test:9444",
      "foreign.test:9443",
      "localhost",
      "127.0.0.1",
      `127.0.0.1:${host.ready.port}`,
      `[::1]:${host.port}`,
    ];
    for (const authority of deniedHosts) {
      for (const upgrading of [false, true]) {
        const response = await raw(
          host.port,
          "/marker",
          [
            `Host: ${authority}`,
            `X-Forwarded-Host: ${controlHost}`,
            `Forwarded: host=${controlHost}`,
          ],
          upgrading,
        );
        expect([400, 403]).toContain(status(response));
      }
    }
    for (const target of [
      `http://${controlHost}/marker`,
      `//${controlHost}/marker`,
      "/bad\\path",
      "/marker#fragment",
      "/%5f%5fpaseo_services/apps/marker/",
    ]) {
      for (const upgrading of [false, true]) {
        expect([400, 403]).toContain(
          status(await raw(host.port, target, [`Host: ${controlHost}`], upgrading)),
        );
      }
    }
    for (const upgrading of [false, true]) {
      expect([400, 403]).toContain(
        status(
          await raw(
            host.port,
            "/marker",
            [`Host: ${controlHost}`, `Host: ${host.script.hostname}`],
            upgrading,
          ),
        ),
      );
      expect(
        status(
          await raw(
            host.port,
            "/__paseo_services/apps/marker/",
            [`Host: ${controlHost}`],
            upgrading,
          ),
        ),
      ).toBe(503);
    }
    await host.client.ping();
    expect(await f.requests()).toEqual(baseline);
    await expect(stat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "invalid transport", options: { invalidTransport: true } },
    { name: "different policy origin", options: { policyOrigin: "https://elsewhere.test" } },
    { name: "unavailable gateway", options: { occupiedGateway: true } },
  ])("retains CLI recovery and prevents legacy selection with $name", async ({ options }) => {
    const f = await fixture(options);
    const host = await f.start();
    const baseline = await f.requests();
    expect(baseline).toHaveLength(1);
    for (const upgrading of [false, true]) {
      expect([400, 403]).toContain(
        status(
          await raw(
            host.port,
            "/marker",
            [`Host: ${host.script.hostname}`, `X-Forwarded-Host: ${controlHost}`],
            upgrading,
          ),
        ),
      );
      expect(
        status(
          await raw(
            host.port,
            "/__paseo_services/apps/marker/",
            [`Host: 127.0.0.1:${host.port}`],
            upgrading,
          ),
        ),
      ).toBe(503);
    }
    expect(
      (
        await request(host.port, "/api/status", `localhost:${host.port}`, {
          Authorization: `Bearer ${password}`,
        })
      ).status,
    ).toBe(200);
    await host.client.ping();
    expect(await f.requests()).toEqual(baseline);
    expect(await readFile(path.join(f.home, "services/policy-v1.json"), "utf8")).toBe(f.policyText);
  });

  it("keeps intentional separate legacy HTTP and upgrades usable and projects that listener's port", async () => {
    const f = await fixture({ separateLegacy: true, publicBaseUrl: "https://public.test:7443" });
    const host = await f.start();
    if (f.legacyPort === null) throw new Error("Missing separate fixture listener");
    expect(host.script.localProxyUrl).toBe(`http://${host.script.hostname}:${f.legacyPort}`);
    if (!host.script.publicProxyUrl) throw new Error("Missing intentional public projection");
    const publicHost = new URL(host.script.publicProxyUrl).host;
    expect((await request(f.legacyPort, "/public-marker", publicHost)).body).toBe(page);
    expect(status(await raw(f.legacyPort, "/public-upgrade", [`Host: ${publicHost}`], true))).toBe(
      101,
    );
    const beforeDenials = await f.requests();
    expect(beforeDenials).toHaveLength(3);
    for (const upgrading of [false, true]) {
      expect([400, 403]).toContain(
        status(await raw(host.port, "/marker", [`Host: ${publicHost}`], upgrading)),
      );
    }
    expect(await f.requests()).toEqual(beforeDenials);
    await host.client.ping();
  });

  it("refuses public aliases without a separate listener before initialization", async () => {
    const f = await fixture({ publicBaseUrl: "https://public.test" });
    await expect(createPaseoDaemon(f.config, logger, f.dependencies)).rejects.toThrow();
    expect(f.skillResolutions()).toBe(0);
    await expect(stat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
