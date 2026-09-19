import { once } from "node:events";
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import {
  createPaseoDaemon,
  type PaseoDaemonConfig,
  type PaseoDaemonDependencies,
} from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolveSkillTargets } from "./orchestration-skills/internal/paths.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";
import { findFreePort } from "./service-proxy.js";
import { managedPreviewServiceId } from "./service-preview/policy.js";
import { PreviewBroker } from "./service-preview/broker.js";
import { PreviewRoutes } from "./service-preview/routes.js";
import { PreviewSources } from "./service-preview/sources.js";
import { ExternalPreviewServices } from "./service-preview/external.js";
import { PreviewRegistrationStore } from "./service-preview/registrations.js";
import { AgentStorage } from "./agent/agent-storage.js";

const origin = "https://control.test";
const password = "isolated-configured-preview-password";
const logger = pino({ level: "silent" });
const cleanups: Array<() => Promise<void>> = [];
const fixtureText = "ordinary file route remains available\n";
const fixturePdf = "%PDF-1.4\nisolated ordinary file preview\n";
const enrollment = {
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "Configured HTML",
  mount: "preserve" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function ignoreRejection() {}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected isolated TCP server");
  return address.port;
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-preview-bootstrap-"));
  const cwd = path.join(home, "workspace");
  const staticDir = path.join(home, "static");
  await mkdir(cwd);
  await mkdir(staticDir);
  await mkdir(path.join(home, "services"));
  await writeFile(path.join(cwd, "hello.txt"), fixtureText);
  await writeFile(path.join(cwd, "document.pdf"), fixturePdf);
  await writeFile(path.join(staticDir, "hello.txt"), fixtureText);
  const policyFile = path.join(home, "services", "policy-v1.json");
  const socketPath = path.join(home, "gateway.sock");
  const front = createServer((_request, response) => response.end("reserved fixture front"));
  const frontPort = await listen(front);
  cleanups.push(() => stopServer(front));
  const projects = new FileBackedProjectRegistry(
    path.join(home, "projects", "projects.json"),
    logger,
  );
  const workspaces = new FileBackedWorkspaceRegistry(
    path.join(home, "projects", "workspaces.json"),
    logger,
  );
  const timestamp = "2026-09-19T00:00:00.000Z";
  await projects.upsert(
    createPersistedProjectRecord({
      projectId: "project-a",
      rootPath: cwd,
      kind: "non_git",
      displayName: "Fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await workspaces.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: enrollment.workspaceId,
      projectId: "project-a",
      cwd,
      kind: "directory",
      displayName: "Fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const clients: DaemonClient[] = [];
  const configOverrides: Partial<PaseoDaemonConfig> = {};
  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | null = null;
  let stopping: Promise<void> | null = null;
  async function stop() {
    stopping ??= daemon?.stop() ?? Promise.resolve();
    await stopping;
  }
  cleanups.push(async () => {
    for (const client of clients) await client.close();
    await stop();
  });
  const transportEnv = {
    PASEO_SERVICES_FRONT_PORT: String(frontPort),
    PASEO_SERVICES_GATEWAY_SOCKET: socketPath,
    PASEO_SERVICES_CONTROL_ORIGIN: origin,
  };
  const configuration = (env: NodeJS.ProcessEnv) => {
    const config = loadConfig(home, {
      env: { PASEO_LISTEN: "127.0.0.1:0", PASEO_PASSWORD: password, ...env },
    });
    config.staticDir = staticDir;
    config.agentClients = createTestAgentClients();
    config.relayEnabled = false;
    config.pluginsEnabled = false;
    config.mcpEnabled = false;
    config.hostnames = true;
    config.corsAllowedOrigins = [origin];
    config.isDev = true;
    config.speech = {
      providers: {
        dictationStt: { provider: "local", explicit: true, enabled: false },
        voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
        voiceStt: { provider: "local", explicit: true, enabled: false },
        voiceTts: { provider: "local", explicit: true, enabled: false },
      },
    };
    return Object.assign(config, configOverrides);
  };
  const dependencies: PaseoDaemonDependencies = {
    resolveSkillTargets: () => resolveSkillTargets(home),
  };
  async function start(
    env: NodeJS.ProcessEnv = {},
    injected: PaseoDaemonDependencies = {},
    runtimeLogger = logger,
  ) {
    daemon = await createPaseoDaemon(configuration(env), runtimeLogger, {
      ...dependencies,
      ...injected,
    });
    await daemon.start();
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Expected isolated daemon TCP address");
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${target.port}/ws`,
      clientId: `preview-bootstrap-${path.basename(home)}`,
      clientType: "browser",
      appVersion: "0.8.0",
      password,
      reconnect: { enabled: false },
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, {
          headers: { ...options?.headers, Origin: origin },
        }) as unknown as WebSocketLike,
    });
    clients.push(client);
    await client.connect();
    return { daemon, client, port: target.port };
  }
  async function writePolicy(value: unknown) {
    const content = `${JSON.stringify(value)}\n`;
    await writeFile(policyFile, content);
    return content;
  }
  return {
    home,
    cwd,
    frontPort,
    socketPath,
    policyFile,
    transportEnv,
    configuration,
    configOverrides,
    dependencies,
    workspaces,
    start,
    stop,
    writePolicy,
  };
}

async function htmlService() {
  const page = "<!doctype html><h1>Actual configured preview page</h1>";
  const streamClosed = deferred<void>();
  const server = createServer((request, response) => {
    request.resume();
    if (request.url?.endsWith("/stream")) {
      response.once("close", () => streamClosed.resolve());
      response.write("held configured stream\n");
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(page);
    }
  });
  const port = await listen(server);
  cleanups.push(() => stopServer(server));
  return { port, page, streamClosed: streamClosed.promise };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function gatewayRequest({
  socketPath,
  target,
  method = "GET",
  headers = {},
  body,
}: {
  socketPath: string;
  target: string;
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string;
}) {
  return new Promise<{
    status: number | undefined;
    headers: IncomingMessage["headers"];
    body: string;
  }>((resolve, reject) => {
    const outgoing = httpRequest({
      socketPath,
      path: target,
      method,
      headers: { Host: "control.test", ...headers },
      agent: false,
    });
    outgoing.on("error", reject);
    outgoing.once("response", (incoming) => {
      void readBody(incoming).then(
        (text) => resolve({ status: incoming.statusCode, headers: incoming.headers, body: text }),
        reject,
      );
    });
    outgoing.end(body);
  });
}

const navigation = {
  Origin: origin,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const appHeaders = (cookie: string) => ({
  Cookie: cookie,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
});

async function openPage({
  client,
  socketPath,
  serviceId,
  attemptId,
}: {
  client: DaemonClient;
  socketPath: string;
  serviceId: string;
  attemptId: string;
}) {
  const reply = await client.prepareServicePreview({
    serviceId,
    attemptId,
    browserHandle: "configured-browser-profile",
    mode: "iframe",
  });
  if (reply.result.status !== "prepared") throw new Error(`Prepare refused: ${reply.result.code}`);
  const prepared = reply.result;
  const bootstrap = await gatewayRequest({
    socketPath,
    target: `/__paseo_services/bootstrap/${prepared.bootstrapId}`,
    method: "POST",
    headers: { ...navigation, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: prepared.ticket }).toString(),
  });
  expect(bootstrap.status).toBe(303);
  const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing preview browser credential");
  const confirmation = await gatewayRequest({
    socketPath,
    target: `/__paseo_services/confirm/${prepared.bootstrapId}`,
    headers: { ...navigation, Cookie: cookie },
  });
  expect(confirmation.status).toBe(200);
  return cookie;
}

async function openStream({
  socketPath,
  serviceId,
  cookie,
}: {
  socketPath: string;
  serviceId: string;
  cookie: string;
}) {
  const first = deferred<void>();
  const closed = deferred<{ body: string; complete: boolean }>();
  const outgoing = httpRequest({
    socketPath,
    path: `/__paseo_services/apps/${serviceId}/stream`,
    headers: { Host: "control.test", ...appHeaders(cookie) },
    agent: false,
  });
  outgoing.on("error", first.reject);
  outgoing.once("response", (incoming) => {
    let body = "";
    incoming.on("error", ignoreRejection);
    incoming.on("data", (chunk) => {
      body += chunk.toString();
      first.resolve();
    });
    incoming.once("close", () => closed.resolve({ body, complete: incoming.complete }));
  });
  outgoing.end();
  await first.promise;
  return { closed: closed.promise };
}

async function ordinaryRoutes(
  host: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>,
  cwd: string,
) {
  const config = await host.client.getDaemonConfig("ordinary-config");
  expect(config.requestId).toBe("ordinary-config");
  expect(config.config.relay?.enabled).toBe(false);
  const staticResponse = await fetch(`http://127.0.0.1:${host.port}/public/hello.txt`, {
    headers: { Authorization: `Bearer ${password}` },
  });
  expect(staticResponse.status).toBe(200);
  expect(await staticResponse.text()).toBe(fixtureText);
  const download = await host.client.requestDownloadToken(cwd, "hello.txt", "ordinary-download");
  expect(download.error).toBeNull();
  if (!download.token) throw new Error("Expected ordinary file download grant");
  const downloaded = await fetch(
    `http://127.0.0.1:${host.port}/api/files/download?token=${encodeURIComponent(download.token)}`,
  );
  expect(downloaded.status).toBe(200);
  expect(await downloaded.text()).toBe(fixtureText);
  const access = await host.client.getFileAccess({
    cwd,
    path: "document.pdf",
    preview: true,
    requestId: "ordinary-file",
  });
  expect(access.error).toBeNull();
  if (!access.previewToken) throw new Error("Expected ordinary file preview grant");
  const response = await fetch(
    `http://127.0.0.1:${host.port}/api/files/preview?token=${encodeURIComponent(access.previewToken)}`,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(fixturePdf);
}

async function expectPending(work: Promise<unknown>) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sentinel = Symbol("pending daemon shutdown");
  expect(await Promise.race([work, Promise.resolve(sentinel)])).toBe(sentinel);
}

async function observeGatewayStart<T>(start: () => Promise<T>) {
  const children: ChildProcess[] = [];
  const published = channel("child_process");
  const observe = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "process" in message &&
      message.process instanceof ChildProcess
    ) {
      children.push(message.process);
    }
  };
  published.subscribe(observe);
  let value: T;
  try {
    value = await start();
  } finally {
    published.unsubscribe(observe);
  }
  const worker = children.find((child) =>
    child.spawnargs.some((argument) => argument.endsWith("/service-preview/worker-process.ts")),
  );
  if (!worker?.pid) throw new Error("Missing configured fixture gateway process");
  return { value, worker, pid: worker.pid };
}

function connectionRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === "ECONNREFUSED");
    });
  });
}

async function persistedAgentStatus(
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>,
  agentId: string,
) {
  // A new storage reader proves bytes reached disk, independent of the daemon's cache.
  return (await new AgentStorage(daemon.config.agentStoragePath, logger).get(agentId))?.lastStatus;
}

function previewService(client: DaemonClient, serviceId: string) {
  return client
    .getLastServerInfoMessage()
    ?.servicePreviews?.services.find((entry) => entry.serviceId === serviceId);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("configured preview daemon startup", () => {
  it.skipIf(process.platform !== "linux")(
    "flushes agents and closes ordinary transport while configured preview shutdown waits for its stopped worker",
    async () => {
      const f = await fixture();
      let agentClosed = false;
      f.configOverrides.agentClients = createTestAgentClients({
        async closeSession() {
          agentClosed = true;
        },
      });
      await f.writePolicy({
        version: 1,
        enabled: true,
        controlOrigin: origin,
        managedServices: [],
      });
      const { value: host, worker, pid } = await observeGatewayStart(() => f.start(f.transportEnv));
      const exited = once(worker, "exit");
      const agent = await host.daemon.agentManager.createAgent(
        { provider: "codex", cwd: f.cwd },
        undefined,
        { workspaceId: enrollment.workspaceId },
      );
      await host.daemon.agentStorage.flush();
      expect(await persistedAgentStatus(host.daemon, agent.id)).toBe("idle");
      agentClosed = false;
      let stopping: Promise<void> | undefined;
      try {
        expect(worker.kill("SIGSTOP")).toBe(true);
        await expect
          .poll(async () => (await readFile(`/proc/${pid}/status`, "utf8")).includes("State:\tT"))
          .toBe(true);
        stopping = f.stop();
        void stopping.catch(ignoreRejection);
        await expect.poll(() => agentClosed).toBe(true);
        await expect.poll(() => persistedAgentStatus(host.daemon, agent.id)).toBe("closed");
        await expect.poll(() => connectionRefused(host.port)).toBe(true);
        await expectPending(stopping);
        expect((await readFile(`/proc/${pid}/status`, "utf8")).includes("State:\tT")).toBe(true);
      } finally {
        // Only this captured fixture-owned child is stopped, and every path resumes it.
        worker.kill("SIGCONT");
        await stopping;
      }
      await exited;
      expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
    },
  );

  it("leaves default startup and ordinary RPC/file routes unchanged even with an unused malformed policy", async () => {
    const f = await fixture();
    await writeFile(f.policyFile, "not-json\n");
    const host = await f.start();
    await ordinaryRoutes(host, f.cwd);
    expect(host.client.getLastServerInfoMessage()?.servicePreviews).toBeUndefined();
    expect(await readFile(f.policyFile, "utf8")).toBe("not-json\n");
    await expect(stat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const reserved = await fetch(`http://127.0.0.1:${host.port}/__paseo_services/apps/unknown/`, {
      headers: { Authorization: `Bearer ${password}` },
    });
    expect(reserved.status).toBe(404);
  });

  it.each([
    { name: "disabled policy", policy: { version: 1, enabled: false }, invalidEnv: false },
    { name: "unknown policy version", policy: { version: 2, enabled: true }, invalidEnv: false },
    {
      name: "incomplete transport settings",
      policy: { version: 1, enabled: true, controlOrigin: origin, managedServices: [] },
      invalidEnv: true,
    },
  ])(
    "keeps ordinary RPC/file routes available for $name and retains saved state",
    async ({ policy, invalidEnv }) => {
      const f = await fixture();
      const saved = await f.writePolicy(policy);
      const env = invalidEnv ? { PASEO_SERVICES_FRONT_PORT: String(f.frontPort) } : f.transportEnv;
      const host = await f.start(env);
      await ordinaryRoutes(host, f.cwd);
      expect(host.client.getLastServerInfoMessage()?.servicePreviews).toBeUndefined();
      expect(await readFile(f.policyFile, "utf8")).toBe(saved);
      await expect(stat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      const reserved = await fetch(`http://127.0.0.1:${host.port}/__paseo_services/apps/unknown/`);
      expect(reserved.status).toBe(503);
      expect(await reserved.text()).toBe("");
    },
  );

  it("retains an occupied worker path and serves ordinary routes after feature startup fails", async () => {
    const f = await fixture();
    const saved = await f.writePolicy({
      version: 1,
      enabled: true,
      controlOrigin: origin,
      managedServices: [],
    });
    await writeFile(f.socketPath, "existing file remains owned by its creator\n");
    const host = await f.start(f.transportEnv);
    await ordinaryRoutes(host, f.cwd);
    expect(host.client.getLastServerInfoMessage()?.servicePreviews).toBeUndefined();
    expect(await readFile(f.socketPath, "utf8")).toBe(
      "existing file remains owned by its creator\n",
    );
    expect(await readFile(f.policyFile, "utf8")).toBe(saved);
  });

  it("opens configured managed and external HTML services and drains the gateway during daemon stop", async () => {
    const f = await fixture();
    const managedApp = await htmlService();
    const externalApp = await htmlService();
    const legacyPort = await findFreePort();
    f.configOverrides.serviceProxy = {
      publicBaseUrl: null,
      standaloneListen: `127.0.0.1:${legacyPort}`,
    };
    const saved = await f.writePolicy({
      version: 1,
      enabled: true,
      controlOrigin: origin,
      managedServices: [enrollment],
    });
    const host = await f.start(f.transportEnv);
    await ordinaryRoutes(host, f.cwd);
    const managedId = managedPreviewServiceId(enrollment);
    expect(host.client.getLastServerInfoMessage()?.servicePreviews).toEqual({
      version: 1,
      origin,
      externalRegistration: 1,
      managedRegistration: 1,
      managedEnrollments: [{ ...enrollment, serviceId: managedId, enabled: true }],
      services: [],
    });
    host.daemon.serviceProxy.registerWorkspaceService({
      workspaceId: enrollment.workspaceId,
      projectSlug: "configured-fixture",
      branchName: "main",
      scriptName: enrollment.scriptName,
      port: managedApp.port,
    });
    host.daemon.scriptRuntimeStore.set({
      workspaceId: enrollment.workspaceId,
      scriptName: enrollment.scriptName,
      type: "service",
      lifecycle: "running",
      terminalId: "fixture-owned-runtime",
      exitCode: null,
    });
    await expect
      .poll(() => host.client.getLastServerInfoMessage()?.servicePreviews?.services)
      .toEqual([
        {
          serviceId: managedId,
          name: enrollment.name,
          workspaceId: enrollment.workspaceId,
          scriptName: enrollment.scriptName,
          port: managedApp.port,
          available: true,
          revision: expect.any(String),
        },
      ]);
    for (const port of [f.frontPort, host.port, legacyPort]) {
      expect(
        (
          await host.client.registerExternalService({
            name: "Infrastructure",
            port,
            workspaceId: null,
            mount: "preserve",
          })
        ).result,
      ).toEqual({ status: "error", code: "infrastructure-port" });
    }
    const registered = await host.client.registerExternalService({
      name: "External HTML",
      port: externalApp.port,
      workspaceId: enrollment.workspaceId,
      mount: "preserve",
    });
    if (registered.result.status !== "ok")
      throw new Error(`Registration refused: ${registered.result.code}`);
    const externalId = registered.result.serviceId;
    await expect.poll(() => previewService(host.client, externalId)?.available).toBe(false);
    expect((await host.client.connectExternalService({ serviceId: externalId })).result).toEqual({
      status: "ok",
      serviceId: externalId,
    });
    const managedCookie = await openPage({
      client: host.client,
      socketPath: f.socketPath,
      serviceId: managedId,
      attemptId: "managed-open",
    });
    const externalCookie = await openPage({
      client: host.client,
      socketPath: f.socketPath,
      serviceId: externalId,
      attemptId: "external-open",
    });
    for (const serviceId of [managedId, externalId]) {
      const page = await gatewayRequest({
        socketPath: f.socketPath,
        target: `/__paseo_services/apps/${serviceId}/`,
        headers: appHeaders(externalCookie),
      });
      expect(page.status).toBe(200);
      expect(page.body).toBe(managedApp.page);
    }
    const denied = await fetch(`http://127.0.0.1:${host.port}/__paseo_services/apps/${managedId}/`);
    expect(denied.status).toBe(503);
    expect(managedCookie).toBe(externalCookie);
    const stream = await openStream({
      socketPath: f.socketPath,
      serviceId: managedId,
      cookie: managedCookie,
    });
    // A distinct application read proves the gateway remains responsive while the stream is open.
    await gatewayRequest({
      socketPath: f.socketPath,
      target: `/__paseo_services/apps/${managedId}/`,
      headers: appHeaders(managedCookie),
    });
    await f.stop();
    expect(await stream.closed).toEqual({ body: "held configured stream\n", complete: false });
    await managedApp.streamClosed;
    expect(await (await fetch(`http://127.0.0.1:${managedApp.port}/`)).text()).toBe(
      managedApp.page,
    );
    expect(await (await fetch(`http://127.0.0.1:${externalApp.port}/`)).text()).toBe(
      externalApp.page,
    );
    expect(await readFile(f.policyFile, "utf8")).toBe(saved);
  });

  it("rejects a configured transport combined with either independently injected owner", async () => {
    const f = await fixture();
    const sources = new PreviewSources(origin);
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const broker = new PreviewBroker({ sources, routes, onFailure: ignoreRejection });
    cleanups.push(async () => {
      broker.close();
      sources.close();
    });
    routes.register({ serviceId: "independent-owner", port: f.frontPort, mount: "preserve" });
    const capture = routes.capture("independent-owner");
    await expect(
      createPaseoDaemon(f.configuration(f.transportEnv), logger, {
        ...f.dependencies,
        previewIngress: null,
      }),
    ).rejects.toThrow("already has an owner");
    await expect(
      createPaseoDaemon(f.configuration(f.transportEnv), logger, {
        ...f.dependencies,
        previewBroker: broker,
      }),
    ).rejects.toThrow("already has an owner");
    expect(broker.isClosed).toBe(false);
    expect(capture?.isCurrent()).toBe(true);
  });

  it("drains an accepted external archive through the independently injected daemon owner", async () => {
    const f = await fixture();
    const sources = new PreviewSources(origin);
    const routes = new PreviewRoutes({ excludedPorts: [] });
    let held: {
      entered: ReturnType<typeof deferred<void>>;
      released: ReturnType<typeof deferred<boolean>>;
    } | null = null;
    const store = new PreviewRegistrationStore({
      paseoHome: f.home,
      excludedPorts: () => new Set(),
      async workspaceExists(workspaceId) {
        const pending = held;
        held = null;
        if (pending) {
          pending.entered.resolve();
          return pending.released.promise;
        }
        const workspace = await f.workspaces.get(workspaceId);
        return !!workspace && !workspace.archivedAt;
      },
    });
    const externalServices = await ExternalPreviewServices.open({ store, routes });
    const failures: unknown[] = [];
    const broker = new PreviewBroker({
      sources,
      routes,
      externalServices,
      onFailure: (error) => {
        failures.push(error);
      },
    });
    cleanups.push(async () => {
      await broker.shutdown();
      sources.close();
    });
    const host = await f.start({}, { previewBroker: broker, previewIngress: null });
    const created = await host.client.registerExternalService({
      name: "Owned archive",
      port: f.frontPort,
      workspaceId: enrollment.workspaceId,
      mount: "preserve",
    });
    if (created.result.status !== "ok")
      throw new Error(`Registration refused: ${created.result.code}`);
    const serviceId = created.result.serviceId;
    expect((await host.client.connectExternalService({ serviceId })).result.status).toBe("ok");
    const capture = routes.capture(serviceId);
    const pending = { entered: deferred<void>(), released: deferred<boolean>() };
    held = pending;
    const connecting = host.client.connectExternalService({ serviceId });
    void connecting.catch(ignoreRejection);
    await pending.entered.promise;
    const revoked = deferred<void>();
    const unsubscribe = routes.subscribe(() => {
      if (!routes.capture(serviceId)) revoked.resolve();
    });
    const disconnecting = host.client.disconnectExternalService({ serviceId });
    void disconnecting.catch(ignoreRejection);
    await revoked.promise;
    const closing = f.stop();
    void closing.catch(ignoreRejection);
    try {
      expect(capture?.isCurrent()).toBe(false);
      await expect.poll(() => broker.isClosed).toBe(true);
      await expectPending(closing);
      const saved = JSON.parse(
        await readFile(path.join(f.home, "services", "registrations-v1.json"), "utf8"),
      );
      expect(saved.registrations[0].archivedAt).toBeNull();
    } finally {
      unsubscribe();
      pending.released.resolve(true);
      await closing;
    }
    await Promise.allSettled([connecting, disconnecting]);
    expect(await store.list()).toEqual([
      expect.objectContaining({ serviceId, archivedAt: expect.any(String) }),
    ]);
    expect(failures).toEqual([]);
  });

  it("preserves agent shutdown and ordinary teardown when an accepted preview archive later fails to persist", async () => {
    const f = await fixture();
    let agentClosed = false;
    f.configOverrides.agentClients = createTestAgentClients({
      async closeSession() {
        agentClosed = true;
      },
    });
    const sources = new PreviewSources(origin);
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const entered = deferred<void>();
    const release = deferred<boolean>();
    let holdNextValidation = false;
    const store = new PreviewRegistrationStore({
      paseoHome: f.home,
      excludedPorts: () => new Set(),
      async workspaceExists(workspaceId) {
        if (holdNextValidation) {
          holdNextValidation = false;
          entered.resolve();
          return release.promise;
        }
        const workspace = await f.workspaces.get(workspaceId);
        return !!workspace && !workspace.archivedAt;
      },
    });
    const externalServices = await ExternalPreviewServices.open({ store, routes });
    const broker = new PreviewBroker({
      sources,
      routes,
      externalServices,
      onFailure: ignoreRejection,
    });
    cleanups.push(async () => {
      release.resolve(true);
      await broker.shutdown().catch(ignoreRejection);
      sources.close();
    });
    const logLines: string[] = [];
    const runtimeLogger = pino({ level: "error" }, { write: (line) => logLines.push(line) });
    const host = await f.start({}, { previewBroker: broker, previewIngress: null }, runtimeLogger);
    const agent = await host.daemon.agentManager.createAgent(
      { provider: "codex", cwd: f.cwd },
      undefined,
      { workspaceId: enrollment.workspaceId },
    );
    await host.daemon.agentStorage.flush();
    expect(await persistedAgentStatus(host.daemon, agent.id)).toBe("idle");
    agentClosed = false;
    const created = await host.client.registerExternalService({
      name: "Retained failed archive",
      port: f.frontPort,
      workspaceId: enrollment.workspaceId,
      mount: "preserve",
    });
    if (created.result.status !== "ok") throw new Error("Expected isolated registration");
    const serviceId = created.result.serviceId;
    expect((await host.client.connectExternalService({ serviceId })).result.status).toBe("ok");
    holdNextValidation = true;
    const connecting = host.client.connectExternalService({ serviceId });
    void connecting.catch(ignoreRejection);
    await entered.promise;
    const revoked = deferred<void>();
    const unsubscribe = routes.subscribe(() => {
      if (!routes.capture(serviceId)) revoked.resolve();
    });
    const disconnecting = host.client.disconnectExternalService({ serviceId });
    void disconnecting.catch(ignoreRejection);
    await revoked.promise;

    // Retain the actual saved file, then make only this fixture's destination
    // unwritable as a file. The accepted archive is still queued behind validation.
    const registrationFile = path.join(f.home, "services", "registrations-v1.json");
    const retainedFile = path.join(f.home, "services", "retained-before-write-failure.json");
    const saved = await readFile(registrationFile, "utf8");
    await rename(registrationFile, retainedFile);
    await mkdir(registrationFile);
    const stopping = f.stop();
    void stopping.catch(ignoreRejection);
    try {
      await expect.poll(() => broker.isClosed).toBe(true);
      await expect.poll(() => agentClosed).toBe(true);
      await expect.poll(() => persistedAgentStatus(host.daemon, agent.id)).toBe("closed");
      await expect.poll(() => connectionRefused(host.port)).toBe(true);
      await expectPending(stopping);
    } finally {
      unsubscribe();
      release.resolve(true);
      await stopping;
    }
    await Promise.allSettled([connecting, disconnecting]);
    await expect(broker.shutdown()).rejects.toThrow("Preview broker shutdown failed");
    expect(
      logLines.some((line) => line.includes("Service preview drain failed during shutdown")),
    ).toBe(true);
    expect(await readFile(retainedFile, "utf8")).toBe(saved);
    expect((await stat(registrationFile)).isDirectory()).toBe(true);
    expect(await persistedAgentStatus(host.daemon, agent.id)).toBe("closed");
    expect(await connectionRefused(host.port)).toBe(true);
  });
});
