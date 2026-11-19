import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { RestartStepTimeoutError } from "./best-effort.js";
import {
  CheckpointLoadError,
  CheckpointStore,
  type CheckpointLoadFailureReason,
} from "./checkpoint-store.js";
import { RestartController, type RestartControllerOptions } from "./restart-controller.js";

interface ReportedFailure {
  step: string;
  error: unknown;
}

const timeouts = { prepareTimeoutMs: 60_000, stopTimeoutMs: 30_000, restoreTimeoutMs: 60_000 };

function recordFailures() {
  const failures: ReportedFailure[] = [];
  return {
    failures,
    failed: (step: string, error: unknown) => {
      failures.push({ step, error });
    },
  };
}

function steps(failures: ReportedFailure[]): string[] {
  return failures.map((failure) => failure.step);
}

/** In-memory store for tests that run under fake timers, where real disk I/O cannot be awaited. */
function memoryStore<T>(saved?: T): RestartControllerOptions<T>["store"] & {
  committed: T[];
  restored: string[];
  abandoned: number;
} {
  const committed: T[] = [];
  const restored: string[] = [];
  const store = {
    committed,
    restored,
    abandoned: 0,
    commit: async (snapshot: T) => {
      committed.push(snapshot);
      return { generationId: `generation-${committed.length}`, snapshot };
    },
    loadAndClaim: async () =>
      saved === undefined ? null : { generationId: "saved", snapshot: saved },
    markRestored: async (generationId: string) => {
      restored.push(generationId);
    },
    abandonReady: async () => {
      store.abandoned++;
    },
  };
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

test("capture failure still invokes replacement without a generation or an error state", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-negative-"));
  const store = new CheckpointStore(home, z.object({ message: z.string() }).parse);
  const { failures, failed } = recordFailures();
  const replaced: unknown[] = [];
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => {
      throw new Error("provider did not stop");
    },
  });
  await controller.replace(async (preparation) => {
    replaced.push(preparation);
  });
  expect(replaced).toEqual([{}]);
  expect(steps(failures)).toEqual(["checkpoint"]);
  expect(controller.status).toEqual({ state: "paused", stage: "replacing" });
  expect(await store.loadAndClaim()).toBeNull();
});

test("failed restoration is reported, ends running, and a later preparation saves current state", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-failed-restore-"));
  const parse = z.object({ message: z.string() }).parse;
  const store = new CheckpointStore(home, parse);
  const original = await store.commit({ message: "complete history" });
  const { failures, failed } = recordFailures();
  let captures = 0;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => {
      captures++;
      return { message: "current" };
    },
    resume: async () => {
      throw new Error("native session unavailable");
    },
  });
  const claim = (await controller.claim())!;
  await controller.restore(claim);
  expect(steps(failures)).toEqual(["resume"]);
  expect(controller.status).toEqual({ state: "running", generationId: original.generationId });
  const successor = await controller.prepare();
  expect(captures).toBe(1);
  expect(successor.generationId).not.toBe(original.generationId);
  await expect(new CheckpointStore(home, parse).loadAndClaim()).resolves.toEqual({
    generationId: successor.generationId,
    snapshot: { message: "current" },
  });
});

test("a completed restoration is recorded durably and a later boot starts fresh without replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-completed-restore-"));
  const parse = z.object({ message: z.string() }).parse;
  const store = new CheckpointStore(home, parse);
  const original = await store.commit({ message: "complete history" });
  const restored = new RestartController({
    ...timeouts,
    failed: recordFailures().failed,
    store,
    capture: async () => original.snapshot,
  });
  const restoredClaim = (await restored.claim())!;
  await restored.restore(restoredClaim);
  expect(restored.status).toEqual({ state: "running", generationId: original.generationId });
  expect(
    JSON.parse(
      await readFile(
        join(home, "restart-checkpoints", original.generationId, "restored.json"),
        "utf8",
      ),
    ).generationId,
  ).toBe(original.generationId);
  const { failures, failed } = recordFailures();
  const resumed: unknown[] = [];
  let opened = 0;
  const next = new RestartController({
    ...timeouts,
    failed,
    store: new CheckpointStore(home, parse),
    capture: async () => ({ message: "next" }),
    resume: async (snapshot) => {
      resumed.push(snapshot);
    },
    open: () => {
      opened++;
    },
  });
  expect(await next.claim()).toBeNull();
  expect(next.status).toEqual({ state: "running" });
  expect(opened).toBe(1);
  expect(resumed).toEqual([]);
  expect(steps(failures)).toEqual(["load"]);
  expect(failures[0]!.error).toMatchObject({ reason: "already_restored" });
});

test("completion write failure is reported and the boot still ends running", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restored-write-failure-"));
  const store = new CheckpointStore(home, z.string().parse);
  const original = await store.commit("complete history");
  const { failures, failed } = recordFailures();
  let opened = 0;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => "current",
    open: () => {
      opened++;
    },
  });
  const claim = (await controller.claim())!;
  await mkdir(join(home, "restart-checkpoints", original.generationId, "restored.json"));
  await controller.restore(claim);
  expect(steps(failures)).toEqual(["mark-restored"]);
  expect(controller.status).toEqual({ state: "running", generationId: original.generationId });
  expect(opened).toBe(1);
});

test("a disk failure during commit still invokes replacement without a generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-write-negative-"));
  // A directory at the atomic pointer's destination makes rename fail on the real filesystem.
  await mkdir(join(home, "restart-checkpoints", "ready.json"), { recursive: true });
  const store = new CheckpointStore(home, z.object({ messages: z.array(z.string()) }).parse);
  const { failures, failed } = recordFailures();
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => ({ messages: ["first", "second"] }),
  });
  const replaced: unknown[] = [];
  await controller.replace(async (preparation) => {
    replaced.push(preparation);
  });
  expect(replaced).toEqual([{}]);
  expect(steps(failures)).toEqual(["checkpoint"]);
  expect(controller.status.state).toBe("paused");
});

test("concurrent preparations commit once and replacement sees a valid unclaimed checkpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-ready-"));
  const parse = z.object({ messages: z.array(z.string()) }).parse;
  const store = new CheckpointStore(home, parse);
  let captures = 0;
  const controller = new RestartController({
    ...timeouts,
    failed: recordFailures().failed,
    store,
    capture: async () => {
      captures++;
      return { messages: ["same", "same"] };
    },
  });
  const [a, b] = await Promise.all([controller.prepare(), controller.prepare()]);
  expect(a.generationId).toBe(b.generationId);
  expect(captures).toBe(1);
  let replacements = 0;
  await controller.replace(async (preparation) => {
    replacements++;
    const restored = await new CheckpointStore(home, parse).loadAndClaim();
    expect(restored).toEqual({
      generationId: preparation.generationId,
      snapshot: { messages: ["same", "same"] },
    });
  });
  await controller.replace(async () => {
    replacements++;
  });
  expect(replacements).toBe(1);
});

test("a marker failure after an active resume ends running and the next checkpoint holds current state", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-active-marker-failure-"));
  const parse = z.object({ events: z.array(z.string()) }).parse;
  const store = new CheckpointStore(home, parse);
  const original = await store.commit({ events: ["original input"] });
  const { failures, failed } = recordFailures();
  const events: string[] = [];
  let resumes = 0;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => ({ events: [...events] }),
    install: async (snapshot) => {
      events.push(...snapshot.events);
    },
    resume: async () => {
      resumes++;
      events.push("new output");
    },
  });
  const claim = (await controller.claim())!;
  await mkdir(join(home, "restart-checkpoints", original.generationId, "restored.json"));
  await controller.restore(claim);
  expect(steps(failures)).toEqual(["mark-restored"]);
  expect(controller.status.state).toBe("running");
  expect(resumes).toBe(1);
  const successor = await controller.prepare();
  await expect(new CheckpointStore(home, parse).loadAndClaim()).resolves.toEqual({
    generationId: successor.generationId,
    snapshot: { events: ["original input", "new output"] },
  });
});

test("a failed stop hook is reported and capture and commit still run", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-blocked-stop-"));
  const store = new CheckpointStore(home, z.string().parse);
  const { failures, failed } = recordFailures();
  let captures = 0;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => {
      captures++;
      return "saved after failed stop";
    },
    stop: async () => {
      throw new Error("provider close failed");
    },
  });
  const preparation = await controller.prepare();
  expect(steps(failures)).toEqual(["stop"]);
  expect(captures).toBe(1);
  expect(controller.status).toEqual({
    state: "paused",
    stage: "ready",
    generationId: preparation.generationId,
  });
  await expect(store.loadAndClaim()).resolves.toEqual({
    generationId: preparation.generationId,
    snapshot: "saved after failed stop",
  });
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
    ...timeouts,
    failed: recordFailures().failed,
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
  ).rejects.toMatchObject({ name: "RestartHandoffInProgressError" });
  await expect(store.loadAndClaim()).resolves.toEqual({
    generationId: ready.generationId,
    snapshot: ["cancel before snapshot"],
  });
  expect(effects).toEqual(["cancel before snapshot"]);
});

test("an install failure is reported, the checkpoint still returns, and the boot ends running", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-partial-install-"));
  const store = new CheckpointStore(home, z.array(z.string()).parse);
  const original = await store.commit(["first", "second"]);
  const { failures, failed } = recordFailures();
  const resumed: string[][] = [];
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    install: async () => {
      throw new Error("registry write failed");
    },
    capture: async () => [],
    resume: async (snapshot) => {
      resumed.push(snapshot);
    },
  });
  const claim = await controller.claim();
  expect(claim).toEqual({ generationId: original.generationId, snapshot: ["first", "second"] });
  expect(controller.status).toEqual({
    state: "restoring",
    stage: "installing",
    generationId: original.generationId,
  });
  await controller.restore(claim!);
  expect(steps(failures)).toEqual(["install"]);
  expect(resumed).toEqual([["first", "second"]]);
  expect(controller.status.state).toBe("running");
});

test("a failed status observer cannot change the authoritative lifecycle transition", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-recovery-observer-"));
  const store = new CheckpointStore(home, z.string().parse);
  await store.commit("saved");
  const errors: unknown[] = [];
  let opened = 0;
  const controller = new RestartController({
    ...timeouts,
    failed: recordFailures().failed,
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

test("fresh initialization failure is reported and the boot still opens admissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-fresh-initialization-"));
  const store = new CheckpointStore(home, z.array(z.string()).parse);
  const { failures, failed } = recordFailures();
  let admissionOpen = true;
  const resumed: unknown[] = [];
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    freeze: async () => {
      admissionOpen = false;
    },
    initialize: async () => {
      expect(admissionOpen).toBe(false);
      throw new Error("startup persistence unavailable");
    },
    capture: async () => [],
    resume: async (snapshot) => {
      resumed.push(snapshot);
    },
    open: () => {
      admissionOpen = true;
    },
  });
  expect(await controller.claim()).toBeNull();
  expect(steps(failures)).toEqual(["initialize"]);
  expect(controller.status).toEqual({ state: "running" });
  expect(admissionOpen).toBe(true);
  expect(resumed).toEqual([]);
});

test("a failed cancellation during restoration is reported as control and the boot ends running", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restore-control-failure-"));
  const store = new CheckpointStore(home, z.string().parse);
  await store.commit("original");
  const { failures, failed } = recordFailures();
  const resuming = Promise.withResolvers<void>();
  const resumeRelease = Promise.withResolvers<void>();
  let opened = false;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => "current",
    resume: async () => {
      resuming.resolve();
      await resumeRelease.promise;
    },
    open: () => {
      opened = true;
    },
  });
  const claim = (await controller.claim())!;
  const restoring = controller.restore(claim);
  await resuming.promise;
  const stopUncertain = new Error("stop uncertain");
  await expect(
    controller.control(async () => {
      throw stopUncertain;
    }),
  ).rejects.toThrow("stop uncertain");
  resumeRelease.resolve();
  await restoring;
  expect(failures).toEqual([{ step: "control", error: stopUncertain }]);
  expect(opened).toBe(true);
  expect(controller.status.state).toBe("running");
});

test("pre-effect invalid cancellation cannot poison installation or an active restoration", async () => {
  const { AgentNotFoundError } = await import("../agent/agent-not-found-error.js");
  const home = await mkdtemp(join(tmpdir(), "paseo-control-validation-"));
  const store = new CheckpointStore(home, z.string().parse);
  await store.commit("history");
  const { failures, failed } = recordFailures();
  const starting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let opened = false;
  const controller = new RestartController({
    ...timeouts,
    failed,
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
  expect(failures).toEqual([]);
});

test("a stop hook that never settles cannot prevent capture and commit after the stop limit", async () => {
  vi.useFakeTimers();
  const store = memoryStore<string>();
  const { failures, failed } = recordFailures();
  const controller = new RestartController({
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 10_000,
    failed,
    store,
    stop: () => new Promise<void>(() => {}),
    capture: async () => "saved",
  });
  const preparation = controller.prepare();
  await vi.advanceTimersByTimeAsync(999);
  expect(controller.status.stage).toBe("stopping");
  await vi.advanceTimersByTimeAsync(1);
  await expect(preparation).resolves.toEqual({ generationId: "generation-1" });
  expect(store.committed).toEqual(["saved"]);
  expect(failures).toEqual([{ step: "stop", error: new RestartStepTimeoutError("stop", 1_000) }]);
});

test.each(["capture", "commit"] as const)(
  "a %s that never settles resolves the preparation without a generation at the limit",
  async (stalled) => {
    vi.useFakeTimers();
    const store = memoryStore<string>();
    if (stalled === "commit") store.commit = () => new Promise(() => {});
    const { failures, failed } = recordFailures();
    const controller = new RestartController({
      prepareTimeoutMs: 5_000,
      stopTimeoutMs: 1_000,
      restoreTimeoutMs: 10_000,
      failed,
      store,
      capture: stalled === "capture" ? () => new Promise<string>(() => {}) : async () => "saved",
    });
    const replaced: unknown[] = [];
    const replacement = controller.replace((preparation) => {
      replaced.push(preparation);
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(replaced).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await replacement;
    expect(replaced).toEqual([{}]);
    expect(controller.status).toEqual({ state: "paused", stage: "replacing" });
    expect(failures).toEqual([
      { step: "checkpoint", error: new RestartStepTimeoutError("checkpoint", 5_000) },
    ]);
  },
);

test("a capture that finishes after the checkpoint limit never publishes a late generation", async () => {
  vi.useFakeTimers();
  const store = memoryStore<string>();
  const captureRelease = Promise.withResolvers<string>();
  const controller = new RestartController({
    prepareTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 10_000,
    failed: recordFailures().failed,
    store,
    capture: () => captureRelease.promise,
  });
  const preparation = controller.prepare();
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(preparation).resolves.toEqual({});
  captureRelease.resolve("late");
  await vi.runAllTimersAsync();
  expect(store.committed).toEqual([]);
});

test("a resume that never settles opens admissions after the restore limit", async () => {
  vi.useFakeTimers();
  const store = memoryStore("saved work");
  const { failures, failed } = recordFailures();
  let opened = 0;
  let finalized = 0;
  const controller = new RestartController({
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 3_000,
    failed,
    store,
    capture: async () => "current",
    resume: () => new Promise<void>(() => {}),
    finalize: async () => {
      finalized++;
    },
    open: () => {
      opened++;
    },
  });
  const claim = (await controller.claim())!;
  const restoration = controller.restore(claim);
  await vi.advanceTimersByTimeAsync(2_999);
  expect(opened).toBe(0);
  expect(controller.status).toEqual({
    state: "restoring",
    stage: "starting",
    generationId: "saved",
  });
  await vi.advanceTimersByTimeAsync(1);
  await restoration;
  expect(opened).toBe(1);
  expect(finalized).toBe(0);
  expect(store.restored).toEqual(["saved"]);
  expect(controller.status).toEqual({ state: "running", generationId: "saved" });
  expect(failures).toEqual([
    { step: "restore", error: new RestartStepTimeoutError("restore", 3_000) },
  ]);
});

test("a preparation during a running restore stops without waiting and skips finalize and open", async () => {
  const store = memoryStore("saved work");
  const { failures, failed } = recordFailures();
  const resumeRelease = Promise.withResolvers<void>();
  const order: string[] = [];
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => {
      order.push("capture");
      return "current";
    },
    resume: async () => {
      order.push("resume started");
      await resumeRelease.promise;
      order.push("resume finished");
    },
    stop: async () => {
      order.push("stop");
    },
    finalize: async () => {
      order.push("finalize");
    },
    open: () => {
      order.push("open");
    },
  });
  const restoration = controller.restore((await controller.claim())!);
  const preparation = controller.prepare();
  await expect(preparation).resolves.toEqual({ generationId: "generation-1" });
  expect(order).toEqual(["resume started", "stop", "capture"]);
  expect(store.committed).toEqual(["current"]);
  resumeRelease.resolve();
  await restoration;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual(["resume started", "stop", "capture", "resume finished"]);
  expect(store.restored).toEqual(["saved"]);
  expect(controller.status).toEqual({
    state: "paused",
    stage: "ready",
    generationId: "generation-1",
  });
  expect(failures).toEqual([]);
});

test("a preparation during a resume that never settles saves a checkpoint without the restore", async () => {
  vi.useFakeTimers();
  const store = memoryStore("saved work");
  const { failures, failed } = recordFailures();
  const order: string[] = [];
  const controller = new RestartController({
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 3_000,
    failed,
    store,
    capture: async () => {
      order.push("capture");
      return "current";
    },
    resume: () => new Promise<void>(() => {}),
    stop: async () => {
      order.push("stop");
    },
    finalize: async () => {
      order.push("finalize");
    },
    open: () => {
      order.push("open");
    },
  });
  const restoration = controller.restore((await controller.claim())!);
  await expect(controller.prepare()).resolves.toEqual({ generationId: "generation-1" });
  expect(order).toEqual(["stop", "capture"]);
  expect(store.committed).toEqual(["current"]);
  await vi.advanceTimersByTimeAsync(3_000);
  await restoration;
  await vi.runAllTimersAsync();
  expect(store.restored).toEqual(["saved"]);
  expect(order).toEqual(["stop", "capture"]);
  expect(controller.status).toEqual({
    state: "paused",
    stage: "ready",
    generationId: "generation-1",
  });
  expect(failures).toEqual([
    { step: "restore", error: new RestartStepTimeoutError("restore", 3_000) },
  ]);
});

test("a control that never settles cannot hold the restore past the stop limit", async () => {
  vi.useFakeTimers();
  const store = memoryStore("saved work");
  const { failures, failed } = recordFailures();
  const resumeRelease = Promise.withResolvers<void>();
  const order: string[] = [];
  const controller = new RestartController({
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 3_000,
    failed,
    store,
    capture: async () => "current",
    resume: () => resumeRelease.promise,
    finalize: async () => {
      order.push("finalize");
    },
    open: () => {
      order.push("open");
    },
  });
  const restoration = controller.restore((await controller.claim())!);
  void controller.control(() => new Promise<void>(() => {}));
  resumeRelease.resolve();
  await vi.advanceTimersByTimeAsync(999);
  expect(order).toEqual([]);
  expect(controller.status).toEqual({
    state: "restoring",
    stage: "starting",
    generationId: "saved",
  });
  await vi.advanceTimersByTimeAsync(1);
  await restoration;
  expect(order).toEqual(["finalize", "open"]);
  expect(store.restored).toEqual(["saved"]);
  expect(controller.status).toEqual({ state: "running", generationId: "saved" });
  expect(failures).toEqual([
    { step: "controls", error: new RestartStepTimeoutError("controls", 1_000) },
  ]);
});

test("a control that never settles cannot consume the checkpoint budget", async () => {
  vi.useFakeTimers();
  const store = memoryStore<string>();
  const { failures, failed } = recordFailures();
  const controller = new RestartController({
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 3_000,
    failed,
    store,
    capture: async () => "saved",
  });
  void controller.control(() => new Promise<void>(() => {}));
  const preparation = controller.prepare();
  await vi.advanceTimersByTimeAsync(999);
  expect(controller.status.stage).toBe("checkpointing");
  expect(store.committed).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(preparation).resolves.toEqual({ generationId: "generation-1" });
  expect(store.committed).toEqual(["saved"]);
  expect(failures).toEqual([
    { step: "controls", error: new RestartStepTimeoutError("controls", 1_000) },
  ]);
});

const loadFailureReasons: CheckpointLoadFailureReason[] = [
  "ready_pointer_corrupt",
  "generation_missing",
  "manifest_corrupt",
  "manifest_checksum_mismatch",
  "snapshot_corrupt",
  "snapshot_invalid",
  "already_claimed",
  "already_restored",
];

test.each([
  ...loadFailureReasons.map((reason) => new CheckpointLoadError(reason, "generation", reason)),
  new Error("permission denied"),
])("a load failure ($message) starts the boot without a checkpoint", async (loadError) => {
  const store = memoryStore<string>();
  store.loadAndClaim = () => Promise.reject(loadError);
  const { failures, failed } = recordFailures();
  let initialized = 0;
  let opened = 0;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => "current",
    initialize: async () => {
      initialized++;
    },
    open: () => {
      opened++;
    },
  });
  expect(await controller.claim()).toBeNull();
  expect(failures).toEqual([{ step: "load", error: loadError }]);
  expect(store.abandoned).toBe(1);
  expect(initialized).toBe(1);
  expect(opened).toBe(1);
  expect(controller.status).toEqual({ state: "running" });
});

test("a boot without a ready generation abandons nothing", async () => {
  const store = memoryStore<string>();
  const { failures, failed } = recordFailures();
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => "current",
  });
  expect(await controller.claim()).toBeNull();
  expect(store.abandoned).toBe(0);
  expect(failures).toEqual([]);
  expect(controller.status).toEqual({ state: "running" });
});

test("a failed abandon is reported and the boot still ends running", async () => {
  const store = memoryStore<string>();
  const loadError = new CheckpointLoadError("snapshot_invalid", "generation", "invalid");
  const abandonError = new Error("claim marker write failed");
  store.loadAndClaim = () => Promise.reject(loadError);
  store.abandonReady = () => Promise.reject(abandonError);
  const { failures, failed } = recordFailures();
  let opened = 0;
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => "current",
    open: () => {
      opened++;
    },
  });
  expect(await controller.claim()).toBeNull();
  expect(failures).toEqual([
    { step: "load", error: loadError },
    { step: "abandon", error: abandonError },
  ]);
  expect(opened).toBe(1);
  expect(controller.status).toEqual({ state: "running" });
});

test("an unloadable checkpoint is abandoned on disk and a later boot does not replay it", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-abandon-unloadable-"));
  const store = new CheckpointStore(home, z.string().parse);
  const old = await store.commit("old continuation");
  await writeFile(join(home, "restart-checkpoints", old.generationId, "snapshot.json"), "{}");
  const resumed: string[] = [];
  function boot() {
    const recorded = recordFailures();
    const controller = new RestartController({
      ...timeouts,
      failed: recorded.failed,
      store: new CheckpointStore(home, z.string().parse),
      capture: async () => "current",
      resume: async (snapshot) => {
        resumed.push(snapshot);
      },
    });
    return { controller, failures: recorded.failures };
  }
  const first = boot();
  expect(await first.controller.claim()).toBeNull();
  expect(first.failures).toMatchObject([
    { step: "load", error: { reason: "manifest_checksum_mismatch" } },
  ]);
  // Repairing the snapshot bytes cannot revive a generation that a boot already skipped.
  await writeFile(
    join(home, "restart-checkpoints", old.generationId, "snapshot.json"),
    JSON.stringify("old continuation", null, 2),
  );
  const second = boot();
  expect(await second.controller.claim()).toBeNull();
  expect(second.failures).toMatchObject([{ step: "load", error: { reason: "already_claimed" } }]);
  expect(resumed).toEqual([]);
});

test("a rejected freeze is reported and stop, capture, and commit still run", async () => {
  const store = memoryStore<string>();
  const { failures, failed } = recordFailures();
  const freezeError = new Error("ingress close failed");
  const order: string[] = [];
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    freeze: () => Promise.reject(freezeError),
    stop: async () => {
      order.push("stop");
    },
    capture: async () => {
      order.push("capture");
      return "saved";
    },
  });
  await expect(controller.prepare()).resolves.toEqual({ generationId: "generation-1" });
  expect(order).toEqual(["stop", "capture"]);
  expect(store.committed).toEqual(["saved"]);
  expect(failures).toEqual([{ step: "freeze", error: freezeError }]);
});

test("a rejected freeze during a running restore is reported and stop still runs", async () => {
  const store = memoryStore("saved work");
  const { failures, failed } = recordFailures();
  const freezeError = new Error("ingress close failed");
  const resumeRelease = Promise.withResolvers<void>();
  let freezes = 0;
  const order: string[] = [];
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    freeze: async () => {
      freezes++;
      if (freezes === 2) throw freezeError;
    },
    resume: () => resumeRelease.promise,
    stop: async () => {
      order.push("stop");
    },
    capture: async () => {
      order.push("capture");
      return "current";
    },
  });
  const restoration = controller.restore((await controller.claim())!);
  await expect(controller.prepare()).resolves.toEqual({ generationId: "generation-1" });
  expect(order).toEqual(["stop", "capture"]);
  resumeRelease.resolve();
  await restoration;
  expect(failures).toEqual([{ step: "freeze", error: freezeError }]);
});

test("a control accepted during the completion marker settles before finalize", async () => {
  const store = memoryStore("saved work");
  const markerEntered = Promise.withResolvers<void>();
  const markerRelease = Promise.withResolvers<void>();
  const controlRelease = Promise.withResolvers<void>();
  const finalizeEntered = Promise.withResolvers<void>();
  const finalizeRelease = Promise.withResolvers<void>();
  store.markRestored = async () => {
    markerEntered.resolve();
    await markerRelease.promise;
  };
  const order: string[] = [];
  const { failures, failed } = recordFailures();
  const controller = new RestartController({
    ...timeouts,
    failed,
    store,
    capture: async () => "current",
    finalize: async () => {
      order.push("finalize");
      finalizeEntered.resolve();
      await finalizeRelease.promise;
    },
    open: () => {
      order.push("open");
    },
  });
  const restoration = controller.restore((await controller.claim())!);
  await markerEntered.promise;
  const cancellation = controller.control(async () => {
    await controlRelease.promise;
    order.push("cancellation");
  });
  markerRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([]);
  controlRelease.resolve();
  await cancellation;
  await finalizeEntered.promise;
  await expect(
    controller.control(async () => {
      order.push("during finalize");
    }),
  ).rejects.toMatchObject({ name: "RestartHandoffInProgressError" });
  finalizeRelease.resolve();
  await restoration;
  expect(order).toEqual(["cancellation", "finalize", "open"]);
  expect(controller.status).toEqual({ state: "running", generationId: "saved" });
  expect(failures).toEqual([]);
});

test("after a resume timeout the boot runs and finalize runs once when the late resume settles", async () => {
  vi.useFakeTimers();
  const store = memoryStore("saved work");
  const { failures, failed } = recordFailures();
  const resumeRelease = Promise.withResolvers<void>();
  const order: string[] = [];
  const controller = new RestartController({
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
    restoreTimeoutMs: 3_000,
    failed,
    store,
    capture: async () => "current",
    resume: () => resumeRelease.promise,
    finalize: async () => {
      order.push("finalize");
    },
    open: () => {
      order.push("open");
    },
  });
  const restoration = controller.restore((await controller.claim())!);
  await vi.advanceTimersByTimeAsync(3_000);
  await restoration;
  expect(order).toEqual(["open"]);
  expect(store.restored).toEqual(["saved"]);
  expect(controller.status).toEqual({ state: "running", generationId: "saved" });
  resumeRelease.resolve();
  await vi.runAllTimersAsync();
  expect(order).toEqual(["open", "finalize"]);
  expect(failures).toEqual([
    { step: "restore", error: new RestartStepTimeoutError("restore", 3_000) },
  ]);
});
