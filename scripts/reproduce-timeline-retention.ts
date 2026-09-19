/**
 * Bounded memory regression for cumulative native-subagent activity.
 *
 * Run in a separate process, after building protocol declarations:
 * node --expose-gc --import tsx scripts/reproduce-timeline-retention.ts
 *   --updates=300 --chunk-units=128 --checkpoint-home=/tmp/paseo-memory-proof
 *
 * This uses the real Codex provider with its existing in-memory transport adapter,
 * then the production coalescer and both timeline stores. It contacts no provider
 * and never reads or changes the running daemon's state. Checkpoint artifacts are
 * retained in a fresh directory, whose path is printed. No history is truncated.
 *
 * --max-retained-growth-mib=N enables an explicit regression budget. Memory samples
 * distinguish post-GC retention from observed heap and the OS process RSS high-water
 * mark; the latter includes transient allocations between JavaScript samples.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { AgentTimelineItem } from "../packages/server/src/server/agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../packages/server/src/server/agent/agent-timeline-store-types.js";
import { AgentStreamCoalescer } from "../packages/server/src/server/agent/agent-stream-coalescer.js";
import { limitAgentTimelineItemContent } from "../packages/server/src/server/agent/agent-timeline-content.js";
import {
  AgentTimelineSnapshotSchema,
  InMemoryAgentTimelineStore,
} from "../packages/server/src/server/agent/agent-timeline-store.js";
import {
  ProviderSubagentStore,
  ProviderSubagentStoreSnapshotSchema,
} from "../packages/server/src/server/agent/provider-subagents/store.js";
import { CodexAppServerAgentSession } from "../packages/server/src/server/agent/providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "../packages/server/src/server/agent/providers/codex/test-utils/fake-app-server.js";
import { projectTimelineRows } from "../packages/server/src/server/agent/timeline-projection.js";
import { CheckpointStore } from "../packages/server/src/server/restart/checkpoint-store.js";
import { createTestLogger } from "../packages/server/src/test-utils/test-logger.js";

const { values } = parseArgs({
  options: {
    updates: { type: "string", default: "300" },
    "chunk-units": { type: "string", default: "128" },
    "checkpoint-home": { type: "string" },
    "max-retained-growth-mib": { type: "string" },
  },
});
function positiveInteger(value: string, name: string): number {
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result) && result > 0, `${name} must be a positive integer`);
  return result;
}
const updates = positiveInteger(values.updates, "updates");
const chunkUnits = positiveInteger(values["chunk-units"], "chunk-units");
const memoryBudget = values["max-retained-growth-mib"]
  ? positiveInteger(values["max-retained-growth-mib"], "max-retained-growth-mib") * 1024 * 1024
  : null;
assert.equal(typeof global.gc, "function", "Run Node with --expose-gc");
const collect = global.gc!;
const parentId = "memory-regression-parent";
const parentEpoch = "memory-regression-epoch";
const timeline = new InMemoryAgentTimelineStore();
const subagents = new ProviderSubagentStore();
timeline.initialize(parentId, { epoch: parentEpoch });
const expectedRows: string[] = [];
const expectedChildren = new Map<string, string[]>();
const expectedDescriptors = new Map<string, string>();
const childEpochs = new Map<string, string>();
const latestLogs = new Map<string, string>();
const latestItems = new Map<string, string>();
let now = 0;
let logicalLogUnits = 0;
let nonPrefixChanges = 0;
let callbackFailure: unknown;
let observedPeakHeap = 0;
const startedAt = process.hrtime.bigint();

function digest(value: unknown): string {
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(
      Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
  assert.notEqual(text, undefined, "Only JSON values can have a checkpoint digest");
  return createHash("sha256").update(text, "utf16le").digest("hex");
}

function timestamp(): string {
  return new Date(Date.UTC(2026, 0, 1) + now).toISOString();
}

function rememberLog(item: AgentTimelineItem): void {
  if (item.type !== "tool_call" || item.detail.type !== "sub_agent") return;
  const previous = latestLogs.get(item.callId);
  if (previous && !item.detail.log.startsWith(previous)) nonPrefixChanges += 1;
  latestLogs.set(item.callId, item.detail.log);
  latestItems.set(item.callId, digest(item));
  logicalLogUnits += item.detail.log.length;
}

function append(item: AgentTimelineItem, turnId?: string): void {
  const limited = limitAgentTimelineItemContent(item);
  const expected: AgentTimelineRow = {
    seq: expectedRows.length + 1,
    timestamp: timestamp(),
    item: limited,
    ...(turnId ? { turnId } : {}),
  };
  expectedRows.push(digest(expected));
  rememberLog(limited);
  timeline.append(parentId, limited, { timestamp: expected.timestamp, turnId });
}

const coalescer = new AgentStreamCoalescer({
  now: () => now,
  windowMs: 60,
  timers: { setTimeout, clearTimeout },
  onFlush: ({ item, turnId }) => append(item, turnId),
});
const appServer = createFakeCodexAppServer();
const session = new CodexAppServerAgentSession(
  { provider: "codex", cwd: tmpdir(), modeId: "auto", model: "gpt-5.4" },
  null,
  createTestLogger(),
  async () => appServer.child,
);
const unsubscribe = session.subscribe((event) => {
  try {
    if (event.type === "timeline" && !coalescer.handle(parentId, event)) {
      append(event.item, event.turnId);
    }
    if (event.type === "provider_subagent") {
      const childEvent = { ...event.event, timestamp: timestamp() };
      if (childEvent.type === "timeline") {
        const rows = expectedChildren.get(childEvent.id) ?? [];
        rows.push(
          digest({
            seq: rows.length + 1,
            timestamp: childEvent.timestamp,
            item: limitAgentTimelineItemContent(childEvent.item),
          }),
        );
        expectedChildren.set(childEvent.id, rows);
      }
      const applied = subagents.apply(parentId, event.provider, childEvent);
      if (applied.type === "upsert") {
        expectedDescriptors.set(applied.subagent.id, digest(applied.subagent));
      } else if (applied.type === "timeline") {
        const epoch = childEpochs.get(applied.subagentId) ?? applied.epoch;
        assert.equal(applied.epoch, epoch);
        childEpochs.set(applied.subagentId, epoch);
      }
    }
  } catch (error) {
    // The provider deliberately isolates subscribers; make failure visible here.
    callbackFailure = error;
  }
});

function sample(stage: string, forceGc: boolean, extra: Record<string, unknown> = {}): number {
  if (forceGc) collect();
  const memory = process.memoryUsage();
  observedPeakHeap = Math.max(observedPeakHeap, memory.heapUsed);
  console.log(
    JSON.stringify({
      stage,
      gc: forceGc,
      elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      ...memory,
      observedPeakHeap,
      processPeakRss: process.resourceUsage().maxRSS * 1024,
      canonicalRows: expectedRows.length,
      logicalLogUnits,
      nonPrefixChanges,
      ...extra,
    }),
  );
  return memory.heapUsed;
}

function notify(method: string, params: unknown): void {
  now += 61;
  appServer.child.stdout.write(`${JSON.stringify({ method, params })}\n`);
  coalescer.flushAll();
  if (callbackFailure) throw callbackFailure;
}

function delta(threadId: string, itemId: string, text: string): void {
  notify("item/agentMessage/delta", { threadId, itemId, delta: text });
}

function assertRows(rows: readonly AgentTimelineRow[], expected: readonly string[]): void {
  assert.equal(rows.length, expected.length);
  for (let index = 0; index < rows.length; index += 1) {
    assert.equal(digest(rows[index]), expected[index], `Raw row ${index + 1} changed`);
  }
}

function verifyState(parentStore: InMemoryAgentTimelineStore, childStore: ProviderSubagentStore) {
  assert.equal(parentStore.getEpoch(parentId), parentEpoch);
  // Non-divisor page size exercises reconnect cursors and the final partial page.
  let cursor = { epoch: parentEpoch, seq: 0 };
  let visited = 0;
  for (;;) {
    const page = parentStore.fetch(parentId, { direction: "after", cursor, limit: 37 });
    assert.equal(page.reset, false);
    assert.equal(page.staleCursor, false);
    assert.equal(page.gap, false);
    assertRows(page.rows, expectedRows.slice(visited, visited + page.rows.length));
    visited += page.rows.length;
    if (!page.hasNewer) break;
    cursor = { epoch: parentEpoch, seq: page.rows.at(-1)!.seq };
  }
  assert.equal(visited, expectedRows.length);
  cursor = { epoch: parentEpoch, seq: expectedRows.length + 1 };
  visited = expectedRows.length;
  for (;;) {
    const page = parentStore.fetch(parentId, { direction: "before", cursor, limit: 37 });
    assert.equal(page.reset, false);
    assertRows(page.rows, expectedRows.slice(visited - page.rows.length, visited));
    visited -= page.rows.length;
    if (!page.hasOlder) break;
    cursor = { epoch: parentEpoch, seq: page.rows[0].seq };
  }
  assert.equal(visited, 0);
  const projected = projectTimelineRows({ rows: parentStore.getRows(parentId), mode: "projected" });
  for (const [callId, expected] of latestItems) {
    const entry = projected.find(
      (row) => row.item.type === "tool_call" && row.item.callId === callId,
    );
    assert.ok(entry, `Missing projected tool ${callId}`);
    assert.equal(digest(entry.item), expected);
  }
  for (const [childId, expected] of expectedChildren) {
    const page = childStore.fetchTimeline(parentId, childId, { limit: 0 });
    assert.equal(page.epoch, childEpochs.get(childId));
    assert.equal(page.window.nextSeq, expected.length + 1);
    assertRows(page.rows, expected);
  }
  assert.equal(childStore.list(parentId).length, expectedDescriptors.size);
  for (const [childId, expected] of expectedDescriptors) {
    assert.equal(digest(childStore.get(parentId, childId)), expected);
  }
}

async function main(): Promise<void> {
  await session.startTurn("Investigate the synthetic task with nested native subagents.");
  appServer.startsSubAgent({ callId: "branch-a", threadId: "child-a", agentPath: "/root/a" });
  delta("child-a", "a-message", "Initial parent commentary. ");
  appServer.startsSubAgent({
    callId: "nested-a",
    threadId: "grandchild-a",
    agentPath: "/root/a/nested",
    parentThreadId: "child-a",
  });
  appServer.startsSubAgent({ callId: "branch-b", threadId: "child-b", agentPath: "/root/b" });
  coalescer.flushAll();
  const baseline = sample("baseline", true);
  // Includes two-byte text, combining characters, supplementary characters, NUL,
  // and an unpaired surrogate. Hashing UTF-16 detects lossy surrogate conversion.
  const alphabet = "λ漢字🙂é\u0000\uD800";
  const chunk = alphabet.repeat(Math.ceil(chunkUnits / alphabet.length)).slice(0, chunkUnits);
  for (let update = 1; update <= updates; update += 1) {
    delta("grandchild-a", "nested-message", `${update}:${chunk}`);
    delta("child-b", "b-message", `${update}:${chunk}`);
    if (update % 100 === 0) {
      // The earlier child message precedes its nested tool in the curated log.
      // Appending here changes the middle of the parent log while preserving the
      // nested suffix, reproducing real non-prefix updates without private calls.
      delta("child-a", "a-message", `Progress ${update}: ${chunk}`);
    }
    if (update % 100 === 0 || update === updates) sample(`updates-${update}`, true);
  }
  appServer.completeTurn({ threadId: "grandchild-a" });
  appServer.completeTurn({ threadId: "child-a" });
  appServer.completeTurn({ threadId: "child-b" });
  appServer.completeTurn();
  coalescer.flushAll();
  if (callbackFailure) throw callbackFailure;
  appServer.assertNoErrors();
  assert.ok(expectedRows.length >= updates * 2);
  assert.ok(nonPrefixChanges >= Math.floor(updates / 100));
  verifyState(timeline, subagents);
  const retained = sample("retained-after-read", true, { baselineHeap: baseline });
  if (memoryBudget !== null) {
    assert.ok(
      retained - baseline <= memoryBudget,
      `Retained growth ${retained - baseline} exceeds ${memoryBudget}`,
    );
  }

  const checkpointRoot = values["checkpoint-home"] ?? tmpdir();
  await mkdir(checkpointRoot, { recursive: true });
  const checkpointHome = await mkdtemp(path.join(checkpointRoot, "timeline-retention-"));
  const snapshotSchema = z.object({
    timeline: AgentTimelineSnapshotSchema,
    children: ProviderSubagentStoreSnapshotSchema,
  });
  const checkpoints = new CheckpointStore(checkpointHome, (input) => snapshotSchema.parse(input));
  const memorySampler = setInterval(() => sample("checkpoint-in-flight", false), 100);
  try {
    sample("before-checkpoint", true, { checkpointHome });
    const committed = await checkpoints.commit({
      timeline: timeline.exportSnapshot(parentId),
      children: subagents.exportSnapshot(),
    });
    const checkpointBytes = (
      await stat(
        path.join(checkpointHome, "restart-checkpoints", committed.generationId, "snapshot.json"),
      )
    ).size;
    sample("checkpoint-committed", false, { checkpointBytes });
    const claimed = await checkpoints.loadAndClaim();
    assert.ok(claimed);
    assert.equal(claimed.generationId, committed.generationId);
    const restored = new InMemoryAgentTimelineStore();
    const restoredChildren = new ProviderSubagentStore();
    restored.restoreSnapshot(parentId, claimed.snapshot.timeline);
    restoredChildren.restoreSnapshot(claimed.snapshot.children);
    assert.equal(restored.exportSnapshot(parentId).nextSeq, expectedRows.length + 1);
    verifyState(restored, restoredChildren);
    sample("checkpoint-restored", true, { checkpointHome, checkpointBytes });
  } finally {
    clearInterval(memorySampler);
  }
}

void main()
  .finally(async () => {
    unsubscribe();
    coalescer.flushAndDiscard(parentId);
    await session.close();
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
