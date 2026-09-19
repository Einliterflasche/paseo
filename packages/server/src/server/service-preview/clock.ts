export interface PreviewClock {
  /** Monotonic milliseconds, independent of wall-clock adjustments. */
  now(): number;
  schedule(options: { delayMs: number; callback(): void }): () => void;
}

export const previewClock: PreviewClock = {
  now: () => performance.now(),
  schedule({ delayMs, callback }) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

// Approved by the operator; these are authorization lifetimes, not data retention.
export const PREVIEW_OPEN_EXPIRY_MS = 60_000;
export const PREVIEW_WATCHDOG_MS = 15_000;
