import { createHash } from "node:crypto";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CheckpointLoadError, CheckpointStore } from "./checkpoint-store.js";

const SnapshotSchema = z.object({
  agentIds: z.array(z.string()),
  epoch: z.number().int(),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

function parse(input: unknown): Snapshot {
  return SnapshotSchema.parse(input);
}

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-checkpoint-store-"));
}

function readyPath(home: string): string {
  return path.join(home, "restart-checkpoints", "ready.json");
}

function generationDir(home: string, generationId: string): string {
  return path.join(home, "restart-checkpoints", generationId);
}

describe("CheckpointStore", () => {
  it("returns null when no checkpoint has ever been committed", async () => {
    const store = new CheckpointStore<Snapshot>(createTempHome(), parse);
    await expect(store.loadAndClaim()).resolves.toBeNull();
    await expect(store.peekStatus()).resolves.toBeNull();
  });

  it("round-trips the exact committed snapshot through loadAndClaim", async () => {
    const store = new CheckpointStore<Snapshot>(createTempHome(), parse);
    const snapshot: Snapshot = { agentIds: ["a1", "a2"], epoch: 7 };

    const committed = await store.commit(snapshot);
    expect(committed.snapshot).toEqual(snapshot);

    const claimed = await store.loadAndClaim();
    expect(claimed).not.toBeNull();
    expect(claimed?.generationId).toBe(committed.generationId);
    expect(claimed?.snapshot).toEqual(snapshot);
  });

  it("advances ready to the newest generation without deleting prior generations", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);

    const first = await store.commit({ agentIds: ["a1"], epoch: 1 });
    const second = await store.commit({ agentIds: ["a1", "a2"], epoch: 2 });
    expect(second.generationId).not.toBe(first.generationId);

    const claimed = await store.loadAndClaim();
    expect(claimed?.generationId).toBe(second.generationId);
    expect(claimed?.snapshot).toEqual({ agentIds: ["a1", "a2"], epoch: 2 });

    // Prior generation is retained on disk; no deletion/expiry.
    await expect(fs.access(generationDir(home, first.generationId))).resolves.toBeUndefined();
  });

  it("never advances ready on a failed commit", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    const good = await store.commit({ agentIds: ["a1"], epoch: 1 });

    // A value JSON.stringify cannot serialize (BigInt) makes commit() fail mid-write.
    const poisoned = { agentIds: ["a1"], epoch: 1n } as unknown as Snapshot;
    await expect(store.commit(poisoned)).rejects.toThrow();

    const claimed = await store.loadAndClaim();
    expect(claimed?.generationId).toBe(good.generationId);
    expect(claimed?.snapshot).toEqual({ agentIds: ["a1"], epoch: 1 });
  });

  it("marks a generation claimed and never auto-replays it on a later load", async () => {
    const store = new CheckpointStore<Snapshot>(createTempHome(), parse);
    await store.commit({ agentIds: ["a1"], epoch: 1 });

    const first = await store.loadAndClaim();
    expect(first).not.toBeNull();

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "already_claimed",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("reports claimed status via peekStatus without claiming", async () => {
    const store = new CheckpointStore<Snapshot>(createTempHome(), parse);
    const committed = await store.commit({ agentIds: [], epoch: 0 });

    await expect(store.peekStatus()).resolves.toEqual({
      generationId: committed.generationId,
      claimed: false,
    });

    await store.loadAndClaim();

    await expect(store.peekStatus()).resolves.toEqual({
      generationId: committed.generationId,
      claimed: true,
    });
  });

  it("rejects a corrupt ready.json instead of falling back to empty state", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    await store.commit({ agentIds: ["a1"], epoch: 1 });

    await fs.writeFile(readyPath(home), "{not json", "utf8");

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "ready_pointer_corrupt",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("rejects a ready pointer whose generation directory is missing", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    await store.commit({ agentIds: ["a1"], epoch: 1 });

    await fs.writeFile(readyPath(home), JSON.stringify({ generationId: "does-not-exist" }), "utf8");

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "generation_missing",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("rejects a snapshot whose bytes no longer match the manifest checksum", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    const committed = await store.commit({ agentIds: ["a1"], epoch: 1 });

    const snapshotPath = path.join(generationDir(home, committed.generationId), "snapshot.json");
    await fs.writeFile(snapshotPath, JSON.stringify({ agentIds: ["tampered"], epoch: 1 }), "utf8");

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "manifest_checksum_mismatch",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("rejects a missing manifest.json", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    const committed = await store.commit({ agentIds: ["a1"], epoch: 1 });

    const file = path.join(generationDir(home, committed.generationId), "manifest.json");
    await fs.rename(file, `${file}.withheld`);

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "manifest_corrupt",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("rejects a snapshot that fails the caller's schema even with a matching checksum", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    const committed = await store.commit({ agentIds: ["a1"], epoch: 1 });

    const dir = generationDir(home, committed.generationId);
    const invalidText = JSON.stringify({ agentIds: ["a1"], epoch: "not-a-number" });
    await fs.writeFile(path.join(dir, "snapshot.json"), invalidText, "utf8");
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.checksum = createHash("sha256").update(invalidText, "utf8").digest("hex");
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "snapshot_invalid",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("rejects corrupt (non-JSON) snapshot bytes even with a matching checksum", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    const committed = await store.commit({ agentIds: ["a1"], epoch: 1 });

    const dir = generationDir(home, committed.generationId);
    const garbage = "{not json at all";
    await fs.writeFile(path.join(dir, "snapshot.json"), garbage, "utf8");
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.checksum = createHash("sha256").update(garbage, "utf8").digest("hex");
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "snapshot_corrupt",
    } satisfies Partial<CheckpointLoadError>);
  });

  it("never loads an incomplete generation missing its snapshot file", async () => {
    const home = createTempHome();
    const store = new CheckpointStore<Snapshot>(home, parse);
    const committed = await store.commit({ agentIds: ["a1"], epoch: 1 });

    const file = path.join(generationDir(home, committed.generationId), "snapshot.json");
    await fs.rename(file, `${file}.withheld`);

    await expect(store.loadAndClaim()).rejects.toMatchObject({
      reason: "snapshot_corrupt",
    } satisfies Partial<CheckpointLoadError>);
  });
});
