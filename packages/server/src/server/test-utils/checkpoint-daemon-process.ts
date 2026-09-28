import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { resolveSkillTargets } from "../orchestration-skills/internal/paths.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { stopWithShutdownCheckpoint } from "../shutdown-checkpoint.js";
import { createCheckpointAgentClient } from "./checkpoint-agent-client.js";

const [home, port = "0", behavior] = process.argv.slice(2);
if (!home) throw new Error("An isolated test home is required");
await mkdir(join(home, "static"), { recursive: true });
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
      codex: createCheckpointAgentClient(join(home, "provider-dispatches.jsonl"), {
        keepResumedActive: behavior === "keep-resumed-active",
      }),
    },
    onLifecycleIntent: () => {
      void daemon.stop().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    },
  },
  pino({ level: "silent" }),
  { resolveSkillTargets: () => resolveSkillTargets(home) },
);
await daemon.start();
const target = daemon.getListenTarget();
if (target?.type !== "tcp") throw new Error("Test daemon did not listen on TCP");
process.send?.({ port: target.port });
process.on("message", (message) => {
  if (message === "stop") void daemon.stop().then(() => process.exit(0));
});
// Mirror the production worker: a SIGTERM stop checkpoints a running daemon first.
process.on("SIGTERM", () => {
  void stopWithShutdownCheckpoint(daemon, {
    logger: pino({ level: "silent" }),
    reason: "test_sigterm",
  }).then(
    (outcome) => {
      if (outcome.checkpoint !== "failed") process.exit(0);
      return undefined;
    },
    (error) => console.error(error),
  );
});
