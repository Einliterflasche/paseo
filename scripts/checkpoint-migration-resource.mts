/**
 * Produce a format-1 checkpoint with an actual historical checkout, then measure
 * its validation/installation with the candidate checkout in a fresh process.
 * This is a resource and exact-history proof, not a daemon activation proof.
 *
 * node --expose-gc --import tsx scripts/checkpoint-migration-resource.mts
 *   --phase=produce --checkout=/path/to/65f76230 --home=/tmp/isolated-migration
 * node --expose-gc --import tsx scripts/checkpoint-migration-resource.mts
 *   --phase=restore --checkout=/path/to/candidate --home=/tmp/isolated-migration
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentTimelineRow } from "../packages/server/src/server/agent/agent-timeline-store-types.js";

const { values } = parseArgs({
  options: {
    phase: { type: "string" },
    checkout: { type: "string" },
    home: { type: "string" },
    updates: { type: "string", default: "600" },
    "chunk-units": { type: "string", default: "256" },
    "expected-revision": { type: "string" },
  },
});
assert.ok(values.checkout && path.isAbsolute(values.checkout), "An absolute checkout is required");
assert.ok(values.home && path.isAbsolute(values.home), "An absolute isolated home is required");
assert.ok(values.phase === "produce" || values.phase === "restore");
assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const collect = global.gc!;
const checkout = values.checkout;
const home = values.home;
const sourceRevision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (values["expected-revision"]) assert.equal(sourceRevision, values["expected-revision"]);
function moduleUrl(relative: string): string {
  return pathToFileURL(path.join(checkout, relative)).href;
}
const managerModule: typeof import("../packages/server/src/server/agent/agent-manager.js") =
  await import(moduleUrl("packages/server/src/server/agent/agent-manager.ts"));
const storageModule: typeof import("../packages/server/src/server/agent/agent-storage.js") =
  await import(moduleUrl("packages/server/src/server/agent/agent-storage.ts"));
const checkpointModule: typeof import("../packages/server/src/server/restart/checkpoint-store.js") =
  await import(moduleUrl("packages/server/src/server/restart/checkpoint-store.ts"));
const schemaModule: typeof import("../packages/server/src/server/restart/daemon-checkpoint.js") =
  await import(moduleUrl("packages/server/src/server/restart/daemon-checkpoint.ts"));
const clientModule: typeof import("../packages/server/src/server/test-utils/checkpoint-agent-client.js") =
  await import(moduleUrl("packages/server/src/server/test-utils/checkpoint-agent-client.ts"));
const loggerModule: typeof import("../packages/server/src/test-utils/test-logger.js") =
  await import(moduleUrl("packages/server/src/test-utils/test-logger.ts"));
const logger = loggerModule.createTestLogger();
// Produce only into a new directory. This command cannot replace an existing daemon's ready pointer.
if (values.phase === "produce") await mkdir(home, { mode: 0o700 });
await mkdir(path.join(home, "agents"), { recursive: true });
const registry = new storageModule.AgentStorage(path.join(home, "agents"), logger);
await registry.initialize();
const dispatchFile = path.join(home, "provider-dispatches.jsonl");
const manager = new managerModule.AgentManager({
  logger,
  registry,
  clients: { codex: clientModule.createCheckpointAgentClient(dispatchFile) },
});
const checkpoints = new checkpointModule.CheckpointStore(home, (input) =>
  schemaModule.DaemonCheckpointSchema.parse(input),
);
const summaryPath = path.join(home, "migration-expected.json");
interface ExpectedHistory {
  sourceRevision: string;
  generationId: string;
  agentId: string;
  epoch: string;
  nextSeq: number;
  rowDigests: string[];
  logicalLogUnits: number;
  largestLogUnits: number;
}
function positiveInteger(value: string): number {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0);
  return number;
}
function digest(row: AgentTimelineRow): string {
  const json = JSON.stringify(row, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
  return createHash("sha256").update(json, "utf16le").digest("hex");
}
function sample(stage: string, extra: Record<string, unknown> = {}): void {
  collect();
  console.log(
    JSON.stringify({
      stage,
      phase: values.phase,
      sourceRevision,
      home,
      ...process.memoryUsage(),
      processPeakRss: process.resourceUsage().maxRSS * 1024,
      ...extra,
    }),
  );
}
async function produce(): Promise<void> {
  const agentId = randomUUID();
  const agent = await manager.createAgent(
    { provider: "codex", cwd: home, modeId: "full-access" },
    agentId,
    { workspaceId: "migration-workspace" },
  );
  const stream = manager.streamAgent(agent.id, "Preserve this accepted request", {
    clientMessageId: "migration-original",
  });
  await stream.next();
  sample("producer-active-baseline");
  const updates = positiveInteger(values.updates);
  const chunkUnits = positiveInteger(values["chunk-units"]);
  const chunk = 'λ🙂\\"\n\ud800'.repeat(chunkUnits).slice(0, chunkUnits);
  let text = "";
  let logicalLogUnits = 0;
  for (let index = 0; index < updates; index++) {
    text += `${index}:${chunk}`;
    logicalLogUnits += text.length;
    // Model native transport ownership: each message supplies an independent string.
    const copied = Buffer.from(text, "utf16le").toString("utf16le");
    await manager.appendTimelineItem(agent.id, {
      type: "tool_call",
      callId: "migration-subagent",
      name: "Subagent",
      status: "running",
      error: null,
      detail: { type: "sub_agent", childSessionId: "child", log: copied },
    });
  }
  sample("producer-active-retained", { logicalLogUnits, largestLogUnits: text.length });
  const agents = await manager.quiesceForRestart();
  assert.equal(agents.agents[0].continue, true);
  assert.equal(agents.agents[0].inputs[0].id, "migration-original");
  const timeline = agents.timelines[agentId];
  assert.equal(
    timeline.textNodes,
    undefined,
    "The producer must use the parent's actual inline codec",
  );
  const snapshot = schemaModule.DaemonCheckpointSchema.parse({
    version: 1,
    agents,
    notifications: [],
    schedules: { runs: [] },
  });
  const committed = await checkpoints.commit(snapshot);
  const expected: ExpectedHistory = {
    sourceRevision,
    generationId: committed.generationId,
    agentId,
    epoch: timeline.epoch,
    nextSeq: timeline.nextSeq,
    rowDigests: timeline.rows.map(digest),
    logicalLogUnits,
    largestLogUnits: text.length,
  };
  await writeFile(summaryPath, JSON.stringify(expected, null, 2), { flag: "wx" });
  const disk = await stat(
    path.join(home, "restart-checkpoints", committed.generationId, "snapshot.json"),
  );
  sample("producer-committed", {
    generationId: committed.generationId,
    checkpointBytes: disk.size,
    logicalLogUnits,
    canonicalRows: timeline.rows.length,
  });
}
async function restore(): Promise<void> {
  const expected: ExpectedHistory = JSON.parse(await readFile(summaryPath, "utf8"));
  const originalDispatches = await readFile(dispatchFile, "utf8");
  sample("restore-baseline", { producerRevision: expected.sourceRevision });
  let claimed = await checkpoints.loadAndClaim();
  assert.ok(claimed);
  assert.equal(claimed.snapshot.version, 1);
  assert.equal(claimed.generationId, expected.generationId);
  sample("parsed-legacy", { logicalLogUnits: expected.logicalLogUnits });
  await manager.installRestartCheckpoint(claimed.snapshot.agents);
  sample("installed-with-source", { logicalLogUnits: expected.logicalLogUnits });
  claimed = null;
  await nextTurn();
  sample("installed-source-released", { logicalLogUnits: expected.logicalLogUnits });
  const rows = await manager.getTimelineRows(expected.agentId);
  assert.deepEqual(rows.map(digest), expected.rowDigests);
  const page = manager.fetchTimeline(expected.agentId, { limit: 1 });
  assert.equal(page.epoch, expected.epoch);
  assert.equal(page.window.nextSeq, expected.nextSeq);
  assert.equal(
    await readFile(dispatchFile, "utf8"),
    originalDispatches,
    "History inspection must not activate a provider",
  );
  const compact = await manager.quiesceForRestart();
  const timeline = compact.timelines[expected.agentId];
  assert.ok(timeline.textBackings);
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(
    compactBytes < expected.logicalLogUnits,
    "Migration should preserve compact ownership for the successor checkpoint",
  );
  assert.equal(compact.agents[0].continue, true);
  assert.equal(compact.agents[0].inputs[0].id, "migration-original");
  sample("restore-verified", {
    producerRevision: expected.sourceRevision,
    generationId: expected.generationId,
    canonicalRows: rows.length,
    compactBytes,
    logicalLogUnits: expected.logicalLogUnits,
    ownedTextUnits: timeline.textBackings.reduce((sum, text) => sum + text.length, 0),
  });
}
try {
  if (values.phase === "produce") await produce();
  else await restore();
} finally {
  await manager.closeAgentsForShutdown();
}
