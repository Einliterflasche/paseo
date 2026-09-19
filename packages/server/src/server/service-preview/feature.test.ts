import { once } from "node:events";
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { hashDaemonPassword } from "../auth.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { createServiceProxySubsystem } from "../service-proxy.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
  type WorkspaceMutation,
} from "../workspace-registry.js";
import { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import { openPreviewFeature } from "./feature.js";
import {
  managedPreviewServiceId,
  readPreviewFeaturePolicy,
  type PreviewFeaturePolicy,
} from "./policy.js";
import { PREVIEW_SOURCE_CAPABILITY } from "./sources.js";

const origin = "https://control.test";
const logger = pino({ level: "silent" });
const password = hashDaemonPassword("isolated-feature-fixture-password");
const enrollment = {
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "Atlas HTML",
  mount: "preserve" as const,
};
const serviceId = managedPreviewServiceId(enrollment);
const prefix = `/__paseo_services/apps/${serviceId}/`;
const page = "<!doctype html><h1>Feature composition page</h1>";
const cleanups: Array<() => Promise<void>> = [];
type Feature = NonNullable<Awaited<ReturnType<typeof openPreviewFeature>>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

class HeldMetadataWorkspaceRegistry extends FileBackedWorkspaceRegistry {
  readonly metadataEntered = deferred<void>();
  readonly releaseMetadata = deferred<void>();

  override subscribeToMutations(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void {
    return super.subscribeToMutations(async (mutation) => {
      if (mutation.kind === "upsert" && mutation.workspace?.title === "Before archive") {
        this.metadataEntered.resolve();
        await this.releaseMetadata.promise;
      }
      await listener(mutation);
    });
  }
}

async function startObservedWorker(start: () => Promise<Feature>) {
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
  let feature: Feature;
  try {
    feature = await start();
  } finally {
    published.unsubscribe(observe);
  }
  const worker = children.find((child) =>
    child.spawnargs.some((argument) => argument.endsWith("/service-preview/worker-process.ts")),
  );
  if (!worker?.pid) throw new Error("Missing owned fixture gateway process");
  return { feature, worker, pid: worker.pid };
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function wire(
  socketPath: string,
  path: string,
  options: { method?: string; headers?: OutgoingHttpHeaders; body?: string } = {},
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
      headers: { Host: "control.test", ...options.headers },
      agent: false,
    });
    outgoing.on("error", reject);
    outgoing.on("response", (incoming) => {
      void readBody(incoming).then(
        (body) => resolve({ status: incoming.statusCode, headers: incoming.headers, body }),
        reject,
      );
    });
    outgoing.end(options.body);
  });
}

const navigation = {
  Origin: origin,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const requestHeaders = (cookie: string) => ({
  Cookie: cookie,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
});

async function open(feature: Feature, id = serviceId, attemptId = "open-1") {
  const frames: string[] = [];
  const socket = { readyState: 1 };
  feature.broker.sources.admitDirectOwner({
    socket,
    connectionId: `source-${attemptId}`,
    principalId: "owner",
    origin,
    permissions: OWNER_PERMISSIONS,
    async send(frame) {
      frames.push(frame);
      return true;
    },
  });
  feature.broker.sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
  await feature.broker.prepare({
    socket,
    request: {
      type: "service.preview.prepare.request",
      requestId: `request-${attemptId}`,
      attemptId,
      browserHandle: "feature-profile",
      serviceId: id,
      mode: "iframe",
    },
  });
  const frame = frames.at(-1);
  if (!frame) throw new Error("Missing feature Prepare reply");
  const prepared = ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(frame).message)
    .payload.result;
  if (prepared.status !== "prepared") throw new Error(`Feature Prepare refused: ${prepared.code}`);
  const issued = await wire(
    feature.socketPath,
    `/__paseo_services/bootstrap/${prepared.bootstrapId}`,
    {
      method: "POST",
      headers: { ...navigation, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: prepared.ticket }).toString(),
    },
  );
  expect(issued.status).toBe(303);
  const cookie = issued.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing feature cookie");
  expect(
    (
      await wire(feature.socketPath, `/__paseo_services/confirm/${prepared.bootstrapId}`, {
        headers: { ...navigation, Cookie: cookie },
      })
    ).status,
  ).toBe(200);
  return { cookie, socket };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-feature-"));
  const workspaceFile = join(home, "projects", "workspaces.json");
  const workspaces = new HeldMetadataWorkspaceRegistry(workspaceFile, logger);
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = createServiceProxySubsystem({ logger });
  const failures: unknown[] = [];
  const features: Feature[] = [];
  const upstreamSockets = new Set<Socket>();
  const websocketClients: WebSocket[] = [];
  const appSockets: WebSocket[] = [];
  const appClosed: Array<Promise<number>> = [];
  const streamClosed = deferred<void>();
  let upstreamContacts = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    upstreamContacts += 1;
    if (request.url?.endsWith("/stream")) {
      response.once("close", () => streamClosed.resolve());
      response.write("first\n");
    } else response.end(page);
  });
  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  const app = new WebSocketServer({ noServer: true });
  app.on("connection", (socket) => {
    appSockets.push(socket);
    appClosed.push(new Promise<number>((resolve) => socket.once("close", resolve)));
    socket.on("error", () => {});
    socket.send("ready");
  });
  upstream.on("upgrade", (request, socket, head) =>
    app.handleUpgrade(request, socket, head, (client) => app.emit("connection", client, request)),
  );
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing feature fixture port");
  const upstreamPort = address.port;
  let socketSequence = 0;
  const options = (
    policy: PreviewFeaturePolicy,
    socketPath = join(home, `gateway-${++socketSequence}.sock`),
  ) => ({
    policy,
    auth: { password },
    paseoHome: home,
    socketPath,
    infrastructurePorts: [],
    controlCookieNames: ["paseo-control"],
    workspaces,
    runtime,
    endpoints,
    onFailure(error: unknown) {
      failures.push(error);
    },
  });
  const record = createPersistedWorkspaceRecord({
    workspaceId: enrollment.workspaceId,
    projectId: "project-a",
    cwd: home,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  async function configure() {
    await workspaces.upsert(record);
    await mkdir(join(home, "services"), { recursive: true });
    await writeFile(
      join(home, "services", "policy-v1.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        controlOrigin: origin,
        managedServices: [enrollment],
      }),
    );
    return readPreviewFeaturePolicy(home);
  }
  function markRunning() {
    endpoints.registerWorkspaceService({
      workspaceId: enrollment.workspaceId,
      projectSlug: "feature-fixture",
      branchName: "main",
      scriptName: enrollment.scriptName,
      port: upstreamPort,
    });
    runtime.set({
      workspaceId: enrollment.workspaceId,
      scriptName: enrollment.scriptName,
      type: "service",
      lifecycle: "running",
      terminalId: "owned-test-terminal",
      exitCode: null,
    });
  }
  async function start(policy: PreviewFeaturePolicy, socketPath?: string) {
    const feature = await openPreviewFeature(options(policy, socketPath));
    if (!feature) throw new Error("Expected enabled feature");
    features.push(feature);
    return feature;
  }
  async function stream(feature: Feature, cookie: string) {
    const first = deferred<void>();
    const closed = deferred<{ body: string; complete: boolean }>();
    let body = "";
    const outgoing = httpRequest({
      socketPath: feature.socketPath,
      path: `${prefix}stream`,
      agent: false,
      headers: { Host: "control.test", ...requestHeaders(cookie) },
    });
    outgoing.on("error", () => {});
    outgoing.on("response", (incoming) => {
      incoming.on("data", (part) => {
        body += part.toString();
        first.resolve();
      });
      incoming.on("error", () => {});
      incoming.once("close", () => closed.resolve({ body, complete: incoming.complete }));
    });
    outgoing.end();
    await first.promise;
    return { closed: closed.promise };
  }
  async function websocket(feature: Feature, cookie: string) {
    const ready = deferred<void>();
    const socket = new WebSocket(`ws+unix://${feature.socketPath}:${prefix}`, ["vite-hmr"], {
      headers: { Host: "control.test", Origin: origin, Cookie: cookie },
    });
    websocketClients.push(socket);
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.on("error", () => {});
    socket.once("message", () => ready.resolve());
    await ready.promise;
    return { socket, closed };
  }
  cleanups.push(async () => {
    for (const feature of features) await feature.shutdown();
    for (const socket of websocketClients) socket.terminate();
    for (const socket of app.clients) socket.terminate();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await stopServer(upstream);
    expect(failures).toEqual([]);
  });
  return {
    home,
    options,
    configure,
    start,
    markRunning,
    record,
    workspaces,
    workspaceFile,
    runtime,
    endpoints,
    stream,
    websocket,
    appSockets,
    appClosed,
    streamClosed: streamClosed.promise,
    upstreamPort,
    upstreamContacts: () => upstreamContacts,
    failures,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("optional preview feature composition", () => {
  it("keeps a disabled policy inert and refuses enabled policy without a password", async () => {
    const f = await fixture();
    const disabled = f.options({ version: 1, enabled: false });
    expect(await openPreviewFeature({ ...disabled, auth: undefined })).toBeNull();
    expect(await readdir(f.home)).toEqual([]);
    const enabled = f.options({
      version: 1,
      enabled: true,
      controlOrigin: origin,
      managedServices: [],
    });
    await expect(openPreviewFeature({ ...enabled, auth: undefined })).rejects.toThrow(
      "require daemon password",
    );
    expect(await readdir(f.home)).toEqual([]);
    expect(f.upstreamContacts()).toBe(0);
  });

  it("restores saved enrollment without starting a stopped service and activates it on a real runtime update", async () => {
    const f = await fixture();
    const policy = await f.configure();
    const feature = await f.start(policy);
    expect(feature.broker.describe().services).toEqual([]);
    expect(f.runtime.listForWorkspace(enrollment.workspaceId)).toEqual([]);
    expect(f.upstreamContacts()).toBe(0);
    f.markRunning();
    expect(feature.broker.describe().services).toMatchObject([
      { serviceId, available: true, port: f.upstreamPort },
    ]);
    const { cookie } = await open(feature);
    expect(
      await wire(feature.socketPath, prefix, { headers: requestHeaders(cookie) }),
    ).toMatchObject({ status: 200, body: page });
    expect(f.upstreamContacts()).toBe(1);
  });

  it.each(["archived", "absent"] as const)(
    "enrolls a workspace that was %s at feature startup when it is restored and later runs",
    async (initialState) => {
      const f = await fixture();
      const policy = await f.configure();
      if (initialState === "archived") {
        await f.workspaces.archive(enrollment.workspaceId, "2026-09-19T00:01:00.000Z");
      } else {
        await f.workspaces.remove(enrollment.workspaceId);
      }
      const feature = await f.start(policy);
      expect(feature.broker.describe().services).toEqual([]);
      expect(f.upstreamContacts()).toBe(0);
      await f.workspaces.upsert(f.record);
      expect(feature.broker.describe().services).toEqual([]);
      f.markRunning();
      expect(feature.broker.describe().services).toMatchObject([
        { serviceId, available: true, port: f.upstreamPort },
      ]);
      const { cookie } = await open(feature);
      expect(
        await wire(feature.socketPath, prefix, { headers: requestHeaders(cookie) }),
      ).toMatchObject({ status: 200, body: page });
      expect(f.upstreamContacts()).toBe(1);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not let an older active metadata notification reactivate a workspace during held remote revocation",
    async () => {
      const f = await fixture();
      const policy = await f.configure();
      f.markRunning();
      const { feature, worker, pid } = await startObservedWorker(() => f.start(policy));
      const { cookie } = await open(feature);
      const socket = await f.websocket(feature, cookie);
      const unavailable = deferred<void>();
      const stopCatalog = feature.broker.subscribeCatalog(() => {
        for (const service of feature.broker.describe().services) {
          if (!service.available) unavailable.resolve();
        }
      });
      const stopMetadata = f.workspaces.subscribeToMutations(() => {});
      const mutations: Promise<unknown>[] = [];
      let archiveCommitted = false;
      try {
        expect(worker.kill("SIGSTOP")).toBe(true);
        await expect
          .poll(async () => (await readFile(`/proc/${pid}/status`, "utf8")).includes("State:\tT"))
          .toBe(true);
        mutations.push(
          f.workspaces.update(enrollment.workspaceId, (record) => ({
            ...record,
            title: "Before archive",
          })),
        );
        mutations.push(
          f.workspaces.archive(enrollment.workspaceId, "2026-09-19T00:02:00.000Z").then(() => {
            archiveCommitted = true;
            return undefined;
          }),
        );
        await f.workspaces.metadataEntered.promise;
        await unavailable.promise;
        expect(socket.socket.readyState).toBe(WebSocket.OPEN);
        f.workspaces.releaseMetadata.resolve();
        await mutations[0];
        expect(feature.broker.describe().services).toMatchObject([{ serviceId, available: false }]);
        await expect(
          feature.broker.run({ serviceId, cookieHeader: cookie }, async () => "must-not-run"),
        ).rejects.toThrow("authorization-ended");
        expect(archiveCommitted).toBe(false);
        expect(await f.workspaces.get(enrollment.workspaceId)).toMatchObject({
          title: "Before archive",
          archivedAt: null,
        });
        expect(JSON.parse(await readFile(f.workspaceFile, "utf8"))[0]).toMatchObject({
          title: "Before archive",
          archivedAt: null,
        });
      } finally {
        f.workspaces.releaseMetadata.resolve();
        worker.kill("SIGCONT");
        await Promise.all(mutations);
        stopMetadata();
        stopCatalog();
      }
      expect(await socket.closed).toBe(1006);
      expect(await f.appClosed[0]).toBe(1006);
      expect(archiveCommitted).toBe(true);
      expect(feature.broker.describe().services).toMatchObject([{ serviceId, available: false }]);
      expect(await (await fetch(`http://127.0.0.1:${f.upstreamPort}/`)).text()).toBe(page);
    },
  );

  it("archives a workspace by revoking previews while its runtime and app continue, then requires fresh Open after restore", async () => {
    const f = await fixture();
    const policy = await f.configure();
    f.markRunning();
    const feature = await f.start(policy);
    const { cookie } = await open(feature);
    const stream = await f.stream(feature, cookie);
    const socket = await f.websocket(feature, cookie);
    const runtime = f.runtime.get(enrollment);
    expect(socket.socket.readyState).toBe(WebSocket.OPEN);
    const archivedAt = "2026-09-19T00:01:00.000Z";
    await f.workspaces.archive(enrollment.workspaceId, archivedAt);
    expect(await stream.closed).toEqual({ complete: false, body: "first\n" });
    await f.streamClosed;
    expect(await socket.closed).toBe(1006);
    expect(await f.appClosed[0]).toBe(1006);
    expect((await f.workspaces.get(enrollment.workspaceId))?.archivedAt).toBe(archivedAt);
    expect(
      (JSON.parse(await readFile(f.workspaceFile, "utf8")) as Array<{ archivedAt: string }>)[0]
        .archivedAt,
    ).toBe(archivedAt);
    expect(
      (await wire(feature.socketPath, prefix, { headers: requestHeaders(cookie) })).status,
    ).toBe(403);
    expect(f.runtime.get(enrollment)).toEqual(runtime);
    expect(await (await fetch(`http://127.0.0.1:${f.upstreamPort}/`)).text()).toBe(page);
    await f.workspaces.upsert({ ...f.record, updatedAt: "2026-09-19T00:02:00.000Z" });
    expect(
      (await wire(feature.socketPath, prefix, { headers: requestHeaders(cookie) })).status,
    ).toBe(403);
    const reopened = await open(feature, serviceId, "open-2");
    expect(
      await wire(feature.socketPath, prefix, { headers: requestHeaders(reopened.cookie) }),
    ).toMatchObject({ status: 200, body: page });
    expect(socket.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("cleans failed worker initialization so existing listeners and later workspace changes remain usable", async () => {
    const f = await fixture();
    const policy = await f.configure();
    f.markRunning();
    const socketPath = join(f.home, "occupied.sock");
    const existing = createServer((_request, response) => response.end("previous-owner"));
    existing.listen(socketPath);
    await once(existing, "listening");
    try {
      await expect(openPreviewFeature(f.options(policy, socketPath))).rejects.toThrow(
        "preview-worker-ended-before-ready",
      );
      expect(await wire(socketPath, "/")).toMatchObject({ status: 200, body: "previous-owner" });
      await f.workspaces.archive(enrollment.workspaceId, "2026-09-19T00:03:00.000Z");
      await f.workspaces.upsert(f.record);
      const feature = await f.start(policy);
      const { cookie } = await open(feature);
      expect(
        await wire(feature.socketPath, prefix, { headers: requestHeaders(cookie) }),
      ).toMatchObject({ status: 200, body: page });
      expect(f.failures).toEqual([]);
    } finally {
      await stopServer(existing);
    }
  });

  it.each(["archive", "remove"] as const)(
    "allows workspace %s after broker closure and waits for its owned gateway to exit",
    async (operation) => {
      const f = await fixture();
      const policy = await f.configure();
      f.markRunning();
      const { feature, worker } = await startObservedWorker(() => f.start(policy));
      const exited = once(worker, "exit");
      const { cookie } = await open(feature);
      const stream = await f.stream(feature, cookie);
      expect(worker.exitCode).toBeNull();

      // The feature is still open. A terminal broker must turn its remote drain
      // into owned-worker teardown instead of vetoing an unrelated workspace write.
      feature.broker.close();
      if (operation === "archive") {
        await f.workspaces.archive(enrollment.workspaceId, "2026-09-19T00:04:00.000Z");
        expect(await f.workspaces.get(enrollment.workspaceId)).toMatchObject({
          archivedAt: "2026-09-19T00:04:00.000Z",
        });
        expect(JSON.parse(await readFile(f.workspaceFile, "utf8"))[0]).toMatchObject({
          archivedAt: "2026-09-19T00:04:00.000Z",
        });
      } else {
        await f.workspaces.remove(enrollment.workspaceId);
        expect(await f.workspaces.get(enrollment.workspaceId)).toBeNull();
        expect(JSON.parse(await readFile(f.workspaceFile, "utf8"))).toEqual([]);
      }
      expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
      await exited;
      expect(await stream.closed).toEqual({ body: "first\n", complete: false });
      await f.streamClosed;
      expect(await (await fetch(`http://127.0.0.1:${f.upstreamPort}/`)).text()).toBe(page);
    },
  );

  it("drains an accepted external disconnect to disk when shutdown begins immediately", async () => {
    const f = await fixture();
    const policy = await f.configure();
    const feature = await f.start(policy);
    const external = feature.broker.externalServices;
    if (!external) throw new Error("Missing external service owner");
    const registered = await external.register({
      input: {
        name: "External HTML",
        port: f.upstreamPort,
        workspaceId: enrollment.workspaceId,
        mount: "preserve",
      },
      assertCurrent() {},
    });
    await external.connect({ serviceId: registered.serviceId, assertCurrent() {} });
    const { cookie } = await open(feature, registered.serviceId, "external-open");
    expect(
      await wire(feature.socketPath, `/__paseo_services/apps/${registered.serviceId}/`, {
        headers: requestHeaders(cookie),
      }),
    ).toMatchObject({ status: 200, body: page });
    const disconnect = external.disconnect(registered.serviceId);
    const shutdown = feature.shutdown();
    await shutdown;
    await disconnect;
    const stored = JSON.parse(
      await readFile(join(f.home, "services", "registrations-v1.json"), "utf8"),
    );
    expect(stored.registrations).toHaveLength(1);
    expect(stored.registrations[0]).toMatchObject({
      serviceId: registered.serviceId,
      archivedAt: expect.any(String),
    });
    expect(
      await stat(feature.socketPath).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${f.upstreamPort}/`)).text()).toBe(page);
  });
});
