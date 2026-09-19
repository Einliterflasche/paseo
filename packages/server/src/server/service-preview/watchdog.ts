import { randomUUID } from "node:crypto";
import { previewClock, PREVIEW_WATCHDOG_MS, type PreviewClock } from "./clock.js";

interface PreviewWatchdogOptions {
  sendProbe(challenge: string): void | PromiseLike<void>;
  clock?: PreviewClock;
}

interface Probe {
  challenge: string;
  sentAt: number;
}

export class PreviewWatchdogError extends Error {
  constructor(readonly code: "timeout" | "transport-closed" | "probe-failed") {
    super(`preview-watchdog-${code}`);
    this.name = "PreviewWatchdogError";
  }
}

/**
 * One gateway-side IPC lifetime. A new connection needs a new owner; an expired
 * owner cannot recover. Use in the gateway process, never as a broker-side timer.
 */
export class PreviewGatewayWatchdog {
  private readonly clock: PreviewClock;
  private readonly sendProbe: PreviewWatchdogOptions["sendProbe"];
  private readonly controller = new AbortController();
  private readonly finishReady: () => void;
  private readonly failReady: (error: PreviewWatchdogError) => void;
  readonly ready: Promise<void>;
  readonly signal = this.controller.signal;
  private deadline: number;
  private confirmed = false;
  private probe: Probe | null = null;
  private cancelExpiry: (() => void) | null = null;
  private cancelRenewal: (() => void) | null = null;

  constructor({ sendProbe, clock = previewClock }: PreviewWatchdogOptions) {
    this.clock = clock;
    this.sendProbe = sendProbe;
    this.deadline = clock.now() + PREVIEW_WATCHDOG_MS;
    let resolve = () => {};
    let reject = (_error: PreviewWatchdogError) => {};
    this.ready = new Promise<void>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    this.finishReady = resolve;
    this.failReady = reject;
    // The owner may be closed before its caller starts awaiting readiness.
    this.ready.catch(() => {});
    this.armExpiry();
    this.requestProbe();
  }

  isCurrent(): boolean {
    return this.checkDeadline() && this.confirmed;
  }

  acknowledge(challenge: string): boolean {
    if (!this.checkDeadline() || this.probe?.challenge !== challenge) return false;
    const { sentAt } = this.probe;
    this.probe = null;
    // Queued replies cannot turn old broker activity into a new 15-second lease.
    this.deadline = sentAt + PREVIEW_WATCHDOG_MS;
    this.confirmed = true;
    this.finishReady();
    this.armExpiry();
    // Renew halfway through the approved interval, allowing the reply time to
    // arrive before the existing deadline. Only one challenge is outstanding.
    this.cancelRenewal = this.clock.schedule({
      delayMs: Math.max(0, sentAt + PREVIEW_WATCHDOG_MS / 2 - this.clock.now()),
      callback: () => {
        this.cancelRenewal = null;
        this.requestProbe();
      },
    });
    return true;
  }

  close(): void {
    this.end("transport-closed");
  }

  private checkDeadline(): boolean {
    if (!this.signal.aborted && this.clock.now() >= this.deadline) this.end("timeout");
    return !this.signal.aborted;
  }

  private requestProbe(): void {
    if (!this.checkDeadline() || this.probe) return;
    this.probe = { challenge: randomUUID(), sentAt: this.clock.now() };
    try {
      Promise.resolve(this.sendProbe(this.probe.challenge)).catch(() => this.end("probe-failed"));
    } catch {
      this.end("probe-failed");
    }
  }

  private armExpiry(): void {
    this.cancelExpiry?.();
    if (!this.checkDeadline()) return;
    this.cancelExpiry = this.clock.schedule({
      delayMs: this.deadline - this.clock.now(),
      callback: () => {
        this.cancelExpiry = null;
        // Re-arm an early callback; synchronous guards enforce a late callback.
        this.armExpiry();
      },
    });
  }

  private end(code: PreviewWatchdogError["code"]): void {
    if (this.signal.aborted) return;
    const error = new PreviewWatchdogError(code);
    this.cancelExpiry?.();
    this.cancelRenewal?.();
    this.cancelExpiry = null;
    this.cancelRenewal = null;
    this.probe = null;
    this.controller.abort(error);
    this.failReady(error);
  }
}
