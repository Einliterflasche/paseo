import { randomUUID } from "node:crypto";
import { TimelineProjection, selectProjectedTimelinePage } from "./timeline-projection.js";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { SharedLogStore } from "./shared-log.js";
import { decodeTextNodes, TextNodeSnapshotSchema, TextSnapshotWriter } from "./shared-text.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

/**
 * Raw, unprojected timeline state for one agent (or provider-subagent). Distinct from
 * `AgentTimelineFetchResult`, which is a paginated/projected UI view — restart checkpoints
 * must round-trip the exact rows, epoch, and sequence counter, not a fetch window.
 */
const CanonicalTimelineRowSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

export const AgentTimelineRowSchema: z.ZodType<AgentTimelineRow, unknown> =
  CanonicalTimelineRowSchema;

export const AgentTimelineSnapshotSchema = z
  .object({
    epoch: z.string(),
    nextSeq: z.number().int().nonnegative(),
    rows: z.array(
      CanonicalTimelineRowSchema.extend({
        logRef: z.number().int().nonnegative().nullable().optional(),
      }),
    ),
    textNodes: z.array(TextNodeSnapshotSchema).optional(),
  })
  .refine(({ rows, nextSeq }) => {
    let previous = -1;
    for (const row of rows) {
      if (row.seq <= previous || row.seq >= nextSeq) return false;
      previous = row.seq;
    }
    return true;
  }, "Timeline sequences must increase and precede nextSeq")
  .superRefine((snapshot, ctx) => {
    try {
      decodeTextNodes(snapshot.textNodes ?? []);
      for (const row of snapshot.rows) {
        if (row.logRef === undefined) continue;
        if (
          !snapshot.textNodes ||
          (row.logRef !== null && row.logRef >= snapshot.textNodes.length) ||
          row.item.type !== "tool_call" ||
          row.item.detail.type !== "sub_agent" ||
          row.item.detail.log !== ""
        ) {
          throw new Error("Invalid shared log reference in timeline checkpoint");
        }
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export type AgentTimelineSnapshot = z.infer<typeof AgentTimelineSnapshotSchema>;

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  rows: AgentTimelineRow[];
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
  logs: SharedLogStore;
}

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  keys(): string[] {
    return [...this.states.keys()];
  }

  clear(): void {
    this.states.clear();
  }

  /** Raw rows/epoch/nextSeq for one agent, not a projected fetch window. */
  exportSnapshot(agentId: string): AgentTimelineSnapshot {
    const state = this.requireState(agentId);
    const text = new TextSnapshotWriter();
    const rows: AgentTimelineSnapshot["rows"] = state.rows.map((row) => {
      const version = state.logs.version(row.item);
      if (
        version === undefined ||
        row.item.type !== "tool_call" ||
        row.item.detail.type !== "sub_agent"
      ) {
        return cloneRow(row);
      }
      // Never spread the lazy detail: its log getter would expand this version.
      const { log: _log, ...detail } = Object.getOwnPropertyDescriptors(row.item.detail);
      const compactDetail: typeof row.item.detail = { type: "sub_agent", log: "" };
      Object.defineProperties(compactDetail, detail);
      return { ...row, item: { ...row.item, detail: compactDetail }, logRef: text.add(version) };
    });
    return {
      epoch: state.epoch,
      nextSeq: state.nextSeq,
      rows,
      ...(text.nodes.length || rows.some((row) => row.logRef !== undefined)
        ? { textNodes: text.nodes }
        : {}),
    };
  }

  exportAll(): Record<string, AgentTimelineSnapshot> {
    const result: Record<string, AgentTimelineSnapshot> = {};
    for (const agentId of this.states.keys()) {
      result[agentId] = this.exportSnapshot(agentId);
    }
    return result;
  }

  /** Replaces this agent's state exactly with the snapshot, no derivation. */
  restoreSnapshot(agentId: string, snapshot: AgentTimelineSnapshot): void {
    const logs = new SharedLogStore();
    const nodes = decodeTextNodes(snapshot.textNodes ?? []);
    const rows = snapshot.rows.map(({ logRef, ...row }) => ({
      ...row,
      item:
        logRef === undefined
          ? logs.retain(row.item)
          : logs.attach(row.item, logRef === null ? null : nodes[logRef]),
    }));
    logs.seedLatest(rows.map((row) => row.item));
    const projection = new TimelineProjection();
    for (const row of rows) projection.append(row);
    this.states.set(agentId, {
      epoch: snapshot.epoch,
      nextSeq: snapshot.nextSeq,
      rows,
      logs,
      projection,
      minSeq: rows[0]?.seq ?? 0,
    });
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const logs = new SharedLogStore();
    for (const row of rows) row.item = logs.retain(row.item);
    const projection = new TimelineProjection();
    for (const row of rows) projection.append(row);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      rows,
      nextSeq,
      logs,
      projection,
      minSeq: rows[0]?.seq ?? 0,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): AgentTimelineRow[] {
    return this.requireState(agentId).rows.map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId).rows.find(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    const state = this.requireState(agentId);
    const index = state.rows.findIndex(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    const row = state.rows[index];
    if (!row || row.item.type !== "user_message") {
      return null;
    }
    const enriched: AgentTimelineRow = { ...row, providerMessageId };
    state.rows[index] = enriched;
    state.projection.enrichSubmittedUserMessage(clientMessageId, providerMessageId);
    return cloneRow(enriched);
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const rows = state.projection.getRows();
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      rows.length > 0 &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = selectProjectedTimelinePage({
      rows,
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item: state.logs.retain(item),
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    state.rows.push(row);
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getRows().find((row) => row.seqEnd === state.nextSeq - 1)?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .findLast((candidate) => candidate.item.type === "assistant_message");
    return row?.item.type === "assistant_message" ? row.item.text : null;
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
