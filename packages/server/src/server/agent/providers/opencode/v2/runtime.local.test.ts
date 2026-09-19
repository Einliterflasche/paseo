import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import * as treeKill from "../../../../../utils/tree-kill.js";
import { V2Runtime } from "./runtime.js";

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^[ZX] /.test(stat.slice(stat.lastIndexOf(") ") + 2))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-v2-helper-"));
  vi.stubEnv("PASEO_HOME", directory);
  const script = join(directory, "helper.cjs");
  const pids = join(directory, "pids");
  const ready = join(directory, "ready");
  await writeFile(
    script,
    `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
const server = http.createServer(async (_request, response) => {
  while (!fs.existsSync(${JSON.stringify(ready)})) await new Promise((resolve) => setTimeout(resolve, 10));
  response.setHeader("content-type", "application/json"); response.end("{}");
});
server.listen(0, "127.0.0.1", () => console.log("server listening on http://127.0.0.1:" + server.address().port));
process.on("SIGTERM", () => process.exit(0));
`,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
    decorateEnv: async (env) => env,
  });
  const identities = async (): Promise<number[]> => JSON.parse(await readFile(pids, "utf8"));
  return {
    runtime,
    ready: () => writeFile(ready, "ready"),
    identities,
    cleanup: async () => {
      await writeFile(ready, "ready");
      await runtime.shutdown();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("OpenCode v2 owned helper leases", () => {
  test("keeps a shared helper alive until its final lease certifies the root and detached descendant", async () => {
    const f = await fixture();
    try {
      await f.ready();
      const first = await f.runtime.acquire();
      const second = await f.runtime.acquire();
      const pids = await f.identities();
      await first.release();
      expect(pids.every(running)).toBe(true);
      await second.client.server.info();
      await second.release();
      expect(pids.some(running)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("retains a failed final release for a successful tree-certification retry", async () => {
    const f = await fixture();
    try {
      await f.ready();
      const lease = await f.runtime.acquire();
      const pids = await f.identities();
      vi.spyOn(treeKill, "terminateWithTreeKill").mockResolvedValueOnce("kill-timeout");
      await expect(lease.release()).rejects.toThrow("did not stop");
      expect(pids.every(running)).toBe(true);
      await lease.release();
      expect(pids.some(running)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("does not stop a helper still being acquired by another caller after one startup is canceled", async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      const canceled = f.runtime.acquire({ signal: abort.signal });
      const canceledResult = expect(canceled).rejects.toThrow("canceled caller");
      const acquired = f.runtime.acquire();
      abort.abort(new Error("canceled caller"));
      await f.ready();
      const lease = await acquired;
      await canceledResult;
      expect((await f.identities()).every(running)).toBe(true);
      await lease.client.server.info();
      await lease.release();
      expect((await f.identities()).some(running)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
