import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateReadyCheckpoint } from "../src/server/restart/checkpoint-compatibility.js";
import { readDaemonInstance } from "../src/server/daemon-instance.js";
import {
  systemProcessTreeInspection,
  type ProcessIdentity,
} from "../src/utils/process-tree-inspection.js";
import { cleanupServiceCgroup, openServiceCgroup } from "../src/utils/service-cgroup-cleanup.js";
import { withTimeout } from "../src/utils/promise-timeout.js";

const execFileAsync = promisify(execFile);

interface PreparedServiceInspection {
  properties(): Promise<Record<string, string>>;
  leaders(home: string): Promise<ProcessIdentity[]>;
  open(excludedPids: number[]): ReturnType<typeof openServiceCgroup>;
}

async function assertGeneration(home: string, generationId: string) {
  const ready = JSON.parse(
    await readFile(path.join(home, "restart-checkpoints", "ready.json"), "utf8"),
  );
  if (ready.generationId !== generationId)
    throw new Error("Prepared generation changed; cleanup refused");
  for (const marker of ["claimed.json", "restored.json"]) {
    try {
      await access(path.join(home, "restart-checkpoints", generationId, marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Deployment generation was consumed; cleanup refused");
  }
}

export function inspectPreparedService(unit = "paseo.service"): PreparedServiceInspection {
  return {
    async properties() {
      const { stdout } = await execFileAsync(
        "systemctl",
        [
          "show",
          unit,
          "-p",
          "MainPID",
          "-p",
          "InvocationID",
          "-p",
          "ActiveState",
          "-p",
          "ExecMainCode",
          "-p",
          "ExecMainStatus",
        ],
        { timeout: 10_000 },
      );
      return Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    },
    async leaders(home) {
      const instance = await readDaemonInstance(home);
      if (!instance) throw new Error("Prepared daemon identity is unavailable");
      const family = await systemProcessTreeInspection.snapshot([{ pid: instance.pid }], 10_000);
      const supervisor = family.find(
        (identity) => identity.pid === instance.pid && !identity.stopped,
      );
      const workers = family.filter(
        (identity) => identity.parentPid === instance.pid && !identity.stopped,
      );
      if (!supervisor || workers.length !== 1)
        throw new Error("Prepared worker identity is unavailable");
      return [supervisor, workers[0]!];
    },
    open: (excludedPids) => openServiceCgroup(`/system.slice/${unit}`, excludedPids, true),
  };
}

/** Used by the checkpointed activation wrapper to transition packages without worker cleanup. */
export async function cleanupPreparedService(
  home: string,
  generationId: string,
  invocationId: string,
  inspection = inspectPreparedService(),
): Promise<void> {
  if (!home || !generationId || !invocationId)
    throw new Error("Exact deployment proof is required");
  const leaders = await inspection.leaders(home);
  const assertPrepared = async () => {
    const properties = await inspection.properties();
    if (
      properties.MainPID !== String(leaders[0]?.pid) ||
      properties.InvocationID !== invocationId ||
      properties.ActiveState !== "active" ||
      JSON.stringify(await inspection.leaders(home)) !== JSON.stringify(leaders)
    )
      throw new Error("Prepared service identity changed; cleanup refused");
    await assertGeneration(home, generationId);
  };
  await assertPrepared();
  await validateReadyCheckpoint(home, generationId);
  const group = await inspection.open(leaders.map((identity) => identity.pid));
  await cleanupServiceCgroup({
    members: async (deadline) => {
      await assertPrepared();
      return group.members(deadline);
    },
    signal: async (identity, signal, deadline) => {
      await assertPrepared();
      await group.signal(identity, signal, deadline, assertPrepared);
    },
  });
}

/** No signals here: refuse activation unless the old invocation stopped cleanly. */
export async function certifyStoppedService(
  home: string,
  generationId: string,
  invocationId: string,
  inspection = inspectPreparedService(),
): Promise<void> {
  if (!home || !generationId || !invocationId)
    throw new Error("Exact deployment proof is required");
  const assertStopped = async () => {
    const properties = await inspection.properties();
    if (
      properties.MainPID !== "0" ||
      properties.ActiveState !== "inactive" ||
      properties.InvocationID !== invocationId ||
      properties.ExecMainCode !== "1" ||
      properties.ExecMainStatus !== "0"
    )
      throw new Error("Old service did not stop successfully; activation refused");
    await assertGeneration(home, generationId);
  };
  await assertStopped();
  await validateReadyCheckpoint(home, generationId);
  const group = await inspection.open([]);
  if ((await withTimeout(group.members(), 10_000, "Inspect stopped service cgroup")).length)
    throw new Error("Old service cgroup is populated; activation refused");
  await assertStopped();
}

if (/cleanup-prepared-service\.[jt]s$/.test(process.argv[1] ?? "")) {
  const stopped = process.argv[2] === "--stopped";
  void (stopped ? certifyStoppedService : cleanupPreparedService)(
    process.env.PASEO_DEPLOY_HOME ?? "",
    process.env.PASEO_DEPLOY_GENERATION ?? "",
    process.argv[stopped ? 3 : 2] ?? "",
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
