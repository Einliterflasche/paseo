import { describe, expect, it } from "vitest";
import { AgentTimelineSnapshotSchema, InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("exports raw rows/epoch/nextSeq exactly, not a projected fetch window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 4,
      rows: [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "one" },
          turnId: "turn-1",
        },
        {
          seq: 2,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "two" },
          providerMessageId: "provider-msg-2",
        },
      ],
    });

    const snapshot = store.exportSnapshot("agent-1");
    expect(snapshot).toEqual({
      epoch: "epoch-1",
      nextSeq: 4,
      rows: store.getRows("agent-1"),
    });
    expect(() => AgentTimelineSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("restoreSnapshot round-trips exactly through exportSnapshot for a fresh agent id", () => {
    const source = new InMemoryAgentTimelineStore();
    source.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 9,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 8,
          timestamp: "2026-01-01T00:00:03.000Z",
          item: { type: "assistant_message", text: "eight" },
        },
      ],
    });
    const snapshot = source.exportSnapshot("agent-1");

    const restored = new InMemoryAgentTimelineStore();
    restored.restoreSnapshot("agent-2", snapshot);

    expect(restored.exportSnapshot("agent-2")).toEqual(snapshot);
    expect(restored.getEpoch("agent-2")).toBe("epoch-1");
    // The restored sequence counter is exactly seeded, not re-derived from row count.
    expect(restored.append("agent-2", { type: "assistant_message", text: "next" }).seq).toBe(9);
  });

  it("exportAll covers every tracked agent id, keyed by id", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", { epoch: "epoch-1" });
    store.initialize("agent-2", { epoch: "epoch-2" });

    expect(Object.keys(store.exportAll()).sort()).toEqual(["agent-1", "agent-2"]);
    expect(store.keys().sort()).toEqual(["agent-1", "agent-2"]);
  });
});
