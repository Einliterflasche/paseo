import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { CheckpointStore } from "./checkpoint-store.js";
import { AgentTimelineSnapshotSchema } from "../agent/agent-timeline-store.js";
import { RestartController } from "./restart-controller.js";

test("a snapshot fsync failure cannot publish readiness or invoke replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-fsync-failure-"));
  const store = new CheckpointStore(home, z.string().parse);
  const previous = await store.commit("prior retained checkpoint");
  const open = fs.open.bind(fs);
  const spy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file).includes(".snapshot.json.")) {
      vi.spyOn(handle, "sync").mockRejectedValue(new Error("injected fsync failure"));
    }
    return handle;
  });
  const replace = vi.fn();
  const controller = new RestartController({ store, capture: async () => "new checkpoint" });
  try {
    await expect(controller.replace(replace)).rejects.toThrow("injected fsync failure");
    expect(replace).not.toHaveBeenCalled();
    expect(controller.status.state).toBe("paused");
    expect(await store.peekStatus()).toEqual({
      generationId: previous.generationId,
      claimed: false,
    });
  } finally {
    spy.mockRestore();
  }
});

test("concurrent claimants cannot both execute the same saved work", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-single-claim-"));
  const schema = z.object({ messages: z.array(z.string()) });
  const first = new CheckpointStore(home, schema.parse);
  await first.commit({ messages: ["do this once"] });
  const results = await Promise.allSettled([
    first.loadAndClaim(),
    new CheckpointStore(home, schema.parse).loadAndClaim(),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toMatchObject([
    { reason: { reason: "already_claimed" } },
  ]);
});

test.each(["..", ".", "../../outside", "/tmp/outside", "generation/child"])(
  "a generation reference %s cannot escape its owned directory",
  async (generationId) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-bad-generation-"));
    await mkdir(join(home, "restart-checkpoints"));
    await writeFile(
      join(home, "restart-checkpoints", "ready.json"),
      JSON.stringify({ generationId }),
    );
    await expect(new CheckpointStore(home, z.unknown().parse).loadAndClaim()).rejects.toMatchObject(
      { reason: "ready_pointer_corrupt" },
    );
  },
);

test("invalid new state never replaces the previous valid ready generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-invalid-save-"));
  const store = new CheckpointStore(home, z.object({ message: z.string() }).parse);
  const good = await store.commit({ message: "retained" });
  const before = await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8");
  await expect(store.commit({ message: 42 } as unknown as { message: string })).rejects.toThrow();
  expect(await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8")).toBe(before);
  expect(await store.loadAndClaim()).toEqual(good);
});

test.each([{ version: 999 }, { generationId: "another-generation" }])(
  "incompatible or mismatched manifests are never claimed: %j",
  async (change) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-manifest-version-"));
    const store = new CheckpointStore(home, z.string().parse);
    const { generationId } = await store.commit("retained");
    const file = join(home, "restart-checkpoints", generationId, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...manifest, ...change }));
    await expect(store.loadAndClaim()).rejects.toMatchObject({ reason: "manifest_corrupt" });
    expect(await store.peekStatus()).toEqual({ generationId, claimed: false });
  },
);

test.each([{ sequences: [1, 1] }, { sequences: [2, 1] }, { sequences: [1, 3] }])(
  "invalid sequence state $sequences cannot overwrite or duplicate restored rows",
  ({ sequences }) => {
    expect(
      AgentTimelineSnapshotSchema.safeParse({
        epoch: "epoch",
        nextSeq: 3,
        rows: sequences.map((seq) => ({
          seq,
          timestamp: "2026-09-16T00:00:00Z",
          item: { type: "assistant_message", text: "retained" },
        })),
      }).success,
    ).toBe(false);
  },
);
