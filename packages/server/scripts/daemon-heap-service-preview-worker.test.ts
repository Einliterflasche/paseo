// The daemon-worker-only heap limit (PASEO_DAEMON_HEAP_MB) is delivered as a
// CLI flag on the daemon worker's own process, via `resolveDaemonHeapArgs`.
// Node's `child_process.fork()` defaults `execArgv` to the *calling*
// process's own `process.execArgv` when the caller doesn't override it — so
// a real gap would be: the daemon (launched with --max-old-space-size) forks
// the preview gateway or terminal worker without an explicit `execArgv`, and
// that worker silently inherits the daemon's heap ceiling. Both real
// Services fork() call sites already pass `execArgv` explicitly; this proves
// it end-to-end through a real spawn chain, not just by reading the source.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPlatform } from "../src/test-utils/platform.js";
import { resolveDaemonHeapArgs } from "./daemon-heap.js";

const linuxOnly = isPlatform("linux") ? it : it.skip;
const tsxLoader = import.meta.resolve("tsx");
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function driverScript(kind: "preview-gateway" | "worker-terminal-manager"): string {
  const previewSourcesUrl = new URL("../src/server/service-preview/sources.ts", import.meta.url)
    .href;
  const previewRoutesUrl = new URL("../src/server/service-preview/routes.ts", import.meta.url).href;
  const previewBrokerUrl = new URL("../src/server/service-preview/broker.ts", import.meta.url).href;
  const previewWorkerUrl = new URL("../src/server/service-preview/worker.ts", import.meta.url).href;
  const workerTerminalManagerUrl = new URL(
    "../src/terminal/worker-terminal-manager.ts",
    import.meta.url,
  ).href;
  if (kind === "preview-gateway") {
    return `
      import { readFileSync, mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { PreviewSources } from ${JSON.stringify(previewSourcesUrl)};
      import { PreviewRoutes } from ${JSON.stringify(previewRoutesUrl)};
      import { PreviewBroker } from ${JSON.stringify(previewBrokerUrl)};
      import { startPreviewGatewayWorker } from ${JSON.stringify(previewWorkerUrl)};
      const directory = mkdtempSync(join(tmpdir(), "paseo-heap-gw-"));
      const socketPath = join(directory, "gateway.sock");
      const sources = new PreviewSources("https://control.test");
      const routes = new PreviewRoutes({ excludedPorts: [] });
      const broker = new PreviewBroker({ sources, routes, onFailure() {} });
      const worker = startPreviewGatewayWorker({
        broker, socketPath, controlCookieNames: ["paseo-control"], onFailure() {},
      });
      await worker.ready;
      const cmdline = readFileSync(\`/proc/\${worker.pid}/cmdline\`, "utf8").split("\\0");
      process.stdout.write(JSON.stringify(cmdline));
      worker.close();
      await worker.closed;
      sources.close();
      routes.close();
      broker.close();
    `;
  }
  return `
    import { readFileSync } from "node:fs";
    import { createWorkerTerminalManager, terminateWorkerTerminalManager } from ${JSON.stringify(workerTerminalManagerUrl)};
    const manager = createWorkerTerminalManager();
    const session = await manager.createTerminal({
      cwd: "/tmp", workspaceId: "ws-heap", command: process.execPath, args: ["-e", "setTimeout(()=>{},2000)"],
    });
    // The worker host process is a direct fork of this driver: scan this
    // process's own children to find its real cmdline.
    const { execSync } = await import("node:child_process");
    const childPids = execSync(\`pgrep -P \${process.pid}\`).toString().trim().split("\\n").filter(Boolean);
    const cmdlines = childPids.map((p) => readFileSync(\`/proc/\${p}/cmdline\`, "utf8").split("\\0"));
    process.stdout.write(JSON.stringify(cmdlines));
    await session.killAndWait();
    terminateWorkerTerminalManager(manager);
  `;
}

function runDriver(kind: "preview-gateway" | "worker-terminal-manager", heapArgs: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-heap-driver-"));
  directories.push(directory);
  const scriptPath = join(directory, "driver.mts");
  writeFileSync(scriptPath, driverScript(kind));
  const result = spawnSync(process.execPath, [...heapArgs, "--import", tsxLoader, scriptPath], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return result;
}

describe("Services worker fork() never inherits the daemon-worker-only heap flag", () => {
  linuxOnly(
    "the real forked preview gateway worker's own argv carries no --max-old-space-size, even when the daemon-under-test was launched with one",
    () => {
      const heapArgs = resolveDaemonHeapArgs({ PASEO_DAEMON_HEAP_MB: "6144" }, false);
      expect(heapArgs).toEqual(["--max-old-space-size=6144"]);
      const result = runDriver("preview-gateway", heapArgs);
      expect(result.status, result.stderr).toBe(0);
      const cmdline: string[] = JSON.parse(result.stdout);
      expect(cmdline.some((part) => part.includes("--max-old-space-size"))).toBe(false);
    },
  );

  linuxOnly(
    "the real forked WorkerTerminalManager host process's own argv carries no --max-old-space-size either",
    () => {
      const heapArgs = resolveDaemonHeapArgs({ PASEO_DAEMON_HEAP_MB: "6144" }, false);
      const result = runDriver("worker-terminal-manager", heapArgs);
      expect(result.status, result.stderr).toBe(0);
      const cmdlines: string[][] = JSON.parse(result.stdout);
      expect(cmdlines.length).toBeGreaterThan(0);
      for (const cmdline of cmdlines) {
        expect(cmdline.some((part) => part.includes("--max-old-space-size"))).toBe(false);
      }
    },
  );
});
