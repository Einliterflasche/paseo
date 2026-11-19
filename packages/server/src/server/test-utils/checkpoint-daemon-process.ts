import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { AgentClient, AgentSession } from "../agent/agent-sdk-types.js";
import { resolveSkillTargets } from "../orchestration-skills/internal/paths.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { stopWithShutdownCheckpoint } from "../shutdown-checkpoint.js";
import { createCheckpointAgentClient } from "./checkpoint-agent-client.js";

/**
 * Child-process daemon for restart end-to-end tests. Arguments: `<home> [port] [behavior]`.
 *
 * Behaviors: `keep-resumed-active`, `fail-resume`, `without-session-handle`, and `hang-close`
 * (provider sessions never finish closing or interrupting).
 *
 * Environment:
 * - `PASEO_TEST_HOLD_EXIT=1` keeps the process frozen with its saved checkpoint after a restart,
 *   shutdown, or SIGTERM until the parent sends the IPC message `release`.
 * - `PASEO_TEST_FAIL_RESUME_SESSIONS` lists native session IDs (comma-separated) whose resume fails.
 * - `PASEO_TEST_RESTART_PREPARE_TIMEOUT_MS` sets the daemon's restart checkpoint limit.
 * - `PASEO_TEST_SHUTDOWN_STOP_TIMEOUT_MS` bounds `daemon.stop()` after the checkpoint.
 *
 * The daemon logs at info level to `<home>/harness-daemon.log`.
 */
const [home, port = "0", behavior] = process.argv.slice(2);
if (!home) throw new Error("An isolated test home is required");
const holdExit = process.env.PASEO_TEST_HOLD_EXIT === "1";
const failResumeSessions = new Set(
  (process.env.PASEO_TEST_FAIL_RESUME_SESSIONS ?? "").split(",").filter(Boolean),
);
const restartPrepareTimeoutMs = optionalNumber(process.env.PASEO_TEST_RESTART_PREPARE_TIMEOUT_MS);
const shutdownStopTimeoutMs = optionalNumber(process.env.PASEO_TEST_SHUTDOWN_STOP_TIMEOUT_MS);

function optionalNumber(value: string | undefined): number | undefined {
  return value ? Number(value) : undefined;
}

function withHarnessFaults(client: AgentClient): AgentClient {
  const attach = (session: AgentSession): AgentSession => {
    if (behavior === "hang-close") {
      session.close = () => new Promise<void>(() => undefined);
      session.interrupt = () => new Promise<void>(() => undefined);
    }
    return session;
  };
  return {
    ...client,
    createSession: async (...args) => attach(await client.createSession(...args)),
    resumeSession: async (handle, ...rest) => {
      if (failResumeSessions.has(handle.sessionId)) {
        throw new Error(`Native session ${handle.sessionId} cannot be resumed`);
      }
      return attach(await client.resumeSession(handle, ...rest));
    },
  };
}

await mkdir(join(home, "static"), { recursive: true });
const logger = pino(
  { level: "info" },
  pino.destination({ dest: join(home, "harness-daemon.log"), sync: true }),
);
let released: () => void = () => undefined;
const release = new Promise<void>((resolve) => {
  released = resolve;
});
let exiting = false;

function exitWithCheckpoint(reason: string): void {
  if (exiting) return;
  exiting = true;
  void (async () => {
    if (holdExit) {
      await daemon.prepareRestart();
      await release;
    }
    await stopWithShutdownCheckpoint(daemon, {
      logger,
      reason,
      ...(shutdownStopTimeoutMs === undefined ? {} : { stopTimeoutMs: shutdownStopTimeoutMs }),
    });
    process.exit(0);
  })();
}

const daemon = await createPaseoDaemon(
  {
    paseoHome: home,
    listen: `127.0.0.1:${port}`,
    corsAllowedOrigins: [],
    hostnames: true,
    staticDir: join(home, "static"),
    mcpDebug: false,
    mcpEnabled: false,
    pluginsEnabled: false,
    relayEnabled: false,
    agentStoragePath: join(home, "agents"),
    agentClients: {
      codex: withHarnessFaults(
        createCheckpointAgentClient(join(home, "provider-dispatches.jsonl"), {
          keepResumedActive: behavior === "keep-resumed-active",
          failResume: behavior === "fail-resume",
          withoutSessionHandle: behavior === "without-session-handle",
        }),
      ),
    },
    ...(restartPrepareTimeoutMs === undefined ? {} : { restartPrepareTimeoutMs }),
    onLifecycleIntent: (intent) => exitWithCheckpoint(`test_${intent.type}`),
  },
  logger,
  { resolveSkillTargets: () => resolveSkillTargets(home) },
);
await daemon.start();
const target = daemon.getListenTarget();
if (target?.type !== "tcp") throw new Error("Test daemon did not listen on TCP");
process.send?.({ port: target.port });
process.on("message", (message) => {
  if (message === "release") released();
  if (message === "stop") void daemon.stop().then(() => process.exit(0));
});
// Mirror the production worker: a SIGTERM stop saves a best-effort checkpoint, then exits.
process.on("SIGTERM", () => exitWithCheckpoint("test_sigterm"));
