import {
  PreviewRegistrationError,
  PreviewRegistrationStore,
  type PreviewExternalInput,
  type PreviewExternalRegistration,
} from "./registrations.js";
import { PreviewRoutes } from "./routes.js";

interface ExternalPreviewOptions {
  store: PreviewRegistrationStore;
  routes: PreviewRoutes;
  isWorkspaceBlocked?(workspaceId: string): boolean;
}

interface ExternalRegistrationOperation {
  input: PreviewExternalInput;
  assertCurrent(): void;
}

interface ExternalConnectOperation {
  serviceId: string;
  assertCurrent(): void;
}

export class ExternalPreviewError extends Error {
  constructor(readonly code: "closed" | "already-registered") {
    super(code);
    this.name = "ExternalPreviewError";
  }
}

/** Connect/disconnect changes routing only; no probes, shell commands or process adoption. */
export class ExternalPreviewServices {
  private readonly entries = new Map<string, PreviewExternalRegistration>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly shutdownFailures: unknown[] = [];
  private readonly disconnected = new Set<string>();
  private readonly acquired = new Set<string>();

  private constructor(private readonly options: ExternalPreviewOptions) {}

  get routes(): PreviewRoutes {
    return this.options.routes;
  }

  static async open(options: ExternalPreviewOptions): Promise<ExternalPreviewServices> {
    const entries = await options.store.list();
    const owner = new ExternalPreviewServices(options);
    try {
      for (const entry of entries) {
        owner.entries.set(entry.serviceId, entry);
        if (entry.archivedAt !== null) continue;
        // Definitions survive restart; a new explicit Connect makes them usable.
        // Stale workspace/port eligibility cannot prevent unrelated definitions
        // from opening or prevent explicit removal of the stale definition.
        owner.acquire(entry);
      }
    } catch (error) {
      try {
        owner.close();
      } catch {
        /* Keep the failed initialization as the cause. */
      }
      throw error;
    }
    return owner;
  }

  register({
    input,
    assertCurrent,
  }: ExternalRegistrationOperation): Promise<PreviewExternalRegistration> {
    return this.serialize(async () => {
      this.requireOpen();
      assertCurrent();
      this.rejectDuplicatePort(input.port);
      const entry = await this.options.store.register(input, () => {
        this.requireOpen();
        this.requireWorkspace(input.workspaceId);
        assertCurrent();
      });
      this.entries.set(entry.serviceId, entry);
      if (this.closed) throw new ExternalPreviewError("closed");
      this.mutateRoute(() => this.acquire(entry));
      return { ...entry };
    });
  }

  connect({ serviceId, assertCurrent }: ExternalConnectOperation): Promise<void> {
    return this.serialize(async () => {
      this.requireOpen();
      assertCurrent();
      const entry = this.activeEntry(serviceId);
      try {
        await this.options.store.validateCurrent(entry);
        this.rejectDuplicatePort(entry.port, serviceId);
      } catch (error) {
        this.mutateRoute(() => this.options.routes.markUnavailable(serviceId));
        throw error;
      }
      this.requireOpen();
      this.activeEntry(serviceId);
      assertCurrent();
      this.mutateRoute(() => this.options.routes.replace(this.route(entry)));
    });
  }

  disconnect(serviceId: string): Promise<void> {
    // Reserve persistence before publishing revocation: an observer may begin
    // shutdown synchronously and must drain this already-accepted operation.
    // The queued callback cannot run until after synchronous revocation.
    this.requireOpen();
    const existing = this.entries.get(serviceId);
    if (!existing) throw new PreviewRegistrationError("unknown-registration");
    if (existing.archivedAt !== null) return Promise.resolve();
    this.disconnected.add(serviceId);
    const persisted = this.serialize(async () => {
      await this.options.store.archive(serviceId);
      const entries = await this.options.store.list();
      const entry = entries.find((candidate) => candidate.serviceId === serviceId);
      if (entry) this.entries.set(serviceId, entry);
      this.mutateRoute(() => this.options.routes.archive(serviceId));
    });
    this.mutateRoute(() => this.options.routes.markUnavailable(serviceId));
    return persisted;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    for (const serviceId of this.acquired) {
      try {
        this.options.routes.markUnavailable(serviceId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "External preview shutdown failed");
  }

  /** Workspace visibility changes revoke routing without deleting definitions. */
  invalidateWorkspace(workspaceId: string): void {
    const failures: unknown[] = [];
    for (const entry of this.entries.values()) {
      if (entry.workspaceId !== workspaceId || !this.acquired.has(entry.serviceId)) continue;
      try {
        this.options.routes.markUnavailable(entry.serviceId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Workspace preview revocation failed");
  }

  /** Stop admission before awaiting writes already accepted by this owner. */
  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.close();
    } catch (error) {
      failures.push(error);
    }
    await this.tail;
    failures.push(...this.shutdownFailures);
    if (failures.length > 0) {
      throw new AggregateError(failures, "External preview shutdown failed");
    }
  }

  private acquire(entry: PreviewExternalRegistration): void {
    this.options.routes.registerUnavailable(this.route(entry), () => {
      // Runs after insertion and before publication, so observer errors still
      // leave ownership recorded without claiming a colliding owner's route.
      this.acquired.add(entry.serviceId);
    });
  }

  private activeEntry(serviceId: string): PreviewExternalRegistration {
    const entry = this.entries.get(serviceId);
    if (!entry || entry.archivedAt !== null || this.disconnected.has(serviceId))
      throw new PreviewRegistrationError("unknown-registration");
    this.requireWorkspace(entry.workspaceId);
    return entry;
  }

  private requireWorkspace(workspaceId: string | null): void {
    if (workspaceId && this.options.isWorkspaceBlocked?.(workspaceId)) {
      throw new PreviewRegistrationError("unknown-workspace");
    }
  }

  private rejectDuplicatePort(port: number, serviceId?: string): void {
    const duplicate = this.options.routes
      .describe()
      .some((route) => route.serviceId !== serviceId && route.port === port);
    if (duplicate) throw new ExternalPreviewError("already-registered");
  }

  private route(entry: PreviewExternalRegistration) {
    return {
      kind: "external" as const,
      serviceId: entry.serviceId,
      name: entry.name,
      port: entry.port,
      mount: entry.mount,
      ...(entry.workspaceId === null ? {} : { workspaceId: entry.workspaceId }),
    };
  }

  private requireOpen(): void {
    if (this.closed) throw new ExternalPreviewError("closed");
  }

  private mutateRoute(work: () => void): void {
    try {
      work();
    } catch (error) {
      try {
        this.close();
      } catch {
        /* All routes were attempted; preserve the operation's cause. */
      }
      throw error;
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      (error) => {
        // A failed validation is already a refused operation. A storage write
        // failing after shutdown starts must not become a successful drain.
        if (
          this.closed &&
          error instanceof PreviewRegistrationError &&
          error.code === "storage-error"
        ) {
          this.shutdownFailures.push(error);
        }
      },
    );
    return result;
  }
}
