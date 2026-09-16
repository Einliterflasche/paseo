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
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
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
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
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
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
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
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
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

describe("projected timeline retention", () => {
  it("retains one full tool state while streaming every source update", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent");
    for (let seq = 1; seq <= 2000; seq++) {
      const item = {
        type: "tool_call" as const,
        callId: "child",
        name: "task",
        status: "running" as const,
        error: null,
        detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
      };
      expect(store.append("agent", item)).toMatchObject({ seq, item });
    }
    const result = store.fetch("agent", { limit: 0 });
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
    expect(result.window.maxSeq).toBe(2000);
  });

  it("catches up a mid-message cursor with the complete projected message", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "e" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "A" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "B" });
    expect(
      store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } }).rows,
    ).toMatchObject([
      {
        item: { text: "AB" },
        seqStart: 1,
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      },
    ]);
  });
});

describe("projected sequence ownership", () => {
  it("preserves fetched coverage when another source chunk arrives", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", text: "A" });
    const before = store.fetch("a");
    store.append("a", { type: "assistant_message", text: "B" });
    expect(before.rows[0]).toMatchObject({
      item: { text: "A" },
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    });
    expect(store.fetch("a").rows[0]).toMatchObject({
      item: { text: "AB" },
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    });
  });
  it("preserves source positions when seeding a projected history whose last update is an earlier tool", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    const tool = {
      type: "tool_call" as const,
      callId: "t",
      name: "shell",
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    store.append("a", { ...tool, status: "running" });
    store.append("a", { type: "assistant_message", text: "Answer" });
    store.append("a", { ...tool, status: "completed" });
    store.initialize("b", { rows: store.getRows("a") });
    expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
    expect(store.fetch("b").rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
  });
  it("returns the last projected assistant message without joining different messages", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
    expect(store.getLastAssistantMessage("a")).toBe("Second");
  });
});

it("includes transitive tool updates in a contiguous projected tail", () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a");
  const tool = (callId: string, status: "running" | "completed") => ({
    type: "tool_call" as const,
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "plain_text" as const, label: "work" },
  });
  store.append("a", tool("first", "running"));
  store.append("a", tool("second", "running"));
  store.append("a", { type: "user_message", text: "Continue" });
  store.append("a", tool("first", "completed"));
  store.append("a", { type: "assistant_message", text: "Answer" });
  store.append("a", tool("second", "completed"));
  const tail = store.fetch("a", { limit: 1 });
  expect(tail.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 5]);
  expect(tail).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false });
});

it("keeps exact canonical checkpoints when interleaved projections have non-monotonic endings", () => {
  const source = new InMemoryAgentTimelineStore();
  source.initialize("a", { epoch: "recovery-epoch" });
  const tool = {
    type: "tool_call" as const,
    callId: "tool",
    name: "shell",
    error: null,
    detail: { type: "plain_text" as const, label: "shell", text: "output" },
  };
  source.append(
    "a",
    { ...tool, status: "running" },
    { turnId: "turn", timestamp: "2026-09-30T00:00:00Z" },
  );
  source.append("a", { type: "assistant_message", text: "Displayed answer", messageId: "answer" });
  source.append("a", { ...tool, status: "completed" }, { turnId: "turn" });
  const display = source.fetch("a", { limit: 0 });
  expect(display.rows.map((row) => row.seqEnd)).toEqual([3, 2]);
  const snapshot = AgentTimelineSnapshotSchema.parse(source.exportSnapshot("a"));
  expect(snapshot.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  const replacement = new InMemoryAgentTimelineStore();
  replacement.restoreSnapshot("a", snapshot);
  expect(replacement.exportSnapshot("a")).toEqual(snapshot);
  expect(replacement.fetch("a", { limit: 0 })).toEqual(display);
  const catchup = replacement.fetch("a", {
    direction: "after",
    cursor: { epoch: snapshot.epoch, seq: 1 },
    limit: 1,
  });
  expect(catchup).toMatchObject({ startSeq: 2, endSeq: 2, hasNewer: true });
  expect(
    replacement.append("a", { type: "user_message", text: "Continue", clientMessageId: "accepted" })
      .seq,
  ).toBe(4);
});
