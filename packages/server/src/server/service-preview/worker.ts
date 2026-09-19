import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PreviewBroker } from "./broker.js";
import { openPreviewAuthorityServer } from "./authority-server.js";
import type { PreviewBrokerMessage } from "./channel.js";
import { createPreviewIpcChannel } from "./ipc-channel.js";
import {
  PreviewWorkerReadySchema,
  PreviewWorkerSocketPathSchema,
  type PreviewWorkerStart,
} from "./worker-protocol.js";

interface PreviewWorkerOptions {
  broker: PreviewBroker;
  socketPath: string;
  controlCookieNames: readonly string[];
  nodeExecutable?: string;
  onFailure(error: unknown): void | Promise<void>;
}

const attached = new WeakSet<PreviewBroker>();

/** Optional isolated feature lifetime. No public listener or automatic restart. */
export function startPreviewGatewayWorker({
  broker,
  socketPath,
  controlCookieNames,
  nodeExecutable = process.execPath,
  onFailure,
}: PreviewWorkerOptions) {
  PreviewWorkerSocketPathSchema.parse(socketPath);
  if (broker.isClosed || attached.has(broker)) throw new Error("preview-broker-already-attached");
  attached.add(broker);
  const source = import.meta.url.endsWith(".ts");
  const worker = fork(
    new URL(source ? "./worker-process.ts" : "./worker-process.js", import.meta.url),
    [],
    {
      execPath: nodeExecutable,
      execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const lifetime = new AbortController();
  const channelId = randomUUID();
  let readySettled = false;
  let resolveReady = () => {};
  let rejectReady = (_error: Error) => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const closed = new Promise<void>((resolve) => {
    // We own no piped stdio. Exit proves a spawned gateway released its kernel
    // sockets; failed spawn instead emits close without exit. Node's explicit
    // IPC disconnect can suppress close after normal exit, so observe both.
    worker.once("exit", () => resolve());
    worker.once("close", () => resolve());
  });
  function end(): void {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("preview-worker-ended-before-ready"));
    }
  }
  async function report(error: Error): Promise<void> {
    try {
      await onFailure(error);
    } catch {
      // Diagnostic failures cannot prevent resource completion.
    }
  }
  worker.on("exit", end);
  worker.on("disconnect", end);
  worker.on("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    end();
    void report(error);
  });
  const channel = createPreviewIpcChannel<PreviewBrokerMessage>({
    signal: lifetime.signal,
    send(frame, completed) {
      worker.send(frame, completed);
    },
    subscribe(receive) {
      worker.on("message", receive);
      return () => {
        worker.off("message", receive);
      };
    },
    disconnect() {
      // Node owns IPC cleanup after failed spawn. Disconnecting inside that
      // error event can suppress its subsequent close event (no child exists).
      if (worker.pid !== undefined && worker.connected) worker.disconnect();
      end();
    },
  });
  const authority = openPreviewAuthorityServer({
    channelId,
    channel,
    broker,
    // This parent feature owner retires the broker on worker loss. Child gateway
    // disposal only closes its channel; it never invokes a global broker RPC.
    onClosed: () => broker.close(),
    onFailure,
  });
  let stopping = false;
  function close(): void {
    if (stopping) return;
    stopping = true;
    authority.close();
    if (worker.pid !== undefined && worker.exitCode === null) worker.kill("SIGTERM");
  }
  broker.closedSignal.addEventListener("abort", close, { once: true });
  void closed.then(() => broker.closedSignal.removeEventListener("abort", close));
  if (broker.isClosed) close();
  worker.on("message", (raw: unknown) => {
    if (raw && typeof raw === "object" && "type" in raw && raw.type === "preview-authority") return;
    const result = PreviewWorkerReadySchema.safeParse(raw);
    if (!result.success || result.data.channelId !== channelId || readySettled) {
      authority.close();
      return;
    }
    if (lifetime.signal.aborted) return;
    readySettled = true;
    resolveReady();
  });
  const config: PreviewWorkerStart = {
    type: "preview-start",
    channelId,
    socketPath,
    controlOrigin: broker.sources.controlOrigin,
    controlCookieNames: [...controlCookieNames],
  };
  try {
    worker.send(config, (error) => {
      if (error) authority.close();
    });
  } catch {
    authority.close();
  }
  return {
    ready,
    closed,
    pid: worker.pid,
    socketPath,
    close,
    async settled(): Promise<void> {
      try {
        await authority.settled();
      } catch (error) {
        if (!broker.isClosed) throw error;
        // A terminal channel cannot acknowledge cancellations. Kernel resource
        // release by the owned child is the remaining teardown proof, including
        // the failed-spawn close event when no process was ever created.
        close();
        await closed;
      }
    },
  };
}
