import { decorateOpenCodeV2Env, materializeOpenCodeV2Plugin } from "../bridge.js";
import { resolvePaseoHome } from "../../../../paseo-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import { spawnProcess } from "../../../../../utils/spawn.js";
import {
  prepareProcessTreeTermination,
  terminateWithTreeKill,
} from "../../../../../utils/tree-kill.js";
import { ProviderInitializationCleanupError } from "../../../provider-initialization-cleanup-error.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { OpenCodeHttpError } from "../http-error.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";

export interface V2Connection {
  client: V2Api;
  prepareRelease(): Promise<void>;
  release(): Promise<void>;
  retain(): V2Connection;
  readonly exited: Promise<Error>;
}
interface Generation {
  client: V2Api;
  users: number;
  prepare(): Promise<void>;
  stop(): Promise<void>;
  running: boolean;
  exited: Promise<Error>;
}
export interface V2RuntimeOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  decorateEnv?: (env: Record<string, string>) => Promise<Record<string, string>>;
}

export interface V2RuntimeAcquireOptions {
  fresh?: boolean;
  dedicated?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: Promise<Generation> | null = null;
  private generations = new Set<Generation>();
  private starts = new Set<Promise<Generation>>();
  private readonly pendingAcquisitions = new Map<Promise<Generation>, number>();
  private readonly processOwners = new Set<{ close(): Promise<void> }>();
  private closed = false;

  constructor(private readonly options: V2RuntimeOptions) {}

  async acquire(input: V2RuntimeAcquireOptions = {}): Promise<V2Connection> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    let pending: Promise<Generation>;
    if (input.env || input.dedicated) {
      pending = this.startTracked(input.env);
    } else {
      if (input.fresh || !this.current) this.current = this.startTracked();
      pending = this.current;
    }
    this.pendingAcquisitions.set(pending, (this.pendingAcquisitions.get(pending) ?? 0) + 1);
    let generation: Generation;
    try {
      generation = await raceProviderRefreshAbort(input.signal, pending);
    } catch (error) {
      this.releasePendingAcquisition(pending);
      await this.settleFailedAcquisition(pending, input.signal);
      throw error;
    }
    this.releasePendingAcquisition(pending);
    if (!generation.running || !this.generations.has(generation)) {
      if (this.current === pending) this.current = null;
      throw new Error("OpenCode helper server exited");
    }
    const connection = this.lease(generation, pending);
    if (input.signal?.aborted || this.closed) {
      await connection.release();
      input.signal?.throwIfAborted();
      throw new Error("OpenCode runtime is closed");
    }
    return connection;
  }

  private async settleFailedAcquisition(
    pending: Promise<Generation>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!signal?.aborted) {
      if (this.current === pending) this.current = null;
      return;
    }
    const started = await pending.catch((startError: unknown) => {
      if (startError instanceof ProviderInitializationCleanupError) throw startError;
      return null;
    });
    if (started && started.users === 0 && !this.pendingAcquisitions.has(pending)) {
      if (this.current === pending) this.current = null;
      await started.stop();
      this.generations.delete(started);
    }
  }

  private releasePendingAcquisition(pending: Promise<Generation>): void {
    const remaining = (this.pendingAcquisitions.get(pending) ?? 1) - 1;
    if (remaining === 0) this.pendingAcquisitions.delete(pending);
    else this.pendingAcquisitions.set(pending, remaining);
  }

  private lease(generation: Generation, pending: Promise<Generation>): V2Connection {
    if (this.closed || !generation.running || !this.generations.has(generation))
      throw new Error("OpenCode helper server is no longer running");
    generation.users += 1;
    let released = false;
    let releasing: Promise<void> | null = null;
    const release = (): Promise<void> => {
      if (releasing) return releasing;
      if (!released) {
        released = true;
        generation.users -= 1;
      }
      const attempt = (async () => {
        if (generation.users !== 0 || this.pendingAcquisitions.has(pending)) return;
        if (this.current === pending) this.current = null;
        await generation.stop();
        this.generations.delete(generation);
      })();
      releasing = attempt;
      void attempt.catch(() => {
        if (releasing === attempt) releasing = null;
      });
      return attempt;
    };
    return {
      client: generation.client,
      prepareRelease: () => generation.prepare(),
      release,
      retain: () => {
        if (released) throw new Error("OpenCode connection lease is released");
        return this.lease(generation, pending);
      },
      exited: generation.exited,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starts);
    await Promise.all([...this.processOwners].map((owner) => owner.close()));
    this.generations.clear();
    this.current = null;
  }

  private startTracked(env?: Record<string, string>): Promise<Generation> {
    const pending = this.start(env);
    this.starts.add(pending);
    void pending.then(
      (generation) =>
        generation.exited.then(() => {
          if (this.current === pending) this.current = null;
          return undefined;
        }),
      () => undefined,
    );
    void pending.then(
      () => this.starts.delete(pending),
      () => this.starts.delete(pending),
    );
    return pending;
  }

  private async start(env: Record<string, string> = {}): Promise<Generation> {
    const { settings, managedProcesses, logger } = this.options;
    const launch = await resolveProviderLaunch({
      commandConfig: settings?.command,
      defaultBinary: "opencode",
    });
    const cwd = resolveOpenCodeHomeDir();
    await mkdir(cwd, { recursive: true });
    const password = randomBytes(32).toString("base64url");
    const inheritedConfig = globalThis.process.env.OPENCODE_CONFIG_CONTENT;
    const configured = {
      ...(inheritedConfig ? { OPENCODE_CONFIG_CONTENT: inheritedConfig } : {}),
      ...settings?.env,
      ...env,
    };
    const decorated = this.options.decorateEnv
      ? await this.options.decorateEnv(configured)
      : decorateOpenCodeV2Env(configured, await materializeOpenCodeV2Plugin(resolvePaseoHome()));
    const args = [...launch.args, "serve", "--hostname", "127.0.0.1", "--port", "0"];
    const process = spawnProcess(launch.command, args, {
      cwd,
      detached: globalThis.process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        runtimeSettings: settings,
        overlays: [{ ...decorated, OPENCODE_PASSWORD: password }],
      }),
    });
    const processAbort = new AbortController();
    const exited = new Promise<Error>((resolve) =>
      process.once("exit", (code) => {
        const error = new Error(`OpenCode helper server exited (${code})`);
        processAbort.abort(error);
        resolve(error);
      }),
    );
    let stopped: Promise<void> | undefined;
    const record =
      process.pid && managedProcesses
        ? managedProcesses
            .record({
              owner: { provider: "opencode", kind: "helper-server" },
              pid: process.pid,
              command: launch.command,
              args,
            })
            .catch((error: unknown) => {
              logger.warn({ error }, "Could not record OpenCode helper process");
              return null;
            })
        : Promise.resolve(null);
    const prepare = () => prepareProcessTreeTermination(process, { timeoutMs: 5_000 });
    let generation: Generation | undefined;
    const ownership = {
      close: (): Promise<void> => {
        if (stopped) return stopped;
        const attempt = (async () => {
          await prepare();
          const result = await terminateWithTreeKill(process, {
            gracefulTimeoutMs: 5_000,
            forceTimeoutMs: 1_000,
          });
          if (result === "kill-timeout") throw new Error("OpenCode helper process did not stop");
          const entry = await record;
          if (entry) await managedProcesses?.remove(entry.id);
          this.processOwners.delete(ownership);
          if (generation) {
            generation.running = false;
            this.generations.delete(generation);
          }
        })();
        stopped = attempt;
        void attempt.catch(() => {
          if (stopped === attempt) stopped = undefined;
        });
        return attempt;
      },
    };
    this.processOwners.add(ownership);
    const stop = ownership.close;
    // Capture the tree while the leader exists, before readiness or native stop can retire it.
    const prepared = prepare();
    void prepared.catch(() => undefined);
    const deadline = Date.now() + 30_000;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("OpenCode v2 server startup timed out after 30s")),
          30_000,
        );
        let buffer = "";
        const finish = (result: string | Error) => {
          clearTimeout(timer);
          process.stdout?.off("data", onData);
          process.off("error", onError);
          process.off("exit", onExit);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-8192);
          const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
          if (match) finish(match[1]);
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) =>
          finish(new Error(`OpenCode v2 server exited during startup (${code})`));
        process.stdout?.on("data", onData);
        process.once("error", onError);
        process.once("exit", onExit);
        // Drain stderr without retaining provider output that may contain credentials.
        process.stderr?.on("data", () => undefined);
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: async (request, init) => {
          const signal = init?.signal
            ? AbortSignal.any([init.signal, processAbort.signal])
            : processAbort.signal;
          const response = await fetch(request, { ...init, signal });
          const html = response.headers.get("content-type")?.includes("text/html") ?? false;
          if (!response.ok || html) {
            const requestUrl = request instanceof Request ? request.url : String(request);
            throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
          }
          return response;
        },
      });
      await client.server.info({ signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      await prepared;
      generation = { client, users: 0, prepare, stop, exited, running: true };
      this.generations.add(generation);
      process.once("exit", () => {
        if (generation) generation.running = false;
        void stop().catch((error: unknown) =>
          logger.warn({ error }, "OpenCode process cleanup failed"),
        );
      });
      return generation;
    } catch (error) {
      try {
        await stop();
      } catch (cleanupError) {
        throw new ProviderInitializationCleanupError(ownership, error, cleanupError);
      }
      throw error;
    }
  }
}
