import { prepareProcessTreeTermination, terminateWithTreeKill } from "../../utils/tree-kill.js";
import { ProviderInitializationCleanupError } from "../agent/provider-initialization-cleanup-error.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import {
  ProviderStatusSchema,
  type ProviderStatus,
  type ProviderStatusRequest,
} from "@getpaseo/plugin/server/provider";
import type { PluginBeforeRequests, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { validateBeforeRequest, validateBeforeResult } from "./lifecycle/index.js";
import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import {
  PROVIDER_CAPABILITIES,
  requireProviderCapabilities,
  type ProviderConnectRequest,
  type ProviderCatalogOptions,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import type { PluginLogEntry } from "@getpaseo/protocol/messages";
import { compilePlugin } from "./compiler.js";
import { readPluginManifest } from "./manifest.js";
import type { PluginRequirements } from "@getpaseo/protocol/messages";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import type {
  PluginProcessMessage,
  PluginProcessRequest,
  PluginProviderMetadata,
  PluginUsageSourceMetadata,
} from "./plugin-process-protocol.js";
import { PluginProcessMessageSchema } from "./plugin-process-protocol.js";
import { PluginSessionSocket } from "./session-socket.js";
import { InternalPluginChild } from "./internal-child.js";
import { evaluateBundle } from "./bundle-evaluator.js";

const CLIENT_ENTRY_FILENAMES = ["index.client.ts", "index.client.tsx"] as const;
const SERVER_ENTRY_FILENAMES = ["index.server.ts", "index.server.tsx"] as const;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;
const SOFT_SHUTDOWN_TIMEOUT_MS = 2_000;

interface PluginOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

interface PluginChild {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  closeRuntime?(): Promise<void>;
  connected: boolean;
  killed: boolean;
  stdout?: PluginOutputStream | null;
  stderr?: PluginOutputStream | null;
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  disconnect(): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingInvocation {
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface LoadedPlugin {
  id: string;
  requirements: PluginRequirements | undefined;
  clientBundle: string;
  methods: ReadonlySet<string>;
  hooks: { events: string[]; before: string[] };
  providers: readonly PluginProviderMetadata[];
  usageSources: readonly PluginUsageSourceMetadata[];
  child: PluginChild | null;
  outputCapture: PluginOutputCapture | null;
  pending: Map<string, PendingInvocation>;
  providerConnections: Map<string, RemoteProviderConnection>;
  providerConnectionTombstones: Set<string>;
  sessionSocket: PluginSessionSocket | null;
  sessionClosed: Promise<void> | null;
  stopping?: boolean;
  stopped?: boolean;
  stopPromise?: Promise<void>;
  preserveForRestart?: boolean;
  shutdownReceipt?: { promise: Promise<void>; resolve(): void; reject(error: Error): void };
}

/** The session socket a loaded plugin currently speaks through. */
interface PluginSessionBinding {
  socket: PluginSessionSocket;
  reattaching: boolean;
  plugin: LoadedPlugin | null;
}

interface PluginFrameInput {
  session: PluginSessionBinding;
  pluginId: string;
  child: PluginChild;
  sessionHost: PluginPaseoSessionHost;
  frame: string | Uint8Array;
  isBinary: boolean;
}

interface PendingProviderSend {
  input: ProviderInput;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface RemoteProviderConnection {
  request: ProviderConnectRequest;
  capabilities: readonly string[];
  listeners: Set<(event: ProviderEvent) => void>;
  pendingSends: Map<string, PendingProviderSend>;
  sessions: Map<string, readonly string[]>;
  connected: boolean;
  closed: boolean;
  certifiedClosed: boolean;
  closing?: Promise<void>;
  closedPromise: Promise<void>;
  resolveConnected(connection: ProviderConnection): void;
  rejectConnected(error: Error): void;
  resolveClosed(): void;
  rejectClosed(error: Error): void;
}

interface PluginRuntimeDependencies {
  settingsDirectory?: string;
  onSettingsChanged?: (pluginId: string, settingsId: string) => void;
  spawnChild?: () => PluginChild;
  sessionHost?: PluginPaseoSessionHost;
}

interface PluginLogTail {
  entries: PluginLogEntry[];
  bytes: number;
  nextSequence: number;
}

class PluginOutputCapture {
  private readonly pending = new Map<PluginLogEntry["stream"], Buffer>([
    ["stdout", Buffer.alloc(0)],
    ["stderr", Buffer.alloc(0)],
  ]);
  private readonly overflowed = new Set<PluginLogEntry["stream"]>();
  private readonly lastActivity = new Map<PluginLogEntry["stream"], number>();
  private activitySequence = 0;
  private flushed = false;

  constructor(
    child: PluginChild,
    private readonly emit: (stream: PluginLogEntry["stream"], message: string) => void,
  ) {
    child.stdout?.on("data", (chunk) => this.write("stdout", chunk));
    child.stderr?.on("data", (chunk) => this.write("stderr", chunk));
    child.on("close", () => this.flush());
  }

  private write(stream: PluginLogEntry["stream"], chunk: Buffer | string): void {
    if (this.flushed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline === -1 ? data.length : newline;
      this.append(stream, data.subarray(offset, end));
      if (newline === -1) return;
      this.emitLine(stream);
      offset = newline + 1;
    }
  }

  private append(stream: PluginLogEntry["stream"], chunk: Buffer): void {
    if (chunk.length > 0) this.lastActivity.set(stream, ++this.activitySequence);
    const current = this.pending.get(stream) ?? Buffer.alloc(0);
    const remaining = MAX_LOG_LINE_BYTES - current.length;
    if (chunk.length > remaining) this.overflowed.add(stream);
    if (remaining <= 0) return;
    this.pending.set(stream, Buffer.concat([current, chunk.subarray(0, remaining)]));
  }

  private emitLine(stream: PluginLogEntry["stream"]): void {
    let line = this.pending.get(stream) ?? Buffer.alloc(0);
    if (!this.overflowed.has(stream) && line.at(-1) === 0x0d) line = line.subarray(0, -1);
    this.emit(stream, line.toString("utf8"));
    this.pending.set(stream, Buffer.alloc(0));
    this.overflowed.delete(stream);
    this.lastActivity.delete(stream);
  }

  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const pendingStreams = (["stdout", "stderr"] as const)
      .filter(
        (stream) => (this.pending.get(stream)?.length ?? 0) > 0 || this.overflowed.has(stream),
      )
      .sort(
        (left, right) => (this.lastActivity.get(left) ?? 0) - (this.lastActivity.get(right) ?? 0),
      );
    for (const stream of pendingStreams) {
      this.emitLine(stream);
    }
  }
}

export interface PluginPaseoSessionHost {
  attachPluginSocket(
    pluginId: string,
    socket: PluginSessionSocket,
  ): Promise<{ closed: Promise<void> }>;
}

function resolveWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts") ? "./plugin-process.ts" : "./plugin-process.js",
    import.meta.url,
  );
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function spawnPluginChild(): PluginChild {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  }) as PluginChild;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonTransportValue<Value>(value: Value): Value {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Provider value is not JSON-serializable");
  return JSON.parse(encoded) as Value;
}

function send(child: PluginChild, message: PluginProcessRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function findEntry(directory: string, filenames: readonly string[]): Promise<string | null> {
  for (const filename of filenames) {
    const filePath = path.join(directory, filename);
    const info = await stat(filePath).catch(() => null);
    if (info?.isFile()) return filePath;
  }
  return null;
}

async function resolveEntryPaths(directory: string): Promise<{
  client: string | null;
  server: string | null;
}> {
  const [client, server] = await Promise.all([
    findEntry(directory, CLIENT_ENTRY_FILENAMES),
    findEntry(directory, SERVER_ENTRY_FILENAMES),
  ]);
  if (client || server) return { client, server };
  const legacyEntry = await findEntry(directory, ["index.ts", "index.tsx"]);
  if (legacyEntry) {
    throw new Error(
      "This plugin was made for an older version of Paseo and cannot run on Paseo v0.8. Ask its author to update it. Plugin authors can follow the migration guide: https://paseo.sh/docs/plugins/migration",
    );
  }
  throw new Error(
    `Plugin entry points are missing: expected ${CLIENT_ENTRY_FILENAMES.join(" or ")} and/or ${SERVER_ENTRY_FILENAMES.join(" or ")} in ${directory}`,
  );
}

export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly logTails = new Map<string, PluginLogTail>();
  private readonly logger: pino.Logger;
  private readonly childOwners = new Map<PluginChild, { close(): Promise<void> }>();
  private readonly retiredPlugins = new Set<LoadedPlugin>();
  private readonly spawnChild: () => PluginChild;
  private sessionHost: PluginPaseoSessionHost | null;
  private readonly listeners = new Set<(pluginId: string, error?: string) => void>();

  constructor(
    logger: pino.Logger,
    private readonly daemonVersion: string,
    private readonly dependencies: PluginRuntimeDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugins" });
    this.spawnChild = dependencies.spawnChild ?? spawnPluginChild;
    this.sessionHost = dependencies.sessionHost ?? null;
  }

  bindPaseoSessionHost(sessionHost: PluginPaseoSessionHost): void {
    if (this.plugins.size > 0)
      throw new Error("Cannot replace the plugin session host while running");
    this.sessionHost = sessionHost;
  }

  subscribe(listener: (pluginId: string, error?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startPlugin(
    pluginId: string,
    configuredPath: string,
    canPublish: () => boolean = () => true,
  ): Promise<void> {
    if (this.plugins.has(pluginId)) throw new Error(`Plugin is already running: ${pluginId}`);
    this.appendLog(pluginId, "stdout", "[paseo] Loading plugin");
    const loaded = await this.loadDirectoryPlugin(pluginId, configuredPath).catch((error) => {
      this.appendLog(pluginId, "stderr", `[paseo] Plugin failed to load: ${describeError(error)}`);
      throw error;
    });
    if (!canPublish()) {
      await this.stopPlugin(loaded);
      throw new Error(`Plugin start cancelled: ${pluginId}`);
    }
    this.plugins.set(pluginId, loaded);
    this.appendLog(pluginId, "stdout", "[paseo] Plugin ready");
  }

  async startBuiltinPlugin(input: { id: string; directory: string }): Promise<void> {
    if (this.plugins.has(input.id)) throw new Error(`Plugin is already running: ${input.id}`);
    this.appendLog(input.id, "stdout", "[paseo] Loading plugin");
    const directory = path.resolve(input.directory);
    const manifest = await readPluginManifest(directory);
    if (manifest.id !== input.id) {
      throw new Error(`Built-in plugin ${input.id} has manifest ID ${manifest.id}`);
    }
    assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
    const bundles = await compilePlugin(await resolveEntryPaths(directory));
    if (!bundles.serverBundle) throw new Error(`Built-in plugin ${input.id} needs a server entry`);
    const loaded = await this.launchPlugin({
      pluginId: input.id,
      pluginDirectory: directory,
      requirements: manifest.requirements,
      child: new InternalPluginChild(evaluateBundle(bundles.serverBundle)),
      bundle: "",
      clientBundle: bundles.clientBundle ?? "",
    });
    this.plugins.set(input.id, loaded);
    this.appendLog(input.id, "stdout", "[paseo] Plugin ready");
  }

  async validatePlugin(configuredPath: string): Promise<void> {
    const directory = path.resolve(configuredPath);
    const manifest = await readPluginManifest(directory);
    assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
    const entryPaths = await resolveEntryPaths(directory);
    await compilePlugin(entryPaths);
  }

  async stopPluginById(pluginId: string): Promise<boolean> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return false;
    await this.stopPlugin(loaded);
    if (this.plugins.get(pluginId) === loaded) this.plugins.delete(pluginId);
    return true;
  }

  catalog(): Array<{ id: string; clientBundle: string; requirements?: PluginRequirements }> {
    return [...this.plugins.values()]
      .map(({ id, clientBundle, requirements }) => ({ id, clientBundle, requirements }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getProviderRegistrations(pluginId: string): readonly PluginProviderMetadata[] {
    return this.plugins.get(pluginId)?.providers ?? [];
  }

  getUsageSourceRegistrations(pluginId: string): readonly PluginUsageSourceMetadata[] {
    return this.plugins.get(pluginId)?.usageSources ?? [];
  }

  identifyUsage(pluginId: string, sourceId: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return this.request(loaded, {
      type: "usage.identify",
      requestId: randomUUID(),
      sourceId,
      input,
    });
  }

  fetchUsage(pluginId: string, sourceId: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return this.request(loaded, { type: "usage.fetch", requestId: randomUUID(), sourceId, input });
  }

  discoverUsage(pluginId: string, sourceId: string): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return this.request(loaded, { type: "usage.discover", requestId: randomUUID(), sourceId });
  }

  async getProviderStatus(
    pluginId: string,
    providerId: string,
    request: ProviderStatusRequest,
  ): Promise<ProviderStatus> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return ProviderStatusSchema.parse(
      await this.request(loaded, {
        type: "provider.status",
        requestId: randomUUID(),
        providerId,
        request: { launch: request.launch },
      }),
    );
  }

  async connectProvider(
    pluginId: string,
    providerId: string,
    request: ProviderConnectRequest,
  ): Promise<ProviderConnection> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded?.child || loaded.stopping) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.providers.some((provider) => provider.id === providerId)) {
      throw new Error(`Plugin ${pluginId} does not contribute provider ${providerId}`);
    }
    const connectionId = randomUUID();
    let resolveConnected!: (connection: ProviderConnection) => void;
    let rejectConnected!: (error: Error) => void;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const connected = new Promise<ProviderConnection>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    void closed.catch(() => undefined);
    const state: RemoteProviderConnection = {
      request,
      capabilities: [],
      listeners: new Set(),
      pendingSends: new Map(),
      sessions: new Map(),
      connected: false,
      closed: false,
      certifiedClosed: false,
      closedPromise: closed,
      resolveConnected,
      rejectConnected,
      resolveClosed,
      rejectClosed,
    };
    loaded.providerConnections.set(connectionId, state);
    const timeout = setTimeout(() => {
      if (state.connected) return;
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider connection timed out: ${pluginId}.${providerId}`),
      );
    }, REQUEST_TIMEOUT_MS);
    void send(loaded.child, {
      type: "provider.connect",
      providerId,
      connectionId,
      request: {
        launch: request.launch,
        versions: request.versions,
        capabilities: request.capabilities,
      },
    }).catch((error) => {
      clearTimeout(timeout);
      this.abandonProviderConnect(loaded, connectionId, state, error);
    });
    return connected.finally(() => clearTimeout(timeout));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    return (
      this.logTails.get(pluginId)?.entries.map((entry) => ({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        stream: entry.stream,
        message: entry.message,
      })) ?? []
    );
  }

  clearLogs(pluginId: string): void {
    this.logTails.delete(pluginId);
  }

  async invoke(pluginId: string, method: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.methods.has(method))
      throw new Error(`Plugin ${pluginId} does not contribute RPC ${method}`);
    return this.request(loaded, { type: "invoke", requestId: randomUUID(), method, input });
  }

  emit<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): void {
    for (const loaded of this.plugins.values()) {
      if (!loaded.hooks.events.includes(name)) {
        continue;
      }
      void this.request(loaded, {
        type: "hook",
        requestId: randomUUID(),
        kind: "event",
        name,
        input: event,
      }).catch((error) => {
        this.appendLog(
          loaded.id,
          "stderr",
          `Lifecycle hook ${name} failed: ${describeError(error)}`,
        );
      });
    }
  }

  async before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    input: PluginBeforeRequests[Name],
  ): Promise<PluginBeforeRequests[Name]> {
    let request = validateBeforeRequest(name, input);
    const plugins = [...this.plugins.values()].sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
    for (const loaded of plugins) {
      if (!loaded.hooks.before.includes(name)) {
        continue;
      }
      try {
        const output = await this.request(loaded, {
          type: "hook",
          requestId: randomUUID(),
          kind: "before",
          name,
          input: request,
        });
        request = validateBeforeResult(name, request, output);
      } catch (error) {
        throw new Error(`Plugin ${loaded.id} before ${name} failed: ${describeError(error)}`, {
          cause: error,
        });
      }
    }
    return request;
  }

  async getProviderCatalogCacheKey(
    pluginId: string,
    providerId: string,
    options: ProviderCatalogOptions,
  ): Promise<string | undefined> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    const output = await this.request(loaded, {
      type: "provider.catalog_key",
      requestId: randomUUID(),
      providerId,
      options,
    });
    if (output !== undefined && typeof output !== "string")
      throw new Error("Invalid catalogue key from plugin");
    return output;
  }

  private request(
    loaded: LoadedPlugin,
    message: Extract<PluginProcessRequest, { requestId: string }>,
  ): Promise<unknown> {
    const child = loaded.child;
    const pluginId = loaded.id;
    if (!child) throw new Error(`Plugin ${pluginId} has no server entry`);
    if (loaded.stopping && message.type !== "prepare_restart")
      throw new Error(`Plugin is stopping: ${pluginId}`);
    const requestId = message.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        loaded.pending.delete(requestId);
        if (message.type === "hook") {
          void send(child, { type: "hook.cancel", requestId }).catch(() => {});
        }
        reject(new Error(`Plugin RPC timed out: ${pluginId}.${message.type}`));
      }, REQUEST_TIMEOUT_MS);
      loaded.pending.set(requestId, { resolve, reject, timeout });
      void send(child, message).catch((error) => {
        clearTimeout(timeout);
        loaded.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async prepareForRestart(): Promise<void> {
    const plugins = new Set([...this.plugins.values(), ...this.retiredPlugins]);
    await Promise.all(
      [...plugins].map(async (plugin) => {
        plugin.preserveForRestart = true;
        plugin.stopping = true;
        if (plugin.stopped || !plugin.child) return;
        if (plugin.child.pid !== undefined)
          await prepareProcessTreeTermination(plugin.child, {
            timeoutMs: SOFT_SHUTDOWN_TIMEOUT_MS,
          });
        if (plugin.child.connected)
          await this.request(plugin, { type: "prepare_restart", requestId: randomUUID() });
        await this.stopPlugin(plugin);
      }),
    );
    await Promise.all([...this.childOwners.values()].map((owner) => owner.close()));
  }

  async stopAll(): Promise<void> {
    const plugins = new Set([...this.plugins.values(), ...this.retiredPlugins]);
    await Promise.all(
      [...plugins].map(async (plugin) => {
        await this.stopPlugin(plugin);
        if (this.plugins.get(plugin.id) === plugin) this.plugins.delete(plugin.id);
        this.retiredPlugins.delete(plugin);
      }),
    );
    await Promise.all([...this.childOwners.values()].map((owner) => owner.close()));
  }

  private ownChild(child: PluginChild): { close(): Promise<void> } {
    const existing = this.childOwners.get(child);
    if (existing) return existing;
    let closing: Promise<void> | null = null;
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    if (child.pid !== undefined)
      void prepareProcessTreeTermination(child, { timeoutMs: SOFT_SHUTDOWN_TIMEOUT_MS }).catch(
        () => undefined,
      );
    const owner = {
      close: (): Promise<void> => {
        if (closing) return closing;
        const attempt = (async () => {
          if (child.closeRuntime)
            await withTimeout(child.closeRuntime(), REQUEST_TIMEOUT_MS, "Plugin worker shutdown");
          else {
            const result = await terminateWithTreeKill(child, {
              gracefulTimeoutMs: SOFT_SHUTDOWN_TIMEOUT_MS,
              forceTimeoutMs: SOFT_SHUTDOWN_TIMEOUT_MS,
            });
            if (result === "kill-timeout") throw new Error("Plugin host process did not stop");
          }
          // A failed spawn has no OS execution or native output to drain.
          if (child.closeRuntime || child.pid !== undefined) await closed;
          this.childOwners.delete(child);
        })();
        closing = attempt;
        void attempt.catch(() => {
          if (closing === attempt) closing = null;
        });
        return attempt;
      },
    };
    this.childOwners.set(child, owner);
    return owner;
  }

  private async stopChild(child: PluginChild, error?: unknown): Promise<void> {
    const owner = this.ownChild(child);
    try {
      await owner.close();
    } catch (cleanupError) {
      throw new ProviderInitializationCleanupError(owner, error, cleanupError);
    }
  }

  private async loadDirectoryPlugin(
    pluginId: string,
    configuredPath: string,
  ): Promise<LoadedPlugin> {
    const directory = path.resolve(configuredPath);
    const manifest = await readPluginManifest(directory);
    assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
    const entryPaths = await resolveEntryPaths(directory);
    const bundles = await compilePlugin(entryPaths);
    const serverBundle = bundles.serverBundle;
    if (!serverBundle) {
      return {
        id: pluginId,
        clientBundle: bundles.clientBundle ?? "",
        requirements: manifest.requirements,
        methods: new Set(),
        hooks: { events: [], before: [] },
        providers: [],
        usageSources: [],
        child: null,
        outputCapture: null,
        pending: new Map(),
        providerConnections: new Map(),
        providerConnectionTombstones: new Set(),
        sessionSocket: null,
        sessionClosed: null,
      };
    }
    return this.launchPlugin({
      pluginId,
      pluginDirectory: directory,
      requirements: manifest.requirements,
      child: this.spawnChild(),
      bundle: serverBundle,
      clientBundle: bundles.clientBundle ?? "",
    });
  }

  private async launchPlugin(input: {
    pluginId: string;
    pluginDirectory: string;
    requirements: PluginRequirements | undefined;
    child: PluginChild;
    bundle: string;
    clientBundle: string;
  }): Promise<LoadedPlugin> {
    const { pluginId, requirements, child, bundle, clientBundle } = input;
    this.ownChild(child);
    const sessionHost = this.sessionHost;
    if (!sessionHost) throw new Error("Plugin Paseo session host is not attached");
    const outputCapture = new PluginOutputCapture(child, (stream, message) => {
      this.appendLog(pluginId, stream, message);
    });
    const session: PluginSessionBinding = {
      socket: new PluginSessionSocket(child),
      reattaching: false,
      plugin: null,
    };
    const pending = new Map<string, PendingInvocation>();
    const sessionAttachment = await sessionHost
      .attachPluginSocket(pluginId, session.socket)
      .catch(async (error) => {
        await this.stopChild(child, error);
        throw error;
      });
    let loaded: LoadedPlugin | null = null;
    let ready: Extract<PluginProcessMessage, { type: "ready" }>;
    try {
      ready = await new Promise<Extract<PluginProcessMessage, { type: "ready" }>>(
        (resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(
            () => fail(new Error(`Plugin ${pluginId} did not initialize`)),
            REQUEST_TIMEOUT_MS,
          );
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
          };
          child.on("message", (rawMessage) => {
            const parsed = PluginProcessMessageSchema.safeParse(rawMessage);
            if (!parsed.success) {
              const error = new Error(
                `Plugin ${pluginId} sent an invalid message: ${parsed.error.message}`,
              );
              if (loaded) this.handleMalformedChildMessage(loaded, rawMessage, error);
              else fail(error);
              return;
            }
            const message = parsed.data;
            if (message.type === "paseo_frame") {
              this.routePluginFrame({
                session,
                pluginId,
                child,
                sessionHost,
                frame: message.data,
                isBinary: message.isBinary,
              });
            } else if (message.type === "paseo_close") {
              session.socket.peerClosed();
            } else if (message.type === "ready") {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve(message);
            } else if (message.type === "fatal") {
              fail(new Error(message.error));
            } else if (loaded) {
              this.handleChildMessage(loaded, message);
            }
          });
          child.on("close", () => {
            session.socket.peerClosed();
            if (!loaded) {
              fail(new Error(`Plugin ${pluginId} exited during initialization`));
              return;
            }
            void this.handleChildClose(loaded);
          });
          void send(child, {
            type: "initialize",
            pluginId,
            pluginDirectory: input.pluginDirectory,
            appVersion: this.daemonVersion,
            bundle,
            settingsDirectory: this.dependencies.settingsDirectory
              ? path.join(this.dependencies.settingsDirectory, pluginId)
              : undefined,
          }).catch(fail);
        },
      );
    } catch (error) {
      session.socket.close();
      await sessionAttachment.closed;
      await this.stopChild(child, error);
      throw error;
    }
    loaded = {
      id: pluginId,
      clientBundle,
      requirements,
      methods: new Set(ready.methods),
      hooks: ready.hooks ?? { events: [], before: [] },
      providers: ready.providers ?? [],
      usageSources: ready.usageSources ?? [],
      child,
      outputCapture,
      pending,
      providerConnections: new Map(),
      providerConnectionTombstones: new Set(),
      sessionSocket: session.socket,
      sessionClosed: sessionAttachment.closed,
    };
    session.plugin = loaded;
    this.logger.info(
      { pluginId, methods: ready.methods, providers: ready.providers },
      "Loaded plugin",
    );
    return loaded;
  }

  /**
   * Frames still in flight belong to the closed session; only a fresh hello
   * means the child redialled and wants a new one. Attaching on the close
   * instead would leave a socket nobody speaks to until the host's hello
   * timeout closed it, and that close would attach another.
   */
  private routePluginFrame(input: PluginFrameInput): void {
    const { session, frame, isBinary } = input;
    if (session.socket.readyState === 1) {
      session.socket.receive(frame, isBinary);
      return;
    }
    if (session.reattaching || !isSessionHelloFrame({ frame, isBinary })) return;
    if (!this.canReattachPluginSession(input)) return;
    session.reattaching = true;
    void this.reattachPluginSession(input).finally(() => {
      session.reattaching = false;
    });
  }

  private async reattachPluginSession(input: PluginFrameInput): Promise<void> {
    const { session, pluginId, sessionHost, child, frame, isBinary } = input;
    const replacement = new PluginSessionSocket(child);
    try {
      const attachment = await sessionHost.attachPluginSocket(pluginId, replacement);
      if (!this.canReattachPluginSession(input)) {
        replacement.close();
        return;
      }
      session.socket = replacement;
      if (session.plugin) {
        session.plugin.sessionSocket = replacement;
        session.plugin.sessionClosed = attachment.closed;
      }
      replacement.receive(frame, isBinary);
      this.appendLog(pluginId, "stdout", "[paseo] Re-attached plugin session");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.appendLog(pluginId, "stderr", `[paseo] Failed to re-attach plugin session: ${reason}`);
      this.logger.warn({ pluginId, err: error }, "Failed to re-attach a plugin session");
      this.notify(pluginId, `Plugin session could not be re-attached: ${pluginId}`);
    }
  }

  /**
   * A published plugin whose process is still up. Anything else is either still
   * loading or being torn down, and must not get a new session.
   */
  private canReattachPluginSession(input: {
    session: PluginSessionBinding;
    pluginId: string;
    child: PluginChild;
  }): boolean {
    const { session, pluginId, child } = input;
    return (
      session.plugin !== null &&
      !session.plugin.stopping &&
      this.plugins.get(pluginId) === session.plugin &&
      child.connected
    );
  }

  private handleChildMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if (message.type === "shutdown_failed") {
      loaded.shutdownReceipt?.reject(new Error(message.error));
      return;
    }
    if (message.type === "shutdown_ready") {
      loaded.shutdownReceipt?.resolve();
      return;
    }
    if (message.type === "hooks.changed") {
      loaded.hooks = message.hooks;
      return;
    }
    if (message.type === "settings.changed") {
      this.dependencies.onSettingsChanged?.(loaded.id, message.settingsId);
      return;
    }
    if (message.type.startsWith("provider.")) {
      this.handleProviderMessage(loaded, message);
      return;
    }
    if (message.type !== "result" && message.type !== "error") return;
    const pending = loaded.pending.get(message.requestId);
    if (!pending) return;
    loaded.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.type === "result") pending.resolve(message.output);
    else pending.reject(new Error(message.error));
  }

  private handleProviderMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if (!("connectionId" in message)) return;
    const state = loaded.providerConnections.get(message.connectionId);
    if (!state) {
      if (!loaded.providerConnectionTombstones.has(message.connectionId)) return;
      if (message.type === "provider.connected" && loaded.child?.connected) {
        void send(loaded.child, {
          type: "provider.close",
          connectionId: message.connectionId,
        }).catch(() => undefined);
      }
      if (message.type === "provider.closed" || message.type === "provider.connect_failed") {
        loaded.providerConnectionTombstones.delete(message.connectionId);
      }
      return;
    }
    if (message.type === "provider.connected") {
      this.finishProviderConnect(loaded, message.connectionId, state, message);
      return;
    }
    if (message.type === "provider.connect_failed") {
      this.abandonProviderConnect(loaded, message.connectionId, state, new Error(message.error));
      return;
    }
    if (message.type === "provider.accepted" || message.type === "provider.rejected") {
      const pending = state.pendingSends.get(message.acceptanceId);
      if (!pending) return;
      state.pendingSends.delete(message.acceptanceId);
      if (message.type === "provider.accepted") {
        this.trackAcceptedProviderInput(state, pending.input);
        pending.resolve();
      } else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === "provider.event") {
      this.publishProviderEvent(loaded, message.connectionId, state, message.event);
      return;
    }
    if (message.type === "provider.close_failed") {
      state.rejectClosed(new Error(message.error));
      return;
    }
    if (message.type === "provider.closed") {
      loaded.providerConnections.delete(message.connectionId);
      if (message.error) {
        this.failRemoteProviderConnection(state, new Error(message.error));
        return;
      }
      state.closed = true;
      state.certifiedClosed = true;
      this.rejectProviderSends(state, "Provider connection closed");
      state.resolveClosed();
    }
  }

  private finishProviderConnect(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    message: Extract<PluginProcessMessage, { type: "provider.connected" }>,
  ): void {
    if (!Number.isInteger(message.version) || message.version < 1) {
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider selected invalid version: ${message.version}`),
      );
      return;
    }
    if (!state.request.versions.includes(message.version)) {
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider selected an unoffered version: ${message.version}`),
      );
      return;
    }
    const knownCapabilities = new Set<string>(PROVIDER_CAPABILITIES);
    const invalidCapability = message.capabilities.find(
      (capability) =>
        knownCapabilities.has(capability) && !state.request.capabilities.includes(capability),
    );
    if (invalidCapability) {
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider selected an unoffered capability: ${invalidCapability}`),
      );
      return;
    }
    const capabilities = PROVIDER_CAPABILITIES.filter((capability) =>
      message.capabilities.includes(capability),
    );
    const connection: ProviderConnection = {
      version: message.version,
      capabilities,
      send: (input) => this.sendProviderInput(loaded, connectionId, state, input),
      onEvent(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      close: () => this.closeProviderConnection(loaded, connectionId, state),
    };
    state.capabilities = capabilities;
    state.connected = true;
    state.resolveConnected(connection);
  }

  private abandonProviderConnect(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    error: Error,
  ): void {
    if (state.connected || state.closed) return;
    loaded.providerConnections.delete(connectionId);
    loaded.providerConnectionTombstones.add(connectionId);
    state.closed = true;
    state.rejectConnected(error);
    state.rejectClosed(error);
    if (loaded.child?.connected) {
      void send(loaded.child, { type: "provider.close", connectionId }).catch(() => undefined);
    }
  }

  private sendProviderInput(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    input: ProviderInput,
  ): Promise<void> {
    if (state.closed) return Promise.reject(new Error("Provider connection is closed"));
    if (state.closing) return Promise.reject(new Error("Provider connection is closing"));
    try {
      if (input.type === "session.open" || !("sessionId" in input)) {
        requireProviderCapabilities(state.capabilities, input);
      } else {
        const capabilities = state.sessions.get(input.sessionId);
        if (!capabilities) throw new Error(`Unknown provider session: ${input.sessionId}`);
        requireProviderCapabilities(capabilities, input);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const child = loaded.child;
    if (!child) return Promise.reject(new Error(`Plugin has no server entry: ${loaded.id}`));
    const acceptanceId = randomUUID();
    return new Promise((resolve, reject) => {
      state.pendingSends.set(acceptanceId, { input, resolve, reject });
      void send(child, {
        type: "provider.send",
        connectionId,
        acceptanceId,
        input: jsonTransportValue(input),
      }).catch((error) => {
        state.pendingSends.delete(acceptanceId);
        reject(error);
      });
    });
  }

  private closeProviderConnection(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
  ): Promise<void> {
    if (state.certifiedClosed || loaded.stopped) return Promise.resolve();
    if (state.closing) return state.closing;
    const child = loaded.child;
    if (!child) return Promise.reject(new Error(`Plugin has no server entry: ${loaded.id}`));
    const attempt = (async () => {
      if (!child.connected) {
        await this.stopChild(child);
        state.certifiedClosed = true;
        return;
      }
      state.closedPromise = new Promise<void>((resolve, reject) => {
        state.resolveClosed = resolve;
        state.rejectClosed = reject;
      });
      void state.closedPromise.catch(() => undefined);
      await send(child, { type: "provider.close", connectionId });
      await state.closedPromise;
    })();
    state.closing = attempt;
    void attempt.catch(() => {
      if (state.closing === attempt) state.closing = undefined;
    });
    return attempt;
  }

  private publishProviderEvent(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    event: ProviderEvent,
  ): void {
    if (
      event.type === "timeline.item" &&
      event.item.type === "plugin" &&
      event.item.pluginId !== loaded.id
    ) {
      this.failProviderConnection(
        loaded,
        connectionId,
        state,
        new Error(
          `Provider plugin ${loaded.id} cannot emit timeline items for ${event.item.pluginId}`,
        ),
      );
      return;
    }
    if (event.type === "session.opened") {
      const knownCapabilities = new Set<string>(PROVIDER_CAPABILITIES);
      const invalidCapability = event.capabilities.find(
        (capability) =>
          knownCapabilities.has(capability) && !state.capabilities.includes(capability),
      );
      if (invalidCapability) {
        this.failProviderConnection(
          loaded,
          connectionId,
          state,
          new Error(`Provider session selected an unoffered capability: ${invalidCapability}`),
        );
        return;
      }
      const selectedCapabilities = event.capabilities;
      event = {
        ...event,
        capabilities: PROVIDER_CAPABILITIES.filter((capability) =>
          selectedCapabilities.includes(capability),
        ),
      };
      if (
        event.parentSessionId &&
        !state.sessions.get(event.parentSessionId)?.includes("session.subsession")
      ) {
        this.failProviderConnection(
          loaded,
          connectionId,
          state,
          new Error(`Provider parent session did not negotiate session.subsession`),
        );
        return;
      }
    }
    if (event.type === "session.opened") {
      state.sessions.set(event.sessionId, event.capabilities);
    }
    for (const listener of state.listeners) listener(event);
    if (event.type === "session.closed") state.sessions.delete(event.sessionId);
  }

  private failProviderConnection(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    error: Error,
  ): void {
    this.failRemoteProviderConnection(state, error);
    void this.closeProviderConnection(loaded, connectionId, state).catch(() => undefined);
  }

  private trackAcceptedProviderInput(state: RemoteProviderConnection, input: ProviderInput): void {
    if (input.type === "session.open" && !state.sessions.has(input.sessionId)) {
      state.sessions.set(input.sessionId, []);
    }
    if (input.type === "session.close") state.sessions.delete(input.sessionId);
  }

  private handleMalformedChildMessage(
    loaded: LoadedPlugin,
    rawMessage: unknown,
    error: Error,
  ): void {
    const connectionId = readConnectionId(rawMessage);
    const state = connectionId ? loaded.providerConnections.get(connectionId) : undefined;
    if (!connectionId || !state) {
      this.appendLog(loaded.id, "stderr", `[paseo] ${error.message}`);
      if (loaded.child)
        void this.stopChild(loaded.child).catch((failure) =>
          this.logger.warn({ err: failure }, "Failed to stop malformed plugin host"),
        );
      return;
    }
    this.failProviderConnection(loaded, connectionId, state, error);
  }

  private failRemoteProviderConnection(state: RemoteProviderConnection, error: Error): void {
    if (state.closed) return;
    for (const sessionId of state.sessions.keys()) {
      const event: ProviderEvent = {
        type: "session.runtime_failed",
        sessionId,
        error: { message: error.message },
      };
      for (const listener of state.listeners) listener(event);
    }
    state.closed = true;
    state.rejectConnected(error);
    this.rejectProviderSends(state, error.message);
    state.rejectClosed(error);
  }

  private rejectProviderSends(state: RemoteProviderConnection, message: string): void {
    for (const pending of state.pendingSends.values()) pending.reject(new Error(message));
    state.pendingSends.clear();
  }

  private async handleChildClose(loaded: LoadedPlugin): Promise<void> {
    loaded.sessionSocket?.peerClosed();
    const wasPublished = this.plugins.get(loaded.id) === loaded;
    if (wasPublished && !loaded.preserveForRestart) {
      this.plugins.delete(loaded.id);
      this.retiredPlugins.add(loaded);
    }
    loaded.shutdownReceipt?.reject(
      new Error(`Plugin process exited before shutdown receipt: ${loaded.id}`),
    );
    this.rejectPending(loaded, `Plugin process exited: ${loaded.id}`);
    for (const state of loaded.providerConnections.values()) {
      this.failRemoteProviderConnection(state, new Error(`Plugin process exited: ${loaded.id}`));
    }
    await loaded.sessionClosed;
    if (wasPublished && !loaded.preserveForRestart)
      this.notify(loaded.id, `Plugin process exited: ${loaded.id}`);
  }

  private stopPlugin(loaded: LoadedPlugin): Promise<void> {
    if (loaded.stopped) return Promise.resolve();
    if (loaded.stopPromise) return loaded.stopPromise;
    const attempt = this.stopPluginRuntime(loaded);
    loaded.stopPromise = attempt;
    void attempt.catch(() => {
      if (loaded.stopPromise === attempt) loaded.stopPromise = undefined;
    });
    return attempt;
  }

  private async stopPluginRuntime(loaded: LoadedPlugin): Promise<void> {
    loaded.stopping = true;
    this.retiredPlugins.add(loaded);
    this.appendLog(loaded.id, "stdout", "[paseo] Stopping plugin");
    const { child, sessionSocket, sessionClosed } = loaded;
    if (!child || !sessionSocket || !sessionClosed) {
      loaded.stopped = true;
      this.retiredPlugins.delete(loaded);
      return;
    }
    if (child.pid !== undefined)
      await prepareProcessTreeTermination(child, { timeoutMs: SOFT_SHUTDOWN_TIMEOUT_MS });
    await Promise.all(
      [...loaded.providerConnections].map(async ([connectionId, state]) => {
        if (!state.connected) {
          this.abandonProviderConnect(
            loaded,
            connectionId,
            state,
            new Error(`Plugin stopped: ${loaded.id}`),
          );
          return;
        }
        await this.closeProviderConnection(loaded, connectionId, state);
      }),
    );
    if (child.connected) {
      if (child.pid !== undefined) {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((onResolve, onReject) => {
          resolve = onResolve;
          reject = onReject;
        });
        void promise.catch(() => undefined);
        loaded.shutdownReceipt = { promise, resolve, reject };
      }
      await send(child, { type: "shutdown" });
      if (loaded.shutdownReceipt)
        await withTimeout(
          loaded.shutdownReceipt.promise,
          REQUEST_TIMEOUT_MS,
          "Plugin shutdown receipt",
        );
    }
    await this.stopChild(child);
    sessionSocket.peerClosed();
    await sessionClosed;
    loaded.stopped = true;
    this.retiredPlugins.delete(loaded);
    this.rejectPending(loaded, `Plugin stopped: ${loaded.id}`);
    this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
  }

  private rejectPending(loaded: LoadedPlugin, message: string): void {
    for (const invocation of loaded.pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(new Error(message));
    }
    loaded.pending.clear();
  }

  private appendLog(pluginId: string, stream: PluginLogEntry["stream"], message: string): void {
    const boundedMessage = Buffer.from(message).subarray(0, MAX_LOG_LINE_BYTES).toString("utf8");
    let tail = this.logTails.get(pluginId);
    if (!tail) {
      tail = { entries: [], bytes: 0, nextSequence: 1 };
      this.logTails.set(pluginId, tail);
    }
    const entry: PluginLogEntry = {
      sequence: tail.nextSequence++,
      timestamp: new Date().toISOString(),
      stream,
      message: boundedMessage,
    };
    tail.entries.push(entry);
    tail.bytes += Buffer.byteLength(boundedMessage);
    while (tail.entries.length > MAX_LOG_ENTRIES || tail.bytes > MAX_LOG_BYTES) {
      const removed = tail.entries.shift();
      if (!removed) break;
      tail.bytes -= Buffer.byteLength(removed.message);
    }
    this.logger.info({ pluginId, ...entry }, "Plugin output");
  }

  private notify(pluginId: string, error?: string): void {
    for (const listener of this.listeners) listener(pluginId, error);
  }
}

function isSessionHelloFrame(input: { frame: string | Uint8Array; isBinary: boolean }): boolean {
  const { frame, isBinary } = input;
  if (isBinary || typeof frame !== "string") return false;
  try {
    return (JSON.parse(frame) as { type?: unknown }).type === "hello";
  } catch {
    return false;
  }
}

function readConnectionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const connectionId = Reflect.get(value, "connectionId");
  return typeof connectionId === "string" ? connectionId : null;
}
