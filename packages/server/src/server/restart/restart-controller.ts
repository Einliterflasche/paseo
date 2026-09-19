import {
  CheckpointStore,
  CheckpointLoadError,
  type CheckpointClaim,
  type CheckpointCommitResult,
} from "./checkpoint-store.js";
import { RestartInProgressError } from "./restart-errors.js";

export type RestartPhase = "running" | "preparing" | "paused" | "restoring";

/** A replacement callback is reachable only through a successfully committed checkpoint. */
export class RestartController<T> {
  private preparation: Promise<CheckpointCommitResult<T>> | null = null;
  private replacement: Promise<void> | null = null;
  private phase: RestartPhase = "running";
  private generationId: string | undefined;
  private error: unknown;
  private restorationFailed = false;

  constructor(
    private readonly options: {
      store: CheckpointStore<T>;
      capture: () => Promise<T>;
      changed?: () => void;
    },
  ) {}

  get status() {
    return {
      state: this.phase,
      generationId: this.generationId,
      error: this.error instanceof Error ? this.error.message : undefined,
    };
  }

  prepare(): Promise<CheckpointCommitResult<T>> {
    if (this.restorationFailed) return Promise.reject(this.error);
    // The listener is live during boot recovery. Never let a second restart
    // capture and replace the partially restored runtime through that listener.
    if (this.phase === "restoring") return Promise.reject(new RestartInProgressError());
    if (this.preparation) return this.preparation;
    this.phase = "preparing";
    this.options.changed?.();
    this.preparation = Promise.resolve().then(async () => {
      try {
        const snapshot = await this.options.capture();
        const checkpoint = await this.options.store.commit(snapshot);
        this.generationId = checkpoint.generationId;
        this.phase = "paused";
        this.error = undefined;
        this.options.changed?.();
        return checkpoint;
      } catch (error) {
        this.phase = "paused";
        this.error = error;
        this.preparation = null;
        this.options.changed?.();
        throw error;
      }
    });
    return this.preparation;
  }

  async replace(replace: (checkpoint: CheckpointCommitResult<T>) => Promise<void>): Promise<void> {
    if (!this.replacement) {
      this.replacement = this.prepare()
        .then(replace)
        .catch((error) => {
          this.replacement = null;
          throw error;
        });
    }
    await this.replacement;
  }

  async claim(): Promise<CheckpointClaim<T> | null> {
    try {
      const checkpoint = await this.options.store.loadAndClaim();
      if (checkpoint) {
        this.generationId = checkpoint.generationId;
        this.phase = "restoring";
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof CheckpointLoadError) {
        this.generationId = error.generationId ?? undefined;
      }
      this.failRestoration(error);
      throw error;
    }
  }

  async completeRestoration(): Promise<void> {
    if (this.phase !== "restoring" || !this.generationId) {
      throw new Error("No checkpoint restoration is in progress");
    }
    try {
      await this.options.store.markRestored(this.generationId);
      this.phase = "running";
      this.options.changed?.();
    } catch (error) {
      this.failRestoration(error);
      throw error;
    }
  }

  failRestoration(error: unknown): void {
    // A partially restored runtime cannot replace the complete saved generation.
    this.restorationFailed = true;
    this.phase = "paused";
    this.error = error;
    this.options.changed?.();
  }
}
