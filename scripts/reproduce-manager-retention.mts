/**
 * Resource proof through AgentManager.runAgent and ScheduleService's new-agent caller.
 * Uses the real Codex provider with its existing fake app-server transport, no network.
 * Run: node --expose-gc --import tsx scripts/reproduce-manager-retention.mts
 *   --mode=schedule --updates=600 --chunk-units=256 --max-retained-growth-mib=24
 * Workload budgets are test assertions, not product retention limits.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { AgentManager } from "../packages/server/src/server/agent/agent-manager.js";
import type {
  AgentRunResult,
  AgentTimelineItem,
} from "../packages/server/src/server/agent/agent-sdk-types.js";
import { AgentStorage } from "../packages/server/src/server/agent/agent-storage.js";
import { CodexAppServerAgentSession } from "../packages/server/src/server/agent/providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "../packages/server/src/server/agent/providers/codex/test-utils/fake-app-server.js";
import { ScheduleService } from "../packages/server/src/server/schedule/service.js";
import { createTestAgentClients } from "../packages/server/src/server/test-utils/fake-agent-client.js";
import { createTestLogger } from "../packages/server/src/test-utils/test-logger.js";
import { SharedLogStore } from "../packages/server/src/server/agent/shared-log.js";
import { TextSnapshotWriter } from "../packages/server/src/server/agent/shared-text.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "direct" },
    updates: { type: "string", default: "600" },
    "chunk-units": { type: "string", default: "256" },
    "max-retained-growth-mib": { type: "string" },
  },
});
function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `${name} must be a positive integer`);
  return parsed;
}
const updates = positiveInteger(values.updates, "updates");
const chunkUnits = positiveInteger(values["chunk-units"], "chunk-units");
const maximum = values["max-retained-growth-mib"]
  ? positiveInteger(values["max-retained-growth-mib"], "max-retained-growth-mib") * 1024 * 1024
  : Infinity;
assert.ok(
  values.mode === "direct" || values.mode === "schedule",
  "mode must be direct or schedule",
);
assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const collect = global.gc!;
const logger = createTestLogger();
const home = await mkdtemp(path.join(tmpdir(), "paseo-manager-retention-"));
await mkdir(path.join(home, "agents"));
const registry = new AgentStorage(path.join(home, "agents"), logger);
await registry.initialize();
const native = createFakeCodexAppServer();
const expected: string[] = [];
let logicalLogUnits = 0;
let longestLogUnits = 0;
let finished = false;
let result: AgentRunResult | null = null;
let runCount = 0;
let subscriberFailure: unknown;
const clients = createTestAgentClients();
clients.codex.createSession = async (config) => {
  const session = new CodexAppServerAgentSession(config, null, logger, async () => native.child);
  await session.connect();
  session.subscribe((event) => {
    if (event.type !== "timeline" || !isLog(event.item)) return;
    try {
      expected.push(digest(event.item));
      logicalLogUnits += event.item.detail.log.length;
      longestLogUnits = Math.max(longestLogUnits, event.item.detail.log.length);
    } catch (error) {
      subscriberFailure = error;
    }
  });
  return session;
};
const manager = new AgentManager({ clients, registry, logger, agentStreamCoalesceWindowMs: 0 });
// Instrument the real caller without replacing its execution or retaining provider items.
const runAgent = manager.runAgent.bind(manager);
manager.runAgent = async (...args) => {
  runCount++;
  result = await runAgent(...args);
  finished = true;
  return result;
};
const agentId = randomUUID();
const workspaceId = "wks_memory_regression";
const schedule = new ScheduleService({
  paseoHome: home,
  logger,
  agentManager: manager,
  agentStorage: registry,
  createAgent: async (input) => {
    assert.equal(input.kind, "mcp");
    const agent = await manager.createAgent(
      { provider: "codex", cwd: home, model: "gpt-5.4", modeId: "auto" },
      agentId,
      {
        workspaceId,
        labels: input.labels,
      },
    );
    return {
      snapshot: agent,
      liveSnapshot: agent,
      background: true,
      initialPromptStarted: false,
      initialPromptError: null,
    };
  },
  createDirectoryWorkspace: async () => ({
    workspaceId,
    projectId: "memory-regression",
    cwd: home,
    kind: "directory",
    displayName: "Memory regression",
    title: "Memory regression",
    branch: null,
    baseBranch: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
  }),
  createPaseoWorktreeWorkspace: async () => {
    throw new Error("The regression uses a directory workspace");
  },
  archiveWorkspace: async () => {
    throw new Error("The regression disables archive-on-finish");
  },
});
function isLog(item: AgentTimelineItem): item is Extract<
  AgentTimelineItem,
  { type: "tool_call" }
> & {
  detail: Extract<
    Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
    { type: "sub_agent" }
  >;
} {
  return item.type === "tool_call" && item.detail.type === "sub_agent";
}
function digest(item: AgentTimelineItem): string {
  const json = JSON.stringify(item, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
  return createHash("sha256").update(json, "utf16le").digest("hex");
}
function sample(stage: string): number {
  collect();
  const memory = process.memoryUsage();
  console.log(
    JSON.stringify({
      stage,
      mode: values.mode,
      ...memory,
      processPeakRss: process.resourceUsage().maxRSS * 1024,
      logicalLogUnits,
      longestLogUnits,
      providerRows: expected.length,
      finished,
      home,
    }),
  );
  return memory.heapUsed;
}
function notify(method: string, params: unknown): void {
  native.child.stdout.write(`${JSON.stringify({ method, params })}\n`);
  if (subscriberFailure) throw subscriberFailure;
}
function currentResult(): AgentRunResult {
  assert.ok(result, "Run has not completed");
  return result;
}
async function main(): Promise<void> {
  let completion: Promise<unknown>;
  let scheduleId: string | null = null;
  if (values.mode === "schedule") {
    const created = await schedule.create({
      prompt: "Inspect this task with native subagents",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "codex",
          cwd: home,
          modeId: "auto",
          model: "gpt-5.4",
          archiveOnFinish: false,
        },
      },
      maxRuns: 1,
    });
    scheduleId = created.id;
    completion = schedule.runOnce(created.id);
  } else {
    await manager.createAgent(
      { provider: "codex", cwd: home, model: "gpt-5.4", modeId: "auto" },
      agentId,
      { workspaceId },
    );
    completion = manager.runAgent(agentId, "Inspect this task with native subagents");
  }
  // Observe startup failures while waiting for the explicit app-server handshake.
  await Promise.race([
    native.waitForTurnStart(),
    completion.then(() => {
      throw new Error("Run completed before the provider started");
    }),
  ]);
  native.startsSubAgent({ callId: "child-call", threadId: "child", agentPath: "/root/child" });
  await nextTurn();
  const baseline = sample("active-baseline");
  const chunk = 'λ漢🙂\\"\n\ud800'.repeat(Math.ceil(chunkUnits / 8)).slice(0, chunkUnits);
  for (let update = 0; update < updates; update++) {
    notify("item/agentMessage/delta", {
      threadId: "child",
      itemId: "child-message",
      delta: `${update}:${chunk}`,
    });
    await nextTurn();
  }
  assert.equal(finished, false, "Measure while runAgent's collector is still active");
  assert.equal(runCount, 1);
  assert.equal(manager.hasInFlightRun(agentId), true);
  const active = sample("active-retained");
  assert.ok(
    active - baseline < maximum,
    `Active collector retained ${active - baseline} bytes; budget ${maximum}`,
  );
  const rows = manager.getTimeline(agentId).filter(isLog);
  assert.equal(rows.length, updates + 1, "Every native activity update must commit once");
  assert.deepEqual(rows.map(digest), expected);
  if (scheduleId) {
    const inspected = await schedule.inspect(scheduleId);
    assert.equal(inspected.runs[0].status, "running");
    assert.equal(inspected.runs[0].agentId, agentId);
  }
  native.completeTurn({ threadId: "child" });
  native.says({ threadId: "thread-1", text: "Memory regression complete" });
  native.completeTurn();
  await completion;
  native.assertNoErrors();
  if (subscriberFailure) throw subscriberFailure;
  const canonical = manager.getTimeline(agentId).filter(isLog);
  const returned = currentResult().timeline.filter(isLog);
  assert.deepEqual(
    returned.map(digest),
    expected,
    "runAgent must return every exact historical version once",
  );
  assert.deepEqual(canonical.map(digest), expected);
  for (let index = 0; index < returned.length; index++)
    assert.equal(
      returned[index],
      canonical[index],
      "Collector must hold the canonical immutable item",
    );
  if (scheduleId) {
    const inspected = await schedule.inspect(scheduleId);
    assert.equal(inspected.runs[0].status, "succeeded");
    assert.equal(inspected.runs[0].output, "Memory regression complete");
  }
  sample("completed-retained");
  // A rolling-window resource proof uses the shared owner directly. Codex child
  // transcript messages are deltas, not rolling replacements; synthesizing the
  // latter in that channel would create a different legitimate history workload.
  const rollingBaseline = sample("rolling-baseline");
  const logs = new SharedLogStore();
  const writer = new TextSnapshotWriter();
  const versions: AgentTimelineItem[] = [];
  const lines: string[] = [];
  for (let update = 0; update < updates; update++) {
    lines.push(`${update}:${chunk}\n`);
    const log = lines.slice(-200).join("");
    const item = logs.retain({
      type: "tool_call",
      callId: "rolling",
      name: "Subagent",
      status: "running",
      error: null,
      detail: { type: "sub_agent", log },
    });
    versions.push(item);
    const version = logs.version(item);
    assert.notEqual(version, undefined);
    writer.add(version!);
  }
  for (let index = 0; index < versions.length; index++) {
    const item = versions[index];
    assert.ok(isLog(item));
    assert.equal(item.detail.log, lines.slice(Math.max(0, index - 199), index + 1).join(""));
  }
  assert.equal(
    writer.backings.reduce((total, text) => total + text.length, 0),
    lines.join("").length,
  );
  const rolling = sample("rolling-retained");
  assert.ok(
    rolling - rollingBaseline < maximum,
    `Rolling owner retained ${rolling - rollingBaseline} bytes; budget ${maximum}`,
  );
  console.log(
    JSON.stringify({
      stage: "verified",
      mode: values.mode,
      canonicalRows: canonical.length,
      exactReturnedRows: returned.length,
      ownedRollingUnits: writer.backings.reduce((total, text) => total + text.length, 0),
      runCount,
      home,
    }),
  );
}
try {
  await main();
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await schedule.stop();
  await manager.closeAgentsForShutdown();
}
