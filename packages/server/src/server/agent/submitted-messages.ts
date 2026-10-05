import { z } from "zod";
import { AgentUserMessagePayloadSchema } from "@getpaseo/protocol/messages";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

export const SubmittedMessageSchema = z.object({
  item: AgentUserMessagePayloadSchema,
  timestamp: z.string(),
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
  afterMessageId: z.string().optional(),
});
export type SubmittedMessage = z.infer<typeof SubmittedMessageSchema>;
type TimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }>;
type SubmittedHistoryEvent = TimelineEvent & { providerMessageId?: string };

/** Native transcripts do not retain daemon attribution or every accepted input. */
export function reconcileSubmittedHistory(
  history: readonly TimelineEvent[],
  submitted: readonly SubmittedMessage[],
  provider: string,
): SubmittedHistoryEvent[] {
  const messages = new Map<string, SubmittedMessage>();
  for (const message of submitted) {
    if (message.item.clientMessageId) messages.set(message.item.clientMessageId, message);
    if (message.item.messageId) messages.set(message.item.messageId, message);
    if (message.providerMessageId) messages.set(message.providerMessageId, message);
  }
  const seen = new Set<SubmittedMessage>();
  const result: SubmittedHistoryEvent[] = [];
  for (const event of history) {
    const item = event.item;
    const message =
      item.type === "user_message"
        ? (messages.get(item.clientMessageId ?? "") ?? messages.get(item.messageId ?? ""))
        : undefined;
    if (!message) {
      result.push(event);
      continue;
    }
    if (seen.has(message)) continue;
    seen.add(message);
    result.push({
      ...event,
      item: message.item,
      timestamp: message.timestamp,
      turnId: message.turnId,
      providerMessageId: message.providerMessageId,
    });
  }
  let previousIndex = -1;
  for (const [offset, message] of submitted.entries()) {
    const present = result.findIndex((event) => event.item === message.item);
    if (present >= 0) {
      previousIndex = present;
      continue;
    }
    const anchor = result.findIndex(
      (event) =>
        "messageId" in event.item &&
        event.item.messageId === message.afterMessageId &&
        message.afterMessageId !== undefined,
    );
    const next = submitted.slice(offset + 1).find((candidate) => seen.has(candidate));
    const nextIndex = next ? result.findIndex((event) => event.item === next.item) : result.length;
    const index = anchor >= 0 ? Math.max(previousIndex, anchor) + 1 : nextIndex;
    result.splice(index, 0, {
      type: "timeline",
      provider,
      item: message.item,
      timestamp: message.timestamp,
      turnId: message.turnId,
      providerMessageId: message.providerMessageId,
    });
    previousIndex = index;
  }
  return result;
}
