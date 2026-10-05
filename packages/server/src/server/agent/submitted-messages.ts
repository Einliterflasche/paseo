import { z } from "zod";
import { createHash } from "node:crypto";
import { AgentUserMessagePayloadSchema } from "@getpaseo/protocol/messages";
import type { AgentStreamEvent } from "./agent-sdk-types.js";
import type { HistoricalSenderAttribution } from "@getpaseo/protocol/messages";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const SuccessfulAgentSendSchema = z.object({
  input: z.object({ agentId: z.string(), prompt: z.string() }),
  output: z.object({ structuredContent: z.object({ success: z.literal(true) }) }),
});

function matchesHistoricalInput(
  row: AgentTimelineRow,
  evidence: HistoricalSenderAttribution,
): boolean {
  return (
    row.item.type === "user_message" &&
    row.timestamp === evidence.timestamp &&
    row.item.messageId === evidence.messageId &&
    row.item.clientMessageId === evidence.clientMessageId &&
    row.providerMessageId === evidence.providerMessageId &&
    createHash("sha256").update(row.item.text).digest("hex") === evidence.textSha256
  );
}

/** Repair metadata only from exact accepted identities and retained successful MCP calls. */
export function prepareHistoricalSenderAttribution(options: {
  agentId: string;
  rows: readonly AgentTimelineRow[];
  sources: ReadonlyMap<string, readonly AgentTimelineRow[]>;
  evidence: readonly HistoricalSenderAttribution[];
}): AgentTimelineRow[] {
  const calls = [...options.sources].flatMap(([agentId, rows]) => {
    const latest = new Map<string, AgentTimelineRow>();
    for (const row of rows) {
      if (row.item.type === "tool_call") latest.set(row.item.callId, row);
    }
    return [...latest.values()].flatMap((row) => {
      if (
        row.item.type !== "tool_call" ||
        row.item.name !== "paseo.send_agent_prompt" ||
        row.item.status !== "completed" ||
        row.item.detail.type !== "unknown"
      )
        return [];
      const send = SuccessfulAgentSendSchema.safeParse(row.item.detail);
      return send.success && send.data.input.agentId === options.agentId
        ? [{ agentId, row, prompt: send.data.input.prompt }]
        : [];
    });
  });
  const seen = new Set<number>();
  return options.evidence.map((evidence) => {
    const reject = () => {
      throw new Error(`Historical sender evidence does not match ${evidence.messageId}`);
    };
    const row = options.rows.find((candidate) => candidate.seq === evidence.seq);
    if (!row || row.item.type !== "user_message") return reject();
    const item = row.item;
    if (
      seen.has(row.seq) ||
      !matchesHistoricalInput(row, evidence) ||
      (item.sender &&
        (item.sender.kind !== "agent" || item.sender.agentId !== evidence.sourceAgentId))
    )
      return reject();
    seen.add(row.seq);
    const accepted = options.rows.filter(
      (candidate) =>
        candidate.item.type === "user_message" &&
        (candidate.item.text === item.text ||
          candidate.item.messageId === item.messageId ||
          candidate.item.clientMessageId === item.clientMessageId ||
          candidate.providerMessageId === row.providerMessageId),
    );
    const matching = calls.filter((call) => call.prompt === item.text);
    const source = matching[0];
    const delay = source ? Date.parse(source.row.timestamp) - Date.parse(row.timestamp) : NaN;
    if (
      accepted.length !== 1 ||
      matching.length !== 1 ||
      !source ||
      source.agentId !== evidence.sourceAgentId ||
      source.row.item.type !== "tool_call" ||
      source.row.item.callId !== evidence.sourceCallId ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay > 1000
    )
      return reject();
    return item.sender
      ? row
      : { ...row, item: { ...item, sender: { kind: "agent", agentId: source.agentId } } };
  });
}

export const SubmittedMessageSchema = z.object({
  item: AgentUserMessagePayloadSchema,
  timestamp: z.string(),
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
  afterMessageId: z.string().optional(),
});
export type SubmittedMessage = z.infer<typeof SubmittedMessageSchema>;

export function mergeHistoricalSubmissions(
  existing: readonly SubmittedMessage[],
  rows: readonly AgentTimelineRow[],
): SubmittedMessage[] {
  const result = [...existing];
  for (const row of rows) {
    if (row.item.type !== "user_message") throw new Error("Expected accepted input");
    const item = row.item;
    const matches = result.filter(
      (message) =>
        message.item.clientMessageId === item.clientMessageId ||
        message.item.messageId === item.messageId ||
        message.providerMessageId === row.providerMessageId,
    );
    const previous = matches[0];
    if (
      matches.length > 1 ||
      (previous &&
        (previous.item.text !== item.text ||
          previous.timestamp !== row.timestamp ||
          previous.turnId !== row.turnId ||
          previous.item.messageId !== item.messageId ||
          previous.item.clientMessageId !== item.clientMessageId ||
          previous.providerMessageId !== row.providerMessageId ||
          (previous.item.sender &&
            JSON.stringify(previous.item.sender) !== JSON.stringify(item.sender))))
    )
      throw new Error(`Conflicting accepted input ${item.messageId}`);
    const message = {
      ...previous,
      item,
      timestamp: row.timestamp,
      turnId: row.turnId,
      providerMessageId: row.providerMessageId,
    };
    if (previous) result[result.indexOf(previous)] = message;
    else result.push(message);
  }
  return result.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}
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
