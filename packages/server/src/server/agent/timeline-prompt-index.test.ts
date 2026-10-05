import { describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildTimelinePromptIndex } from "./timeline-prompt-index.js";

describe("buildTimelinePromptIndex", () => {
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
