// Real activation argv for controlled-restart deploy E2E tests: a short-lived
// subprocess (standing in for `switch-to-configuration switch` + systemd unit
// restart) that must observe the daemon's committed ready generation BEFORE
// touching anything, then hand off from the old real process to a new one on
// the same port. Never used outside packages/cli/src/commands/daemon/*.e2e.test.ts.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fork } from "node:child_process";

interface ReadyFile {
  generationId: string;
}

async function main(): Promise<void> {
  const [daemonProcessScript, home, port, oldPidRaw, expectedGenerationId] = process.argv.slice(2);
  if (!daemonProcessScript || !home || !port || !oldPidRaw || !expectedGenerationId) {
    console.error(
      "usage: fake-activation-process <daemonProcessScript> <home> <port> <oldPid> <expectedGenerationId>",
    );
    process.exit(2);
  }

  const ready = JSON.parse(
    await readFile(join(home, "restart-checkpoints", "ready.json"), "utf8"),
  ) as ReadyFile;

  // Activation observes the ready generation BEFORE stopping anything. A mismatch
  // (or a missing/corrupt ready.json) aborts here: the previous process is never
  // touched and no replacement is spawned.
  if (ready.generationId !== expectedGenerationId) {
    console.error(
      `ready generation '${ready.generationId}' does not match expected '${expectedGenerationId}'; refusing to activate`,
    );
    process.exit(1);
  }

  // Only now is it safe to remove the previous process: its state is durably
  // checkpointed. This mirrors the real entrypoint, where the checkpoint is
  // secure before Nix/systemd stop timers run.
  process.kill(Number(oldPidRaw), "SIGKILL");

  const child = fork(daemonProcessScript, [home, port], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
    env: { ...process.env, PASEO_SUPERVISED: "0" },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("exit", (code) => reject(new Error(`replacement daemon exited ${code}`)));
    child.once("error", reject);
  });
  await writeFile(join(home, "activation-replacement.pid"), String(child.pid), "utf8");
  child.unref();
  process.exit(0);
}

void main();
