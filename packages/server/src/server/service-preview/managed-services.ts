import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { managedPreviewServiceId, type PreviewManagedServicePolicy } from "./policy.js";
import type { ManagedPreviewRoutes } from "./managed.js";

const enrollmentSchema = z
  .object({
    workspaceId: z.string().min(1),
    scriptName: z.string().min(1),
    name: z.string().trim().min(1),
    mount: z.enum(["preserve", "strip"]),
    enabled: z.boolean(),
  })
  .strict();
const fileSchema = z
  .object({ version: z.literal(1), enrollments: z.array(enrollmentSchema) })
  .strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    for (const entry of file.enrollments) {
      const id = managedPreviewServiceId(entry);
      if (ids.has(id))
        context.addIssue({ code: "custom", message: "Duplicate managed enrollment" });
      ids.add(id);
    }
  });
type Enrollment = z.infer<typeof enrollmentSchema>;

interface ManagedServicesOptions {
  paseoHome: string;
  policy: readonly PreviewManagedServicePolicy[];
  managed: ManagedPreviewRoutes;
  validateService(input: { workspaceId: string; scriptName: string }): Promise<void>;
  isWorkspaceBlocked(workspaceId: string): boolean;
}

interface EnableInput {
  workspaceId: string;
  scriptName: string;
  mount: "preserve" | "strip";
}

export class ManagedEnrollmentError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "unknown-service"
      | "already-enabled"
      | "invalid-store"
      | "storage-error",
  ) {
    super(code);
    this.name = "ManagedEnrollmentError";
  }
}

/** Durable mount decisions, separate from process ownership and core daemon config. */
export class ManagedPreviewServices {
  private readonly file: string;
  private readonly entries = new Map<string, Enrollment>();
  private readonly decisions = new Map<string, Enrollment>();
  private readonly installed = new Set<string>();
  private readonly enabling = new Map<string, Enrollment>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private readonly failures: unknown[] = [];
  private closed = false;

  private constructor(private readonly options: ManagedServicesOptions) {
    this.file = path.join(options.paseoHome, "services", "managed-enrollments-v1.json");
  }

  static async open(options: ManagedServicesOptions): Promise<ManagedPreviewServices> {
    const owner = new ManagedPreviewServices(options);
    for (const declaration of options.policy) {
      owner.entries.set(managedPreviewServiceId(declaration), { ...declaration, enabled: true });
    }
    let content: string;
    try {
      content = await readFile(owner.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return owner;
      throw new ManagedEnrollmentError("storage-error");
    }
    let saved: z.infer<typeof fileSchema>;
    try {
      saved = fileSchema.parse(JSON.parse(content));
    } catch {
      throw new ManagedEnrollmentError("invalid-store");
    }
    // An explicit UI decision overrides the startup default, including Disable.
    // Merge before enrollment so the same workspace/script is never acquired twice.
    for (const entry of saved.enrollments) {
      const serviceId = managedPreviewServiceId(entry);
      owner.entries.set(serviceId, entry);
      owner.decisions.set(serviceId, entry);
    }
    return owner;
  }

  describe() {
    return Array.from(this.entries, ([serviceId, entry]) => ({ ...entry, serviceId }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  restoreWorkspace(workspaceId: string): void {
    if (this.closed || this.options.isWorkspaceBlocked(workspaceId)) return;
    for (const [serviceId, entry] of this.entries) {
      if (!entry.enabled || entry.workspaceId !== workspaceId || this.installed.has(serviceId))
        continue;
      this.installed.add(serviceId);
      try {
        this.options.managed.restore({ ...entry, serviceId });
      } catch (error) {
        this.installed.delete(serviceId);
        throw error;
      }
    }
  }

  /** Catalog service definitions are previewable without a persisted UI decision. */
  restoreDefault(workspaceId: string, scriptName: string): string {
    const serviceId = managedPreviewServiceId({ workspaceId, scriptName });
    const existing = this.entries.get(serviceId);
    if (!existing?.enabled) {
      this.entries.set(serviceId, {
        workspaceId,
        scriptName,
        name: scriptName,
        mount: "strip",
        enabled: true,
      });
      this.publish();
    }
    this.restoreWorkspace(workspaceId);
    return serviceId;
  }

  blockWorkspace(workspaceId: string): void {
    // Even a quick archive/restore cannot revive an earlier pending Enable.
    for (const [serviceId, entry] of this.enabling) {
      if (entry.workspaceId === workspaceId)
        this.revisions.set(serviceId, (this.revisions.get(serviceId) ?? 0) + 1);
    }
    this.options.managed.blockWorkspace(workspaceId);
  }

  enable(input: EnableInput, assertCurrent: () => void): Promise<string> {
    this.requireOpen();
    assertCurrent();
    const entry = enrollmentSchema.parse({ ...input, name: input.scriptName, enabled: true });
    const serviceId = managedPreviewServiceId(entry);
    if (this.entries.get(serviceId)?.enabled || this.enabling.has(serviceId)) {
      throw new ManagedEnrollmentError("already-enabled");
    }
    const revision = this.revisions.get(serviceId) ?? 0;
    this.enabling.set(serviceId, entry);
    return this.serialize(async () => {
      try {
        await this.options.validateService(entry);
        const check = () => {
          this.requireOpen();
          assertCurrent();
          if (
            this.options.isWorkspaceBlocked(entry.workspaceId) ||
            (this.revisions.get(serviceId) ?? 0) !== revision
          )
            throw new ManagedEnrollmentError("unavailable");
        };
        check();
        await this.persist(serviceId, entry);
        check();
        this.restoreWorkspace(entry.workspaceId);
        check();
        return serviceId;
      } finally {
        if (this.enabling.get(serviceId) === entry) this.enabling.delete(serviceId);
      }
    });
  }

  disable(
    input: { workspaceId: string; scriptName: string },
    assertCurrent: () => void,
  ): Promise<string> {
    this.requireOpen();
    assertCurrent();
    const serviceId = managedPreviewServiceId(input);
    const entry = this.entries.get(serviceId) ?? this.enabling.get(serviceId);
    if (!entry) throw new ManagedEnrollmentError("unknown-service");
    this.revisions.set(serviceId, (this.revisions.get(serviceId) ?? 0) + 1);
    // Reserve the write before route publication can reenter shutdown.
    const persisted = this.serialize(async () => {
      await this.persist(serviceId, { ...entry, enabled: false });
      return serviceId;
    });
    this.installed.delete(serviceId);
    this.options.managed.disable(serviceId);
    return persisted;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.managed.close();
    this.listeners.clear();
  }

  async shutdown(): Promise<void> {
    this.close();
    await this.tail;
    if (this.failures.length)
      throw new AggregateError(this.failures, "Managed enrollment persistence failed");
  }

  private requireOpen(): void {
    if (this.closed) throw new ManagedEnrollmentError("unavailable");
  }

  private async persist(serviceId: string, entry: Enrollment): Promise<void> {
    // Saving one explicit decision must not turn unrelated policy defaults into
    // permanent overrides that survive their later removal from operator policy.
    const next = new Map(this.decisions).set(serviceId, entry);
    try {
      await writeJsonFileAtomic(this.file, { version: 1, enrollments: [...next.values()] });
    } catch {
      throw new ManagedEnrollmentError("storage-error");
    }
    this.decisions.set(serviceId, entry);
    this.entries.set(serviceId, entry);
    // A committed definition remains observable even if source loss prevents
    // activation or its acknowledgement. It is never silently replayed.
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      (error) => {
        if (
          this.closed &&
          error instanceof ManagedEnrollmentError &&
          error.code === "storage-error"
        )
          this.failures.push(error);
      },
    );
    return result;
  }
}
