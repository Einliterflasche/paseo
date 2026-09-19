import { AgentNotFoundError } from "../agent/agent-not-found-error.js";
import {
  CheckpointStore,
  CheckpointLoadError,
  type CheckpointClaim,
  type CheckpointCommitResult,
  type CrashAcknowledgmentRequester,
} from "./checkpoint-store.js";
import { RestartHandoffInProgressError, RestartInProgressError } from "./restart-errors.js";

export type RestartPhase = "running" | "preparing" | "paused" | "restoring";
export type RestartStage =
  | "installing"
  | "starting"
  | "stopping"
  | "blocked"
  | "checkpointing"
  | "ready"
  | "replacing";

export interface RestartStatus {
  state: RestartPhase;
  generationId?: string;
  previousGenerationId?: string;
  stage?: RestartStage;
  error?: string;
  affectedAgentIds?: string[];
}

/** Owns lifecycle publication, admission, certified stopping, and successor attempts. */
export class RestartController<T> {
  private preparation: Promise<CheckpointCommitResult<T>> | null = null;
  private replacement: Promise<void> | null = null;
  private restoration: Promise<void> | null = null;
  private failureCleanup: Promise<void> | null = null;
  private handledFailure: { error: unknown } | null = null;
  private readonly controls = new Set<Promise<unknown>>();
  private readonly recoveryControlErrors: unknown[] = [];
  private finalizing = false;
  private phase: RestartPhase = "running";
  private stage: RestartStage | undefined;
  private generationId: string | undefined;
  private previousGenerationId: string | undefined;
  private error: unknown;
  private recovery: "none" | "installed" | "unavailable" = "none";
  private pendingInstallation: T | null = null;
  private initializationPending = false;
  private claimFailure: CheckpointLoadError | null = null;
  private crashAcknowledgment: { generationId: string; acknowledgmentId: string } | null = null;
  private acknowledgedReadyGeneration: string | null = null;

  constructor(
    private readonly options: {
      store: CheckpointStore<T>;
      capture: () => Promise<T>;
      /** Closing ingress is synchronous; its promise drains accepted short operations. */
      freeze?: () => Promise<void>;
      stop?: () => Promise<void>;
      install?: (snapshot: T) => Promise<void>;
      initialize?: () => Promise<void>;
      resume?: (snapshot: T) => Promise<void>;
      finalize?: () => Promise<void>;
      open?: () => void;
      affectedAgentIds?: () => string[];
      changed?: () => void;
      observerFailed?: (error: unknown) => void;
    },
  ) {}

  get status(): RestartStatus {
    return {
      state: this.phase,
      generationId: this.generationId,
      error: this.error instanceof Error ? this.error.message : undefined,
      ...(this.previousGenerationId ? { previousGenerationId: this.previousGenerationId } : {}),
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.stage === "blocked"
        ? { affectedAgentIds: this.options.affectedAgentIds?.() ?? [] }
        : {}),
    };
  }

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

  private freeze(): Promise<void> {
    try {
      return this.options.freeze?.() ?? Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
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
      .catch((error) => {
        if (belongsToRecovery && !(error instanceof AgentNotFoundError))
          this.recoveryControlErrors.push(error);
      })
      .finally(() => this.controls.delete(result));
    return result;
  }

  prepare(): Promise<CheckpointCommitResult<T>> {
    if (this.recovery !== "none") return Promise.reject(this.error ?? new RestartInProgressError());
    if (this.phase === "restoring") return Promise.reject(new RestartInProgressError());
    if (this.preparation) return this.preparation;
    this.handledFailure = null;
    this.phase = "preparing";
    this.stage = "stopping";
    const freeze = this.freeze();
    this.changed();
    this.preparation = Promise.resolve().then(async () => {
      try {
        await freeze;
        await this.options.stop?.();
        this.stage = "checkpointing";
        this.changed();
        while (this.controls.size) await Promise.allSettled(this.controls);
        const snapshot = await this.options.capture();
        const checkpoint = await this.options.store.commit(snapshot);
        this.generationId = checkpoint.generationId;
        this.phase = "paused";
        this.stage = "ready";
        this.error = undefined;
        this.changed();
        return checkpoint;
      } catch (error) {
        await this.stopAfterFailure(error);
        this.preparation = null;
        throw error;
      }
    });
    return this.preparation;
  }

  async replace(replace: (checkpoint: CheckpointCommitResult<T>) => Promise<void>): Promise<void> {
    if (!this.replacement) {
      this.replacement = this.prepare()
        .then(async (checkpoint) => {
          this.stage = "replacing";
          this.changed();
          await replace(checkpoint);
          return undefined;
        })
        .catch((error) => {
          this.replacement = null;
          throw error;
        });
    }
    await this.replacement;
  }

  async claim(): Promise<CheckpointClaim<T> | null> {
    this.handledFailure = null;
    // Freeze before any asynchronous disk read: the listener may already exist.
    this.phase = "restoring";
    this.stage = "installing";
    const freeze = this.freeze();
    this.changed();
    try {
      await freeze;
      const checkpoint = await this.options.store.loadAndClaim();
      if (checkpoint) {
        this.generationId = checkpoint.generationId;
        this.phase = "restoring";
        this.stage = "installing";
        this.recovery = "unavailable";
        this.changed();
      } else {
        // No source generation exists: the current runtime owns this fresh initialization.
        this.recovery = "installed";
        this.initializationPending = true;
        await this.options.initialize?.();
        this.initializationPending = false;
        this.phase = "running";
        this.stage = undefined;
        this.recovery = "none";
        this.options.open?.();
        this.changed();
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof CheckpointLoadError) {
        this.claimFailure = error;
        this.generationId = error.generationId ?? undefined;
      }
      if (this.recovery !== "installed") this.recovery = "unavailable";
      await this.stopAfterFailure(error);
      throw error;
    }
  }

  /** Installation is idempotent at the runtime owner; no execution starts until it completes. */
  async install(checkpoint: CheckpointClaim<T>): Promise<void> {
    if (
      checkpoint.generationId !== this.generationId ||
      this.phase !== "restoring" ||
      this.stage !== "installing"
    )
      throw new Error("Checkpoint installation does not belong to the active recovery attempt");
    this.pendingInstallation = checkpoint.snapshot;
    try {
      await this.options.install?.(checkpoint.snapshot);
      this.recovery = "installed";
      this.pendingInstallation = null;
    } catch (error) {
      await this.stopAfterFailure(error);
      throw error;
    }
  }

  restore(checkpoint: CheckpointClaim<T>): Promise<void> {
    if (this.restoration) return this.restoration;
    if (
      checkpoint.generationId !== this.generationId ||
      this.phase !== "restoring" ||
      this.stage !== "installing"
    )
      return Promise.reject(new RestartInProgressError());
    this.handledFailure = null;
    this.restoration = (async () => {
      try {
        if (this.recovery !== "installed") await this.install(checkpoint);
        this.phase = "restoring";
        this.stage = "starting";
        this.changed();
        await this.options.resume?.(checkpoint.snapshot);
        await this.completeRestoration();
      } catch (error) {
        await this.stopAfterFailure(error);
        throw error;
      }
    })().finally(() => {
      this.restoration = null;
    });
    return this.restoration;
  }

  private async completeRestoration(): Promise<void> {
    if (this.phase !== "restoring" || this.stage !== "starting" || !this.generationId) {
      throw new Error("No checkpoint restoration is in progress");
    }
    // Controls accepted while durable completion is being written still own
    // provider teardown. Seal admission, join them, then retire closed handles.
    try {
      await this.options.store.markRestored(this.generationId);
      this.finalizing = true;
      while (this.controls.size) await Promise.allSettled(this.controls);
      if (this.recoveryControlErrors.length) {
        throw new AggregateError(
          this.recoveryControlErrors.splice(0),
          "Recovery cancellation did not complete",
        );
      }
      await this.options.finalize?.();
      this.phase = "running";
      this.stage = undefined;
      this.recovery = "none";
      this.error = undefined;
      this.options.open?.();
      this.changed();
    } catch (error) {
      this.finalizing = false;
      await this.stopAfterFailure(error);
      throw error;
    } finally {
      this.finalizing = false;
    }
  }

  async failRestoration(error: unknown): Promise<void> {
    if (this.recovery === "none") this.recovery = "unavailable";
    await this.stopAfterFailure(error);
  }

  private async stopAfterFailure(failure: unknown): Promise<void> {
    if (this.failureCleanup) return this.failureCleanup;
    if (this.handledFailure?.error === failure) return;
    this.handledFailure = { error: failure };
    this.error = failure;
    this.phase = "restoring";
    this.stage = "stopping";
    const freeze = this.freeze();
    this.changed();
    this.failureCleanup = this.stopFailedAttempt(failure, freeze).finally(() => {
      this.failureCleanup = null;
    });
    await this.failureCleanup;
  }

  private async stopFailedAttempt(failure: unknown, freeze: Promise<void>): Promise<void> {
    try {
      await freeze;
      await this.options.stop?.();
      while (this.controls.size) await Promise.allSettled(this.controls);
      this.phase = "paused";
      this.stage = undefined;
    } catch (stopError) {
      this.phase = "restoring";
      this.stage = "blocked";
      this.error = new AggregateError(
        [failure, stopError],
        `${failure instanceof Error ? failure.message : String(failure)}; execution stop could not be confirmed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
      );
    }
    this.changed();
  }

  /** Retry current quiescent state, never install an old source over newer output. */
  retryRecovery(): Promise<void> {
    if (this.restoration) return this.restoration;
    const stoppingBlocked = this.phase === "restoring" && this.stage === "blocked";
    if (
      (this.phase !== "paused" && !stoppingBlocked) ||
      (this.recovery !== "installed" && !this.pendingInstallation)
    ) {
      return Promise.reject(this.error ?? new RestartInProgressError());
    }
    this.handledFailure = null;
    this.recoveryControlErrors.length = 0;
    this.phase = "restoring";
    this.stage = "stopping";
    this.changed();
    this.restoration = (async () => {
      try {
        await this.freeze();
        await this.options.stop?.();
        this.stage = "checkpointing";
        this.changed();
        while (this.controls.size) await Promise.allSettled(this.controls);
        if (this.initializationPending) {
          await this.options.initialize?.();
          this.initializationPending = false;
        }
        if (this.pendingInstallation) {
          await this.options.install?.(this.pendingInstallation);
          this.pendingInstallation = null;
          this.recovery = "installed";
        }
        await this.restoreCurrentSuccessor();
      } catch (error) {
        await this.stopAfterFailure(error);
        throw error;
      }
    })().finally(() => {
      this.restoration = null;
    });
    return this.restoration;
  }

  /** Deliberate unexpected-crash reconciliation, never an ordinary retry fallback. */
  acknowledgeCrash(
    expectedGenerationId: string,
    orphanExecutionReconciled: true,
    requester: CrashAcknowledgmentRequester,
  ): Promise<void> {
    if (
      orphanExecutionReconciled !== true ||
      this.restoration ||
      this.preparation ||
      this.recovery !== "unavailable" ||
      this.pendingInstallation ||
      this.claimFailure?.reason !== "already_restored" ||
      this.claimFailure.generationId !== expectedGenerationId ||
      this.generationId !== expectedGenerationId ||
      this.phase !== "paused"
    ) {
      return Promise.reject(
        new Error(
          "Crash acknowledgment requires the exact consumed generation, no installed recovery, and reconciled orphan execution",
        ),
      );
    }
    this.handledFailure = null;
    this.recoveryControlErrors.length = 0;
    this.phase = "restoring";
    this.stage = "stopping";
    const freeze = this.freeze();
    this.changed();
    this.restoration = (async () => {
      try {
        await freeze;
        await this.options.stop?.();
        this.stage = "checkpointing";
        this.changed();
        while (this.controls.size) await Promise.allSettled(this.controls);
        this.crashAcknowledgment = await this.options.store.acknowledgeConsumedGeneration(
          expectedGenerationId,
          requester,
        );
        this.acknowledgedReadyGeneration = expectedGenerationId;
        // From here the current owners, not the old checkpoint, are authoritative.
        // Failure uses ordinary retained-state retry. A process death still sees the
        // consumed pointer and requires a fresh operator decision: the audit is inert.
        this.recovery = "installed";
        this.initializationPending = true;
        await this.options.initialize?.();
        this.initializationPending = false;
        await this.options.store.assertReadyGeneration(expectedGenerationId);
        await this.restoreCurrentSuccessor();
      } catch (error) {
        await this.stopAfterFailure(error);
        throw error;
      }
    })().finally(() => {
      this.restoration = null;
    });
    return this.restoration;
  }

  private async restoreCurrentSuccessor(): Promise<void> {
    const snapshot = await this.options.capture();
    if (this.acknowledgedReadyGeneration)
      await this.options.store.assertReadyGeneration(this.acknowledgedReadyGeneration);
    const successor = await this.options.store.commit(
      snapshot,
      this.crashAcknowledgment
        ? {
            crashAcknowledgment: this.crashAcknowledgment,
            expectedReadyGeneration: this.acknowledgedReadyGeneration ?? undefined,
          }
        : undefined,
    );
    if (this.crashAcknowledgment) this.acknowledgedReadyGeneration = successor.generationId;
    const claimed = await this.options.store.loadAndClaim();
    if (!claimed || claimed.generationId !== successor.generationId)
      throw new Error("Recovery successor changed before it could be claimed");
    this.previousGenerationId = this.generationId;
    this.generationId = claimed.generationId;
    this.stage = "starting";
    this.error = undefined;
    this.changed();
    await this.options.resume?.(claimed.snapshot);
    await this.completeRestoration();
    this.crashAcknowledgment = null;
    this.acknowledgedReadyGeneration = null;
  }
}
