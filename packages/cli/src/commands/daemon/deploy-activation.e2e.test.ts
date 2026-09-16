import { fork, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, onTestFinished, test } from "vitest";
import { runDeployCommand, type DeployCommandDependencies } from "./deploy.js";
import { tryConnectToDaemon } from "../../utils/client.js";
import type { LocalDaemonState } from "./local-daemon.js";

/**
 * Exercises `paseo daemon deploy` end to end against real checkpoint daemon
 * processes and a real activation subprocess (test-utils/fake-activation-process.ts),
 * not a mocked activation callback. Only `resolveState` and `acquireLock` are
 * supplied locally, because production `resolveState` reads the real installed
 * daemon's pid/config files, which this isolated fixture never writes; every
 * other dependency (connectPrepare/connectReadiness/spawnActivation/sleep/now)
 * is the same real implementation `runDeployCommand` uses in production.
 */

const DAEMON_PROCESS_SCRIPT = fileURLToPath(
  new URL("../../../../server/src/server/test-utils/checkpoint-daemon-process.ts", import.meta.url),
);
const ACTIVATION_SCRIPT = fileURLToPath(
  new URL("./test-utils/fake-activation-process.ts", import.meta.url),
);

async function spawnDaemon(
  home: string,
  port: number,
): Promise<{ child: ChildProcess; port: number }> {
  const child = fork(DAEMON_PROCESS_SCRIPT, [home, String(port)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PASEO_SUPERVISED: "0" },
  });
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += String(data);
  });
  child.stdout?.resume();
  onTestFinished(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const ready = await new Promise<{ port: number }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as { port: number }));
    child.once("exit", (code) => reject(new Error(`Daemon exited ${code}: ${errors}`)));
    child.once("error", reject);
  });
  return { child, port: ready.port };
}

function baseState(home: string, port: number): LocalDaemonState {
  return {
    home,
    listen: `127.0.0.1:${port}`,
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    relayUseTls: false,
    relayPublicUseTls: false,
    logPath: join(home, "daemon.log"),
    pidPath: join(home, "paseo.pid"),
    pidInfo: null,
    running: true,
    stalePidFile: false,
  };
}

/** Real fs lock, matching deploy.ts's own (unexported) default. */
async function acquireLock(home: string): Promise<{ release(): Promise<void> }> {
  await fs.mkdir(home, { recursive: true });
  const lockPath = join(home, "deploy.lock");
  const handle = await fs.open(lockPath, "wx");
  await handle.close();
  return { release: () => fs.rm(lockPath, { force: true }) };
}

function spawnActivation(
  argv: readonly string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error("empty activation argv"));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        console.error(`[activation output]\n${output}`);
      }
      resolve({ code, signal });
    });
  });
}

function makeDeps(home: string, port: number): DeployCommandDependencies {
  return {
    resolveState: () => baseState(home, port),
    acquireLock,
    connectPrepare: (target, timeoutMs) => tryConnectToDaemon({ host: target, timeout: timeoutMs }),
    connectReadiness: (target, timeoutMs) =>
      tryConnectToDaemon({ host: target, timeout: timeoutMs }),
    spawnActivation,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

async function readReplacementPid(home: string): Promise<number> {
  return Number(await readFile(join(home, "activation-replacement.pid"), "utf8"));
}

test("deploy activation observes the ready generation before stopping, and the replacement reports the same generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-deploy-activation-"));
  const originalPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  onTestFinished(() => {
    if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalPaseoHome;
  });

  const first = await spawnDaemon(home, 0);
  const deps = makeDeps(home, first.port);

  const result = await runDeployCommand(
    [
      process.execPath,
      "--import",
      "tsx",
      ACTIVATION_SCRIPT,
      DAEMON_PROCESS_SCRIPT,
      home,
      String(first.port),
      String(first.child.pid),
      // The real generation is only known once prepareGeneration() returns, which
      // happens inside runDeployCommand itself — resolved via a placeholder swapped
      // in through spawnActivation below.
      "__GENERATION__",
    ],
    { home },
    {} as never,
    {
      ...deps,
      spawnActivation: async (argv) => {
        // Substitute the real prepared generation id, captured from the daemon
        // this same test already prepared against, for the placeholder above.
        const ready = JSON.parse(
          await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8"),
        ) as { generationId: string };
        const resolvedArgv = argv.map((arg) =>
          arg === "__GENERATION__" ? ready.generationId : arg,
        );
        return spawnActivation(resolvedArgv);
      },
    },
  );

  expect(result.data.action).toBe("deployed");
  expect(result.data.generationId).not.toBe("");

  const replacementPid = await readReplacementPid(home);
  onTestFinished(async () => {
    try {
      process.kill(replacementPid, "SIGKILL");
    } catch {
      // already gone
    }
  });

  // The old real process was actually replaced, not merely reconnected to. It
  // was SIGKILLed, so it exits via signal — exitCode stays null forever in that
  // case; signalCode is what actually reports termination.
  if (first.child.exitCode === null && first.child.signalCode === null) {
    await once(first.child, "exit");
  }
  expect(first.child.signalCode).toBe("SIGKILL");
  expect(replacementPid).not.toBe(first.child.pid);

  // The replacement daemon reports running the exact generation deploy prepared.
  const verify = await tryConnectToDaemon({ host: `127.0.0.1:${first.port}`, timeout: 5000 });
  expect(verify).not.toBeNull();
  try {
    const info = verify!.getLastServerInfoMessage();
    expect(info?.restartRecoveryState).toBe("running");
    expect(info?.restartRecoveryGeneration).toBe(result.data.generationId);
  } finally {
    await verify!.close();
  }
});

test("a checkpoint generation mismatch aborts activation before the old process is touched", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-deploy-activation-mismatch-"));
  const originalPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  onTestFinished(() => {
    if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalPaseoHome;
  });

  const daemon = await spawnDaemon(home, 0);
  const deps = makeDeps(home, daemon.port);

  await expect(
    runDeployCommand(
      [
        process.execPath,
        "--import",
        "tsx",
        ACTIVATION_SCRIPT,
        DAEMON_PROCESS_SCRIPT,
        home,
        String(daemon.port),
        String(daemon.child.pid),
        "generation-that-was-never-prepared",
      ],
      { home },
      {} as never,
      deps,
    ),
  ).rejects.toMatchObject({ code: "DEPLOY_ACTIVATION_FAILED" });

  // Activation refused before stopping anything: the real old process is still alive
  // and never replaced.
  expect(daemon.child.exitCode).toBeNull();
  await expect(fs.access(join(home, "activation-replacement.pid"))).rejects.toThrow();

  const verify = await tryConnectToDaemon({ host: `127.0.0.1:${daemon.port}`, timeout: 5000 });
  expect(verify).not.toBeNull();
  try {
    expect(verify!.getLastServerInfoMessage()?.restartRecoveryState).toBe("paused");
  } finally {
    await verify!.close();
  }
});

test("a failed checkpoint never runs activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-deploy-activation-prepare-failure-"));
  const originalPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  onTestFinished(() => {
    if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalPaseoHome;
  });

  const daemon = await spawnDaemon(home, 0);
  // Block the real ready-pointer write so checkpoint preparation itself fails,
  // the same technique controlled-restart.e2e.test.ts uses.
  await fs.mkdir(join(home, "restart-checkpoints", "ready.json"), { recursive: true });

  let activationCalls = 0;
  const deps: DeployCommandDependencies = {
    ...makeDeps(home, daemon.port),
    spawnActivation: async (argv) => {
      activationCalls += 1;
      return spawnActivation(argv);
    },
  };

  // The RPC surfaces its own error code (e.g. a checkpoint commit failure),
  // which toCommandError passes through unchanged rather than relabeling as a
  // generic DEPLOY_FAILED. The meaningful assertion is what happens *around*
  // it: prepareGeneration() throwing means spawnActivation() is never reached.
  await expect(
    runDeployCommand(
      [
        process.execPath,
        "--import",
        "tsx",
        ACTIVATION_SCRIPT,
        DAEMON_PROCESS_SCRIPT,
        home,
        String(daemon.port),
        String(daemon.child.pid),
        "n/a",
      ],
      { home },
      {} as never,
      deps,
    ),
  ).rejects.toMatchObject({ code: expect.any(String) });

  expect(activationCalls).toBe(0);
  expect(daemon.child.exitCode).toBeNull();

  const verify = await tryConnectToDaemon({ host: `127.0.0.1:${daemon.port}`, timeout: 5000 });
  expect(verify).not.toBeNull();
  try {
    expect(verify!.getLastServerInfoMessage()?.restartRecoveryState).toBe("paused");
  } finally {
    await verify!.close();
  }
});
