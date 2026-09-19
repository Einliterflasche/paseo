import type {
  ServicePreviewCloseRequest,
  ServicePreviewCloseResponseMessage,
  ServicePreviewPrepareRequest,
  ServicePreviewPrepareResponseMessage,
} from "@getpaseo/protocol/messages";
import { PreviewProfileError, type createPreviewProfile } from "./preview-profile";

type PrepareInput = Omit<ServicePreviewPrepareRequest, "type" | "requestId">;
type CloseInput = Omit<ServicePreviewCloseRequest, "type" | "requestId">;
type PrepareResult = ServicePreviewPrepareResponseMessage["payload"]["result"];
export type PreparedPreview = Extract<PrepareResult, { status: "prepared" }>;

export interface PreviewClientPort {
  prepareServicePreview(input: PrepareInput): Promise<{ result: PrepareResult }>;
  closeServicePreview(input: CloseInput): Promise<ServicePreviewCloseResponseMessage["payload"]>;
}

export interface PreviewClientSource {
  client: PreviewClientPort;
  clientGeneration: number;
  connectionEpoch: number;
  routeRevision?: string;
}

export type PreviewOpenState =
  | { status: "idle" | "preparing" | "ready" | "loading" | "open" | "cancelling" | "closed" }
  | {
      status: "error";
      code:
        | "unavailable"
        | "connection-ended"
        | "close"
        | "storage"
        | "replaced"
        | "launch"
        | "denied";
      recovery: boolean;
    };

export interface PreviewCoordinatorPort {
  serviceId: string;
  mode: "iframe" | "tab";
  lifetime: AbortSignal;
  profile: ReturnType<typeof createPreviewProfile>;
  createId(): string;
  getSource(): PreviewClientSource | null;
  subscribeSource(listener: () => void): () => void;
  launch(prepared: PreparedPreview, options: PreviewLaunchOptions): void;
  reserveLaunch?(input: { attemptId: string; closed(): void }): PreviewLaunchReservation | null;
  onCloseFailure(): void | Promise<void>;
  clock?: {
    now(): number;
    schedule(input: { delayMs: number; callback(): void }): () => void;
  };
}

export interface PreviewLaunchReservation {
  launch(prepared: PreparedPreview, options: PreviewLaunchOptions): void;
  close(): void;
}

export interface PreviewLaunchOptions {
  signal: AbortSignal;
  reload: boolean;
}

interface Attempt {
  id: string;
  source: PreviewClientSource;
  prepared: PreparedPreview | null;
  sent: boolean;
  ended: boolean;
  closing: Promise<boolean> | null;
  navigation: AbortController;
  reload: boolean;
  expiresAt: number | null;
  cancelExpiry: (() => void) | null;
  reservation: PreviewLaunchReservation | null;
}

function sameSource(a: PreviewClientSource, b: PreviewClientSource | null): boolean {
  return (
    b !== null &&
    a.client === b.client &&
    a.clientGeneration === b.clientGeneration &&
    a.connectionEpoch === b.connectionEpoch &&
    a.routeRevision === b.routeRevision
  );
}

/** Owns one document's explicit opens. Placement and visibility never mutate authority. */
export function createPreviewCoordinator(port: PreviewCoordinatorPort) {
  const clock = port.clock ?? {
    now: () => performance.now(),
    schedule({ delayMs, callback }: { delayMs: number; callback(): void }) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  let state: PreviewOpenState = { status: "idle" };
  const listeners = new Set<() => void>();
  let attempt: Attempt | null = null;
  let closed = false;
  let recovery: { observed: string | null } | null = null;
  let cancellation: { attempt: Attempt | null } | null = null;

  function publish(next: PreviewOpenState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function reportCloseFailure(): Promise<void> {
    try {
      await port.onCloseFailure();
    } catch {
      /* Reporting cannot leave cleanup unhandled. */
    }
  }

  function end(previous: Attempt | null): Promise<boolean> {
    if (!previous) return Promise.resolve(true);
    if (previous.ended) return previous.closing ?? Promise.resolve(true);
    previous.ended = true;
    previous.cancelExpiry?.();
    previous.cancelExpiry = null;
    previous.prepared = null;
    previous.navigation.abort();
    previous.reservation?.close();
    previous.reservation = null;
    // Never send an old Close through a replacement physical source. Detach
    // already removes that source's authority on the server.
    if (previous.sent && sameSource(previous.source, port.getSource())) {
      previous.closing = previous.source.client
        .closeServicePreview({ attemptId: previous.id })
        .then((reply) => {
          if (reply.result.status !== "closed" || reply.result.attemptId !== previous.id) {
            throw new Error("Preview Close was refused");
          }
          return true;
        })
        .catch(() => {
          // This is a single best-effort Close, never queued or retried. Loss of
          // its source also revokes it. A still-connected failure remains visible.
          const sourceEnded = !sameSource(previous.source, port.getSource());
          if (!closed && attempt === previous && !sourceEnded) {
            publish({ status: "error", code: "connection-ended", recovery: false });
          }
          if (
            !sourceEnded &&
            (closed || (attempt !== previous && cancellation?.attempt !== previous))
          ) {
            void reportCloseFailure();
          }
          return sourceEnded;
        });
    }
    return previous.closing ?? Promise.resolve(true);
  }

  function current(value: Attempt): boolean {
    return (
      !closed && !value.ended && attempt === value && sameSource(value.source, port.getSource())
    );
  }

  function fail(value: Attempt, code: Extract<PreviewOpenState, { status: "error" }>["code"]) {
    if (!current(value)) return;
    end(value);
    publish({ status: "error", code, recovery: recovery !== null });
  }

  function launch() {
    const value = attempt;
    if (!value || !current(value) || !value.prepared) return;
    if (expired(value)) {
      expire(value);
      return;
    }
    const prepared = value.prepared;
    // Consume before invoking the browser. A throw or blocked popup requires
    // another explicit Open and a new attempt, never replay of this ticket.
    value.prepared = null;
    publish({ status: port.mode === "iframe" ? "loading" : "open" });
    if (!current(value)) return;
    if (expired(value)) {
      expire(value);
      return;
    }
    value.cancelExpiry?.();
    value.cancelExpiry = null;
    try {
      const options = { signal: value.navigation.signal, reload: value.reload };
      if (value.reservation) value.reservation.launch(prepared, options);
      else port.launch(prepared, options);
    } catch {
      fail(value, "launch");
    }
  }

  function expired(value: Attempt): boolean {
    return value.expiresAt !== null && clock.now() >= value.expiresAt;
  }

  function expire(value: Attempt): void {
    if (!current(value)) return;
    attempt = null;
    void end(value);
    // End never retries. A fresh user action is required to obtain another ticket.
    if (!closed && attempt === null) publish({ status: "idle" });
  }

  function reserve(value: Attempt): boolean {
    if (port.mode !== "tab" || !port.reserveLaunch) return true;
    value.reservation = port.reserveLaunch({
      attemptId: value.id,
      closed() {
        if (current(value)) coordinator.cancel();
      },
    });
    if (value.reservation) return true;
    fail(value, "launch");
    return false;
  }

  function acceptPrepared(value: Attempt, result: PreparedPreview, requestedAt: number): void {
    value.prepared = result;
    // COMPAT(preview-expiry): pre-field v1 replies use the same approved 60s
    // server contract. Remove when the pre-field v1 feature is retired.
    // Anchor before the RPC so network/delivery delay cannot extend validity.
    value.expiresAt = requestedAt + (result.expiresInMs ?? 60_000);
    if (expired(value)) {
      expire(value);
      return;
    }
    value.cancelExpiry = clock.schedule({
      delayMs: value.expiresAt - clock.now(),
      callback: () => {
        if (value.prepared && current(value)) expire(value);
      },
    });
    publish({ status: "ready" });
    // Embedded navigation needs no popup activation. A standalone reservation
    // was created synchronously by the user's original click, so it can also
    // navigate as soon as authorization is ready.
    if (port.mode === "iframe" || value.reservation) launch();
  }

  async function open(options?: { recover?: boolean; reload?: boolean }): Promise<void> {
    if (closed) return;
    cancellation = null;
    end(attempt);
    const source = port.getSource();
    if (!source) {
      attempt = null;
      publish({ status: "error", code: "unavailable", recovery: false });
      return;
    }
    const value: Attempt = {
      id: port.createId(),
      source,
      prepared: null,
      sent: false,
      ended: false,
      closing: null,
      navigation: new AbortController(),
      reload: options?.reload === true,
      expiresAt: null,
      cancelExpiry: null,
      reservation: null,
    };
    attempt = value;
    if (!reserve(value)) return;
    const requestedRecovery = options?.recover ? recovery : null;
    recovery = null;
    publish({ status: "preparing" });
    let handle: string;
    try {
      handle = requestedRecovery
        ? await port.profile.recover(requestedRecovery.observed)
        : await port.profile.read();
    } catch (error) {
      if (!current(value)) return;
      if (error instanceof PreviewProfileError) recovery = { observed: error.observed };
      fail(value, "storage");
      return;
    }
    if (!current(value)) return;
    try {
      value.sent = true;
      const requestedAt = clock.now();
      const { result } = await source.client.prepareServicePreview({
        attemptId: value.id,
        browserHandle: handle,
        serviceId: port.serviceId,
        mode: port.mode,
      });
      if (!current(value)) return;
      if (result.status === "error") {
        if (result.code === "browser-session-replaced") recovery = { observed: handle };
        fail(value, result.code === "browser-session-replaced" ? "replaced" : "unavailable");
        return;
      }
      if (
        result.attemptId !== value.id ||
        result.serviceId !== port.serviceId ||
        result.mode !== port.mode
      ) {
        fail(value, "denied");
        return;
      }
      acceptPrepared(value, result, requestedAt);
    } catch {
      fail(value, "connection-ended");
    }
  }

  const unsubscribe = port.subscribeSource(() => {
    if (!closed && attempt && !attempt.ended && !sameSource(attempt.source, port.getSource())) {
      end(attempt);
      publish({ status: "error", code: "connection-ended", recovery: false });
    }
  });
  function close() {
    if (closed) return;
    closed = true;
    cancellation = null;
    end(attempt);
    unsubscribe();
    port.lifetime.removeEventListener("abort", close);
    publish({ status: "closed" });
    listeners.clear();
  }
  port.lifetime.addEventListener("abort", close, { once: true });
  if (port.lifetime.aborted) close();

  const coordinator = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    launch,
    cancel() {
      if (closed || cancellation !== null) return;
      const previous = attempt;
      const token = { attempt: previous };
      cancellation = token;
      attempt = null;
      recovery = null;
      publish({ status: "cancelling" });
      void end(previous).then((confirmed) => {
        if (closed || cancellation !== token) return;
        cancellation = null;
        if (confirmed) publish({ status: "idle" });
        else publish({ status: "error", code: "close", recovery: false });
        return undefined;
      });
    },
    navigationCompleted(attemptId: string, success: boolean) {
      if (!attempt || attempt.id !== attemptId || !current(attempt) || state.status !== "loading")
        return;
      if (success) publish({ status: "open" });
      else fail(attempt, "denied");
    },
    close,
  };
  return coordinator;
}
