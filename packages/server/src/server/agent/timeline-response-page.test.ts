import { describe, expect, it } from "vitest";
import { SharedLogStore } from "./shared-log.js";
import { decodeTextNodes, type TextNodeSnapshot } from "./shared-text.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  selectTimelineResponsePage,
  TimelineResponseBusyError,
  TimelineItemTooLargeError,
} from "./timeline-response-page.js";
import { selectProjectedTimelinePage } from "./timeline-projection.js";

function repeatedLog(unit: string, doublings: number): AgentTimelineItem {
  const nodes: TextNodeSnapshot[] = [unit];
  for (let i = 0; i < doublings; i++) nodes.push([i, i]);
  return new SharedLogStore().attach(
    {
      type: "tool_call",
      callId: "child",
      name: "agent",
      status: "running",
      error: null,
      detail: { type: "sub_agent", log: "" },
    },
    decodeTextNodes(nodes)[doublings]!,
  );
}

interface Entry {
  item: AgentTimelineItem;
  seq: number;
}
function selectTestPage(entries: Entry[], direction: "tail" | "before" | "after") {
  return selectTimelineResponsePage({
    entries,
    direction,
    startSeq: entries[0]?.seq ?? null,
    endSeq: entries.at(-1)?.seq ?? null,
    hasOlder: false,
    hasNewer: false,
    getBounds: (entry) => ({ startSeq: entry.seq, endSeq: entry.seq }),
    envelope: (selected) => ({ type: "test_timeline_response", payload: selected }),
  });
}

describe("timeline response byte paging", () => {
  it.each(["tail", "before"] as const)(
    "keeps newest contiguous rows for %s without expanding rejected versions",
    (direction) => {
      const item = repeatedLog("x", 25);
      const selected = selectTestPage(
        [1, 2, 3].map((seq) => ({ seq, item })),
        direction,
      );
      expect(selected).toEqual({
        entries: [{ seq: 3, item }],
        startSeq: 3,
        endSeq: 3,
        hasOlder: true,
        hasNewer: false,
      });
    },
  );
  it("keeps oldest contiguous rows for after", () => {
    const item = repeatedLog("x", 25);
    const selected = selectTestPage(
      [1, 2, 3].map((seq) => ({ seq, item })),
      "after",
    );
    expect(selected).toEqual({
      entries: [{ seq: 1, item }],
      startSeq: 1,
      endSeq: 1,
      hasOlder: false,
      hasNewer: true,
    });
  });
  it("reports the indivisible sequence explicitly instead of omitting it", () => {
    expect(() => selectTestPage([{ seq: 21, item: repeatedLog("x", 27) }], "tail")).toThrow(
      "sequence 21",
    );
  });
  it("includes JSON escaping and envelope bytes in the actual socket capacity", () => {
    expect(() => selectTestPage([{ seq: 9, item: repeatedLog("\n", 25) }], "after")).toThrow(
      "sequence 9",
    );
  });
  it("preserves exact requested source coverage when all supported entries fit", () => {
    const item: AgentTimelineItem = { type: "assistant_message", text: "one" };
    const entries = [{ seq: 2, item }];
    const selected = selectTimelineResponsePage({
      entries,
      direction: "tail",
      startSeq: 1,
      endSeq: 3,
      hasOlder: true,
      hasNewer: true,
      getBounds: (entry) => ({ startSeq: entry.seq, endSeq: entry.seq }),
      envelope: (result) => result,
    });
    expect(selected).toEqual({ entries, startSeq: 1, endSeq: 3, hasOlder: true, hasNewer: true });
  });
  it("respects a connection-specific budget including the outer session envelope", () => {
    const entries = [1, 2, 3].map((seq) => ({
      seq,
      item: { type: "assistant_message" as const, text: 'λ🙂\\"\n'.repeat(12) },
    }));
    const envelope = (result: unknown) => ({
      type: "session",
      message: { type: "timeline", payload: result },
    });
    const expected = {
      entries: entries.slice(0, 2),
      startSeq: 1,
      endSeq: 2,
      hasOlder: false,
      hasNewer: true,
    };
    const budget = Buffer.byteLength(JSON.stringify(envelope(expected)));
    const select = (maximumBytes: number) =>
      selectTimelineResponsePage({
        entries,
        direction: "after",
        maximumBytes,
        startSeq: 1,
        endSeq: 3,
        hasOlder: false,
        hasNewer: false,
        getBounds: (entry) => ({ startSeq: entry.seq, endSeq: entry.seq }),
        envelope,
      });
    expect(select(budget)).toEqual(expected);
    const smaller = select(budget - 1);
    expect(smaller.entries).toEqual(entries.slice(0, 1));
    expect(Buffer.byteLength(JSON.stringify(envelope(smaller)))).toBeLessThanOrEqual(budget - 1);
  });
  it("does not skip interleaved cards when a wide lifecycle fills an after page", () => {
    const tool = (log: string): AgentTimelineItem => ({
      type: "tool_call",
      callId: "wide",
      name: "agent",
      status: "running",
      error: null,
      detail: { type: "sub_agent", log },
    });
    const rows = [
      tool("first"),
      { type: "assistant_message", text: "interleaved".repeat(100) } as AgentTimelineItem,
      tool("latest".repeat(180)),
    ].map((item, index) => ({ seq: index + 1, item, timestamp: "2026-09-19T00:00:00.000Z" }));
    const first = selectProjectedTimelinePage({ rows, direction: "after", cursorSeq: 0, limit: 0 });
    expect(first.entries[0]?.sourceSeqRanges).toEqual([
      { startSeq: 1, endSeq: 1 },
      { startSeq: 3, endSeq: 3 },
    ]);
    const one = {
      entries: first.entries.slice(0, 1),
      startSeq: 1,
      endSeq: 1,
      hasOlder: false,
      hasNewer: true,
    };
    const maximumBytes = Buffer.byteLength(JSON.stringify(one));
    const pages = [];
    let cursorSeq = 0;
    for (let index = 0; index < 3; index++) {
      const projected = selectProjectedTimelinePage({
        rows,
        direction: "after",
        cursorSeq,
        limit: 0,
      });
      const selected = selectTimelineResponsePage({
        ...projected,
        direction: "after",
        maximumBytes,
        getBounds: (entry) => ({ startSeq: entry.seqStart, endSeq: entry.seqEnd }),
        getSourceRanges: (entry) => entry.sourceSeqRanges,
        envelope: (page) => page,
      });
      pages.push(selected);
      cursorSeq = selected.endSeq!;
    }
    expect(pages.map((page) => page.endSeq)).toEqual([1, 2, 3]);
    const itemTypes = [];
    for (const selected of pages) itemTypes.push(selected.entries.map((entry) => entry.item.type));
    expect(itemTypes).toEqual([["tool_call"], ["assistant_message"], ["tool_call"]]);
    expect(pages.map((page) => page.hasNewer)).toEqual([true, true, false]);
  });
  it("distinguishes temporary backlog from an indivisible oversized item", () => {
    const input = {
      entries: [{ seq: 1, item: { type: "assistant_message" as const, text: "x".repeat(300) } }],
      direction: "after" as const,
      startSeq: 1,
      endSeq: 1,
      hasOlder: false,
      hasNewer: false,
      getBounds: (entry: Entry) => ({ startSeq: entry.seq, endSeq: entry.seq }),
      envelope: (page: unknown) => page,
    };
    expect(() =>
      selectTimelineResponsePage({ ...input, maximumBytes: 500, availableBytes: 100 }),
    ).toThrow(TimelineResponseBusyError);
    expect(() =>
      selectTimelineResponsePage({ ...input, maximumBytes: 200, availableBytes: 100 }),
    ).toThrow(TimelineItemTooLargeError);
    expect(
      selectTimelineResponsePage({ ...input, maximumBytes: 500, availableBytes: 500 }).entries,
    ).toEqual(input.entries);
  });
  it("pages backward by display anchor while preserving a wide card's later updates", () => {
    const tool = (log: string): AgentTimelineItem => ({
      type: "tool_call",
      callId: "wide",
      name: "agent",
      status: "running",
      error: null,
      detail: { type: "sub_agent", log },
    });
    const rows = [
      tool("first"),
      { type: "assistant_message", text: "interleaved".repeat(100) } as AgentTimelineItem,
      tool("latest".repeat(180)),
    ].map((item, index) => ({ seq: index + 1, item, timestamp: "2026-09-19T00:00:00.000Z" }));
    const projected = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: 4,
      limit: 0,
    });
    const expected = {
      entries: projected.entries.slice(1),
      startSeq: 2,
      endSeq: 3,
      hasOlder: true,
      hasNewer: false,
    };
    const maximumBytes = Buffer.byteLength(
      JSON.stringify({
        entries: projected.entries.slice(0, 1),
        startSeq: 1,
        endSeq: 1,
        hasOlder: false,
        hasNewer: true,
      }),
    );
    const select = (cursorSeq: number) =>
      selectTimelineResponsePage({
        ...selectProjectedTimelinePage({ rows, direction: "before", cursorSeq, limit: 0 }),
        direction: "before",
        maximumBytes,
        getBounds: (entry) => ({ startSeq: entry.seqStart, endSeq: entry.seqEnd }),
        getSourceRanges: (entry) => entry.sourceSeqRanges,
        envelope: (page) => page,
      });
    const newest = select(4);
    expect(newest).toEqual(expected);
    const older = select(newest.startSeq!);
    expect(older).toEqual({
      entries: projected.entries.slice(0, 1),
      startSeq: 1,
      endSeq: 1,
      hasOlder: false,
      hasNewer: true,
    });
    expect(older.entries[0]?.sourceSeqRanges).toEqual([
      { startSeq: 1, endSeq: 1 },
      { startSeq: 3, endSeq: 3 },
    ]);
    expect(older.entries[0]?.item).toEqual(tool("latest".repeat(180)));
  });
});
