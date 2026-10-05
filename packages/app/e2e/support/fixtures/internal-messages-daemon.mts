import { createTestPaseoDaemon } from "../../../../server/src/server/test-utils/paseo-daemon.js";
import { MockLoadTestAgentClient } from "../../../../server/src/server/agent/providers/mock-load-test-agent.js";
import type { AgentTimelineItem } from "../../../../server/src/server/agent/agent-sdk-types.js";

const host = await createTestPaseoDaemon({
  agentClients: { mock: new MockLoadTestAgentClient() },
  isDev: true,
  corsAllowedOrigins: [`http://localhost:${process.env.E2E_METRO_PORT}`],
});
const manager = host.daemon.agentManager;
process.send?.({ ready: true, port: host.port, serverId: host.daemon.getServerId() });
process.on(
  "message",
  async (command: { id: number; type: string; agentId: string; item: AgentTimelineItem }) => {
    try {
      let result: unknown;
      if (command.type === "append")
        result = await manager.appendTimelineItem(command.agentId, command.item);
      if (command.type === "clear") await manager.clearAgentAttention(command.agentId);
      if (command.type === "status")
        result = { attention: manager.getAgent(command.agentId)?.attention };
      if (command.type === "run" && command.item.type === "user_message")
        await manager.runAgent(command.agentId, command.item.text, {
          clientMessageId: command.item.clientMessageId,
          sender: command.item.sender,
        });
      if (command.type === "close") await host.close();
      process.send?.({ id: command.id, result });
      if (command.type === "close") process.exit(0);
    } catch (error) {
      process.send?.({ id: command.id, error: String(error) });
    }
  },
);
