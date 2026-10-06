import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PreviewBroker } from "./broker.js";
import { openPreviewAuthorityServer } from "./authority-server.js";
import type { PreviewBrokerMessage } from "./channel.js";
import { createPreviewIpcChannel } from "./ipc-channel.js";
import {
  PreviewWorkerReadySchema,
  PreviewWorkerFailureSchema,
  previewWorkerErrorCode,
  PreviewWorkerSocketPathSchema,
  type PreviewWorkerStart,
} from "./worker-protocol.js";

export interface PreviewWorkerDiagnostic {
  event:
    | "spawn"
    | "ready"
    | "exit"
    | "disconnect"
    | "process-error"
    | "startup-failed"
    | "protocol-error"
    | "send-error"
    | "close-requested";
  pid: number | null;
  parentPid: number;
  startTicks: string | null;
  ready: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  code?: ReturnType<typeof previewWorkerErrorCode>;
  step?: "oom-preference" | "gateway" | "listen";
}

interface PreviewWorkerOptions {
  broker: PreviewBroker;
  socketPath: string;
  controlCookieNames: readonly string[];
  nodeExecutable?: string;
  onFailure(error: unknown): void | Promise<void>;
  onDiagnostic?(event: PreviewWorkerDiagnostic): void;
}

const attached = new WeakSet<PreviewBroker>();

/** Optional isolated feature lifetime. No public listener or automatic restart. */
export function startPreviewGatewayWorker({
  broker,
  socketPath,
  controlCookieNames,
  nodeExecutable = process.execPath,
  onFailure,
  onDiagnostic,
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
  let startTicks: string | null = null;
  let becameReady = false;
  function diagnostic(
    event: PreviewWorkerDiagnostic["event"],
    details: Pick<PreviewWorkerDiagnostic, "exitCode" | "signal" | "code" | "step"> = {},
  ) {
    try {
      onDiagnostic?.({
        event,
        pid: worker.pid ?? null,
        parentPid: process.pid,
        startTicks,
        ready: becameReady,
        ...details,
      });
    } catch {
      /* Diagnostics cannot change authority retirement or child cleanup. */
    }
  }
  worker.once("spawn", () => {
    if (process.platform === "linux" && worker.pid !== undefined) {
      try {
        const stat = readFileSync(`/proc/${worker.pid}/stat`, "utf8");
        const fields = stat
          .slice(stat.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/);
        if (Number(fields[1]) === process.pid && /^\d+$/.test(fields[19] ?? ""))
          startTicks = fields[19]!;
      } catch {
        /* An already-ended child has no observable creation identity. */
      }
    }
    diagnostic("spawn");
  });
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
  worker.on("exit", (exitCode, signal) => {
    diagnostic("exit", { exitCode, signal });
    end();
  });
  worker.on("disconnect", () => {
    diagnostic("disconnect");
    end();
  });
  worker.on("error", (error) => {
    diagnostic("process-error", { code: previewWorkerErrorCode(error) });
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
    diagnostic("close-requested");
    authority.close();
    if (worker.pid !== undefined && worker.exitCode === null) worker.kill("SIGTERM");
  }
  broker.closedSignal.addEventListener("abort", close, { once: true });
  void closed.then(() => broker.closedSignal.removeEventListener("abort", close));
  if (broker.isClosed) close();
  worker.on("message", (raw: unknown) => {
    if (raw && typeof raw === "object" && "type" in raw && raw.type === "preview-authority") return;
    const failure = PreviewWorkerFailureSchema.safeParse(raw);
    if (failure.success && failure.data.channelId === channelId && !readySettled) {
      diagnostic("startup-failed", { step: failure.data.step, code: failure.data.code });
      authority.close();
      return;
    }
    const result = PreviewWorkerReadySchema.safeParse(raw);
    if (!result.success || result.data.channelId !== channelId || readySettled) {
      diagnostic("protocol-error");
      authority.close();
      return;
    }
    if (lifetime.signal.aborted) return;
    readySettled = true;
    becameReady = true;
    diagnostic("ready");
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
      if (error) {
        diagnostic("send-error", { code: previewWorkerErrorCode(error) });
        authority.close();
      }
    });
  } catch (error) {
    diagnostic("send-error", { code: previewWorkerErrorCode(error) });
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
