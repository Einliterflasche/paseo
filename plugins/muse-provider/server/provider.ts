import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  type ProviderStatus,
  type ProviderProcessLifecycle,
  type ProviderProcessOwner,
} from "@getpaseo/plugin/server/provider";
import { serveArgs } from "./options.js";
import { Usage } from "./usage.js";
import { execFile, type ExecFileException } from "node:child_process";
import { Catalog, launchKey } from "./catalog.js";
import { MspConnection } from "./connection.js";
import { MuseError, actionableError } from "./errors.js";
import { Sessions } from "./sessions.js";
import { Session } from "./session.js";
import { accountSchema } from "./wire.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "permission",
  "session.list",
] as const;

export function createMuseProvider(usage: Usage): ProviderRegistration {
  return {
    id: "muse",
    label: "Muse Code",
    icon: "icon.svg",
    command: ["muse"],
    async getCatalogCacheKey(options) {
      return launchKey(requireLaunch(options.launch));
    },
    async status({ launch, processes }) {
      if (!launch)
        return { available: false, diagnostic: "Install Muse Code and ensure `muse` is on PATH." };
      usage.remember(launch, processes);
      return status(launch, processes);
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new MuseError("protocol", "Provider protocol version 1 is required");
      usage.remember(requireLaunch(request.launch), request.processes);
      return connect(
        requireLaunch(request.launch),
        negotiateProviderCapabilities(request.capabilities, capabilities),
        usage,
        request.processes,
      );
    },
  };
}
function requireLaunch(launch: ProviderLaunch | undefined): ProviderLaunch {
  if (!launch) throw new MuseError("missingLaunch", "Muse requires a daemon-resolved executable");
  return launch;
}
async function status(
  launch: ProviderLaunch,
  processes?: ProviderProcessLifecycle,
): Promise<ProviderStatus> {
  let host: MspConnection | undefined;
  try {
    let ownership: ProviderProcessOwner | undefined;
    const version = await new Promise<{ error: ExecFileException | null; stdout: string }>(
      (resolve) => {
        const child = execFile(
          launch.command,
          [...launch.args, "--version"],
          { env: launch.env, timeout: 3000, maxBuffer: 8192 },
          (error, stdout) => resolve({ error, stdout }),
        );
        ownership = processes?.own({ process: child });
      },
    );
    await ownership?.close({
      completedExecution:
        !version.error ||
        (typeof version.error.code === "number" && !version.error.killed && !version.error.signal),
    });
    if (version.error) throw new MuseError("version", version.error.message);
    const versionText = version.stdout;
    const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(versionText);
    if (!match) return { available: false, diagnostic: "Muse returned an unrecognized version." };
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 1 || (major === 1 && minor < 3))
      return { available: false, diagnostic: `Update Muse Code: found ${match[0]}, need ≥1.3.0` };
    host = new MspConnection({ launch, timeoutMs: 3000, processes });
    await host.initialize();
    const account = await host.request("account/read", {}, accountSchema);
    if (account.state === "loggedOut")
      return { available: false, diagnostic: "Run `muse login` or set META_API_KEY" };
    return { available: true };
  } catch (error) {
    return { available: false, diagnostic: actionableError(error, launch).message };
  } finally {
    await host?.close();
  }
}
function connect(
  launch: ProviderLaunch,
  negotiated: readonly string[],
  usage: Usage,
  processes?: ProviderProcessLifecycle,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const catalog = new Catalog(processes);
  const imports = new Sessions(processes);
  let closed = false;
  let admissionClosed = false;
  let closePromise: Promise<void> | null = null;
  const dispatches = new Set<Promise<void>>();
  function emit(event: ProviderEvent): void {
    if (!closed) for (const listener of listeners) listener(event);
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "sessions") {
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: await imports.list(launch, input),
      });
      return;
    }
    if (input.type === "catalog") {
      emit({ type: "catalog", requestId: input.requestId, catalog: await catalog.read(launch) });
      return;
    }
    if (input.type === "session.open") {
      if (sessions.has(input.sessionId))
        throw new MuseError("duplicateSession", "Muse session is already open");
      const session = new Session({
        id: input.sessionId,
        config: input.config,
        launch,
        processes,
        emit,
        capabilities: negotiated,
        serveArgs: serveArgs(input.config.providerOptions),
      });
      sessions.set(input.sessionId, session);
      try {
        await session.open(input);
        usage.attach(
          input.sessionId,
          { ...launch, env: { ...launch.env, ...input.config.env } },
          () => session.readUsage(),
          processes,
        );
      } catch (error) {
        await session.close();
        sessions.delete(input.sessionId);
        throw error;
      }
      return;
    }
    if (!("sessionId" in input))
      throw new MuseError("unsupported", `Muse does not support ${input.type}`);
    const session = sessions.get(input.sessionId);
    if (!session) throw new MuseError("unknownSession", "Muse session is not open");
    switch (input.type) {
      case "session.prompt":
        await session.prompt(input.prompt);
        return;
      case "session.configure":
        await session.configure(input.changes);
        break;
      case "session.permission":
        await session.answer(input.permissionId, input.response);
        return;
      case "session.interrupt":
        await session.interrupt();
        break;
      case "session.close":
        await session.close();
        sessions.delete(input.sessionId);
        usage.detach(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      default:
        throw new MuseError("unsupported", `Muse does not support ${input.type}`);
    }
    if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
  }
  function failed(input: ProviderInput, failure: unknown): void {
    const error = actionableError(failure, launch);
    if (input.type === "session.prompt")
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
    else if ("requestId" in input)
      emit({ type: "request.failed", requestId: input.requestId, error });
    else if ("sessionId" in input)
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (admissionClosed) throw new MuseError("closed", "Muse connection is closed");
      requireProviderCapabilities(negotiated, input);
      queueMicrotask(() => {
        if (closed) return;
        const operation = dispatch(input).catch((error: unknown) => failed(input, error));
        dispatches.add(operation);
        void operation.then(() => dispatches.delete(operation));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closePromise) return closePromise;
      admissionClosed = true;
      const attempt = (async () => {
        // Include accepted microtasks before collecting their runtime owners.
        await Promise.resolve();
        await Promise.all([
          catalog.close(),
          imports.close(),
          ...[...sessions.values()].map((session) => session.close()),
        ]);
        await Promise.all(dispatches);
        for (const id of sessions.keys()) usage.detach(id);
        sessions.clear();
        closed = true;
        listeners.clear();
      })();
      closePromise = attempt;
      void attempt.catch(() => {
        if (closePromise === attempt) closePromise = null;
      });
      return attempt;
    },
  };
}
