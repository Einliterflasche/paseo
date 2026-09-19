import { expect, test } from "vitest";
import { DaemonCheckpointSchema } from "./daemon-checkpoint.js";
import { InMemoryAgentTimelineStore } from "../agent/agent-timeline-store.js";

test("legacy checkpoints remain readable, while shared text requires a new format version", () => {
  const legacy = {
    version: 1,
    agents: { timelines: {}, children: [], agents: [] },
    notifications: [],
    schedules: { runs: [] },
  };
  expect(DaemonCheckpointSchema.parse(legacy)).toEqual(legacy);
  const store = new InMemoryAgentTimelineStore();
  store.initialize("agent");
  store.append("agent", {
    type: "tool_call",
    name: "Sub-agent",
    callId: "call",
    status: "running",
    error: null,
    detail: { type: "sub_agent", log: "complete historical log" },
  });
  const timeline = store.exportSnapshot("agent");
  const compact = { ...legacy, agents: { ...legacy.agents, timelines: { agent: timeline } } };
  expect(() => DaemonCheckpointSchema.parse(compact)).toThrow(
    "Checkpoint text encoding does not match its declared version",
  );
  expect(() => DaemonCheckpointSchema.parse({ ...compact, version: 2 })).toThrow(
    "Checkpoint text encoding does not match its declared version",
  );
  expect(DaemonCheckpointSchema.parse({ ...compact, version: 3 }).version).toBe(3);
  const { textBackings: _backings, ...v2Timeline } = timeline;
  v2Timeline.textNodes = ["complete historical log"];
  const v2 = {
    ...legacy,
    version: 2,
    agents: { ...legacy.agents, timelines: { agent: v2Timeline } },
  };
  expect(DaemonCheckpointSchema.parse(v2)).toEqual(v2);
  const child = {
    ...legacy,
    agents: {
      ...legacy.agents,
      children: [{ parentAgentId: "parent", subagentId: "child", descriptor: null, timeline }],
    },
  };
  expect(() => DaemonCheckpointSchema.parse(child)).toThrow(
    "Checkpoint text encoding does not match its declared version",
  );
});
