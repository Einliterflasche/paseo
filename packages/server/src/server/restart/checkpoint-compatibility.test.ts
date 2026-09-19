import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CheckpointStore } from "./checkpoint-store.js";
import { DaemonCheckpointSchema } from "./daemon-checkpoint.js";
import {
  READABLE_CHECKPOINT_FORMATS,
  validateReadyCheckpoint,
} from "./checkpoint-compatibility.js";

test.each(READABLE_CHECKPOINT_FORMATS)(
  "offline preflight reads format %i without claiming or modifying it",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-checkpoint-preflight-"));
    const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
    const saved = await store.commit({
      version,
      agents: { agents: [], timelines: {}, children: [] },
      notifications: [],
      schedules: { runs: [] },
    });
    const dir = join(home, "restart-checkpoints", saved.generationId);
    const before = await readFile(join(dir, "snapshot.json"), "utf8");
    expect(await validateReadyCheckpoint(home, saved.generationId)).toEqual({
      generationId: saved.generationId,
      format: version,
    });
    expect((await readdir(dir)).sort()).toEqual(["manifest.json", "snapshot.json"]);
    expect(await readFile(join(dir, "snapshot.json"), "utf8")).toBe(before);
    expect((await store.loadAndClaim())?.generationId).toBe(saved.generationId);
  },
);

test("offline preflight rejects a substituted ready generation and a corrupt snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-checkpoint-preflight-"));
  const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
  const saved = await store.commit({
    version: 3,
    agents: { agents: [], timelines: {}, children: [] },
    notifications: [],
    schedules: { runs: [] },
  });
  await expect(validateReadyCheckpoint(home, "wrong-generation")).rejects.toThrow();
  await writeFile(join(home, "restart-checkpoints", saved.generationId, "snapshot.json"), "{}");
  await expect(validateReadyCheckpoint(home, saved.generationId)).rejects.toMatchObject({
    reason: "manifest_checksum_mismatch",
  });
  expect((await store.peekStatus())?.claimed).toBe(false);
});
