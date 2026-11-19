import { AgentNotFoundError } from "../agent/agent-not-found-error.js";
import {
  attempt,
  attemptWithin,
  RestartStepTimeoutError,
  type RestartFailureReporter,
} from "./best-effort.js";
import type { CheckpointClaim, CheckpointStore } from "./checkpoint-store.js";
import { RestartHandoffInProgressError } from "./restart-errors.js";

export type RestartPhase = "running" | "preparing" | "paused" | "restoring";
export type RestartStage =
  | "installing"
  | "starting"
  | "stopping"
  | "checkpointing"
  | "ready"
  | "replacing";

export interface RestartStatus {
  state: RestartPhase;
  generationId?: string;
  stage?: RestartStage;
}

/** Result of the best-effort checkpoint. `generationId` is absent when none was saved. */
export interface RestartPreparation {
  generationId?: string;
}

export interface RestartControllerOptions<T> {
  store: Pick<CheckpointStore<T>, "commit" | "loadAndClaim" | "markRestored" | "abandonReady">;
  capture: () => Promise<T>;
  /** Closing ingress is synchronous. The promise drains accepted short operations. */
  freeze?: () => Promise<void>;
  stop?: () => Promise<void>;
  install?: (snapshot: T) => Promise<void>;
  initialize?: () => Promise<void>;
  resume?: (snapshot: T) => Promise<void>;
  finalize?: () => Promise<void>;
  open?: () => void;
  changed?: () => void;
  observerFailed?: (error: unknown) => void;
  /** Receives every step that failed or ran out of time. */
  failed: RestartFailureReporter;
  prepareTimeoutMs: number;
  stopTimeoutMs: number;
  restoreTimeoutMs: number;
}

/**
 * Owns the admission freeze, the best-effort checkpoint, and the boot restoration. Every hook is
 * bounded or isolated, so a restart, a stop, and a boot always complete; a failed step is reported
 * through `failed` and skipped.
 */
export class RestartController<T> {
  private preparation: Promise<RestartPreparation> | null = null;
  private replacement: Promise<void> | null = null;
  private readonly controls = new Set<Promise<unknown>>();
  private finalizing = false;
  private phase: RestartPhase = "running";
  private stage: RestartStage | undefined;
  private generationId: string | undefined;

  constructor(private readonly options: RestartControllerOptions<T>) {}

  get status(): RestartStatus {
    return {
      state: this.phase,
      ...(this.generationId ? { generationId: this.generationId } : {}),
      ...(this.stage ? { stage: this.stage } : {}),
    };
  }

  private readonly report: RestartFailureReporter = (step, error) => {
    this.options.failed(step, error);
  };

  private changed(): void {
    try {
      this.options.changed?.();
    } catch (error) {
      // Observers, including their diagnostics, cannot undo an owned transition.
      try {
        this.options.observerFailed?.(error);
      } catch {
        /* observation only */
      }
    }
  }

  private open(): void {
    this.phase = "running";
    this.stage = undefined;
    try {
      this.options.open?.();
    } catch (error) {
      this.report("open", error);
    }
    this.changed();
  }

  /**
   * Waits until tracked controls settle, for at most `timeoutMs`. A control can wait for a
   * provider call that never settles, so after the bound the step `controls` is reported and the
   * caller continues. Resolves synchronously after the last check, so the caller can seal the
   * control set without an await in between.
   */
  private async settleControls(timeoutMs: number): Promise<void> {
    if (!this.controls.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    try {
      while (this.controls.size) {
        const timedOut = await Promise.race([
          Promise.allSettled(this.controls).then(() => false),
          expired,
        ]);
        if (timedOut) {
          try {
            this.report("controls", new RestartStepTimeoutError("controls", timeoutMs));
          } catch {
            // A broken reporter must not hold the restart or the boot.
          }
          return;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cancellation remains available while stopping; an immutable handoff cannot be edited. */
  control<R>(operation: () => Promise<R>): Promise<R> {
    if (
      this.finalizing ||
      this.stage === "installing" ||
      this.stage === "checkpointing" ||
      this.stage === "ready" ||
      this.stage === "replacing"
    ) {
      return Promise.reject(new RestartHandoffInProgressError());
    }
    const result = Promise.resolve().then(operation);
    this.controls.add(result);
    const belongsToRecovery = this.phase !== "running";
    void result
      .catch((error: unknown) => {
        if (!belongsToRecovery || error instanceof AgentNotFoundError) return;
        try {
          this.report("control", error);
        } catch {
          // The caller still receives the rejection; the reporter only adds diagnostics.
        }
      })
      .finally(() => this.controls.delete(result));
    return result;
  }

  prepare(): Promise<RestartPreparation> {
    if (this.preparation) return this.preparation;
    const startedAt = Date.now();
    this.phase = "preparing";
    this.stage = "stopping";
    const frozen = attempt(this.report, "freeze", () => this.options.freeze?.(), undefined);
    this.changed();
    this.preparation = (async () => {
      await attemptWithin(
        this.report,
        "stop",
        this.options.stopTimeoutMs,
        // A running restore is not awaited: the agent manager ends its resume loop when the
        // quiesce in `stop` begins, and the restore skips its finalize once a preparation began.
        async () => {
          await frozen;
          await this.options.stop?.();
        },
        undefined,
      );
      this.stage = "checkpointing";
      this.changed();
      const checkpointTimeoutMs = Math.max(
        0,
        this.options.prepareTimeoutMs - (Date.now() - startedAt),
      );
      let expired = false;
      const committed = await attemptWithin(
        this.report,
        "checkpoint",
        checkpointTimeoutMs,
        async () => {
          await this.settleControls(Math.min(this.options.stopTimeoutMs, checkpointTimeoutMs));
          const snapshot = await this.options.capture();
          // A late commit would publish a pointer after the replacement already booted without it.
          if (expired) return null;
          return await this.options.store.commit(snapshot);
        },
        null,
      );
      expired = true;
      this.phase = "paused";
      this.stage = "ready";
      this.generationId = committed?.generationId;
      this.changed();
      return committed ? { generationId: committed.generationId } : {};
    })();
    return this.preparation;
  }

  replace(replace: (preparation: RestartPreparation) => void | Promise<void>): Promise<void> {
    this.replacement ??= (async () => {
      const preparation = await this.prepare();
      this.stage = "replacing";
      this.changed();
      await attempt(this.report, "replace", () => replace(preparation), undefined);
    })();
    return this.replacement;
  }

  /** Boot step one. Admissions stay frozen until `restore` when a checkpoint comes back. */
  async claim(): Promise<CheckpointClaim<T> | null> {
    // Freeze before any asynchronous disk read: the listener may already exist.
    this.phase = "restoring";
    this.stage = "installing";
    const frozen = attempt(this.report, "freeze", () => this.options.freeze?.(), undefined);
    this.changed();
    await frozen;
    let loadFailed = false;
    const checkpoint = await attempt(
      (step, error) => {
        loadFailed = true;
        this.report(step, error);
      },
      "load",
      () => this.options.store.loadAndClaim(),
      null,
    );
    if (loadFailed) {
      await attempt(this.report, "abandon", () => this.options.store.abandonReady(), undefined);
    }
    if (checkpoint) {
      this.generationId = checkpoint.generationId;
      this.changed();
      await attempt(
        this.report,
        "install",
        () => this.options.install?.(checkpoint.snapshot),
        undefined,
      );
      return checkpoint;
    }
    await attempt(this.report, "initialize", () => this.options.initialize?.(), undefined);
    if (this.phase === "restoring") this.open();
    return null;
  }

  /** Boot step two. Opens admissions after the resume or after `restoreTimeoutMs`. */
  async restore(checkpoint: CheckpointClaim<T>): Promise<void> {
    if (
      checkpoint.generationId !== this.generationId ||
      this.phase !== "restoring" ||
      this.stage !== "installing"
    )
      return;
    this.stage = "starting";
    this.changed();
    const resumed = attempt(
      this.report,
      "resume",
      () => this.options.resume?.(checkpoint.snapshot),
      undefined,
    );
    const resumedInTime = await attemptWithin(
      this.report,
      "restore",
      this.options.restoreTimeoutMs,
      async () => {
        await resumed;
        return true;
      },
      false,
    );
    await attempt(
      this.report,
      "mark-restored",
      () => this.options.store.markRestored(checkpoint.generationId),
      undefined,
    );
    // Finalize after the marker: a cancellation accepted during its write must be retired too.
    // After a timeout, finalize waits for the late resume without holding admissions closed.
    const finalized = resumed.then(() => this.finalizeRestoration());
    if (resumedInTime) await finalized;
    // A preparation that began meanwhile owns the frozen admissions now.
    if (!this.preparation) this.open();
  }

  private async finalizeRestoration(): Promise<void> {
    // A preparation means the process exits soon; retiring handles would only race its capture.
    if (this.preparation) return;
    await this.settleControls(this.options.stopTimeoutMs);
    if (this.preparation) return;
    // No await may separate the drained control set from sealing it against new controls.
    this.finalizing = true;
    try {
      await attempt(this.report, "finalize", () => this.options.finalize?.(), undefined);
    } finally {
      this.finalizing = false;
    }
  }
}
