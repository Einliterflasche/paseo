/** A provider factory still owns a runtime until close certifies its cessation. */
export interface ProviderCleanupOwner {
  close(): Promise<void>;
}

export class ProviderInitializationCleanupError extends Error {
  constructor(
    readonly cleanup: ProviderCleanupOwner,
    readonly initializationError: unknown,
    readonly cleanupError: unknown,
  ) {
    super(
      `Provider initialization failed and cleanup is unconfirmed: ${initializationError instanceof Error ? initializationError.message : String(initializationError)}`,
      {
        cause: new AggregateError(
          [initializationError, cleanupError],
          "Provider initialization and cleanup failed",
        ),
      },
    );
    this.name = "ProviderInitializationCleanupError";
  }
}
