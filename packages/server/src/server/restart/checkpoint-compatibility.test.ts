import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { inspectServiceCgroup } from "../../utils/service-cgroup-cleanup.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { DaemonCheckpointSchema } from "./daemon-checkpoint.js";
import {
  cleanupPreparedService,
  certifyStoppedService,
} from "../../../scripts/cleanup-prepared-service.js";
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
      ...(version === 4 ? { services: [] } : {}),
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

async function stoppedServiceFixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-service-transition-"));
  const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
  const saved = await store.commit({
    version: 4,
    agents: { agents: [], timelines: {}, children: [] },
    notifications: [],
    schedules: { runs: [] },
    services: [],
  });
  const calls: string[] = [];
  const properties = {
    MainPID: "101",
    InvocationID: "old-invocation",
    ActiveState: "active",
    ExecMainCode: "1",
    ExecMainStatus: "0",
  };
  const inspection = {
    properties: async () => properties,
    leaders: async () => [
      { pid: 101, parentPid: 1, created: "supervisor", stopped: false },
      { pid: 202, parentPid: 101, created: "worker", stopped: false },
    ],
    open: async () => {
      calls.push("open");
      let alive = true;
      return {
        members: async () =>
          alive ? [{ pid: 303, parentPid: 1, created: "orphan", stopped: false }] : [],
        signal: async (_identity: unknown, signal: NodeJS.Signals) => {
          calls.push(signal);
          alive = false;
        },
      };
    },
  };
  return { home, store, saved, calls, properties, inspection };
}

test("the old package transition cleans after exact unclaimed checkpoint proof and retains its leaders", async () => {
  const f = await stoppedServiceFixture();
  const before = await readFile(
    join(f.home, "restart-checkpoints", f.saved.generationId, "snapshot.json"),
    "utf8",
  );
  await cleanupPreparedService(f.home, f.saved.generationId, "old-invocation", f.inspection);
  expect(f.calls).toEqual(["open", "SIGTERM"]);
  expect(
    await readFile(
      join(f.home, "restart-checkpoints", f.saved.generationId, "snapshot.json"),
      "utf8",
    ),
  ).toBe(before);
  expect((await f.store.peekStatus())?.claimed).toBe(false);
});

test.each([
  { MainPID: "0", ActiveState: "inactive" },
  { ActiveState: "failed", ExecMainCode: "2", ExecMainStatus: "15" },
  { MainPID: "999" },
  { InvocationID: "replacement-invocation" },
])(
  "the old package transition refuses changed or unexpectedly exited workers: %j",
  async (change) => {
    const f = await stoppedServiceFixture();
    Object.assign(f.properties, change);
    await expect(
      cleanupPreparedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
    ).rejects.toThrow("cleanup refused");
    expect(f.calls).toEqual([]);
  },
);

test.each(["wrong", "consumed", "corrupt"])(
  "the old package transition refuses a %s checkpoint",
  async (failure) => {
    const f = await stoppedServiceFixture();
    if (failure === "consumed") await f.store.loadAndClaim();
    if (failure === "corrupt")
      await writeFile(
        join(f.home, "restart-checkpoints", f.saved.generationId, "snapshot.json"),
        "{}",
      );
    await expect(
      cleanupPreparedService(
        f.home,
        failure === "wrong" ? "wrong" : f.saved.generationId,
        "old-invocation",
        f.inspection,
      ),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);

test.each(["invocation", "consumed", "generation", "supervisor", "worker"])(
  "proof changing between membership and signal refuses cleanup: %s",
  async (failure) => {
    const f = await stoppedServiceFixture();
    const leaders = await f.inspection.leaders();
    let captures = 0;
    f.inspection.leaders = async () => leaders;
    f.inspection.open = async () => ({
      members: async () => {
        if (++captures === 1) {
          if (failure === "invocation") f.properties.InvocationID = "replacement";
          if (failure === "consumed") await f.store.loadAndClaim();
          if (failure === "generation")
            await writeFile(
              join(f.home, "restart-checkpoints", "ready.json"),
              JSON.stringify({ generationId: "newer" }),
            );
          if (failure === "supervisor") leaders[0]!.created = "replacement-supervisor";
          if (failure === "worker") leaders[1]!.created = "replacement-worker";
        }
        return [{ pid: 303, parentPid: 1, created: "orphan", stopped: false }];
      },
      signal: async () => {
        f.calls.push("unexpected signal");
      },
    });
    // Return value copies prevent the retained proof from sharing mutable adapter state.
    f.inspection.leaders = async () => leaders.map((identity) => Object.assign({}, identity));
    await expect(
      cleanupPreparedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
    ).rejects.toThrow("cleanup refused");
    expect(f.calls).toEqual([]);
  },
);

test("an executor in the service cgroup refuses the prepared transition", async () => {
  const f = await stoppedServiceFixture();
  f.inspection.open = async () => {
    throw new Error("Deployment cleanup executor must be outside the service cgroup");
  };
  await expect(
    cleanupPreparedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
  ).rejects.toThrow("must be outside");
  expect(f.calls).toEqual([]);
});

test.each(["invocation", "consumed", "generation", "supervisor", "worker"])(
  "a proof change during the final identity read refuses the signal: %s",
  async (failure) => {
    const f = await stoppedServiceFixture();
    const leaders = await f.inspection.leaders();
    f.inspection.leaders = async () => leaders.map((identity) => Object.assign({}, identity));
    let reads = 0;
    const identity = { pid: 303, parentPid: 1, created: "orphan", stopped: false };
    f.inspection.open = async () =>
      inspectServiceCgroup(
        {
          pids: async () => [303],
          current: () => identity.created,
          read: async () => {
            if (++reads === 2) {
              if (failure === "invocation") f.properties.InvocationID = "replacement";
              if (failure === "consumed") await f.store.loadAndClaim();
              if (failure === "generation")
                await writeFile(
                  join(f.home, "restart-checkpoints", "ready.json"),
                  JSON.stringify({ generationId: "replacement" }),
                );
              if (failure === "supervisor") leaders[0]!.created = "replacement-supervisor";
              if (failure === "worker") leaders[1]!.created = "replacement-worker";
            }
            return identity;
          },
          signal: async () => {
            f.calls.push("unexpected signal");
          },
        },
        [],
      );
    await expect(
      cleanupPreparedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
    ).rejects.toThrow("cleanup refused");
    expect(reads).toBe(2);
    expect(f.calls).toEqual([]);
  },
);

async function finalStopFixture() {
  const f = await stoppedServiceFixture();
  Object.assign(f.properties, { MainPID: "0", ActiveState: "inactive" });
  f.inspection.open = async () => ({
    members: async () => [],
    signal: async () => {
      throw new Error("No stopped signals allowed");
    },
  });
  return f;
}

test("final stopped certification requires the exact successful exit and empty group without changing its checkpoint", async () => {
  const f = await finalStopFixture();
  await certifyStoppedService(f.home, f.saved.generationId, "old-invocation", f.inspection);
  expect((await f.store.peekStatus())?.claimed).toBe(false);
});

test.each([
  { MainPID: "101" },
  { ActiveState: "active" },
  { ActiveState: "failed" },
  { InvocationID: "replacement" },
  { ExecMainCode: "2", ExecMainStatus: "15" },
  { ExecMainStatus: "1" },
])("final stopped certification refuses failed or changed exit proof: %j", async (change) => {
  const f = await finalStopFixture();
  Object.assign(f.properties, change);
  await expect(
    certifyStoppedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
  ).rejects.toThrow("activation refused");
});

test("final stopped certification refuses a surviving member", async () => {
  const f = await finalStopFixture();
  f.inspection.open = async () => ({
    members: async () => [{ pid: 303, parentPid: 1, created: "survivor", stopped: false }],
    signal: async () => {
      throw new Error("No stopped signals allowed");
    },
  });
  await expect(
    certifyStoppedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
  ).rejects.toThrow("populated");
});

test.each(["invocation", "consumed", "generation"])(
  "final stopped proof is rechecked after membership: %s",
  async (failure) => {
    const f = await finalStopFixture();
    f.inspection.open = async () => ({
      members: async () => {
        if (failure === "invocation") f.properties.InvocationID = "replacement";
        if (failure === "consumed") await f.store.loadAndClaim();
        if (failure === "generation")
          await writeFile(
            join(f.home, "restart-checkpoints", "ready.json"),
            JSON.stringify({ generationId: "newer" }),
          );
        return [];
      },
      signal: async () => {
        throw new Error("No stopped signals allowed");
      },
    });
    await expect(
      certifyStoppedService(f.home, f.saved.generationId, "old-invocation", f.inspection),
    ).rejects.toThrow(/refused/);
  },
);
