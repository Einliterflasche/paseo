import { AgentProviderSchema } from "@getpaseo/protocol/provider-manifest";
import { z } from "zod";
import type { AgentProvider, AgentTimelineItem } from "../agent-sdk-types.js";
import {
  AgentTimelineSnapshotSchema,
  InMemoryAgentTimelineStore,
} from "../agent-timeline-store.js";
import type { AgentTimelineSnapshot } from "../agent-timeline-store.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent-timeline-store-types.js";
import { selectTimelineWindowByProjectedLimit } from "../timeline-projection.js";

export type ProviderSubagentStatus = "running" | "completed" | "failed" | "canceled";

export interface ProviderSubagentDescriptor {
  id: string;
  parentAgentId: string;
  /** Direct provider-subagent parent. Null identifies a child of the managed agent. */
  parentSubagentId: string | null;
  provider: AgentProvider;
  title: string | null;
  description: string | null;
  status: ProviderSubagentStatus;
  createdAt: string;
  updatedAt: string;
  toolCallId: string | null;
  cwd: string | null;
  subtitle: string | null;
}

const ProviderSubagentDescriptorSchema: z.ZodType<ProviderSubagentDescriptor, unknown> = z.object({
  id: z.string(),
  parentAgentId: z.string(),
  parentSubagentId: z.string().nullable(),
  provider: AgentProviderSchema,
  title: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  toolCallId: z.string().nullable(),
  cwd: z.string().nullable(),
  subtitle: z.string().nullable(),
});

/**
 * One provider-subagent's snapshot state, keyed explicitly by its parent agent and its own
 * id rather than the store's internal composite key. `descriptor` is null when a child
 * timeline exists (an event was appended) before any upsert produced a descriptor — that
 * timeline is still owned state and must round-trip through restart.
 */
export interface ProviderSubagentSnapshotEntry {
  parentAgentId: string;
  subagentId: string;
  descriptor: ProviderSubagentDescriptor | null;
  timeline: AgentTimelineSnapshot;
}

export const ProviderSubagentSnapshotEntrySchema: z.ZodType<
  ProviderSubagentSnapshotEntry,
  unknown
> = z.object({
  parentAgentId: z.string(),
  subagentId: z.string(),
  descriptor: ProviderSubagentDescriptorSchema.nullable(),
  timeline: AgentTimelineSnapshotSchema,
});

export const ProviderSubagentStoreSnapshotSchema = z.array(ProviderSubagentSnapshotEntrySchema);

export type ProviderSubagentStoreSnapshot = z.infer<typeof ProviderSubagentStoreSnapshotSchema>;

export type ProviderSubagentInputEvent =
  | {
      type: "upsert";
      id: string;
      title?: string | null;
      description?: string | null;
      /**
       * Omit to keep the stored status. A presentation-only upsert says nothing about whether the
       * child is still running, and must not revert a finished one.
       */
      status?: ProviderSubagentStatus;
      toolCallId?: string | null;
      cwd?: string | null;
      subtitle?: string | null;
      parentSubagentId?: string | null;
      timestamp?: string;
    }
  | {
      type: "timeline";
      id: string;
      item: AgentTimelineItem;
      timestamp?: string;
    }
  | { type: "remove"; id: string };

export type ProviderSubagentStoreEvent =
  | { type: "upsert"; subagent: ProviderSubagentDescriptor }
  | {
      type: "timeline";
      parentAgentId: string;
      subagentId: string;
      provider: AgentProvider;
      row: AgentTimelineRow;
      epoch: string;
    }
  | { type: "remove"; parentAgentId: string; subagentId: string };

function storeKey(parentAgentId: string, subagentId: string): string {
  return `${parentAgentId}\0${subagentId}`;
}

/**
 * Sticky upsert semantics for a descriptor field: an omitted value preserves what is stored, an
 * explicit `null` clears it. Providers observe these fields incrementally, so a partial upsert
 * must never blank fields it says nothing about.
 */
function stickyField<T>(next: T | undefined, previous: T | null | undefined): T | null {
  return next === undefined ? (previous ?? null) : next;
}

export class ProviderSubagentStore {
  private readonly descriptors = new Map<string, ProviderSubagentDescriptor>();
  private readonly timelines = new InMemoryAgentTimelineStore();

  apply(
    parentAgentId: string,
    provider: AgentProvider,
    event: ProviderSubagentInputEvent,
  ): ProviderSubagentStoreEvent {
    const key = storeKey(parentAgentId, event.id);
    if (event.type === "remove") {
      this.descriptors.delete(key);
      this.timelines.delete(key);
      return { type: "remove", parentAgentId, subagentId: event.id };
    }

    if (event.type === "timeline") {
      if (!this.timelines.has(key)) {
        this.timelines.initialize(key);
      }
      const row = this.timelines.append(key, limitAgentTimelineItemContent(event.item), {
        timestamp: event.timestamp,
      });
      return {
        type: "timeline",
        parentAgentId,
        subagentId: event.id,
        provider,
        row,
        epoch: this.timelines.getEpoch(key),
      };
    }

    const previous = this.descriptors.get(key);
    if (!this.timelines.has(key)) {
      this.timelines.initialize(key);
    }
    const timestamp = event.timestamp ?? new Date().toISOString();
    const subagent: ProviderSubagentDescriptor = {
      id: event.id,
      parentAgentId,
      provider,
      title: stickyField(event.title, previous?.title),
      description: stickyField(event.description, previous?.description),
      status: event.status ?? previous?.status ?? "running",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      toolCallId: stickyField(event.toolCallId, previous?.toolCallId),
      cwd: stickyField(event.cwd, previous?.cwd),
      subtitle: stickyField(event.subtitle, previous?.subtitle),
      parentSubagentId: stickyField(event.parentSubagentId, previous?.parentSubagentId),
    };
    this.descriptors.set(key, subagent);
    return { type: "upsert", subagent };
  }

  list(parentAgentId: string): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()]
      .filter((subagent) => subagent.parentAgentId === parentAgentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listAll(): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()];
  }

  get(parentAgentId: string, subagentId: string): ProviderSubagentDescriptor | null {
    return this.descriptors.get(storeKey(parentAgentId, subagentId)) ?? null;
  }

  fetchTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    const direction = options?.direction ?? "tail";
    const limit = options?.limit === undefined ? 200 : Math.max(0, Math.floor(options.limit));
    const timeline = this.timelines.fetch(storeKey(parentAgentId, subagentId), {
      ...options,
      limit: 0,
    });
    if (limit === 0 || timeline.rows.length === 0) {
      return timeline;
    }
    const selected = selectTimelineWindowByProjectedLimit({
      rows: timeline.rows,
      direction: timeline.reset ? "tail" : direction,
      limit,
    });
    const firstRow = selected.selectedRows[0];
    const lastRow = selected.selectedRows[selected.selectedRows.length - 1];
    return {
      ...timeline,
      rows: selected.selectedRows,
      hasOlder:
        timeline.hasOlder || (firstRow !== undefined && firstRow.seq > timeline.window.minSeq),
      hasNewer:
        timeline.hasNewer || (lastRow !== undefined && lastRow.seq < timeline.window.maxSeq),
    };
  }

  /** All descriptor + timeline state, including timelines with no descriptor yet. */
  exportSnapshot(): ProviderSubagentStoreSnapshot {
    const keys = new Set<string>([...this.descriptors.keys(), ...this.timelines.keys()]);
    const entries: ProviderSubagentSnapshotEntry[] = [];
    for (const key of keys) {
      const separatorIndex = key.indexOf("\0");
      const parentAgentId = key.slice(0, separatorIndex);
      const subagentId = key.slice(separatorIndex + 1);
      entries.push({
        parentAgentId,
        subagentId,
        descriptor: this.descriptors.get(key) ?? null,
        timeline: this.timelines.exportSnapshot(key),
      });
    }
    return entries;
  }

  /** Replaces all descriptor + timeline state exactly with the snapshot, no derivation. */
  restoreSnapshot(snapshot: ProviderSubagentStoreSnapshot): void {
    this.descriptors.clear();
    this.timelines.clear();
    for (const entry of snapshot) {
      const key = storeKey(entry.parentAgentId, entry.subagentId);
      if (entry.descriptor) {
        this.descriptors.set(key, entry.descriptor);
      }
      this.timelines.restoreSnapshot(key, entry.timeline);
    }
  }

  deleteParent(parentAgentId: string): ProviderSubagentStoreEvent[] {
    const events: ProviderSubagentStoreEvent[] = [];
    for (const subagent of this.list(parentAgentId)) {
      const key = storeKey(parentAgentId, subagent.id);
      this.descriptors.delete(key);
      this.timelines.delete(key);
      events.push({ type: "remove", parentAgentId, subagentId: subagent.id });
    }
    return events;
  }
}
