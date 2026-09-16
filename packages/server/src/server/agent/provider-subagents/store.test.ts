import { describe, expect, test } from "vitest";
import { ProviderSubagentStore, ProviderSubagentStoreSnapshotSchema } from "./store.js";

describe("ProviderSubagentStore", () => {
  test("keeps provider children and their timelines scoped to the parent agent", () => {
    const subagents = new ProviderSubagentStore();

    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      cwd: "/workspace/child",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "Found it." },
      timestamp: "2026-07-12T10:00:01.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      status: "completed",
      timestamp: "2026-07-12T10:00:02.000Z",
    });
    subagents.apply("parent-b", "claude", {
      type: "upsert",
      id: "child-1",
      title: "Review",
      status: "running",
      timestamp: "2026-07-12T10:00:03.000Z",
    });

    expect(subagents.list("parent-a")).toEqual([
      expect.objectContaining({
        id: "child-1",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Explore",
        cwd: "/workspace/child",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
      }),
    ]);
    expect(subagents.fetchTimeline("parent-a", "child-1").rows).toEqual([
      {
        seq: 1,
        timestamp: "2026-07-12T10:00:01.000Z",
        item: { type: "assistant_message", text: "Found it." },
      },
    ]);
    expect(subagents.list("parent-b")[0]).toMatchObject({ provider: "claude", title: "Review" });
    expect(subagents.deleteParent("parent-a")).toEqual([
      { type: "remove", parentAgentId: "parent-a", subagentId: "child-1" },
    ]);
    expect(subagents.list("parent-a")).toEqual([]);
    expect(subagents.list("parent-b")).toHaveLength(1);
  });

  test("limits oversized provider child tool output before storage", () => {
    const subagents = new ProviderSubagentStore();
    const output = "x".repeat(70 * 1024);
    const update = subagents.apply("parent-a", "opencode", {
      type: "timeline",
      id: "child-1",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "print", output },
      },
    });

    expect(update.type).toBe("timeline");
    const [row] = subagents.fetchTimeline("parent-a", "child-1").rows;
    expect(row?.item).toMatchObject({
      type: "tool_call",
      detail: { type: "shell", output: "x".repeat(64 * 1024) },
    });
  });

  test("pages provider history on projected item boundaries", () => {
    const subagents = new ProviderSubagentStore();
    for (let index = 0; index < 101; index += 1) {
      subagents.apply("parent-a", "opencode", {
        type: "timeline",
        id: "child-1",
        item: { type: "assistant_message", text: String(index) },
      });
    }

    const page = subagents.fetchTimeline("parent-a", "child-1", {
      direction: "tail",
      limit: 1,
    });
    expect(page.rows).toHaveLength(101);
    expect(page.rows[0]?.seq).toBe(1);
    expect(page.rows.at(-1)?.seq).toBe(101);
    expect(page.hasOlder).toBe(false);
  });

  test("exportSnapshot includes a child timeline with no descriptor yet", () => {
    const subagents = new ProviderSubagentStore();
    subagents.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "before any upsert" },
      timestamp: "2026-07-12T10:00:00.000Z",
    });

    const snapshot = subagents.exportSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      parentAgentId: "parent-a",
      subagentId: "child-1",
      descriptor: null,
    });
    expect(snapshot[0]?.timeline.rows).toHaveLength(1);
    expect(() => ProviderSubagentStoreSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  test("restoreSnapshot round-trips descriptors and every child timeline exactly", () => {
    const source = new ProviderSubagentStore();
    source.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });
    source.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "found it" },
      timestamp: "2026-07-12T10:00:01.000Z",
    });
    source.apply("parent-b", "claude", {
      type: "timeline",
      id: "child-2",
      item: { type: "assistant_message", text: "no descriptor for this one" },
      timestamp: "2026-07-12T10:00:02.000Z",
    });
    const snapshot = source.exportSnapshot();

    const restored = new ProviderSubagentStore();
    restored.restoreSnapshot(snapshot);

    expect(restored.list("parent-a")).toEqual(source.list("parent-a"));
    expect(restored.fetchTimeline("parent-a", "child-1").rows).toEqual(
      source.fetchTimeline("parent-a", "child-1").rows,
    );
    // A child observed only through a timeline event, never upserted, still round-trips.
    expect(restored.get("parent-b", "child-2")).toBeNull();
    expect(restored.fetchTimeline("parent-b", "child-2").rows).toEqual(
      source.fetchTimeline("parent-b", "child-2").rows,
    );
    expect(
      restored.exportSnapshot().sort((a, b) => a.subagentId.localeCompare(b.subagentId)),
    ).toEqual(snapshot.sort((a, b) => a.subagentId.localeCompare(b.subagentId)));
  });

  test("restoreSnapshot clears prior state instead of merging with it", () => {
    const store = new ProviderSubagentStore();
    store.apply("parent-a", "codex", {
      type: "upsert",
      id: "stale-child",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });

    store.restoreSnapshot([]);

    expect(store.list("parent-a")).toEqual([]);
    expect(store.exportSnapshot()).toEqual([]);
  });
});
