import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentProbe } from "../server/agent/agent-probe.js";
import { execCommand } from "./spawn.js";

test.skipIf(process.platform === "win32")(
  "an aborted diagnostic command cannot outlive its owner even when SIGTERM is ignored",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-owned-command-"));
    const marker = join(directory, "ready");
    const probe = new AgentProbe();
    const result = probe
      .run((context) =>
        execCommand(
          process.execPath,
          [
            "-e",
            `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `,
            marker,
          ],
          { probe: context },
        ),
      )
      .catch((error: unknown) => error);
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("");
      const pid = Number(await readFile(marker, "utf8"));
      await probe.close();
      expect(await result).toBeInstanceOf(Error);
      expect(() => process.kill(pid, 0)).toThrow();
      await probe.close();
    } finally {
      await probe.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a completed owned diagnostic preserves both output streams", async () => {
  const probe = new AgentProbe();
  await expect(
    probe.run((context) =>
      execCommand(
        process.execPath,
        ["-e", 'process.stdout.write("version ✓"); process.stderr.write("diagnostic ✓");'],
        { probe: context },
      ),
    ),
  ).resolves.toEqual({ stdout: "version ✓", stderr: "diagnostic ✓" });
});

test("an already-aborted diagnostic never acquires a native process", async () => {
  const abort = new AbortController();
  const reason = new Error("query stopped");
  abort.abort(reason);
  await expect(
    execCommand(process.execPath, ["-e", "process.exit(0)"], {
      probe: {
        signal: abort.signal,
        own: () => {
          throw new Error("unexpected acquisition");
        },
      },
    }),
  ).rejects.toBe(reason);
});

test.skipIf(process.platform !== "linux")(
  "aborting a native query stops its wrapper and descendants together",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-owned-query-tree-"));
    const marker = join(directory, "ready");
    const probe = new AgentProbe();
    const childSource =
      'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);';
    const source = `
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], {stdio: ["ignore", process.stdout, process.stderr, "ipc"]});
    process.on("SIGTERM", () => process.exit(0));
    child.once("message", () => require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid])));
    setInterval(() => {}, 1000);
  `;
    const result = probe
      .run((context) => execCommand(process.execPath, ["-e", source, marker], { probe: context }))
      .catch((error: unknown) => error);
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("");
      const pids = JSON.parse(await readFile(marker, "utf8")) as number[];
      await probe.close();
      expect(await result).toBeInstanceOf(Error);
      for (const pid of pids) {
        // A reparented zombie is already stopped; init owns its final reap.
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
        expect(stat === undefined || stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ")).toBe(
          true,
        );
      }
    } finally {
      await probe.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
