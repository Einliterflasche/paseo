import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile, PRIVATE_FILE_MODE } from "../private-files.js";

const CHECKPOINTS_DIR = "restart-checkpoints";
const READY_FILE = "ready.json";
const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_FILE = "snapshot.json";
const CLAIMED_FILE = "claimed.json";
const RESTORED_FILE = "restored.json";
const MANIFEST_VERSION = 1;

export type CheckpointLoadFailureReason =
  | "ready_pointer_corrupt"
  | "generation_missing"
  | "manifest_corrupt"
  | "manifest_checksum_mismatch"
  | "snapshot_corrupt"
  | "snapshot_invalid"
  | "already_claimed"
  | "already_restored";

/**
 * Typed failure for a ready generation that cannot be trusted. There is no fallback: every
 * reason here must block recovery visibly rather than silently replacing it with shorter
 * native history or an older generation.
 */
export class CheckpointLoadError extends Error {
  constructor(
    readonly reason: CheckpointLoadFailureReason,
    readonly generationId: string | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CheckpointLoadError";
  }
}

export interface CheckpointCommitResult<T> {
  generationId: string;
  snapshot: T;
}

export interface CheckpointClaim<T> {
  generationId: string;
  snapshot: T;
}

export interface CheckpointStatus {
  generationId: string;
  claimed: boolean;
}

interface ManifestFile {
  version: number;
  generationId: string;
  createdAt: string;
  checksum: string;
}

interface ReadyFile {
  generationId: string;
}

async function fsyncFileHandle(handle: FileHandle): Promise<void> {
  await handle.sync();
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, "r");
  try {
    await fsyncFileHandle(handle);
  } finally {
    await handle.close();
  }
}

/**
 * Writes `data` to `filePath` via temp-file + fsync + rename + parent-directory fsync. Plain
 * rename (see `atomic-file.ts`) makes the new name visible but does not guarantee the rename
 * itself survives a crash; the directory fsync is the durability barrier a checkpoint commit
 * needs before it can be trusted at boot.
 */
async function writeFileDurable(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  ensurePrivateDirectory(dir);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tempPath, "w", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(data, "utf8");
    await fsyncFileHandle(handle);
  } finally {
    await handle.close();
  }
  // Preserve incomplete files too, so a failed commit can be inspected.
  await fs.rename(tempPath, filePath);
  ensurePrivateFile(filePath);
  await fsyncDirectory(dir);
}

function checksumOf(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Durable, versioned restart checkpoints under `<home>/restart-checkpoints/`. Each generation
 * is a directory holding one `snapshot.json` (the caller's full `T`) plus a `manifest.json`
 * checksum record; `ready.json` at the root is the atomically-committed pointer to the latest
 * trustworthy generation. Prior generations and partially-written generations are never
 * deleted — only `ready.json` decides what counts as ready. No pointer is published until
 * the snapshot and manifest are durable. Failure of the final directory sync can leave the
 * new pointer visible, but the caller still receives failure and must not replace the process.
 *
 * `parse` is the only source of truth for what `T` is: the store never assumes a snapshot is
 * valid because it parsed as JSON and matched a checksum. It must also match the caller's
 * runtime schema.
 */
export class CheckpointStore<T> {
  private readonly root: string;
  private claimedGenerationId: string | null = null;

  constructor(
    home: string,
    private readonly parse: (input: unknown) => T,
  ) {
    this.root = path.join(home, CHECKPOINTS_DIR);
  }

  async commit(snapshot: T): Promise<CheckpointCommitResult<T>> {
    const generationId = `${Date.now()}-${randomUUID()}`;
    const generationDir = path.join(this.root, generationId);
    await fs.mkdir(generationDir, { recursive: true });
    ensurePrivateDirectory(generationDir);
    await fsyncDirectory(path.dirname(this.root));
    await fsyncDirectory(this.root);

    snapshot = this.parse(snapshot);
    const snapshotText = JSON.stringify(snapshot, null, 2);
    await writeFileDurable(path.join(generationDir, SNAPSHOT_FILE), snapshotText);

    const manifest: ManifestFile = {
      version: MANIFEST_VERSION,
      generationId,
      createdAt: new Date().toISOString(),
      checksum: checksumOf(snapshotText),
    };
    await writeFileDurable(
      path.join(generationDir, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
    );

    const ready: ReadyFile = { generationId };
    await writeFileDurable(path.join(this.root, READY_FILE), JSON.stringify(ready, null, 2));

    return { generationId, snapshot };
  }

  /**
   * Validates the ready generation, writes its claimed marker, and only then returns the
   * snapshot. The marker is committed before the caller can act on the result, so a crash
   * between validation and use still leaves a durable record that this generation was
   * claimed — a later unrelated crash must never auto-replay it.
   */
  async loadAndClaim(): Promise<CheckpointClaim<T> | null> {
    const generationId = await this.readReadyGenerationId();
    if (generationId === null) {
      return null;
    }

    const generationDir = path.join(this.root, generationId);
    if (!(await pathExists(generationDir))) {
      throw new CheckpointLoadError(
        "generation_missing",
        generationId,
        `Ready generation '${generationId}' has no checkpoint directory`,
      );
    }

    if (await pathExists(path.join(generationDir, CLAIMED_FILE))) {
      const restoredText = await readFileOrNull(path.join(generationDir, RESTORED_FILE));
      if (restoredText !== null) {
        let restored: unknown;
        try {
          restored = JSON.parse(restoredText);
        } catch {
          // A malformed completion marker cannot turn a consumed checkpoint into
          // fresh work. Keep the claim authoritative and fail closed below.
        }
        if (
          typeof restored === "object" &&
          restored !== null &&
          "generationId" in restored &&
          restored.generationId === generationId &&
          "restoredAt" in restored &&
          typeof restored.restoredAt === "string"
        ) {
          throw new CheckpointLoadError(
            "already_restored",
            generationId,
            `Generation '${generationId}' already completed restoration. Recovery is paused because later work must be reconciled before this checkpoint can be used again.`,
          );
        }
      }
      throw new CheckpointLoadError(
        "already_claimed",
        generationId,
        `Generation '${generationId}' was already claimed by a prior boot`,
      );
    }

    const manifest = await this.readManifest(generationDir, generationId);
    const snapshotText = await readFileOrNull(path.join(generationDir, SNAPSHOT_FILE));
    if (snapshotText === null) {
      throw new CheckpointLoadError(
        "snapshot_corrupt",
        generationId,
        `Generation '${generationId}' is missing snapshot.json`,
      );
    }
    if (checksumOf(snapshotText) !== manifest.checksum) {
      throw new CheckpointLoadError(
        "manifest_checksum_mismatch",
        generationId,
        `Generation '${generationId}' snapshot.json does not match its manifest checksum`,
      );
    }

    let snapshotJson: unknown;
    try {
      snapshotJson = JSON.parse(snapshotText);
    } catch (error) {
      throw new CheckpointLoadError(
        "snapshot_corrupt",
        generationId,
        `Generation '${generationId}' snapshot.json is not valid JSON`,
        { cause: error },
      );
    }

    let snapshot: T;
    try {
      snapshot = this.parse(snapshotJson);
    } catch (error) {
      throw new CheckpointLoadError(
        "snapshot_invalid",
        generationId,
        `Generation '${generationId}' snapshot.json failed schema validation`,
        { cause: error },
      );
    }

    // Exclusive creation makes the claim single-use even for two concurrent booters.
    let claimHandle: FileHandle;
    try {
      claimHandle = await fs.open(path.join(generationDir, CLAIMED_FILE), "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CheckpointLoadError(
          "already_claimed",
          generationId,
          "Checkpoint was concurrently claimed",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await claimHandle.writeFile(JSON.stringify({ claimedAt: new Date().toISOString() }));
      await claimHandle.sync();
    } finally {
      await claimHandle.close();
    }
    await fsyncDirectory(generationDir);
    this.claimedGenerationId = generationId;

    return { generationId, snapshot };
  }

  /**
   * Record completion before opening new admissions. Keep ready.json and the
   * claim: completion does not make this old snapshot safe after a later crash.
   */
  async markRestored(generationId: string): Promise<void> {
    if (this.claimedGenerationId !== generationId) {
      throw new Error("Only the store that claimed a checkpoint may complete its restoration");
    }
    await writeFileDurable(
      path.join(this.root, generationId, RESTORED_FILE),
      JSON.stringify({ generationId, restoredAt: new Date().toISOString() }),
    );
  }

  /** Cheap status read for reporting: does not validate checksum/schema or claim anything. */
  async peekStatus(): Promise<CheckpointStatus | null> {
    const generationId = await this.readReadyGenerationId();
    if (generationId === null) {
      return null;
    }
    const claimed = await pathExists(path.join(this.root, generationId, CLAIMED_FILE));
    return { generationId, claimed };
  }

  private async readReadyGenerationId(): Promise<string | null> {
    const readyText = await readFileOrNull(path.join(this.root, READY_FILE));
    if (readyText === null) {
      return null;
    }
    let ready: unknown;
    try {
      ready = JSON.parse(readyText);
    } catch (error) {
      throw new CheckpointLoadError("ready_pointer_corrupt", null, "ready.json is not valid JSON", {
        cause: error,
      });
    }
    if (
      typeof ready !== "object" ||
      ready === null ||
      typeof (ready as ReadyFile).generationId !== "string" ||
      (ready as ReadyFile).generationId.length === 0
    ) {
      throw new CheckpointLoadError(
        "ready_pointer_corrupt",
        null,
        "ready.json is missing a valid generationId",
      );
    }
    const generationId = (ready as ReadyFile).generationId;
    if (
      path.basename(generationId) !== generationId ||
      generationId === "." ||
      generationId === ".."
    ) {
      throw new CheckpointLoadError(
        "ready_pointer_corrupt",
        null,
        "Checkpoint generation must name a child directory",
      );
    }
    return generationId;
  }

  private async readManifest(generationDir: string, generationId: string): Promise<ManifestFile> {
    const manifestText = await readFileOrNull(path.join(generationDir, MANIFEST_FILE));
    if (manifestText === null) {
      throw new CheckpointLoadError(
        "manifest_corrupt",
        generationId,
        `Generation '${generationId}' is missing manifest.json`,
      );
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      throw new CheckpointLoadError(
        "manifest_corrupt",
        generationId,
        `Generation '${generationId}' manifest.json is not valid JSON`,
        { cause: error },
      );
    }
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      (manifest as ManifestFile).version !== MANIFEST_VERSION ||
      (manifest as ManifestFile).generationId !== generationId ||
      typeof (manifest as ManifestFile).checksum !== "string" ||
      typeof (manifest as ManifestFile).generationId !== "string"
    ) {
      throw new CheckpointLoadError(
        "manifest_corrupt",
        generationId,
        `Generation '${generationId}' manifest.json is malformed`,
      );
    }
    return manifest as ManifestFile;
  }
}
