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
  await controller.failRestoration(new Error("native session unavailable"));
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
  const restoredClaim = (await restored.claim())!;
  await restored.restore(restoredClaim);
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
  const claim = (await controller.claim())!;
  await mkdir(join(home, "restart-checkpoints", original.generationId, "restored.json"));
  await expect(controller.restore(claim)).rejects.toThrow();
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

test("active marker failure waits for certified stop, then retries a successor of current state", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-active-marker-failure-"));
  const store = new CheckpointStore(home, z.object({ events: z.array(z.string()) }).parse);
  const original = await store.commit({ events: ["original input"] });
  const stopEntered = Promise.withResolvers<void>();
  const stopRelease = Promise.withResolvers<void>();
  let active = false;
  let installed = 0;
  const events: string[] = [];
  let stopCount = 0;
  const controller = new RestartController({
    store,
    capture: async () => ({ events: [...events] }),
    install: async (snapshot) => {
      installed++;
      events.push(...snapshot.events);
    },
    resume: async () => {
      active = true;
      events.push("new output");
    },
    stop: async () => {
      stopCount++;
      stopEntered.resolve();
      await stopRelease.promise;
      if (active) events.push("late output");
      active = false;
    },
  });
  const claim = (await controller.claim())!;
  await mkdir(join(home, "restart-checkpoints", original.generationId, "restored.json"));
  const restored = controller.restore(claim);
  const rejection = expect(restored).rejects.toThrow();
  await stopEntered.promise;
  expect(active).toBe(true);
  expect(controller.status).toMatchObject({ state: "restoring", stage: "stopping" });
  stopRelease.resolve();
  await rejection;
  expect(active).toBe(false);
  expect(controller.status.state).toBe("paused");
  expect(events).toEqual(["original input", "new output", "late output"]);
  await controller.retryRecovery();
  expect(installed).toBe(1);
  expect(active).toBe(true);
  expect(controller.status.state).toBe("running");
  expect(controller.status.previousGenerationId).toBe(original.generationId);
  expect(controller.status.generationId).not.toBe(original.generationId);
  const successor = await store.inspectReadyGeneration(controller.status.generationId!);
  expect(successor.snapshot.events).toEqual(["original input", "new output", "late output"]);
  expect(events).toEqual(["original input", "new output", "late output", "new output"]);
  expect(stopCount).toBe(2);
});

test("uncertified teardown stays blocked and cannot be retried or replaced", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-blocked-stop-"));
  const store = new CheckpointStore(home, z.string().parse);
  await store.commit("saved");
  let active = false;
  let captures = 0;
  const controller = new RestartController({
    store,
    capture: async () => {
      captures++;
      return "must not export";
    },
    resume: async () => {
      active = true;
      throw new Error("second start failed");
    },
    stop: async () => {
      if (active) throw new Error("provider close failed");
    },
    affectedAgentIds: () => ["agent-1"],
  });
  const claim = (await controller.claim())!;
  await expect(controller.restore(claim)).rejects.toThrow("second start failed");
  expect(controller.status).toMatchObject({
    state: "restoring",
    stage: "blocked",
    affectedAgentIds: ["agent-1"],
  });
  expect(controller.status.error).toContain("provider close failed");
  await expect(controller.retryRecovery()).rejects.toThrow();
  await expect(controller.prepare()).rejects.toThrow();
  expect(captures).toBe(0);
});

test("cancellation joins stopping but cannot mutate a checkpoint during commit or handoff", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-control-handoff-"));
  const store = new CheckpointStore(home, z.array(z.string()).parse);
  const stopped = Promise.withResolvers<void>();
  const stopRelease = Promise.withResolvers<void>();
  const captureEntered = Promise.withResolvers<void>();
  const captureRelease = Promise.withResolvers<void>();
  const effects: string[] = [];
  const controller = new RestartController({
    store,
    stop: async () => {
      stopped.resolve();
      await stopRelease.promise;
    },
    capture: async () => {
      captureEntered.resolve();
      await captureRelease.promise;
      return [...effects];
    },
  });
  const preparation = controller.prepare();
  await stopped.promise;
  await controller.control(async () => {
    effects.push("cancel before snapshot");
  });
  stopRelease.resolve();
  await captureEntered.promise;
  await expect(
    controller.control(async () => {
      effects.push("must not change");
    }),
  ).rejects.toMatchObject({ name: "RestartHandoffInProgressError" });
  captureRelease.resolve();
  const ready = await preparation;
  await expect(
    controller.control(async () => {
      effects.push("too late");
    }),
  ).rejects.toThrow();
  expect(ready.snapshot).toEqual(["cancel before snapshot"]);
  expect(effects).toEqual(["cancel before snapshot"]);
});

test("repair incomplete installation before exporting its successor inventory", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-partial-install-"));
  const store = new CheckpointStore(home, z.array(z.string()).parse);
  await store.commit(["first", "second"]);
  const installed = new Set<string>();
  let fail = true;
  let starts = 0;
  const controller = new RestartController({
    store,
    install: async (snapshot) => {
      for (const value of snapshot) {
        installed.add(value);
        if (fail) {
          fail = false;
          throw new Error("registry write failed");
        }
      }
    },
    capture: async () => [...installed],
    resume: async () => {
      starts++;
    },
  });
  const claim = (await controller.claim())!;
  await expect(controller.install(claim)).rejects.toThrow("registry write failed");
  expect(starts).toBe(0);
  await controller.retryRecovery();
  expect((await store.inspectReadyGeneration(controller.status.generationId!)).snapshot).toEqual([
    "first",
    "second",
  ]);
  expect(starts).toBe(1);
});

test("a failed status observer cannot change the authoritative lifecycle transition", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-recovery-observer-"));
  const store = new CheckpointStore(home, z.string().parse);
  await store.commit("saved");
  const errors: unknown[] = [];
  let opened = 0;
  const controller = new RestartController({
    store,
    capture: async () => "current",
    open: () => {
      opened++;
    },
    changed: () => {
      throw new Error("client broadcast failed");
    },
    observerFailed: (error) => {
      errors.push(error);
    },
  });
  const checkpoint = (await controller.claim())!;
  await controller.restore(checkpoint);
  expect(controller.status.state).toBe("running");
  expect(opened).toBe(1);
  expect(errors.length).toBeGreaterThan(0);
  await expect(store.loadAndClaim()).rejects.toMatchObject({ reason: "already_restored" });
});

test("fresh initialization stays frozen and can retry its current inventory without a source generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-fresh-initialization-"));
  const store = new CheckpointStore(home, z.array(z.string()).parse);
  let admissionOpen = true;
  let fail = true;
  let resumes = 0;
  const owned = ["existing schedule obligation"];
  const controller = new RestartController({
    store,
    freeze: async () => {
      admissionOpen = false;
    },
    initialize: async () => {
      expect(admissionOpen).toBe(false);
      if (fail) throw new Error("startup persistence unavailable");
    },
    stop: async () => {},
    capture: async () => [...owned],
    resume: async (snapshot) => {
      expect(snapshot).toEqual(owned);
      resumes++;
    },
    open: () => {
      admissionOpen = true;
    },
  });
  await expect(controller.claim()).rejects.toThrow("startup persistence unavailable");
  expect(controller.status).toMatchObject({ state: "paused", generationId: undefined });
  expect(admissionOpen).toBe(false);
  expect(resumes).toBe(0);
  fail = false;
  await controller.retryRecovery();
  expect(controller.status.state).toBe("running");
  expect(controller.status.generationId).toEqual(expect.any(String));
  expect(admissionOpen).toBe(true);
  expect(resumes).toBe(1);
  expect((await store.inspectReadyGeneration(controller.status.generationId!)).snapshot).toEqual(
    owned,
  );
});

test("failed cancellation during marker persistence prevents readiness", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-marker-control-failure-"));
  const markerEntered = Promise.withResolvers<void>();
  const markerRelease = Promise.withResolvers<void>();
  class HeldMarkerStore extends CheckpointStore<string> {
    override async markRestored(id: string) {
      await super.markRestored(id);
      markerEntered.resolve();
      await markerRelease.promise;
    }
  }
  const store = new HeldMarkerStore(home, z.string().parse);
  await store.commit("original");
  let opened = false;
  const controller = new RestartController({
    store,
    capture: async () => "current",
    open: () => {
      opened = true;
    },
  });
  const claim = (await controller.claim())!;
  const restoring = controller.restore(claim);
  const rejected = expect(restoring).rejects.toThrow("Recovery cancellation did not complete");
  await markerEntered.promise;
  await expect(
    controller.control(async () => {
      throw new Error("stop uncertain");
    }),
  ).rejects.toThrow("stop uncertain");
  markerRelease.resolve();
  await rejected;
  expect(opened).toBe(false);
  expect(controller.status.state).toBe("paused");
});

test("pre-effect invalid cancellation cannot poison installation or an active restoration", async () => {
  const { AgentNotFoundError } = await import("../agent/agent-not-found-error.js");
  const home = await mkdtemp(join(tmpdir(), "paseo-control-validation-"));
  const store = new CheckpointStore(home, z.string().parse);
  await store.commit("history");
  const starting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let opened = false;
  const controller = new RestartController({
    store,
    capture: async () => "current",
    resume: async () => {
      starting.resolve();
      await release.promise;
    },
    open: () => {
      opened = true;
    },
  });
  const checkpoint = (await controller.claim())!;
  let invoked = false;
  await expect(
    controller.control(async () => {
      invoked = true;
    }),
  ).rejects.toMatchObject({ name: "RestartHandoffInProgressError" });
  expect(invoked).toBe(false);
  const restoration = controller.restore(checkpoint);
  await starting.promise;
  await expect(
    controller.control(async () => {
      throw new AgentNotFoundError("unknown-agent");
    }),
  ).rejects.toThrow("not found");
  release.resolve();
  await restoration;
  expect(controller.status.state).toBe("running");
  expect(opened).toBe(true);
});
