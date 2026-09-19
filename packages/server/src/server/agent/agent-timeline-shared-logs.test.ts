import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { AgentTimelineSnapshotSchema, InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { SharedLogStore, timelineItemJsonBytes } from "./shared-log.js";
import { decodeTextNodes } from "./shared-text.js";
import { projectTimelineRows } from "./timeline-projection.js";

function call(callId: string, log: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "Sub-agent",
    status: "running",
    error: null,
    detail: {
      type: "sub_agent",
      childSessionId: `child-${callId}`,
      subAgentType: "review",
      description: "Inspect the task",
      actions: [{ index: 1, toolName: "read", summary: "Read source" }],
      log,
    },
  };
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("canonical shared subagent logs", () => {
  it("preserves every raw version and cursor while projection selects the latest call", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("parent", { epoch: "epoch" });
    const items = [
      call("one", "start🙂\ud800"),
      call("two", "other"),
      call("one", "start🙂\ud800 and more"),
      call("one", "edited🙂\ud800 and more"),
      call("two", ""),
      call("two", "new"),
    ];
    for (const [index, item] of items.entries())
      store.append("parent", item, {
        timestamp: `${index}`,
        turnId: "turn",
        providerMessageId: `${index}`,
      });
    const all = plain(store.getRows("parent"));
    expect(all.map((row) => row.item)).toEqual(items);
    const page = store.fetch("parent", {
      direction: "before",
      cursor: { epoch: "epoch", seq: 5 },
      limit: 2,
    });
    expect(plain(page.rows)).toEqual(all.slice(2, 4));
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(true);
    expect(page.window).toEqual({ minSeq: 1, maxSeq: 6, nextSeq: 7 });
    const projected = projectTimelineRows({ rows: store.getRows("parent"), mode: "projected" });
    expect(plain(projected.map((row) => row.item))).toEqual([items[3], items[5]]);
  });

  it("round trips compact and legacy checkpoints, then shares subsequent updates", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("parent", { epoch: "epoch", nextSeq: 7 });
    store.append("parent", call("one", "before"), { timestamp: "first" });
    store.append("parent", call("one", "before + after"), { timestamp: "second" });
    const expected = plain(store.getRows("parent"));
    const compact = AgentTimelineSnapshotSchema.parse(plain(store.exportSnapshot("parent")));
    const legacy = AgentTimelineSnapshotSchema.parse({
      epoch: "epoch",
      nextSeq: 9,
      rows: expected,
    });
    const version2 = AgentTimelineSnapshotSchema.parse({
      epoch: "epoch",
      nextSeq: 9,
      rows: compact.rows.map((row, index) => ({ ...row, logRef: index === 0 ? 0 : 2 })),
      textNodes: ["before", " + after", [0, 1]],
    });
    for (const snapshot of [compact, legacy, version2]) {
      const restored = new InMemoryAgentTimelineStore();
      restored.restoreSnapshot("parent", snapshot);
      expect(plain(restored.getRows("parent"))).toEqual(expected);
      const next = restored.append("parent", call("one", "before + after + restored"), {
        timestamp: "third",
      });
      expect(next.seq).toBe(9);
      expect(plain(next.item)).toEqual(call("one", "before + after + restored"));
      expect(plain(restored.getRows("parent").slice(0, 2))).toEqual(expected);
    }
  });

  it("keeps returned historical views readable after replacement and deletion", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("first");
    store.initialize("second");
    store.append("first", call("same-id", "original"));
    const old = store.getRows("first")[0];
    store.append("first", call("same-id", "original extended"));
    store.append("second", call("same-id", "independent"));
    store.initialize("first", { items: [call("same-id", "replaced")] });
    store.delete("first");
    expect(plain(old.item)).toEqual(call("same-id", "original"));
    expect(plain(store.getRows("second")[0].item)).toEqual(call("same-id", "independent"));
  });

  it("seeds imported rows through the same sharing boundary", () => {
    const source = new InMemoryAgentTimelineStore();
    source.initialize("source", {
      items: [call("one", "a"), call("one", "ab"), call("one", "abc")],
    });
    const imported = new InMemoryAgentTimelineStore();
    imported.initialize("copy", {
      rows: source.getRows("source"),
      epoch: source.getEpoch("source"),
    });
    expect(plain(imported.getRows("copy"))).toEqual(plain(source.getRows("source")));
    const snapshot = imported.exportSnapshot("copy");
    expect(snapshot.rows.every((row) => row.logRef !== undefined)).toBe(true);
    expect(AgentTimelineSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("sizes shared and projected items exactly without flattening retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("parent");
    const values = ["", "\ud800", "\ud800\udfff", 'quote"\\\n\u0001', "new🙂 text"];
    for (const value of values) store.append("parent", call("one", value));
    const rows = store.getRows("parent");
    const projected = projectTimelineRows({ rows, mode: "projected" });
    for (const { item } of [...rows, ...projected]) {
      const expected = Buffer.byteLength(JSON.stringify(item));
      expect(timelineItemJsonBytes(item)).toBe(expected);
      expect(timelineItemJsonBytes(item, expected)).toBe(expected);
      expect(timelineItemJsonBytes(item, expected - 1)).toBe(null);
    }
    const ordinary: AgentTimelineItem = { type: "assistant_message", text: "hello🙂" };
    expect(timelineItemJsonBytes(ordinary)).toBe(Buffer.byteLength(JSON.stringify(ordinary)));
    expect(timelineItemJsonBytes(ordinary, 0)).toBe(null);
  });

  it("rejects an unrepresentable response before expanding a shared log", () => {
    const nodes: Array<string | [number, number]> = ["a"];
    for (let index = 0; index < 27; index++) nodes.push([index, index]);
    const logs = new SharedLogStore();
    const item = logs.attach(call("one", ""), decodeTextNodes(nodes)[27]);
    // Existing physical socket capacity; no 128 MiB expanded log is needed to refuse it.
    expect(timelineItemJsonBytes(item, 64 * 1024 * 1024)).toBe(null);
  });

  it("rejects malformed compact references and conflicting inline log text", () => {
    const row = { seq: 1, timestamp: "now", item: call("one", ""), logRef: 0 };
    const base = { epoch: "epoch", nextSeq: 2, rows: [row], textNodes: ["text"] };
    expect(AgentTimelineSnapshotSchema.safeParse(base).success).toBe(true);
    expect(AgentTimelineSnapshotSchema.safeParse({ ...base, textNodes: [] }).success).toBe(false);
    expect(AgentTimelineSnapshotSchema.safeParse({ ...base, textNodes: [[0, 0]] }).success).toBe(
      false,
    );
    expect(
      AgentTimelineSnapshotSchema.safeParse({
        ...base,
        rows: [{ ...row, item: call("one", "contradiction") }],
      }).success,
    ).toBe(false);
    expect(
      AgentTimelineSnapshotSchema.safeParse({
        ...base,
        rows: [{ ...row, item: { type: "assistant_message", text: "not a log" } }],
      }).success,
    ).toBe(false);
  });
});
