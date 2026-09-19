// POSIX-only: real node-pty spawns, no daemon, no host memory pressure.
import { afterEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isPlatform } from "../test-utils/platform.js";
import { createTerminal, type TerminalSession } from "./terminal.js";
import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";

const linuxOnly = isPlatform("linux") ? it : it.skip;
const cwd = realpathSync(tmpdir());

const sessions: TerminalSession[] = [];
let manager: TerminalManager | null = null;

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.killAndWait();
  if (manager) {
    manager.killAll();
    manager = null;
  }
});

function trackSession(session: TerminalSession): TerminalSession {
  sessions.push(session);
  return session;
}

function rowText(row: ReturnType<TerminalSession["getState"]>["grid"][number]): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

async function waitForOutput(
  session: TerminalSession,
  predicate: (lines: string[]) => boolean,
  timeoutMs = 5000,
): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lines = session.getState().grid.map(rowText);
    if (predicate(lines)) return lines;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for terminal output. Last seen:\n${session
      .getState()
      .grid.map(rowText)
      .join("\n")}`,
  );
}

function includesRaisedScore(lines: string[]): boolean {
  return lines.some((line) => line.includes("1000"));
}

function hasOrdinaryScoreLine(line: string): boolean {
  const trimmed = line.trim();
  return /-?\d+/.test(trimmed) && trimmed.length > 0;
}

function includesOrdinaryScore(lines: string[]): boolean {
  return lines.some(hasOrdinaryScoreLine);
}

function includesArgvEcho(lines: string[]): boolean {
  return lines.some((line) => line.includes("a b"));
}

function readOwnScoreCommand() {
  return {
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(require('fs').readFileSync('/proc/self/oom_score_adj','utf8').trim())",
    ],
  };
}

describe("Linux service-process OOM score propagation through real spawns", () => {
  linuxOnly(
    "createTerminal wraps a serviceProcess: true command so the actual spawned process is raised, and an ordinary terminal is not",
    async () => {
      const service = trackSession(
        await createTerminal({
          workspaceId: "ws-oom",
          cwd,
          serviceProcess: true,
          ...readOwnScoreCommand(),
        }),
      );
      const serviceLines = await waitForOutput(service, includesRaisedScore);
      expect(serviceLines.join("\n")).toContain("1000");

      const ordinary = trackSession(
        await createTerminal({ workspaceId: "ws-oom", cwd, ...readOwnScoreCommand() }),
      );
      const ordinaryLines = await waitForOutput(ordinary, includesOrdinaryScore);
      expect(ordinaryLines.join("\n")).not.toContain("1000");
    },
  );

  linuxOnly(
    "the raised score is inherited by a real grandchild the wrapped shell forks, not just the direct exec target",
    async () => {
      const session = trackSession(
        await createTerminal({
          workspaceId: "ws-oom-grandchild",
          cwd,
          serviceProcess: true,
          // The wrapper execs this as the direct pty child; this shell then
          // *forks* `cat` as a genuine grandchild, which never self-adjusts.
          command: "/bin/sh",
          args: ["-c", "cat /proc/self/oom_score_adj"],
        }),
      );
      const lines = await waitForOutput(session, includesRaisedScore);
      expect(lines.join("\n")).toContain("1000");
    },
  );

  linuxOnly(
    "literal args with shell-significant characters survive the /bin/sh -c wrapping unaltered",
    async () => {
      const session = trackSession(
        await createTerminal({
          workspaceId: "ws-oom-args",
          cwd,
          serviceProcess: true,
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
            "a b",
            "$HOME",
            "'q'",
          ],
        }),
      );
      const lines = await waitForOutput(session, includesArgvEcho);
      const argv = JSON.parse(lines.find((line) => line.includes("a b"))!) as string[];
      expect(argv).toEqual(["a b", "$HOME", "'q'"]);
    },
  );

  linuxOnly(
    "propagates serviceProcess through the real TerminalManager, not only the low-level helper",
    async () => {
      manager = createTerminalManager();
      const service = trackSession(
        await manager.createTerminal({
          cwd,
          workspaceId: "ws-manager-oom",
          serviceProcess: true,
          ...readOwnScoreCommand(),
        }),
      );
      const lines = await waitForOutput(service, includesRaisedScore);
      expect(lines.join("\n")).toContain("1000");

      const ordinary = trackSession(
        await manager.createTerminal({
          cwd,
          workspaceId: "ws-manager-oom",
          ...readOwnScoreCommand(),
        }),
      );
      const ordinaryLines = await waitForOutput(ordinary, includesOrdinaryScore);
      expect(ordinaryLines.join("\n")).not.toContain("1000");
    },
  );
});
