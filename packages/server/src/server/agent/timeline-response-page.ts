import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { timelineItemJsonBytes } from "./shared-log.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "../websocket/physical-socket.js";

export interface TimelineResponsePage<T> {
  entries: T[];
  startSeq: number | null;
  endSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

export class TimelineItemTooLargeError extends Error {
  readonly code = "TIMELINE_ITEM_TOO_LARGE";
  constructor(readonly sequence: number | null) {
    super(
      `Timeline item at sequence ${sequence ?? "unknown"} exceeds the socket's response capacity`,
    );
    this.name = "TimelineItemTooLargeError";
  }
}

export class TimelineResponseBusyError extends Error {
  readonly code = "TIMELINE_BUSY";
  constructor() {
    super("The connection is still sending data. Retry this history page after it drains.");
    this.name = "TimelineResponseBusyError";
  }
}

export function timelineResponseErrorCode(error: unknown) {
  return error instanceof TimelineItemTooLargeError || error instanceof TimelineResponseBusyError
    ? error.code
    : undefined;
}

export interface TimelineResponsePageInput<T extends { item: AgentTimelineItem }> {
  entries: readonly T[];
  direction: "tail" | "before" | "after";
  maximumBytes?: number;
  availableBytes?: number;
  startSeq: number | null;
  endSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  getBounds: (entry: T) => { startSeq: number; endSeq: number };
  /** Projected cards can own discontiguous source rows far beyond their display anchor. */
  getSourceRanges?: (entry: T) => readonly { startSeq: number; endSeq: number }[];
  /** Return the actual wire envelope with the item array empty; page bounds are authoritative. */
  envelope: (page: TimelineResponsePage<T>) => unknown;
}

function orderTimelineEntries<T extends { item: AgentTimelineItem }>(
  input: TimelineResponsePageInput<T>,
) {
  const sourceStart = input.startSeq ?? -Infinity;
  const ordered = input.entries.map((entry, index) => {
    const ranges = input.getSourceRanges?.(entry) ?? [input.getBounds(entry)];
    const firstSource = ranges.reduce(
      (first, range) =>
        range.endSeq >= sourceStart
          ? Math.min(first, Math.max(sourceStart, range.startSeq))
          : first,
      Infinity,
    );
    return { index, firstSource };
  });
  if (input.direction === "after")
    ordered.sort((left, right) => left.firstSource - right.firstSource || left.index - right.index);
  else ordered.reverse();
  return ordered;
}

function rejectFirstTimelineItem(
  item: AgentTimelineItem,
  sequence: number,
  staticRemaining: number,
): never {
  if (staticRemaining < 0 || timelineItemJsonBytes(item, staticRemaining) === null)
    throw new TimelineItemTooLargeError(sequence);
  throw new TimelineResponseBusyError();
}

function assertEmptyPageCapacity(
  envelope: unknown,
  maximumBytes: number,
  availableBytes: number,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  if (bytes > maximumBytes) throw new TimelineItemTooLargeError(null);
  if (bytes > availableBytes) throw new TimelineResponseBusyError();
}

/** Size the JSON envelope and lazy items before any historical log is expanded. */
export function selectTimelineResponsePage<T extends { item: AgentTimelineItem }>(
  input: TimelineResponsePageInput<T>,
): TimelineResponsePage<T> {
  const forward = input.direction === "after";
  const maximumBytes = input.maximumBytes ?? MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
  const availableBytes = Math.min(maximumBytes, input.availableBytes ?? maximumBytes);
  const page: TimelineResponsePage<T> = {
    entries: [],
    startSeq: input.startSeq,
    endSeq: input.endSeq,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer,
  };
  let entriesBytes = 0;
  let count = 0;
  const ordered = orderTimelineEntries(input);
  const selectedIndices = new Set<number>();
  for (let offset = 0; offset < ordered.length; offset++) {
    const index = ordered[offset]!.index;
    const entry = input.entries[index]!;
    const bounds = input.getBounds(entry);
    const candidate: TimelineResponsePage<T> = {
      entries: [],
      startSeq: forward ? input.startSeq : bounds.startSeq,
      // Stop before the first source row owned by an omitted card. seqEnd alone
      // can leap over that card when a tool lifecycle spans later updates.
      endSeq: forward
        ? Math.min(
            input.endSeq ?? bounds.endSeq,
            (ordered[offset + 1]?.firstSource ?? Infinity) - 1,
          )
        : input.endSeq,
      hasOlder: input.hasOlder || (!forward && index > 0),
      hasNewer: input.hasNewer || (forward && offset < ordered.length - 1),
    };
    // The complete page can include filtered/unsupported source rows at either edge.
    // Preserve that coverage when no entries were removed by the byte budget.
    if (offset === input.entries.length - 1) {
      candidate.startSeq = input.startSeq;
      candidate.endSeq = input.endSeq;
    }
    const envelopeBytes = Buffer.byteLength(JSON.stringify(input.envelope(candidate)));
    const metadataBytes = Buffer.byteLength(JSON.stringify({ ...entry, item: null })) - 4;
    const remaining =
      availableBytes - envelopeBytes - entriesBytes - metadataBytes - (count ? 1 : 0);
    const itemBytes = remaining < 0 ? null : timelineItemJsonBytes(entry.item, remaining);
    if (itemBytes === null) {
      if (count === 0) {
        const staticRemaining = maximumBytes - envelopeBytes - metadataBytes;
        rejectFirstTimelineItem(entry.item, bounds.startSeq, staticRemaining);
      }
      break;
    }
    entriesBytes += metadataBytes + itemBytes + (count ? 1 : 0);
    count++;
    selectedIndices.add(index);
    Object.assign(page, candidate);
  }
  if (count === 0) {
    assertEmptyPageCapacity(input.envelope(page), maximumBytes, availableBytes);
  }
  page.entries = input.entries.filter((_entry, index) => selectedIndices.has(index));
  return page;
}
