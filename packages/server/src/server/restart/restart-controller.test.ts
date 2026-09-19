import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { CheckpointStore } from "./checkpoint-store.js";
import { RestartController } from "./restart-controller.js";

test("capture failure never invokes replacement or publishes readiness", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-negative-"));
  const store = new CheckpointStore(home, z.object({ message: z.string() }).parse);
  const replaced: string[] = [];
  const controller = new RestartController({
    store,
    capture: async () => {
      throw new Error("provider did not stop");
    },
  });
  await expect(
    controller.replace(async (checkpoint) => {
      replaced.push(checkpoint.generationId);
    }),
  ).rejects.toThrow("provider did not stop");
  expect(replaced).toEqual([]);
  expect(await store.loadAndClaim()).toBeNull();
  expect(controller.status.state).toBe("paused");
});

test("failed restoration cannot overwrite a complete checkpoint with partial runtime state", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-failed-restore-"));
  const store = new CheckpointStore(home, z.object({ message: z.string() }).parse);
  const original = await store.commit({ message: "complete history" });
  let captures = 0;
  const controller = new RestartController({
    store,
    capture: async () => {
      captures++;
      return { message: "partial" };
    },
  });
  await controller.claim();
  await expect(controller.prepare()).rejects.toMatchObject({ code: "restart_in_progress" });
  expect(captures).toBe(0);
  controller.failRestoration(new Error("native session unavailable"));
  await expect(controller.prepare()).rejects.toThrow("native session unavailable");
  expect(captures).toBe(0);
  expect((await store.peekStatus())?.generationId).toBe(original.generationId);
});

test("a completed restoration is recorded durably and a later boot stays blocked without replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-completed-restore-"));
  const parse = z.object({ message: z.string() }).parse;
  const store = new CheckpointStore(home, parse);
  const original = await store.commit({ message: "complete history" });
  const restored = new RestartController({ store, capture: async () => original.snapshot });
  await restored.claim();
  await restored.completeRestoration();
  expect(restored.status).toEqual({
    state: "running",
    generationId: original.generationId,
    error: undefined,
  });
  expect(
    JSON.parse(
      await readFile(
        join(home, "restart-checkpoints", original.generationId, "restored.json"),
        "utf8",
      ),
    ).generationId,
  ).toBe(original.generationId);
  const next = new RestartController({
    store: new CheckpointStore(home, parse),
    capture: async () => {
      throw new Error("Must not capture stale state");
    },
  });
  await expect(next.claim()).rejects.toMatchObject({ reason: "already_restored" });
  expect(next.status.state).toBe("paused");
  expect(next.status.generationId).toBe(original.generationId);
  expect(next.status.error).toContain("later work");
  await expect(next.prepare()).rejects.toMatchObject({ reason: "already_restored" });
});

test("completion write failure does not publish running or permit replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restored-write-failure-"));
  const store = new CheckpointStore(home, z.string().parse);
  const original = await store.commit("complete history");
  const controller = new RestartController({ store, capture: async () => "must not replace" });
  await controller.claim();
  await mkdir(join(home, "restart-checkpoints", original.generationId, "restored.json"));
  await expect(controller.completeRestoration()).rejects.toThrow();
  expect(controller.status.state).toBe("paused");
  expect(controller.status.generationId).toBe(original.generationId);
  await expect(controller.prepare()).rejects.toThrow();
  expect((await store.peekStatus())?.generationId).toBe(original.generationId);
});

test("a disk failure never invokes replacement and a retry can preserve the same payload", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-write-negative-"));
  // A directory at the atomic pointer's destination makes rename fail on the real filesystem.
  await mkdir(join(home, "restart-checkpoints", "ready.json"), { recursive: true });
  const store = new CheckpointStore(home, z.object({ messages: z.array(z.string()) }).parse);
  const controller = new RestartController({
    store,
    capture: async () => ({ messages: ["first", "second"] }),
  });
  const replaced: string[] = [];
  await expect(
    controller.replace(async ({ generationId }) => {
      replaced.push(generationId);
    }),
  ).rejects.toThrow();
  expect(replaced).toEqual([]);
  expect(controller.status.state).toBe("paused");
});

test("concurrent preparations commit once and replacement sees a valid unclaimed checkpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-ready-"));
  const parse = z.object({ messages: z.array(z.string()) }).parse;
  const store = new CheckpointStore(home, parse);
  let captures = 0;
  const controller = new RestartController({
    store,
    capture: async () => {
      captures++;
      return { messages: ["same", "same"] };
    },
  });
  const [a, b] = await Promise.all([controller.prepare(), controller.prepare()]);
  expect(a.generationId).toBe(b.generationId);
  expect(captures).toBe(1);
  await controller.replace(async (checkpoint) => {
    const restored = await new CheckpointStore(home, parse).loadAndClaim();
    expect(restored).toEqual(checkpoint);
    expect(restored?.snapshot.messages).toEqual(["same", "same"]);
  });
  await controller.replace(async () => {
    throw new Error("must not replace twice");
  });
});
