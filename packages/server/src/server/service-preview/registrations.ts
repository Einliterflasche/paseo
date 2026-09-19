import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const externalInput = z
  .object({
    name: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    workspaceId: z.string().min(1).nullable(),
    mount: z.enum(["preserve", "strip"]),
  })
  .strict();

const registration = externalInput.extend({
  serviceId: z.string().regex(/^external-[0-9a-f-]+$/),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

const fileSchema = z
  .object({
    version: z.literal(1),
    registrations: z.array(registration),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const item of value.registrations) {
      if (ids.has(item.serviceId))
        context.addIssue({ code: "custom", message: "Duplicate preview registration" });
      ids.add(item.serviceId);
    }
  });

export type PreviewExternalInput = z.infer<typeof externalInput>;
export type PreviewExternalRegistration = z.infer<typeof registration>;
type RegistrationFile = z.infer<typeof fileSchema>;

interface RegistrationStoreOptions {
  paseoHome: string;
  workspaceExists(workspaceId: string): Promise<boolean>;
  excludedPorts(): ReadonlySet<number>;
}

export class PreviewRegistrationError extends Error {
  constructor(
    readonly code:
      | "invalid-store"
      | "unknown-registration"
      | "unknown-workspace"
      | "already-registered"
      | "infrastructure-port"
      | "storage-error",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "PreviewRegistrationError";
  }
}

/** Definitions only. No process adoption, route activation or network probes. */
export class PreviewRegistrationStore {
  private readonly file: string;
  private loaded: Promise<RegistrationFile> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RegistrationStoreOptions) {
    this.file = path.join(options.paseoHome, "services", "registrations-v1.json");
  }

  async list(): Promise<PreviewExternalRegistration[]> {
    await this.tail;
    const data = await this.load();
    const entries: PreviewExternalRegistration[] = [];
    for (const item of data.registrations) entries.push({ ...item });
    return entries;
  }

  register(
    input: PreviewExternalInput,
    beforeCommit: () => void = () => {},
  ): Promise<PreviewExternalRegistration> {
    const parsed = externalInput.parse(input);
    return this.serialize(async () => {
      const data = await this.load();
      if (parsed.workspaceId && !(await this.options.workspaceExists(parsed.workspaceId))) {
        throw new PreviewRegistrationError("unknown-workspace");
      }
      if (this.options.excludedPorts().has(parsed.port)) {
        throw new PreviewRegistrationError("infrastructure-port");
      }
      if (
        data.registrations.some((entry) => entry.archivedAt === null && entry.port === parsed.port)
      ) {
        throw new PreviewRegistrationError("already-registered");
      }
      const created = {
        ...parsed,
        serviceId: `external-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        archivedAt: null,
      };
      beforeCommit();
      await this.commit({ ...data, registrations: [...data.registrations, created] });
      return { ...created };
    });
  }

  archive(serviceId: string): Promise<void> {
    return this.serialize(async () => {
      const data = await this.load();
      const entry = data.registrations.find((item) => item.serviceId === serviceId);
      if (!entry) throw new PreviewRegistrationError("unknown-registration");
      if (entry.archivedAt !== null) return;
      const archivedAt = new Date().toISOString();
      const registrations = data.registrations.slice();
      registrations[registrations.indexOf(entry)] = { ...entry, archivedAt };
      await this.commit({
        ...data,
        registrations,
      });
    });
  }

  async validateCurrent(entry: PreviewExternalRegistration): Promise<void> {
    if (entry.workspaceId && !(await this.options.workspaceExists(entry.workspaceId)))
      throw new PreviewRegistrationError("unknown-workspace");
    if (this.options.excludedPorts().has(entry.port))
      throw new PreviewRegistrationError("infrastructure-port");
  }

  private load(): Promise<RegistrationFile> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<RegistrationFile> {
    let content: string;
    try {
      content = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, registrations: [] };
      throw new PreviewRegistrationError("storage-error", { cause: error });
    }
    try {
      return fileSchema.parse(JSON.parse(content));
    } catch {
      // Retain unknown versions and malformed data verbatim. A failed load
      // stays failed; this owner must never replace it with an empty file.
      throw new PreviewRegistrationError("invalid-store");
    }
  }

  private async commit(data: RegistrationFile) {
    try {
      await writeJsonFileAtomic(this.file, data);
    } catch (error) {
      throw new PreviewRegistrationError("storage-error", { cause: error });
    }
    this.loaded = Promise.resolve(data);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
