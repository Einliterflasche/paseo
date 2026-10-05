import { describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildTimelinePromptIndex } from "./timeline-prompt-index.js";

describe("buildTimelinePromptIndex", () => {
  it("excludes the seven attributed manager reports and completion entries without renumbering history", () => {
    const timestamp = "2026-10-05T20:34:54.190Z";
    const rows: AgentTimelineRow[] = [5947, 5953, 5966, 5981, 5999, 6009, 6045].map((seq) => ({
      seq,
      timestamp,
      providerMessageId: `native-${seq}`,
      item: {
        type: "user_message",
        text: "Original plain report",
        clientMessageId: `accepted-${seq}`,
        sender: { kind: "agent", agentId: "reviewer" },
      },
    }));
    for (const seq of [6044, 6185])
      rows.push({
        seq,
        timestamp,
        item: {
          type: "user_message",
          text: "<paseo-system>\nCompletion report\n</paseo-system>",
          sender: { kind: "system", source: "Completion report" },
        },
      });
    for (const seq of [6025, 6057])
      rows.push({
        seq,
        timestamp,
        item: { type: "user_message", text: "Original plain report", sender: { kind: "human" } },
      });
    rows.push({
      seq: 5930,
      timestamp,
      item: { type: "user_message", text: "Original plain report" },
    });
    rows.sort((a, b) => a.seq - b.seq);
    const original = structuredClone(rows);
    expect(buildTimelinePromptIndex("retained-epoch", rows).prompts.map((p) => p.seq)).toEqual([
      5930, 6025, 6057,
    ]);
    expect(rows).toEqual(original);
  });
  it("omits system envelopes while preserving ordinary prompts and their timeline positions", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const rows: AgentTimelineRow[] = [
      { seq: 1, timestamp, item: { type: "user_message", text: "First prompt" } },
      { seq: 2, timestamp, item: { type: "assistant_message", text: "First reply" } },
      {
        seq: 3,
        timestamp,
        item: {
          type: "user_message",
          text: "<paseo-system>\nHuman system message\n</paseo-system>",
          sender: { kind: "human" },
        },
      },
      {
        seq: 4,
        timestamp,
        item: {
          type: "user_message",
          text: "<paseo-system>\nAgent system message\n</paseo-system>",
          sender: { kind: "agent", agentId: "agent-1" },
        },
      },
      {
        seq: 5,
        timestamp,
        item: {
          type: "user_message",
          text: "<paseo-system>\nScheduled system message\n</paseo-system>",
          sender: { kind: "system", source: "schedule" },
        },
      },
      { seq: 6, timestamp, item: { type: "assistant_message", text: "System reply" } },
      { seq: 9, timestamp, item: { type: "user_message", text: "Show the <paseo-system> tag." } },
    ];
    expect(buildTimelinePromptIndex("epoch-1", rows)).toEqual({
      epoch: "epoch-1",
      prompts: [
        { seq: 1, timestamp, preview: "First prompt" },
        { seq: 9, timestamp, preview: "Show the <paseo-system> tag." },
      ],
    });
  });

  it("indexes every canonical user prompt with a stable timeline position", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "  First\n\n   prompt  " },
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "response" },
      },
      {
        seq: 8,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "user_message", text: "Second prompt" },
      },
    ];

    expect(buildTimelinePromptIndex("epoch-1", rows)).toEqual({
      epoch: "epoch-1",
      prompts: [
        { seq: 3, timestamp: "2026-01-01T00:00:00.000Z", preview: "First prompt" },
        { seq: 8, timestamp: "2026-01-01T00:00:02.000Z", preview: "Second prompt" },
      ],
    });
  });

  it("bounds previews without indexing assistant rows", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "x".repeat(200) },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "ignored" },
      },
    ];

    const result = buildTimelinePromptIndex("epoch-1", rows);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.preview).toHaveLength(120);
    expect(result.prompts[0]?.preview.endsWith("…")).toBe(true);
  });
});
