import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { AgentProbe } from "../agent-probe.js";
import type { AgentClient, AgentCreateSessionOptions } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { PiRpcAgentClient } from "./pi/agent.js";
import { OmpAgentClient } from "./omp/agent.js";

const fixture = fileURLToPath(new URL("./test-utils/pending-probe-runtime.cjs", import.meta.url));
const phases = { claude: "control_initialize", codex: "initialize", pi: "get_state", omp: "ready" };

function createClient(provider: keyof typeof phases, marker?: string): AgentClient {
  const logger = createTestLogger();
  const runtimeSettings = {
    env: marker ? { PASEO_TEST_PROBE_MARKER: marker } : undefined,
    command: {
      mode: "replace" as const,
      argv: [process.execPath, fixture, provider, ...(marker ? [`--probe-marker=${marker}`] : [])],
    },
  };
  switch (provider) {
    case "claude":
      return new ClaudeAgentClient({
        logger,
        runtimeSettings,
        resolveBinary: async () => process.execPath,
      });
    case "codex":
      return new CodexAppServerAgentClient(logger, runtimeSettings);
    case "pi":
      return new PiRpcAgentClient({ logger, runtimeSettings });
    case "omp":
      return new OmpAgentClient({ logger, runtimeSettings });
  }
}

test.skipIf(process.platform === "win32").each(["claude", "codex", "pi", "omp"] as const)(
  "%s draft probe owns and retires an unanswered native initialization",
  async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-provider-probe-"));
    const marker = join(directory, "pending.json");
    const probe = new AgentProbe();
    const client = createClient(provider);
    const result = probe
      .run(async (context) => {
        const session = await client.createSession(
          { provider, cwd: directory },
          { env: { PASEO_TEST_PROBE_MARKER: marker } },
          { probe: context },
        );
        if (provider === "claude") await session.listCommands?.();
      })
      .catch((error: unknown) => error);
    try {
      await expect
        .poll(async () => JSON.parse(await readFile(marker, "utf8").catch(() => "null"))?.phase)
        .toBe(phases[provider]);
      const { pid } = JSON.parse(await readFile(marker, "utf8")) as { pid: number };
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

test.each(["claude", "codex", "pi", "omp"] as const)(
  "%s refuses an already-aborted draft before spawning",
  async (provider) => {
    const abort = new AbortController();
    const reason = new Error("probe already closed");
    abort.abort(reason);
    const options: AgentCreateSessionOptions = {
      probe: {
        signal: abort.signal,
        own: () => {
          throw new Error("unexpected native owner");
        },
      },
    };
    await expect(
      createClient(provider).createSession({ provider, cwd: process.cwd() }, undefined, options),
    ).rejects.toBe(reason);
  },
);

const queryCases = [
  { provider: "claude", operation: "catalog", phase: "version" },
  { provider: "codex", operation: "catalog", phase: "initialize" },
  { provider: "pi", operation: "catalog", phase: "get_available_models" },
  { provider: "omp", operation: "catalog", phase: "ready" },
  { provider: "codex", operation: "imports", phase: "initialize" },
  { provider: "claude", operation: "diagnostic", phase: "auth" },
  { provider: "codex", operation: "diagnostic", phase: "version" },
  { provider: "pi", operation: "diagnostic", phase: "version" },
  { provider: "omp", operation: "diagnostic", phase: "version" },
] as const;

test.skipIf(process.platform === "win32").each(queryCases)(
  "$provider $operation retains its native query until certified cleanup",
  async ({ provider, operation, phase }) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-catalog-probe-"));
    const marker = join(directory, "pending.json");
    const probe = new AgentProbe();
    const client = createClient(provider, marker);
    const result = probe
      .run(async (context) => {
        if (operation === "diagnostic") return client.getDiagnostic?.(context);
        if (operation === "imports") return client.listImportableSessions?.({}, context);
        return client.fetchCatalog?.(
          { scope: "global" },
          {
            signal: context.signal,
            probe: context,
            runActivity: async (_name, work) => {
              context.signal.throwIfAborted();
              return work();
            },
          },
        );
      })
      .catch((error: unknown) => error);
    try {
      await expect
        .poll(async () => JSON.parse(await readFile(marker, "utf8").catch(() => "null"))?.phase)
        .toBe(phase);
      const { pid } = JSON.parse(await readFile(marker, "utf8")) as { pid: number };
      await probe.close();
      expect(await result).toBeInstanceOf(Error);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await probe.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
