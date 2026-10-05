import { z } from "zod";

export const AgentMessageSenderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }),
  z.object({ kind: z.literal("agent"), agentId: z.string(), title: z.string().optional() }),
  z.object({ kind: z.literal("system"), source: z.string() }),
]);

export type AgentMessageSender = z.infer<typeof AgentMessageSenderSchema>;

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n([\s\S]*)\n<\/paseo-system>$/;

export function systemMessageBody(text: string): string | null {
  return SYSTEM_ENVELOPE_PATTERN.exec(text)?.[1] ?? null;
}

export function isSystemInjectedEnvelope(text: string): boolean {
  return systemMessageBody(text) !== null;
}
