import type { AgentProbeContext } from "./agent-sdk-types.js";
import {
  ProviderInitializationCleanupError,
  type ProviderCleanupOwner,
} from "./provider-initialization-cleanup-error.js";

/** Owns a temporary query from dispatch through native cleanup, outside admission. */
export class AgentProbe implements ProviderCleanupOwner {
  private readonly abort = new AbortController();
  private readonly resources = new Set<ProviderCleanupOwner>();
  private readonly closing = new Map<ProviderCleanupOwner, Promise<void>>();
  private operation: Promise<unknown> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  readonly context: AgentProbeContext = {
    signal: this.abort.signal,
    own: (resource) => {
      this.resources.add(resource);
      // An acquisition can complete after stop began. It never escapes ownership.
      if (this.abort.signal.aborted) void this.closeResource(resource).catch(() => undefined);
      return () => {
        this.resources.delete(resource);
      };
    },
  };

  run<T>(operation: (context: AgentProbeContext) => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => {
      this.abort.signal.throwIfAborted();
      return operation(this.context);
    });
    this.operation = pending;
    return pending.then(
      async (value) => {
        try {
          await this.close();
        } catch (cleanupError) {
          throw new ProviderInitializationCleanupError(
            this,
            new Error("Provider query completed but its resources remain active"),
            cleanupError,
          );
        }
        return value;
      },
      async (error: unknown) => {
        if (error instanceof ProviderInitializationCleanupError) this.resources.add(error.cleanup);
        try {
          await this.close();
        } catch (cleanupError) {
          throw new ProviderInitializationCleanupError(this, error, cleanupError);
        }
        throw error instanceof ProviderInitializationCleanupError
          ? error.initializationError
          : error;
      },
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.abort.abort();
    const pending = (async () => {
      await this.closeResources();
      // Native close/abort settles outstanding initialization and query receipts.
      await this.operation.catch(() => undefined);
      await this.closeResources();
    })();
    this.closePromise = pending;
    void pending.catch(() => {
      if (this.closePromise === pending) this.closePromise = null;
    });
    return pending;
  }

  private async closeResources(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.resources].map((resource) => this.closeResource(resource)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Temporary provider probe did not stop");
  }

  private closeResource(resource: ProviderCleanupOwner): Promise<void> {
    const existing = this.closing.get(resource);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => resource.close())
      .then(() => {
        this.resources.delete(resource);
        return undefined;
      });
    this.closing.set(resource, pending);
    void pending
      .finally(() => {
        this.closing.delete(resource);
      })
      .catch(() => undefined);
    return pending;
  }
}
