import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

interface RunWorkerOptions {
  publicationDelayMs?: number;
  gracefulExitTimeoutMs?: number;
}

async function runWorker(worker: string, options: RunWorkerOptions = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-readiness-"));
  const workerPath = path.join(home, "worker.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const eventsPath = path.join(home, "events.jsonl");
  const supervisor = new URL("./supervisor.ts", import.meta.url).href;
  await writeFile(workerPath, worker);
  await writeFile(
    runnerPath,
    `
    import { appendFile } from "node:fs/promises";
    import { runSupervisor } from ${JSON.stringify(supervisor)};
    const record = (event) => appendFile(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    runSupervisor({
      name: "ReadinessTest", startupMessage: "starting", restartOnCrash: true,
      gracefulExitTimeoutMs: ${options.gracefulExitTimeoutMs ?? 10_000},
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)}, workerArgs: [], workerExecArgv: [],
      onWorkerReady: async ({ listen }) => {
        await new Promise(resolve => setTimeout(resolve, ${options.publicationDelayMs ?? 0}));
        await record(listen);
      },
      onWorkerExit: () => record(null),
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...env, HOME: home, PASEO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(output));
      }, 15_000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const events = await readFile(eventsPath, "utf8").catch(() => "");
    return {
      code,
      output,
      events: events
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a worker that exits before ready fails the supervisor without respawning", async () => {
  const result = await runWorker(`
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    if (existsSync(marker)) process.exit(0);
    writeFileSync(marker, "started");
    process.exit(1);
  `);
  expect(result.code).toBe(1);
  expect(result.output).not.toContain("Restarting worker");
});

test("a replacement worker must independently reach ready", async () => {
  const result = await runWorker(`
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    if (existsSync(marker)) process.exit(0);
    writeFileSync(marker, "started");
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_test" });
    process.send({ type: "paseo:restart" });
  `);
  expect(result.code).toBe(1);
  expect(result.events, result.output).toEqual(["test-endpoint", null, null]);
});

test("a restart requested before first readiness replaces the worker", async () => {
  const result = await runWorker(
    `
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    const replacement = existsSync(marker);
    writeFileSync(marker, "started");
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    if (replacement) {
      process.send({ type: "paseo:ready", listen: "replacement", serverId: "srv_test" });
      process.send({ type: "paseo:shutdown" });
    } else {
      // Still restoring: the restart arrives before this worker reports ready.
      process.send({ type: "paseo:restart", reason: "restart_during_restore" });
      setInterval(() => {}, 1000);
    }
  `,
    { gracefulExitTimeoutMs: 300 },
  );
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain("before successful readiness");
  expect(result.events, result.output).toEqual([null, "replacement", null]);
});

test("exit clears publication after an in-flight ready write", async () => {
  const result = await runWorker(
    `
    process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_test" }, () => process.exit(0));
  `,
    { publicationDelayMs: 100 },
  );
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toBeNull();
});

test("requested shutdown before first readiness exits successfully", async () => {
  const result = await runWorker(`
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:shutdown", reason: "cancelled_start" });
  `);
  expect(result.code).toBe(0);
  expect(result.events).toEqual([null]);
});

test("an ordinary restart replaces an uncooperative worker after the grace period", async () => {
  const result = await runWorker(
    `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".count";
    const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
    writeFileSync(marker, String(count + 1));
    if (count === 0) {
      process.send({ type: "paseo:ready", listen: "uncooperative", serverId: "srv_test" });
      process.send({ type: "paseo:restart" });
      process.send({ type: "paseo:restart" });
      // Deliberately ignore graceful shutdown and keep the worker alive.
      setInterval(() => {}, 1000);
    } else {
      process.on("message", message => {
        if (message.type === "paseo:graceful-shutdown") process.exit(0);
      });
      const bypass = process.env.PASEO_RESTART_ANYWAY_ID ?? process.env.PASEO_SUPERVISOR_RESTART_ANYWAY;
      process.send({ type: "paseo:ready", listen: bypass ?? "replacement", serverId: "srv_test" });
      process.send({ type: "paseo:shutdown" });
    }
  `,
    { gracefulExitTimeoutMs: 300 },
  );
  expect(result.code, result.output).toBe(0);
  expect(result.events, result.output).toEqual(["uncooperative", null, "replacement", null]);
});
