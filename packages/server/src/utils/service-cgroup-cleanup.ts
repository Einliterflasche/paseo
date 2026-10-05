import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { systemProcessTreeInspection, type ProcessIdentity } from "./process-tree-inspection.js";
import { withTimeout } from "./promise-timeout.js";

export interface ServiceCgroup {
  members(deadline?: number): Promise<ProcessIdentity[]>;
  signal(
    identity: ProcessIdentity,
    signal: NodeJS.Signals,
    deadline?: number,
    guard?: () => Promise<void>,
  ): Promise<void>;
}

export interface ServiceCgroupInspection {
  pids(): Promise<number[]>;
  read(pid: number): Promise<ProcessIdentity | null>;
  current(pid: number): string | null;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export function inspectServiceCgroup(
  inspection: ServiceCgroupInspection,
  excludedPids: readonly number[],
  now = Date.now,
): ServiceCgroup {
  const excluded = new Set(excludedPids);
  return {
    async members(deadline = now() + 10_000) {
      while (now() <= deadline) {
        const identities = await Promise.all(
          (await inspection.pids())
            .filter((pid) => !excluded.has(pid))
            .map((pid) => inspection.read(pid)),
        );
        const current = (await inspection.pids()).filter((pid) => !excluded.has(pid));
        // Identity inspection can race a fork plus parent exit. Only a fresh raw
        // inventory can certify emptiness; otherwise inspect newly discovered tasks.
        if (!current.length) return [];
        const live = identities.filter(
          (identity): identity is ProcessIdentity =>
            identity !== null && !identity.stopped && current.includes(identity.pid),
        );
        if (current.every((pid) => live.some((identity) => identity.pid === pid))) return live;
      }
      throw new Error("Service membership inspection exceeded its deadline");
    },
    async signal(identity, signal, deadline = now() + 10_000, guard) {
      if (excluded.has(identity.pid)) return;
      const current = await inspection.read(identity.pid);
      // withTimeout cannot cancel the read. Never signal after its caller's budget.
      if (!current || current.stopped || current.created !== identity.created || now() >= deadline)
        return;
      await guard?.();
      // No await between the final target scope/creation check and dispatch.
      if (inspection.current(identity.pid) === identity.created && now() < deadline)
        inspection.signal(identity.pid, signal);
    },
  };
}

/** Call only after a successful checkpoint guard and daemon stop. */
export async function cleanupServiceCgroup(
  group: ServiceCgroup,
  timeoutMs = 10_000,
  now = Date.now,
): Promise<void> {
  const cleanPhase = async (signal: NodeJS.Signals, deadline: number) => {
    const budget = () => Math.max(1, deadline - now());
    const sent = new Set<string>();
    do {
      const members = await withTimeout(
        group.members(deadline),
        budget(),
        "Inspect service cgroup",
      );
      if (!members.length) return true;
      for (const identity of members) {
        if (timeoutMs > 0 && now() >= deadline) break;
        const key = `${identity.pid}:${identity.created}`;
        if (sent.has(key)) continue;
        await withTimeout(
          group.signal(identity, signal, deadline),
          budget(),
          "Signal service member",
        );
        sent.add(key);
      }
      if (now() >= deadline) break;
      await delay(Math.min(50, deadline - now()));
    } while (now() < deadline);
    return false;
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const deadline = now() + timeoutMs;
    try {
      if (await cleanPhase(signal, deadline)) return;
    } catch (error) {
      // An expired phase can escalate. Proof/ownership errors still refuse cleanup.
      if (
        now() < deadline ||
        !(error instanceof Error) ||
        ![
          "Inspect service cgroup",
          "Signal service member",
          "Service membership inspection exceeded its deadline",
        ].includes(error.message)
      )
        throw error;
    }
  }
  const finalDeadline = now() + Math.max(1, timeoutMs);
  if (
    (
      await withTimeout(
        group.members(finalDeadline),
        Math.max(1, timeoutMs),
        "Inspect service cgroup",
      )
    ).length
  )
    throw new Error("Service cgroup cleanup remains unconfirmed");
}

/** A dedicated systemd service cgroup contains detached children too. Never scan a shared slice. */
export async function openServiceCgroup(
  cgroupPath: string,
  excludedPids: readonly number[],
  requireOutside = false,
): Promise<ServiceCgroup> {
  if (
    !cgroupPath.startsWith("/") ||
    path.posix.normalize(cgroupPath) !== cgroupPath ||
    !cgroupPath.endsWith(".service")
  )
    throw new Error("Cleanup requires an exact systemd service cgroup");
  const directory = path.join("/sys/fs/cgroup", cgroupPath);
  const original = await stat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const excluded = new Set([process.pid, ...excludedPids]);
  const belongs = (pid: number) => {
    try {
      const membership = readFileSync(`/proc/${pid}/cgroup`, "utf8");
      return membership
        .split("\n")
        .some((line) => line === `0::${cgroupPath}` || line.startsWith(`0::${cgroupPath}/`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (requireOutside && belongs(process.pid))
    throw new Error("Deployment cleanup executor must be outside the service cgroup");
  const assertGroup = async () => {
    const current = await stat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!current) return false;
    if (!original || current.ino !== original.ino || current.dev !== original.dev)
      throw new Error("Service cgroup changed during cleanup");
    return true;
  };
  const pids = async (dir: string): Promise<number[]> => {
    const [text, entries] = await Promise.all([
      readFile(path.join(dir, "cgroup.procs"), "utf8"),
      readdir(dir, { withFileTypes: true }),
    ]);
    return [
      ...text.trim().split(/\s+/).filter(Boolean).map(Number),
      ...(
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => pids(path.join(dir, entry.name))),
        )
      ).flat(),
    ];
  };
  return inspectServiceCgroup(
    {
      async pids() {
        if (!(await assertGroup())) return [];
        let members: number[];
        try {
          members = await pids(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await assertGroup()))
            return [];
          throw error;
        }
        return members;
      },
      async read(pid) {
        if (!(await assertGroup()) || !belongs(pid)) return null;
        return systemProcessTreeInspection.read(pid, 10_000);
      },
      current(pid) {
        try {
          const current = statSync(directory);
          if (!original || current.ino !== original.ino || current.dev !== original.dev)
            throw new Error("Service cgroup changed during cleanup");
          if (!belongs(pid)) return null;
          const text = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = text
            .slice(text.lastIndexOf(") ") + 2)
            .trim()
            .split(/\s+/);
          if (/^[ZX]$/.test(fields[0]!)) return null;
          if (!fields[19] || !/^\d+$/.test(fields[19]))
            throw new Error("Process creation identity is unavailable");
          return fields[19];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      signal(pid, signal) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
    },
    [...excluded],
  );
}
