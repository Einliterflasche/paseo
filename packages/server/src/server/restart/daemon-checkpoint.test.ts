import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CheckpointStore } from "./checkpoint-store.js";
import { DaemonCheckpointSchema, READABLE_CHECKPOINT_FORMATS } from "./daemon-checkpoint.js";
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

test.each(READABLE_CHECKPOINT_FORMATS)(
  "a saved format %i checkpoint still loads",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-checkpoint-format-"));
    const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
    const snapshot = {
      version,
      agents: { agents: [], timelines: {}, children: [] },
      notifications: [],
      schedules: { runs: [] },
      ...(version === 4 ? { services: [] } : {}),
    };
    const saved = await store.commit(snapshot);
    await expect(
      new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value)).loadAndClaim(),
    ).resolves.toEqual({ generationId: saved.generationId, snapshot });
  },
);
