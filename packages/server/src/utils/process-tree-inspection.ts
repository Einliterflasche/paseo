import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  created: string;
  stopped: boolean;
}

export interface ProcessTreeSeed {
  pid: number;
  created?: string;
}

export interface ProcessTreeInspection {
  snapshot(roots: readonly ProcessTreeSeed[], timeoutMs: number): Promise<ProcessIdentity[]>;
  read(pid: number, timeoutMs: number): Promise<ProcessIdentity | null>;
  signal(pid: number, signal: NodeJS.Signals): Promise<void>;
}

function isMissingProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

async function readLinuxProcess(pid: number): Promise<ProcessIdentity | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isMissingProcess(error)) return null;
    throw error;
  }
  // comm may contain spaces and ')'; all remaining fields are scalar tokens.
  const fields = stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const created = fields[19];
  if (!Number.isInteger(parentPid) || !created || !/^\d+$/.test(created)) {
    throw new Error(`Cannot inspect creation identity for process ${pid}`);
  }
  return { pid, parentPid, created, stopped: fields[0] === "Z" || fields[0] === "X" };
}

async function readLinuxChildren(pid: number): Promise<number[]> {
  try {
    const tasks = await readdir(`/proc/${pid}/task`);
    const children = await Promise.all(
      tasks.map(async (tid) => {
        try {
          return (await readFile(`/proc/${pid}/task/${tid}/children`, "utf8"))
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
        } catch (error) {
          if (isMissingProcess(error)) return [];
          throw error;
        }
      }),
    );
    return children.flat();
  } catch (error) {
    if (isMissingProcess(error)) return [];
    throw error;
  }
}

async function readLinuxSnapshot(roots: readonly ProcessTreeSeed[]): Promise<ProcessIdentity[]> {
  // Traverse only owned families. An unrelated process hidden by procfs must not
  // block cleanup; inability to inspect an owned descendant remains an error.
  const seen = new Set<string>();
  const processes: ProcessIdentity[] = [];
  let pending = [...roots];
  while (pending.length) {
    const current = pending.filter((seed) => {
      const key = `${seed.pid}:${seed.created ?? "new"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const children = await Promise.all(
      current.map(async (seed) => {
        const identity = await readLinuxProcess(seed.pid);
        if (!identity) return [];
        processes.push(identity);
        return identity.stopped || (seed.created !== undefined && seed.created !== identity.created)
          ? []
          : (await readLinuxChildren(seed.pid)).map((pid) => ({ pid }));
      }),
    );
    pending = children.flat();
  }
  return processes;
}

function parsePosixProcesses(stdout: string): ProcessIdentity[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error("Cannot parse process creation identity from ps");
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        stopped: /^[ZX]/.test(match[3]!),
        created: match[4]!,
      };
    });
}

async function readPosixSnapshot(timeoutMs: number): Promise<ProcessIdentity[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,stat=,lstart="], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...process.env, LC_ALL: "C" },
  });
  return parsePosixProcesses(stdout);
}

async function readWindowsSnapshot(timeoutMs: number): Promise<ProcessIdentity[]> {
  const script =
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;created=$(if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()} else {$null})} }) | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true },
  );
  const parsed: unknown = JSON.parse(stdout);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Error("Cannot inspect Windows process identity");
    const row = value as Record<string, unknown>;
    if (
      !Number.isInteger(row.pid) ||
      !Number.isInteger(row.parentPid) ||
      (row.created !== null && (typeof row.created !== "string" || !/^\d+$/.test(row.created)))
    ) {
      throw new Error("Cannot inspect Windows process creation identity");
    }
    return {
      pid: row.pid as number,
      parentPid: row.parentPid as number,
      created: typeof row.created === "string" ? row.created : "",
      stopped: false,
    };
  });
}

async function snapshot(
  roots: readonly ProcessTreeSeed[],
  timeoutMs: number,
): Promise<ProcessIdentity[]> {
  if (process.platform === "linux") return readLinuxSnapshot(roots);
  if (process.platform === "win32") return readWindowsSnapshot(timeoutMs);
  return readPosixSnapshot(timeoutMs);
}

export const systemProcessTreeInspection: ProcessTreeInspection = {
  snapshot,
  async read(pid, timeoutMs) {
    if (process.platform === "linux") return readLinuxProcess(pid);
    return (await snapshot([{ pid }], timeoutMs)).find((entry) => entry.pid === pid) ?? null;
  },
  async signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  },
};
