import { systemMessageBody, type AgentMessageSender } from "@getpaseo/protocol/agent-message";

export function messageSenderLabel(sender?: AgentMessageSender): string {
  if (!sender) return "Unknown sender";
  switch (sender.kind) {
    case "human":
      return "You";
    case "system":
      return "Paseo";
    case "agent":
      return sender.title
        ? `${sender.title} (${sender.agentId.slice(0, 8)})`
        : `Agent ${sender.agentId.slice(0, 8)}`;
  }
}

export function systemMessageLabel(message: string, sender?: AgentMessageSender): string {
  if (sender?.kind === "system") return sender.source;
  const body = systemMessageBody(message);
  const firstLine = body?.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim() || "System message";
}
