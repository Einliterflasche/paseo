import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ACPAgentClient } from "./providers/acp-agent.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

test.each(["unanswered", "completed", "failed"])(
  "checkpoint distinguishes an ACP %s receipt from a shutdown cancellation",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-acp-restart-"));
    const logger = createTestLogger();
    const registry = new AgentStorage(join(home, "agents"), logger);
    await registry.initialize();
    const client = new ACPAgentClient({
      provider: "codex",
      logger,
      defaultCommand: [
        process.execPath,
        fileURLToPath(new URL("./providers/acp/test-utils/closing-runtime.cjs", import.meta.url)),
      ],
    });
    const manager = new AgentManager({ clients: { codex: client }, registry, logger });
    const agent = await manager.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    const run = manager.streamAgent(agent.id, mode, { clientMessageId: "original-input" });
    try {
      for (;;) {
        const event = await run.next();
        if (event.done) throw new Error("native prompt ended before its ready output");
        if (
          event.value.type === "timeline" &&
          event.value.item.type === "assistant_message" &&
          event.value.item.text === "ready"
        )
          break;
      }
      const saved = await manager.quiesceForRestart();
      expect(saved.agents).toHaveLength(1);
      expect(saved.agents[0]!.continue).toBe(mode === "unanswered");
      expect(saved.agents[0]!.inputs.map((input) => input.id)).toEqual(
        mode === "unanswered" ? ["original-input"] : [],
      );
      const items = saved.timelines[agent.id]!.rows.map((row) => row.item);
      expect(items.filter((item) => item.type === "user_message")).toMatchObject([
        { type: "user_message", text: mode, clientMessageId: "original-input" },
      ]);
      expect(
        items.filter((item) => item.type === "assistant_message").map((item) => item.text),
      ).toEqual(
        mode === "failed"
          ? ["ready", "final output", expect.stringContaining("[System Error] native failure")]
          : ["ready", "final output"],
      );
    } finally {
      await manager.quiesceForRestart();
      await run.return(undefined);
    }
  },
);
