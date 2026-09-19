import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { CheckpointStore } from "./checkpoint-store.js";
import { RestartController } from "./restart-controller.js";

const requester = { principalId: "owner", clientId: "operator-cli", sessionId: "bound-session" };
const parse = z.array(z.string()).parse;

async function consumed() {
  const home = await mkdtemp(join(tmpdir(), "paseo-crash-ack-"));
  const store = new CheckpointStore(home, parse);
  const source = await store.commit(["obsolete continuation"]);
  await store.loadAndClaim();
  await store.markRestored(source.generationId);
  return { home, source, directory: join(home, "restart-checkpoints", source.generationId) };
}

async function files(directory: string) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory))
        .sort()
        .map(async (name) => [name, await readFile(join(directory, name), "utf8")]),
    ),
  );
}

test("acknowledgment preserves the consumed generation and opens only its current-state successor", async () => {
  const { home, source, directory } = await consumed();
  const before = await files(directory);
  const store = new CheckpointStore(home, parse);
  let initialized = 0;
  let installed = 0;
  let opened = 0;
  const resumed: string[][] = [];
  const controller = new RestartController({
    store,
    capture: async () => ["current registry obligations"],
    install: async () => {
      installed++;
    },
    initialize: async () => {
      initialized++;
    },
    resume: async (snapshot) => {
      resumed.push(snapshot);
    },
    open: () => {
      opened++;
    },
  });
  await expect(controller.claim()).rejects.toMatchObject({ reason: "already_restored" });
  await expect(controller.acknowledgeCrash("wrong-generation", true, requester)).rejects.toThrow(
    "exact consumed generation",
  );
  expect(await files(directory)).toEqual(before);
  expect(initialized).toBe(0);
  await controller.acknowledgeCrash(source.generationId, true, requester);
  expect(controller.status).toMatchObject({
    state: "running",
    previousGenerationId: source.generationId,
  });
  const successor = controller.status.generationId!;
  expect(successor).not.toBe(source.generationId);
  expect(installed).toBe(0);
  expect(initialized).toBe(1);
  expect(opened).toBe(1);
  expect(resumed).toEqual([["current registry obligations"]]);
  const after = await files(directory);
  for (const [name, bytes] of Object.entries(before)) expect(after[name]).toBe(bytes);
  const audit = Object.entries(after).find(([name]) =>
    name.startsWith("operator-crash-acknowledgment-"),
  )!;
  expect(JSON.parse(audit[1])).toMatchObject({
    generationId: source.generationId,
    requester,
    daemonPid: process.pid,
    orphanExecutionReconciled: true,
    paseoOnlyStateMayBeLost: true,
  });
  const provenance = JSON.parse(
    await readFile(
      join(home, "restart-checkpoints", successor, "crash-reconciliation.json"),
      "utf8",
    ),
  );
  expect(provenance).toMatchObject({
    successorGenerationId: successor,
    acknowledgment: { generationId: source.generationId, requester },
  });
  expect((await store.inspectReadyGeneration(successor)).snapshot).toEqual([
    "current registry obligations",
  ]);
  const nextBoot = new RestartController({
    store: new CheckpointStore(home, parse),
    capture: async () => [],
  });
  await expect(nextBoot.claim()).rejects.toMatchObject({
    reason: "already_restored",
    generationId: successor,
  });
});

test("an audit-only interrupted acknowledgment grants no boot authority and a new decision gets a new receipt", async () => {
  const { home, source, directory } = await consumed();
  let initializeCount = 0;
  const first = new RestartController({
    store: new CheckpointStore(home, parse),
    capture: async () => ["current"],
    initialize: async () => {
      initializeCount++;
      throw new Error("registry reconciliation failed");
    },
  });
  await expect(first.claim()).rejects.toMatchObject({ reason: "already_restored" });
  await expect(first.acknowledgeCrash(source.generationId, true, requester)).rejects.toThrow(
    "registry reconciliation failed",
  );
  const second = new RestartController({
    store: new CheckpointStore(home, parse),
    capture: async () => ["current"],
    initialize: async () => {
      initializeCount++;
    },
  });
  await expect(second.claim()).rejects.toMatchObject({
    reason: "already_restored",
    generationId: source.generationId,
  });
  expect(initializeCount).toBe(1);
  await second.acknowledgeCrash(source.generationId, true, requester);
  expect(initializeCount).toBe(2);
  expect(
    (await readdir(directory)).filter((name) => name.startsWith("operator-crash-acknowledgment-")),
  ).toHaveLength(2);
});

test("failed fresh initialization after acknowledgment retries current ownership without reinstalling source work", async () => {
  const { home, source, directory } = await consumed();
  const current: string[] = [];
  let fail = true;
  const controller = new RestartController({
    store: new CheckpointStore(home, parse),
    capture: async () => current,
    initialize: async () => {
      if (!current.length) current.push("retained reconciliation work");
      if (fail) throw new Error("temporary initialization failure");
    },
    install: async () => {
      throw new Error("must not install obsolete work");
    },
    resume: async (snapshot) => {
      expect(snapshot).toEqual(current);
    },
  });
  await expect(controller.claim()).rejects.toMatchObject({ reason: "already_restored" });
  await expect(controller.acknowledgeCrash(source.generationId, true, requester)).rejects.toThrow(
    "temporary initialization failure",
  );
  fail = false;
  await controller.retryRecovery();
  expect(controller.status.state).toBe("running");
  expect(current).toEqual(["retained reconciliation work"]);
  expect(
    (await readdir(directory)).filter((name) => name.startsWith("operator-crash-acknowledgment-")),
  ).toHaveLength(1);
});

test.each(["claimed", "corrupt snapshot", "changed pointer"] as const)(
  "refuses %s without initializing or writing an acknowledgment",
  async (condition) => {
    const { home, source, directory } = await consumed();
    const store = new CheckpointStore(home, parse);
    let initialized = false;
    const controller = new RestartController({
      store,
      capture: async () => [],
      initialize: async () => {
        initialized = true;
      },
    });
    if (condition === "claimed") await writeFile(join(directory, "restored.json"), "{}");
    await expect(controller.claim()).rejects.toThrow();
    if (condition === "corrupt snapshot") await writeFile(join(directory, "snapshot.json"), "[]");
    if (condition === "changed pointer") await store.commit(["another generation"]);
    const before = await files(directory);
    await expect(
      controller.acknowledgeCrash(source.generationId, true, requester),
    ).rejects.toThrow();
    expect(initialized).toBe(false);
    expect(await files(directory)).toEqual(before);
  },
);

test("an independently advanced ready pointer during capture is preserved", async () => {
  const { home, source, directory } = await consumed();
  const store = new CheckpointStore(home, parse);
  let laterGeneration = "";
  const controller = new RestartController({
    store,
    capture: async () => {
      laterGeneration = (
        await new CheckpointStore(home, parse).commit(["independent current state"])
      ).generationId;
      return ["acknowledged current state"];
    },
  });
  await expect(controller.claim()).rejects.toMatchObject({ reason: "already_restored" });
  await expect(controller.acknowledgeCrash(source.generationId, true, requester)).rejects.toThrow(
    "Expected ready generation",
  );
  expect((await store.peekStatus())?.generationId).toBe(laterGeneration);
  expect(
    (await readdir(directory)).filter((name) => name.startsWith("operator-crash-successor-")),
  ).toEqual([]);
});

test("acknowledging consumed history verifies streaming integrity without decoding the snapshot", async () => {
  const { home, source } = await consumed();
  let decodes = 0;
  const store = new CheckpointStore(home, () => {
    decodes++;
    throw new Error("consumed history must not be decoded");
  });
  await expect(
    store.acknowledgeConsumedGeneration(source.generationId, requester),
  ).resolves.toMatchObject({ generationId: source.generationId });
  expect(decodes).toBe(0);
});

test("a crash after successor publication retains provenance and restores only reconciled state", async () => {
  const { home, source, directory } = await consumed();
  const before = await files(directory);
  class CommitInterruptedStore extends CheckpointStore<string[]> {
    override async commit(
      ...args: Parameters<CheckpointStore<string[]>["commit"]>
    ): ReturnType<CheckpointStore<string[]>["commit"]> {
      await super.commit(...args);
      throw new Error("process lost after ready publication");
    }
  }
  const controller = new RestartController({
    store: new CommitInterruptedStore(home, parse),
    capture: async () => ["reconciled registry"],
    resume: async () => {
      throw new Error("must not resume before claim");
    },
  });
  await expect(controller.claim()).rejects.toMatchObject({ reason: "already_restored" });
  await expect(controller.acknowledgeCrash(source.generationId, true, requester)).rejects.toThrow(
    "process lost",
  );
  const next = new CheckpointStore(home, parse);
  const successor = (await next.loadAndClaim())!;
  expect(successor.snapshot).toEqual(["reconciled registry"]);
  const provenance = JSON.parse(
    await readFile(
      join(home, "restart-checkpoints", successor.generationId, "crash-reconciliation.json"),
      "utf8",
    ),
  );
  expect(provenance).toMatchObject({
    successorGenerationId: successor.generationId,
    acknowledgment: {
      generationId: source.generationId,
      requester,
      orphanExecutionReconciled: true,
      paseoOnlyStateMayBeLost: true,
    },
  });
  const after = await files(directory);
  for (const [name, bytes] of Object.entries(before)) expect(after[name]).toBe(bytes);
  await expect(new CheckpointStore(home, parse).loadAndClaim()).rejects.toMatchObject({
    reason: "already_claimed",
    generationId: successor.generationId,
  });
});

test("a crash after successor claim cannot replay reconciled state", async () => {
  const { home, source } = await consumed();
  const store = new CheckpointStore(home, parse);
  const controller = new RestartController({
    store,
    capture: async () => ["reconciled registry"],
    resume: async () => {
      throw new Error("process lost after claim");
    },
  });
  await expect(controller.claim()).rejects.toMatchObject({ reason: "already_restored" });
  await expect(controller.acknowledgeCrash(source.generationId, true, requester)).rejects.toThrow(
    "process lost after claim",
  );
  const successor = (await store.peekStatus())!.generationId;
  expect(successor).not.toBe(source.generationId);
  expect(
    JSON.parse(
      await readFile(
        join(home, "restart-checkpoints", successor, "crash-reconciliation.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({ successorGenerationId: successor });
  await expect(new CheckpointStore(home, parse).loadAndClaim()).rejects.toMatchObject({
    reason: "already_claimed",
    generationId: successor,
  });
});
